// ---------------------------------------------------------------------------
//  FoamSystem.js -- world-anchored disturbance fields.
//
//  One class, three instances:
//    coarse ripples  420 m / 512 px  follows the camera  (boat wakes, rain)
//    fine ripples     26 m / 512 px  follows the player  (footsteps, strokes)
//    footprints       48 m / 512 px  follows the player  (stamps only, on land)
//
//  Wave-crest foam is NOT here -- that comes out of the simulation Jacobian
//  (see WaveSimulation / DERIV_FRAG).  These buffers carry only what the world
//  puts INTO the water, resampled in world space every frame so a ripple stays
//  where it was made while the camera moves.
//
//  A footstep needs centimetre-scale detail and a boat wake needs hundreds of
//  metres of reach; one field cannot do both, which is why the fine field
//  exists and why the ocean shader adds the two.
// ---------------------------------------------------------------------------

import { DISTURB_FRAG } from "../shaders/oceanSim.js";

const B = () => window.BABYLON;
const MAX_INJECT = 16;

export class FoamSystem {
  constructor(engine, scene, opts = {}) {
    this.engine = engine;
    this.scene = scene;
    this.size = opts.size || 512;
    this.extent = opts.extent || 420;   // metres covered
    this.mode = opts.mode || 0;         // 0 propagating ripples, 1 stamps only
    // c^2 / dx^2, so it must be derived from this field's texel size
    const dx = (opts.extent || 420) / (opts.size || 512);
    this.speed = opts.speed !== undefined ? opts.speed
      : ((opts.waveSpeed || 2.5) / dx) * ((opts.waveSpeed || 2.5) / dx);
    this.decay = opts.decay === undefined ? 0.55 : opts.decay;
    this.name = opts.name || "disturb";
    this.centre = [0, 0];
    this.prevCentre = [0, 0];
    this.queue = [];
    this.enabled = true;
    this._built = false;
  }

  build(renderer) {
    const BJ = B();
    this.renderer = renderer;
    const mk = (n) => {
      const t = new BJ.RenderTargetTexture(n, { width: this.size, height: this.size }, this.scene, {
        generateDepthBuffer: false, generateMipMaps: false,
        type: BJ.Constants.TEXTURETYPE_HALF_FLOAT,
        format: BJ.Constants.TEXTUREFORMAT_RGBA,
        samplingMode: BJ.Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
      });
      t.wrapU = t.wrapV = BJ.Constants.TEXTURE_CLAMP_ADDRESSMODE;
      return t;
    };
    this.rt = [mk(this.name + "A"), mk(this.name + "B")];
    this.idx = 0;
    this._inject = new Float32Array(MAX_INJECT * 2 * 4);
    this.injectTex = new BJ.RawTexture(this._inject, MAX_INJECT, 2,
      BJ.Constants.TEXTUREFORMAT_RGBA, this.scene, false, false,
      BJ.Constants.TEXTURE_NEAREST_SAMPLINGMODE, BJ.Constants.TEXTURETYPE_FLOAT);
    this.injectTex.wrapU = this.injectTex.wrapV = BJ.Constants.TEXTURE_CLAMP_ADDRESSMODE;

    this.ew = new BJ.EffectWrapper({
      engine: this.engine, name: "oceanDisturb",
      fragmentShader: DISTURB_FRAG,
      uniformNames: ["uDt", "uSize", "uDecay", "uInjectCount", "uRes", "uMode",
        "uSpeed", "uCentre", "uPrevCentre", "uDrift"],
      samplerNames: ["uPrev", "uInjectTex"],
    });
    this._bind = null;
    this.ew.onApplyObservable.add(() => { if (this._bind) this._bind(this.ew.effect); });
    this._built = true;
  }

  get texture() { return this._built ? this.rt[this.idx] : null; }

