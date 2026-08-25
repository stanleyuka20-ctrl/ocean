// ---------------------------------------------------------------------------
//  UnderwaterWorld.js -- streamed demonstration sectors under the FFT sea.
// ---------------------------------------------------------------------------

import { TerrainWorld } from "./TerrainWorld.js";
import { Formations } from "./Formations.js";
import { LifeSystem } from "./LifeSystem.js";
import { VentSystem } from "./VentSystem.js";
import { profileAt, UW_PRESETS } from "./DepthProfile.js";
import { UW, bathyY } from "./bathymetry.js";

const B = () => window.BABYLON;

export class UnderwaterWorld {
  constructor(scene, ocean) {
    this.scene = scene;
    this.ocean = ocean;
    this.maxDepth = 4000;
    this.causticCut = 70;
    this.visibility = 1;
    this.shaftQuality = 0.75;
    this.particleMul = 1;
    this.snowMul = 1;
    this.bubbleMul = 1;
    this.coralMul = 1;
    this.fishMul = 1;
    this.bioMul = 0.4;
    this.diveManual = -1;
    this.diveRange = 34;
    this.current = [0.04, 0, 0.01];
    this.presetKey = "tropicalClear";
    this.profile = profileAt(8);
    this.dive = {
      pos: new (B().Vector3)(0, 0, 0),
      dir: new (B().Vector3)(0, -1, 0),
      intensity: 12,
      range: 34,
      sharp: 7.2,
    };
    this.stats = { meshes: 0, instances: 0, particles: 0 };
  }

  build() {
    this.terrain = new TerrainWorld(this.scene, this.ocean).build();
    this.formations = new Formations(this.scene, this.ocean).build();
    this.life = new LifeSystem(this.scene, this.ocean);
    this.life.coralDensity = this.coralMul;
    this.life.fishDensity = this.fishMul;
    this.life.build();
    this.vents = new VentSystem(this.scene, this.ocean).build();
    this._buildBio();
    return this;
  }

  _buildBio() {
    const BJ = B();
    const mat = new BJ.StandardMaterial("uwBioM", this.scene);
    mat.emissiveColor = new BJ.Color3(0.15, 0.85, 0.55);
    mat.disableLighting = true;
    mat.alpha = 0.75;
    this.bioMat = mat;
    this.bio = [];
    this._bioSeed = [];
    this.bioN = 12;
    for (let i = 0; i < this.bioN; i++) {
      const m = BJ.MeshBuilder.CreateSphere("uwBio" + i, { diameter: 0.12, segments: 4 }, this.scene);
      m.material = mat;
      m.renderingGroupId = 2;
      m.isPickable = false;
      m.setEnabled(false);
      this.bio.push(m);
      this._bioSeed.push({
        x: 380 + Math.random() * 180,
        z: -320 + Math.random() * 160,
        y: -800 - Math.random() * 2800,
        p: Math.random() * 6.28,
        mesh: m,
      });
    }
  }

  opaqueMeshes() {
    const list = [];
    if (this.terrain) list.push(...this.terrain.meshes);
    if (this.formations) list.push(...this.formations.meshes);
    if (this.life) {
      const fish = this.life.fish || [];
      for (const m of this.life.meshes) if (fish.indexOf(m) < 0) list.push(m);
    }
    return list;
  }

  materials() {
    const list = [];
    if (this.terrain && this.terrain.material) list.push(this.terrain.material);
    if (this.formations && this.formations.material) list.push(this.formations.material);
    if (this.life && this.life.material) list.push(this.life.material);
    if (this.life && this.life.heroMat) list.push(this.life.heroMat);
    if (this.life && this.life.fishMat) list.push(this.life.fishMat);
    return list;
  }

  sample(x, z) { return this.terrain.sample(x, z); }
  sampleDepth(x, z) { return this.terrain.sampleDepth(x, z); }

