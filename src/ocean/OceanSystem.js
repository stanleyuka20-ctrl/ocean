// ---------------------------------------------------------------------------
//  OceanSystem.js -- assembles and drives every ocean subsystem.
//
//  Public surface used by the rest of the app:
//      ocean.update(dt)
//      ocean.getSurfaceData(worldPosition) -> { height, normal, velocity, foam }
//      ocean.addDisturbance({ position, radius, strength, velocity })
//      ocean.setQuality(tierName)
// ---------------------------------------------------------------------------

import { WaveSimulation } from "./WaveSimulation.js";
import { OceanLODManager } from "./OceanLODManager.js";
import { OceanMaterial } from "./OceanMaterial.js";
import { OceanEffects } from "./OceanEffects.js";
import { ReflectionSystem } from "./ReflectionSystem.js";
import { RefractionSystem } from "./RefractionSystem.js";
import { FoamSystem } from "./FoamSystem.js";
import { UnderwaterSystem } from "./UnderwaterSystem.js";
import { SpraySystem } from "./SpraySystem.js";
import { BuoyancySystem } from "./BuoyancySystem.js";
import { BreakingWaves } from "./BreakingWaves.js";
import { CausticsSystem } from "./CausticsSystem.js";
import { SeafloorSystem } from "./SeafloorSystem.js";
import { WeatherOceanController } from "./WeatherOceanController.js";
import { OceanDebugTools } from "./OceanDebugTools.js";
import { WATER_TYPES } from "./waterTypes.js";
import { TIERS } from "../core/quality.js";

const B = () => window.BABYLON;
function mixf(a, b, t) { return a + (b - a) * t; }

export class OceanSystem {
  constructor(engine, scene, camera, sky, tierName, opts = {}) {
    this.opts = opts;
    this.engine = engine;
    this.scene = scene;
    this.camera = camera;
    this.sky = sky;
    this.tierName = tierName;
    this.tier = TIERS[tierName];
    this.seaLevel = 0;
    this.water = Object.assign({}, WATER_TYPES.tropical);
    this._waterTarget = Object.assign({}, WATER_TYPES.tropical);
    this.mesh = null;
    this.time = 0;
    this.clarity = 1.0;      // >1 clearer water, <1 murkier
    const BJ = B();
    this._depthRect = new BJ.Vector4();
    this._disturbRect = new BJ.Vector4();
    this._rippleRect = new BJ.Vector4();
    this._waterTint = new BJ.Vector3();
  }

  // -------------------------------------------------------------------------
  build() {
    const t = this.tier;
    this.sim = new WaveSimulation(this.engine, this.scene, t);
    this.sim.build();

    // OCEAN ONLY: there is no bathymetry.  The shoreline module was a
    // dependency of the old island scene; the core ocean is a deep-water
    // system and everything that used to read a sea bed now falls through to
    // uDeepDepth.  A shallow-water module can be reattached here later --
    // the shader still carries the shoaling/breaking maths and simply stays
    // inert while no depth map is bound.
    this.shoreline = null;
    this.effects = new OceanEffects(this.engine, this.scene,
      t.breakerQuality !== undefined ? t.breakerQuality : 1).build(this.sim.renderer);

    this.lod = new OceanLODManager(this.scene, t);
    this.mesh = this.lod.build();

    this.material = new OceanMaterial(this.scene, t);
    this.mesh.material = this.material.build();
    this.mesh.renderingGroupId = 1;

    this.reflection = new ReflectionSystem(this.scene, this.engine, t);
    this.refraction = new RefractionSystem(this.scene, this.engine, t);

    // Three world-anchored disturbance fields.  A footstep needs centimetre
    // texels and a boat wake needs hundreds of metres of reach; one field
    // cannot serve both, so the ocean shader adds a coarse and a fine one.
    this.foam = new FoamSystem(this.engine, this.scene, {
      size: t.disturb, extent: 420, decay: 0.55, waveSpeed: 3.0, name: "coarseRipple" });
    this.foam.build(this.sim.renderer);
    this.ripple = new FoamSystem(this.engine, this.scene, {
      size: Math.max(256, t.disturb), extent: 26, decay: 0.42, waveSpeed: 1.0,
      name: "fineRipple" });
    this.ripple.build(this.sim.renderer);
    this.footprints = new FoamSystem(this.engine, this.scene, {
      size: 512, extent: 48, decay: 0.055, mode: 1, speed: 0, name: "footprints" });
    this.footprints.build(this.sim.renderer);
    this.focus = [0, 0];        // what the fine fields follow (the player)
    this.breakers = new BreakingWaves(this);

    this.buoyancy = new BuoyancySystem(this.sim, this.shoreline, {
      sizes: t.sim[0] >= 128 ? [128, 64] : [64, 32],
    });
    this.buoyancy.build();

    this.underwater = new UnderwaterSystem(this.scene, this.engine, this.camera, t);
    this.underwater.build();

    this.spray = new SpraySystem(this.scene, this.camera, t, this.buoyancy);
    this.spray.build();

    this.caustics = new CausticsSystem(this.sim);
    this.world = null;
    this.seafloor = new SeafloorSystem(this.scene, this).build();
    this.weather = new WeatherOceanController(this);
    this.debug = new OceanDebugTools(this);

    this.material.state.deepDepth = this.shoreline ? this.shoreline.deepDepth : 220;
    this.setSceneObjects({ reflect: [], refract: [], surfaceMaterials: [] });
    return this;
  }

