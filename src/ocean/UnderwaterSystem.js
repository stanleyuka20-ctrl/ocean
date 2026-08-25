// ---------------------------------------------------------------------------
//  UnderwaterSystem.js -- crossing the surface.
//
//  The transition is driven by the ACTUAL wave height at the camera (from the
//  CPU mirror), not by a flat plane, so ducking under a passing crest works.
//  Attenuation itself lives in the surface and terrain shaders where the real
//  path lengths are known; this owns the screen-space part (shafts, motes,
//  droplets) and the suspended-particle system.
// ---------------------------------------------------------------------------

import { UNDERWATER_FRAG } from "../shaders/scene.js";

const B = () => window.BABYLON;

export class UnderwaterSystem {
  constructor(scene, engine, camera, tier) {
    this.scene = scene;
    this.engine = engine;
    this.camera = camera;
    this.tier = tier;
    this.submerged = false;
    // Independently switchable so each can be measured against the temporal
    // filter on its own -- all three animate in SCREEN space.
    this.godRays = 1;
    this.motesAmount = 1;
    this.causticShimmer = 1;
    this.moteDensity = 1;
    this.bubbleAmount = 1;
    this._moteAcc = 0;
    this.blend = 0;          // 0 above, 1 below
    this.droplets = 0;
    this.camDepth = 0;
    this.seaLevel = 0;
    this.enabled = true;
    this.pp = null;
  }

  build() {
    const BJ = B();
    BJ.Effect.ShadersStore["oceanUnderwaterFragmentShader"] = UNDERWATER_FRAG;
    this.pp = new BJ.PostProcess("oceanUnderwater", "oceanUnderwater",
      ["uSunDir", "uSunColor", "uSunI", "uTurbidity", "uStorm", "uFlash", "uTime",
       "uAbsorb", "uScatterCol", "uScatterAmt", "uTurbid", "uSubmerged", "uDroplets",
       "uCamDepth", "uSunScreen", "uGodRays", "uMotes", "uCausticShimmer",
       "uUwCamPos", "uUwRight", "uUwUp", "uUwFwd", "uUwTanHalf", "uUwAspect",
       "uUwCascadeL", "uSeaLevel"],
      ["textureSampler", "uUwDeriv"],
      1.0, this.camera, BJ.Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
      this.engine, false, null, BJ.Constants.TEXTURETYPE_HALF_FLOAT);

    // Motes now live in OceanEffects as a GpuParticleField: a Babylon
    // GPUParticleSystem does not expose per-particle previous positions, so its
    // motes could never carry a motion vector, and they were the isolated
    // reason underwater TAA went negative.
  }

  /** waterHeight comes from BuoyancySystem so a crest can duck you under. */
  /**
   * Keep a drifting cloud of suspended matter around the camera while it is
   * under.  Emitted into the ocean's own particle field, so every mote has a
   * readable previous position and therefore a real screen-space velocity.
   */
  _emitMotes(dt, ocean) {
    const f = ocean && ocean.effects && ocean.effects.motes;
    if (!f) return;
    // uMotes is the A/B switch: with it at zero no mote may exist at all,
    // otherwise "motes off" would still measure whatever is still drifting.
    const on = this.enabled && this.motesAmount > 0.001 && this.blend > 0.02;
    if (f.mesh) f.mesh.setEnabled(on);
    if (!on) return;
    this._moteAcc = (this._moteAcc || 0) + dt;
    if (this._moteAcc < 0.09) return;
    const step = this._moteAcc; this._moteAcc = 0;
    const c = this.camera.globalPosition;
    const n = Math.round(step * 380 * this.moteDensity * this.motesAmount);
    if (n <= 0) return;
    const y = Math.min(c.y, this.seaLevel - 0.5) - 1.8;
    f.emit({
      position: [c.x, y, c.z],
      radius: 7.0,
      velocity: [0, -0.02, 0], spread: 0.85,
      count: n, size: [0.008, 0.038],
      life: [3.2, 9.0], jitter: 1.0,
    });
  }