  applyPreset(key, instant) {
    const p = UW_PRESETS[key];
    if (!p) return;
    this.presetKey = key;
    this.maxDepth = p.maxDepth;
    this.causticCut = p.causticCut;
    this.particleMul = p.particle;
    this.snowMul = p.snow;
    this.bubbleMul = p.bubbles;
    this.coralMul = p.coral;
    this.fishMul = p.fish;
    this.bioMul = p.bio;
    this.shaftQuality = Math.min(1, p.shafts);
    this.diveRange = 18 + p.dive * 0.25;
    if (this.diveManual < 0) this.dive.intensity = p.dive;
    const o = this.ocean;
    o.clarity = p.clarity;
    o.setWaterType(p.water, instant);
    o._waterTarget = Object.assign({}, o._waterTarget, { turbid: p.turbid, scatterAmt: p.scatterAmt });
    if (instant) {
      o.water.turbid = p.turbid;
      o.water.scatterAmt = p.scatterAmt;
    }
    if (this.life) {
      this.life.coralDensity = p.coral;
      this.life.fishDensity = p.fish;
    }
    if (this.vents) this.vents.intensity = p.bubbles;
  }

  update(dt) {
    const o = this.ocean;
    const cam = o.camera.globalPosition;
    const depth = Math.max(0, o.seaLevel - cam.y);
    this.profile = profileAt(depth);
    const p = this.profile;

    this.dive.pos.copyFrom(cam);
    const fwd = o.camera.getDirection(B().Axis.Z);
    this.dive.dir.copyFrom(fwd);
    this.dive.range = this.diveRange;
    const auto = 16 + p.dive * (1.0 - p.sunReach) * 88;
    this.dive.intensity = this.diveManual >= 0 ? this.diveManual : auto;
    this.dive.range = this.diveRange * (1.35 + p.dive * 1.15);
    this.dive.sharp = 7.2;
    if (o.underwater) {
      o.underwater.moteDensity = Math.max(0.15, this.snowMul * p.snow * this.particleMul);
      o.underwater.depthFade = p.bubbles;
      o.underwater.shaftQuality = this.shaftQuality * p.sunReach;
    }
    if (this.vents) this.vents.intensity = this.bubbleMul * (0.4 + 0.6 * p.bubbles);

    if (this.terrain) this.terrain.update();
    if (this.formations) this.formations.update();
    if (this.life) this.life.update(dt);
    if (this.vents) this.vents.update(dt);
    this._updateBio(dt, p);

    this.stats.meshes = this.opaqueMeshes().filter((m) => m.isEnabled()).length;
  }

  _updateBio(dt, p) {
    if (!this.bio || !this.bio.length) return;
    const on = p.bio * this.bioMul > 0.05 && p.depth > 180;
    const t = (this._bt = (this._bt || 0) + dt);
    for (const s of this._bioSeed) {
      const m = s.mesh;
      if (!m) continue;
      m.setEnabled(on);
      if (!on) continue;
      const pulse = 0.55 + 0.45 * Math.sin(t * 1.7 + s.p);
      const sc = (0.4 + p.bio * this.bioMul) * pulse;
      let y = s.y + Math.sin(t * 0.11 + s.p) * 3;
      const x = s.x + Math.sin(t * 0.07 + s.p) * 4;
      const z = s.z;
      const bed = bathyY(x, z) + 1.2;
      if (y < bed) y = bed;
      m.position.set(x, y, z);
      m.scaling.set(sc, sc, sc);
    }
    if (this.bioMat) this.bioMat.alpha = 0.35 + 0.4 * p.bio * this.bioMul;
  }

  rebind() {
    const o = this.ocean;
    for (const m of this.materials()) o.caustics.register(m);
  }

  dispose() {
    if (this.terrain) this.terrain.dispose();
    if (this.formations) this.formations.dispose();
    if (this.life) this.life.dispose();
    if (this.vents) this.vents.dispose();
    if (this.bio) {
      for (const m of this.bio) m.dispose(false, false);
      this.bio = [];
    }
    if (this.bioMat) { this.bioMat.dispose(); this.bioMat = null; }
  }
}

void UW;