  /** Tell the reflection / refraction passes what the world contains. */
  setSceneObjects({ reflect = [], refract = [], surfaceMaterials = [] }) {
    const floor = (this.seafloor && this.seafloor.mesh) ? [this.seafloor.mesh] : [];
    const floorMat = (this.seafloor && this.seafloor.material) ? [this.seafloor.material] : [];
    this.reflection.build(reflect);
    this.refraction.build(refract.concat(floor));
    this.caustics.materials.length = 0;
    for (const m of surfaceMaterials.concat(floorMat)) this.caustics.register(m);
  }

  /** Whatever holds focus drives the fine ripple / footprint fields. */
  setFocus(x, z, owner) { this.focus = [x, z]; this._focusOwner = owner || null; }

  setWaterType(key, instant, opts = {}) {
    const w = WATER_TYPES[key];
    if (!w) return false;
    this.waterKey = key;
    this._waterTarget = Object.assign({}, w, {
      absorb: w.absorb.slice(),
      scatterCol: w.scatterCol.slice(),
    });
    if (this.weather) {
      this.weather.waterKey = key;
      if (!opts.fromPreset) this.weather.presetKey = null;
    }
    if (instant) {
      const c = Math.max(0.2, this.clarity);
      this.water.absorb = w.absorb.map((v) => v / c);
      this.water.scatterCol = w.scatterCol.slice();
      this.water.scatterAmt = w.scatterAmt;
      this.water.turbid = w.turbid / c;
    }
    return true;
  }

  _easeWater(dt) {
    const k = 1 - Math.exp(-dt * 0.9);
    const t = this._waterTarget;
    const w = this.water;
    const c = Math.max(0.2, this.clarity);
    for (let i = 0; i < 3; i++) {
      w.absorb[i] += (t.absorb[i] / c - w.absorb[i]) * k;
      w.scatterCol[i] += (t.scatterCol[i] - w.scatterCol[i]) * k;
    }
    w.scatterAmt += (t.scatterAmt - w.scatterAmt) * k;
    // Clarity is a real optical control: it scales extinction and turbidity,
    // so the depth at which red disappears moves with it.
    w.turbid += (t.turbid / c - w.turbid) * k;
  }