  /**
   * Ambient bubbles filling the water around the camera.  Whitecap injection
   * only fires on the steepest crests, so a quiet dive used to have none at
   * all -- which is the empty "god rays in a void" look.  Spawn deep enough
   * that the GPU jitter stays below the surface (life is killed above it).
   */
  _emitBubbles(dt, ocean) {
    const f = ocean && ocean.effects && ocean.effects.bubbles;
    if (!f) return;
    const on = this.enabled && this.blend > 0.08 && this.bubbleAmount > 0.001;
    if (!on) return;
    this._bubAcc = (this._bubAcc || 0) + dt;
    if (this._bubAcc < 0.11) return;
    const step = this._bubAcc; this._bubAcc = 0;
    const c = this.camera.globalPosition;
    const q = this.bubbleAmount * (this.depthFade === undefined ? 1 : this.depthFade);
    const floorY = this.seaLevel - ((ocean.seafloor && ocean.seafloor.enabled) ? ocean.seafloor.depth : 12);
    const BJ = B();
    const fwd = this.camera.getDirection(BJ.Axis.Z);
    const rt = this.camera.getDirection(BJ.Axis.X);
    const y = Math.min(c.y - 1.8, this.seaLevel - 2.6);
    const n = Math.round(step * 10 * q);
    if (n > 0) {
      f.emit({
        position: [c.x, y, c.z],
        radius: 7.5,
        velocity: [0, 0.38, 0], spread: 0.45,
        count: n, size: [0.04, 0.11],
        life: [3.5, 8.0], jitter: 0.4,
      });
    }
    const side = ((this._bubFlip = !(this._bubFlip)) ? 1 : -1) * (1.1 + step * 2.0);
    f.emit({
      position: [
        c.x + fwd.x * 2.8 + rt.x * side,
        Math.min(c.y - 0.4, this.seaLevel - 1.2),
        c.z + fwd.z * 2.8 + rt.z * side,
      ],
      radius: 0.55,
      velocity: [0, 0.24, 0], spread: 0.12,
      count: Math.max(1, Math.round(step * 2.2 * q)),
      size: [0.09, 0.20],
      life: [2.8, 5.8], jitter: 0.15,
    });
    f.emit({
      position: [c.x, floorY + 0.45, c.z],
      radius: 8.0,
      velocity: [0, 0.20, 0], spread: 0.35,
      count: Math.max(1, Math.round(step * 6 * q)),
      size: [0.045, 0.13],
      life: [4.5, 9.5], jitter: 0.32,
    });
  }

  update(dt, waterHeight, sky, water) {
    this.clock = (this.clock || 0) + (dt || 0);
    const cam = this.camera.globalPosition;
    const was = this.submerged;
    const margin = 0.06;
    this.camDepth = waterHeight - cam.y;
    this.submerged = this.camDepth > (was ? -margin : margin);
    this.blend += ((this.submerged ? 1 : 0) - this.blend) * (1 - Math.exp(-dt * 14));

    if (was && !this.submerged) this.droplets = 1;
    this.droplets = Math.max(0, this.droplets - dt * 0.42);

    if (!this.pp) return;
    const needPost = this.enabled && (this.blend > 0.008 || this.droplets > 0.008);
    if (typeof this.pp.enabled === "boolean") this.pp.enabled = needPost;
    else if (this.pp.setEnabled) this.pp.setEnabled(needPost);
    if (!needPost) return;
    const BJ = B();
    const self = this;
    this.pp.onApply = (effect) => {
      effect.setVector3("uSunDir", sky.sunDir);
      effect.setColor3("uSunColor", sky.sunColor);
      effect.setFloat("uSunI", sky.sunI);
      effect.setFloat("uTurbidity", sky.turbidity);
      effect.setFloat("uStorm", sky.storm);
      effect.setFloat("uFlash", sky.flash);
      // SIM clock, not the wall clock.  performance.now() keeps advancing
      // when the simulation is stopped, so a shader driven by it animates in
      // a scene that is supposed to be frozen -- which defeats every
      // frozen-scene measurement.  It put ~10 RMS of drift into the
      // persistence floor and collapsed the whole matrix below it.  At
      // normal playback the two are equivalent; under __lockStep they are
      // not, and only this one is honest.
      effect.setFloat("uTime", self.clock || 0);
      effect.setFloat3("uAbsorb", water.absorb[0], water.absorb[1], water.absorb[2]);
      effect.setFloat3("uScatterCol", water.scatterCol[0], water.scatterCol[1], water.scatterCol[2]);
      effect.setFloat("uScatterAmt", water.scatterAmt);
      effect.setFloat("uTurbid", water.turbid);
      effect.setFloat("uSubmerged", self.enabled ? self.blend : 0);
      effect.setFloat("uDroplets", self.enabled ? self.droplets : 0);
      effect.setFloat("uMotes", self.motesAmount);
      effect.setFloat("uCausticShimmer", self.causticShimmer);
      // camera basis, so the caustics can be sampled in world space
      const c = self.camera;
      const B2 = B();
      effect.setVector3("uUwCamPos", c.globalPosition);
      effect.setVector3("uUwRight", c.getDirection(B2.Axis.X));
      effect.setVector3("uUwUp", c.getDirection(B2.Axis.Y));
      effect.setVector3("uUwFwd", c.getDirection(B2.Axis.Z));
      effect.setFloat("uUwTanHalf", Math.tan((c.fov || 0.9) * 0.5));
      effect.setFloat("uUwAspect", self.engine.getAspectRatio(c));
      if (self.derivTex) effect.setTexture("uUwDeriv", self.derivTex);
      effect.setFloat("uUwCascadeL", self.cascadeL || 127);
      effect.setFloat("uCamDepth", Math.max(0, self.camDepth));
      effect.setFloat("uSeaLevel", self.seaLevel);
      effect.setFloat("uGodRays", self.enabled ? self.godRays : 0);

      // project the sun onto the screen for the shafts
      const m = self.camera.getScene().getTransformMatrix();
      const p = BJ.Vector3.TransformCoordinates(
        self.camera.globalPosition.add(sky.sunDir.scale(1000)), m);
      effect.setFloat2("uSunScreen", p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    };
  }

  dispose() {
    if (this.pp) { this.pp.dispose(); this.pp = null; }
    if (this.motes) { this.motes.dispose(); this.motes = null; }
  }
}