  /**
   * Empty the field.
   *
   * Foam is INTEGRATED state, not a function of the wave phase, so anchoring
   * sim.time does not anchor it: it keeps filling for about a minute of rough
   * seas and every measurement taken while it does is on a different scene.
   * Harnesses clear it and then run a fixed number of frames, which makes it a
   * deterministic function of the frame count instead of of wall-clock luck.
   */
  clear() {
    if (!this._built) return;
    const BJ = window.BABYLON;
    const black = new BJ.Color4(0, 0, 0, 0);
    for (const t of this.rt) {
      this.engine.bindFramebuffer(t.renderTarget || t._renderTarget);
      this.engine.clear(black, true, false, false);
      this.engine.unBindFramebuffer(t.renderTarget || t._renderTarget);
    }
  }
  /** vec4 for the shader: (centreX, centreZ, extent, enabled) */
  get rect() { return [this.centre[0], this.centre[1], this.extent, this.enabled && this._built ? 1 : 0]; }

  /**
   * Public interaction API.
   *   ocean.addDisturbance({ position, radius, strength, velocity, lift, type })
   * position: Vector3 or [x,y,z]; velocity elongates the ripple along the
   * motion; lift displaces the surface (>0 bulge, <0 trough).
   */
  add(d) {
    if (!this.enabled) return;
    const p = d.position;
    const v = d.velocity;
    const x = p.x !== undefined ? p.x : p[0];
    const z = p.z !== undefined ? p.z : p[2];
    let vx = 0, vz = 0;
    if (v) { vx = v.x !== undefined ? v.x : v[0]; vz = v.z !== undefined ? v.z : v[2]; }
    const lift = d.lift === undefined ? (d.strength === undefined ? 0.3 : d.strength * 0.30) : d.lift;
    this.queue.push([x, z, Math.max(d.radius || 2, 0.08),
      d.strength === undefined ? 1 : d.strength, vx, vz, lift]);
    if (this.queue.length > 96) this.queue.splice(0, this.queue.length - 96);
  }

  /** @param follow [x,z] world point the field is centred on */
  update(dt, follow, drift) {
    if (this.subsystemEnabled === false) return;
    this.updateCount = (this.updateCount || 0) + 1;
    if (!this._built || !this.enabled || !this.ew.isReady()) { this.queue.length = 0; return; }
    this.prevCentre = this.centre.slice();
    // snap so the resample does not jitter sub-texel every frame
    const t = this.extent / this.size;
    this.centre = [Math.round(follow[0] / t) * t, Math.round(follow[1] / t) * t];

    const inj = this._inject;
    inj.fill(0);
    const n = Math.min(this.queue.length, MAX_INJECT);
    const row = MAX_INJECT * 4;
    for (let i = 0; i < n; i++) {
      const q = this.queue[i], o = i * 4;
      inj[o] = q[0]; inj[o + 1] = q[1]; inj[o + 2] = q[2]; inj[o + 3] = q[3];
      inj[row + o] = q[4]; inj[row + o + 1] = q[5]; inj[row + o + 2] = q[6];
    }
    this.queue.splice(0, n);
    this.injectTex.update(inj);

    const src = this.rt[this.idx];
    const dst = this.rt[1 - this.idx];
    this._bind = (e) => {
      e.setFloat("uDt", Math.min(dt, 0.05));
      e.setFloat("uSize", this.extent);
      e.setFloat("uDecay", this.decay);
      e.setFloat("uInjectCount", n);
      e.setFloat("uRes", this.size);
      e.setFloat("uMode", this.mode);
      e.setFloat("uSpeed", this.speed);
      e.setFloat2("uCentre", this.centre[0], this.centre[1]);
      e.setFloat2("uPrevCentre", this.prevCentre[0], this.prevCentre[1]);
      e.setFloat2("uDrift", drift ? drift[0] : 0, drift ? drift[1] : 0);
      e.setTexture("uInjectTex", this.injectTex);
      e.setTexture("uPrev", src);
    };
    this.renderer.render(this.ew, dst);
    this.idx = 1 - this.idx;
  }

  dispose() {
    if (!this._built) return;
    this.rt.forEach((t) => t.dispose());
    if (this.injectTex) this.injectTex.dispose();
    this.ew.dispose();
    this._built = false;
  }
  /**
   * Real disable hook.  The update path READS this flag and the counter proves
   * it stopped -- a bisection that merely sets a property nobody reads produces
   * rows identical to the baseline and looks like a diffuse cause, which is
   * exactly what happened here once already.
   */
  setEnabled(v) { this.subsystemEnabled = !!v; return this.subsystemEnabled; }
  subsystemStats() {
    return { enabled: this.subsystemEnabled !== false,
             updates: this.updateCount || 0 };
  }

}