  // -------------------------------------------------------------------------
  update(dt) {
    const d = Math.min(dt, 0.1);
    this.time += d;

    this.weather.update(d);
    if (this.weather.waterKey !== this.waterKey) {
      this.setWaterType(this.weather.waterKey, false, { fromPreset: true });
    }
    this._easeWater(d);

    this.sky.update(d);
    this.sim.update(d);
    this.buoyancy.seaLevel = this.seaLevel;
    this.buoyancy.shoreSteepen = this.material.state.shoreSteepen;
    this.buoyancy.update(d);

    const wv = this.sim.windVector();
    const drift = [wv[0] * this.sim.params.windSpeed * 0.12,
                   wv[1] * this.sim.params.windSpeed * 0.12];
    const cam = this.camera.globalPosition;
    if (!this._focusOwner) this.focus = [cam.x, cam.z];
    this.foam.update(d, [cam.x, cam.z], drift);
    // Fine ripple / footprint fields exist for a character that is not in
    // this build.  Stepping them every frame is two extra GPU passes of
    // zeros.
    if (this._focusOwner) {
      this.ripple.update(d, this.focus, [drift[0] * 0.35, drift[1] * 0.35]);
      this.footprints.update(d, this.focus, [0, 0]);
    }

    // rain lands on the water: a few impact rings per frame, scaled by rate
    const rain = this.weather.rain;
    if (rain > 0.02 && this.camera.globalPosition.y > this.seaLevel) {
      const n = Math.round(rain * 6);
      const c = this.camera.globalPosition;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 90;
        this.foam.add({ position: [c.x + Math.cos(a) * r, 0, c.z + Math.sin(a) * r],
                        radius: 1.2 + Math.random() * 1.5, strength: 0.10 + rain * 0.10 });
      }
    }

    const wh = this.buoyancy.getHeight(this.camera.globalPosition.x, this.camera.globalPosition.z);
    this.underwater.seaLevel = this.seaLevel;
    this.underwater.derivTex = this.sim.derivatives[1];
    this.underwater.cascadeL = this.sim.patchSizes[1];
    this.underwater.update(d, wh, this.sky, this.water);
    this.underwater._emitMotes(d, this);
    this.underwater._emitBubbles(d, this);
    if (this.effects) {
      const wet = this.underwater.blend > 0.04 && this.underwater.enabled;
      if (this.effects.bubbles) {
        this.effects.bubbles.setEnabled(wet && this.underwater.bubbleAmount > 0.001);
      }
      if (this.effects.motes) {
        this.effects.motes.setEnabled(wet && this.underwater.motesAmount > 0.001);
      }
    }

    if (this.seafloor) this.seafloor.update();
    this.material.state.floorDepth = (this.seafloor && this.seafloor.mesh &&
      this.seafloor.mesh.isEnabled()) ? this.seafloor.depth : 0;

    // Fill the frame with the water VOLUME while the camera is under.  With no
    // sea bed in an ocean-only scene there is nothing behind the surface, so
    // looking up from below used to end at a hard horizontal line with the
    // clear colour beneath it -- a visible mesh edge, which the brief lists as
    // a failure.  The volume colour is the same in-scattering the underwater
    // pass integrates, so the two meet without a seam.
    // Fully under, the sky dome must not draw at all: it renders its analytic
    // ground for every downward ray, which from below is a black hemisphere
    // meeting the water at a dead straight line.  The Snell window and the
    // surface above come from the ocean shader's own underwater branch, so the
    // dome has no job down there.  It stays on through the crossing, where the
    // air half of the screen still needs it.
    if (this.sky.dome) this.sky.dome.setEnabled(this.underwater.blend < 0.995);

    if (this.underwater.blend > 0.001) {
      const w = this.water;
      const L = (0.06 + 0.94 * Math.max(0, this.sky.sunDir.y) * this.sky.sunI) * 0.85;
      const depthFade = Math.exp(-Math.max(0, -cam.y) * 0.007);
      const k = this.underwater.blend;
      const c = this.scene.clearColor;
      c.r = mixf(0.02, w.scatterCol[0] * w.scatterAmt * L * 3.4 * depthFade, k);
      c.g = mixf(0.04, w.scatterCol[1] * w.scatterAmt * L * 3.4 * depthFade, k);
      c.b = mixf(0.06, w.scatterCol[2] * w.scatterAmt * L * 3.4 * depthFade, k);
    } else {
      const c = this.scene.clearColor;
      c.r = 0.02; c.g = 0.04; c.b = 0.06;
    }

    this.spray.seaLevel = this.seaLevel;
    this.spray.update(d, this.weather.windSpeed, this.weather.storm, rain,
                      this.sim.windVector(), this.sky);

    // --- the surf zone ------------------------------------------------------
    const hs = this.debug.significantWaveHeight();
    this.breakers.syncToSeaState(this.weather.windSpeed, hs, this.weather.storm);
    this.breakers.update(d, cam, {
      time: this.sim.time,
      windDir: wv,
      windSpeed: this.weather.windSpeed,
      hs,
      quality: this.tier.breakerQuality !== undefined ? this.tier.breakerQuality : 1,
    });

    // the ocean's own droplet / mist / bubble fields
    if (this.effects) {
      const water = this.water;
      const ws2 = this.sim.params.windSpeed;
      this.effects.update(d, {
        time: this.sim.time, camera: this.camera, sky: this.sky,
        seaLevel: this.seaLevel, cascadeL: this.sim.patchSizes,
        waveScale: this.sim.params.waveScale, disp: this.sim.displacement,
        wind: [wv[0] * ws2 * 0.35, 0, wv[1] * ws2 * 0.35],
        current: [wv[0] * ws2 * 0.03, 0, wv[1] * ws2 * 0.03],
        turbulence: this.weather.storm + Math.min(1, ws2 / 22),
        waterTint: this._waterTint.set(water.scatterCol[0] * 12, water.scatterCol[1] * 12,
                          water.scatterCol[2] * 12),
        underwaterAmbient: 0.10 + 0.9 * Math.max(0, this.sky.sunDir.y) * this.sky.sunI,
      });
    }

    this.caustics.update(this.sky.sunDir);
    this.reflection.update(this.camera);

    // --- upload -------------------------------------------------------------
    const m = this.material.material;
    this.material.state.seaLevel = this.seaLevel;
    this.lastCtx = {
      sim: this.sim, camera: this.camera, sky: this.sky,
      weather: { rain }, water: this.water, engine: this.engine,
      surf: this.breakers.uniforms,
    };
    this.material.bind(this.lastCtx);
    this.bindOceanTextures(m, hs);
  }

  /**
   * Textures and rects the surface material needs.  Factored out because the
   * TAA velocity pass runs the SAME vertex shader and therefore declares the
   * same samplers -- if it does not receive them, WebGPU refuses the bind group
   * and floods the log rather than failing outright.
   */
  bindOceanTextures(m, significantWaveHeight) {
    // With no bathymetry the rect's w is 0 and the shader falls straight to
    // uDeepDepth, so nothing samples a texture that does not exist.
    const sl = this.shoreline;
    m.setTexture("uDepthMap", sl ? sl.texture : this.sim.displacement[0]);
    const r = sl ? sl.rect : [0, 0, 1, 1];
    m.setVector4("uDepthMapRect", this._depthRect.set(r[0], r[1], r[2], r[3]));
    m.setFloat("uDepthMapSize", sl ? sl.size : 1);
    m.setFloat("uHasDepthMap", sl ? 1 : 0);
    const mirrorOn = !!(this.reflection.texture && this.reflection.enabled &&
      this.reflection.subsystemEnabled !== false);
    m.setFloat("uMirrorOn", mirrorOn ? 1 : 0);
    if (mirrorOn) m.setTexture("uMirror", this.reflection.texture);
    else m.setTexture("uMirror", this.sim.displacement[0]);
    // how far above the flat sea level the wave crests reach, so the
    // refraction clip keeps the beach the water is actually drawn over
    const hs = Number.isFinite(significantWaveHeight) ? significantWaveHeight
      : this.debug.significantWaveHeight();
    this.refraction.clipTop = Math.min(4.0, 0.7 * hs + 0.3);
    const refractOn = !!(this.refraction.texture && this.refraction.enabled &&
      this.refraction.subsystemEnabled !== false);
    m.setFloat("uRefractOn", refractOn ? 1 : 0);
    if (refractOn) m.setTexture("uRefract", this.refraction.texture);
    else m.setTexture("uRefract", this.sim.displacement[0]);
    const fr = this.foam.rect;
    m.setVector4("uDisturbRect", this._disturbRect.set(fr[0], fr[1], fr[2], fr[3]));
    m.setTexture("uDisturb", this.foam.texture || this.sim.displacement[0]);
    const rr = this.ripple.rect;
    m.setVector4("uRippleRect", this._rippleRect.set(rr[0], rr[1], rr[2], rr[3]));
    m.setTexture("uRipple", this.ripple.texture || this.sim.displacement[0]);
  }

  // -------------------------------------------------------------------------
  //  public API
  // -------------------------------------------------------------------------
  getSurfaceData(pos, out) { return this.buoyancy.getSurfaceData(pos, out); }
  getHeight(x, z) { return this.buoyancy.getHeight(x, z); }

  /**
   * ocean.addDisturbance({ position, radius, strength, velocity, lift, type })
   * Character-scale types go into the fine field (centimetre texels, short
   * reach); vessel and object impacts go into the coarse one.  Anything close
   * enough to the fine field also lands there, so a footstep never falls
   * through a gap between the two.
   */
  addDisturbance(d) {
    const t = d.type || "OBJECT_IMPACT";
    const fine = t === "FOOTSTEP" || t === "RUN_STEP" || t === "SWIM_STROKE" ||
                 t === "KICK" || t === "BODY_ENTRY";
    if (fine) {
      const p = d.position;
      const x = p.x !== undefined ? p.x : p[0];
      const z = p.z !== undefined ? p.z : p[2];
      const half = this.ripple.extent * 0.45;
      if (Math.abs(x - this.ripple.centre[0]) < half &&
          Math.abs(z - this.ripple.centre[1]) < half) { this.ripple.add(d); return; }
    }
    this.foam.add(d);
  }

  setQuality(name) {
    if (!TIERS[name] || name === this.tierName) return false;
    const weather = this.weather;
    const debug = this.debug;
    const materialState = Object.assign({}, this.material.state);
    const simState = {
      params: Object.assign({}, this.sim.params),
      time: this.sim.time,
      paused: this.sim.paused,
      timeScale: this.sim.timeScale,
      enabled: this.sim.enabled.slice(),
      frozen: !!this.sim.frozen,
    };
    // UnderwaterSystem's post-process is tier-independent. Keep it attached in
    // place so a quality switch cannot reorder the camera's post-process chain.
    const underwater = this.underwater;
    const effectsEnabled = this.effects ? this.effects.enabled : true;
    const sprayEnabled = this.spray.enabled;
    const disturbanceState = [this.foam, this.ripple, this.footprints].map((field) => ({
      enabled: field.enabled,
      subsystemEnabled: field.subsystemEnabled !== false,
    }));
    const causticsStrength = this.caustics.strength;
    const reflectionEnabled = this.reflection.subsystemEnabled !== false;
    const refractionEnabled = this.refraction.subsystemEnabled !== false;
    const focus = this.focus.slice();
    const focusOwner = this._focusOwner;

    // Every object below owns GPU resources tied to the old wave renderer.
    // Tear the complete tier graph down; retaining even one particle field or
    // buoyancy worker here leaves it sampling a disposed simulation.
    this.reflection.dispose();
    this.refraction.dispose();
    this.spray.dispose();
    this.buoyancy.dispose();
    if (this.effects) this.effects.dispose();
    this.foam.dispose();
    this.ripple.dispose();
    this.footprints.dispose();
    this.material.dispose();
    this.lod.dispose();
    this.sim.dispose();

    this.tierName = name;
    this.tier = TIERS[name];
    const t = this.tier;

    this.sim = new WaveSimulation(this.engine, this.scene, t);
    this.sim.build();
    this.sim.setParams(simState.params);
    this.sim.time = simState.time;
    this.sim.paused = simState.paused;
    this.sim.timeScale = simState.timeScale;
    this.sim.enabled = simState.enabled.slice();
    this.sim.frozen = simState.frozen;
    this.sim.updateSlopeVariance();

    this.effects = new OceanEffects(this.engine, this.scene,
      t.breakerQuality !== undefined ? t.breakerQuality : 1).build(this.sim.renderer);
    this.effects.enabled = effectsEnabled;
    this.lod = new OceanLODManager(this.scene, t);
    this.mesh = this.lod.build();
    this.material = new OceanMaterial(this.scene, t);
    this.mesh.material = this.material.build();
    this.mesh.renderingGroupId = 1;
    Object.assign(this.material.state, materialState);
    this.material.state.microDetail = t.microDetail;
    this.material.state.deepDepth = this.shoreline ? this.shoreline.deepDepth : 220;

    this.reflection = new ReflectionSystem(this.scene, this.engine, t);
    this.refraction = new RefractionSystem(this.scene, this.engine, t);
    // Three world-anchored disturbance fields.  A footstep needs centimetre
    // texels and a boat wake needs hundreds of metres of reach; one field
    // cannot serve both, so the ocean shader adds a coarse and a fine one.
    this.foam = new FoamSystem(this.engine, this.scene, {
      size: t.disturb, extent: 420, decay: 0.55, waveSpeed: 3.0, name: "coarseRipple" });
    this.foam.build(this.sim.renderer);
    this.ripple = new FoamSystem(this.engine, this.scene, {
      size: Math.max(256, t.disturb), extent: 26, decay: 0.42, waveSpeed: 1.0,
      name: "fineRipple" });
    this.ripple.build(this.sim.renderer);
    this.footprints = new FoamSystem(this.engine, this.scene, {
      size: 512, extent: 48, decay: 0.055, mode: 1, speed: 0, name: "footprints" });
    this.footprints.build(this.sim.renderer);
    [this.foam, this.ripple, this.footprints].forEach((field, i) => {
      field.enabled = disturbanceState[i].enabled;
      field.setEnabled(disturbanceState[i].subsystemEnabled);
    });
    this.focus = focus;
    this._focusOwner = focusOwner;

    this.buoyancy = new BuoyancySystem(this.sim, this.shoreline, {
      sizes: t.sim[0] >= 128 ? [128, 64] : [64, 32],
    });
    this.buoyancy.build();
    this.underwater = underwater;
    this.underwater.tier = t;
    this.spray = new SpraySystem(this.scene, this.camera, t, this.buoyancy);
    this.spray.build();
    this.spray.enabled = sprayEnabled;
    this.caustics = new CausticsSystem(this.sim);
    this.caustics.strength = causticsStrength;
    this.weather = weather;
    this.weather.ocean = this;
    this.weather._dirty = true;
    this.debug = debug;
    this.debug.ocean = this;
    this.debug.setChannel(this.debug.channel);
    this.debug.setWireframe(this.debug.showWire);
    this.setSceneObjects({ reflect: [], refract: [], surfaceMaterials: [] });
    this.reflection.setEnabled(reflectionEnabled);
    this.refraction.setEnabled(refractionEnabled);
    // resolution belongs to Presentation; a tier switch must not reach past it
    if (window.__present) window.__present.apply();
    else this.engine.setHardwareScalingLevel(t.hardwareScale);
    return true;
  }

  dispose() {
    this.reflection.dispose();
    this.refraction.dispose();
    this.foam.dispose();
    this.ripple.dispose();
    this.footprints.dispose();
    this.spray.dispose();
    this.underwater.dispose();
    this.buoyancy.dispose();
    if (this.effects) this.effects.dispose();
    if (this.seafloor) this.seafloor.dispose();
    this.world = null;
    this.seafloor = null;
    this.material.dispose();
    this.lod.dispose();
    this.sim.dispose();
    if (this.shoreline) this.shoreline.dispose();
  }
}
