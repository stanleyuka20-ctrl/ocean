// ---------------------------------------------------------------------------
//  BuoyancySystem.js -- the query surface everything that floats talks to.
//
//      ocean.getSurfaceData(worldPosition) ->
//          { height, normal, velocity, foam, depth }
//
//  Backed by the CPU mirror in a worker (oceanCpu.js).  Falls back to a
//  main-thread tick at a reduced rate if workers are unavailable.
// ---------------------------------------------------------------------------

import { CpuCascade, sampleGrid } from "./oceanCpu.js";

const B = () => window.BABYLON;

export class BuoyancySystem {
  constructor(sim, shoreline, opts = {}) {
    this.sim = sim;
    this.shoreline = shoreline;
    this.seaLevel = 0;
    this.shoreSteepen = 0.85;
    this.rate = opts.rate || 1 / 30;
    this.cpuSizes = opts.sizes || [128, 64];
    this.ready = false;
    this.worker = null;
    this.fallback = null;
    this._acc = 0;
    this._busy = false;
    this._recycle = null;
    this.grids = null;
    this.gridTime = 0;
    this.layout = [];
  }

  build() {
    const cfg = this.sim.spectrumConfig();
    this.layout = this.cpuSizes.map((N, i) => ({
      N, L: cfg.L[i], cutLow: cfg.cuts[i][0], cutHigh: cfg.cuts[i][1], offset: 0,
    }));
    let off = 0;
    for (const l of this.layout) { l.offset = off; off += l.N * l.N * 6; }
    this.total = off;

    try {
      this.worker = new Worker(new URL("./buoyancyWorker.js", import.meta.url), { type: "module" });
      this.worker.onmessage = (ev) => this._onMessage(ev.data);
      this.worker.onerror = () => { this._useFallback(); };
      this.worker.postMessage({ type: "init", cascades: this.layout, params: cfg.params });
    } catch (e) {
      this._useFallback();
    }
  }

  _useFallback() {
    if (this.fallback) return;
    console.warn("[ocean] worker unavailable, running the CPU mirror on the main thread");
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    const cfg = this.sim.spectrumConfig();
    this.fallback = this.layout.map((l) => new CpuCascade(l.N, l.L, l.cutLow, l.cutHigh, cfg.params));
    this.grids = new Float32Array(this.total);
    this.ready = true;
    this.rate = 1 / 15;
  }

  _onMessage(m) {
    if (m.type === "ready") { this.ready = true; this._busy = false; return; }
    if (m.type === "grid") {
      if (this.grids) this._recycle = this.grids;
      this.grids = m.buf;
      this.gridTime = m.time;
      this._busy = false;
    }
  }

  onParamsChanged() {
    const cfg = this.sim.spectrumConfig();
    if (this.worker) this.worker.postMessage({ type: "params", params: cfg.params });
    else if (this.fallback) for (const c of this.fallback) c.setParams(cfg.params);
  }

  update(dt) {
    if (!this.ready) return;
    this._acc += dt;
    if (this._acc < this.rate) return;
    this._acc = 0;
    if (this.fallback) {
      let off = 0;
      for (const c of this.fallback) {
        const out = c.evolve(this.sim.time);
        this.grids.set(out, off);
        off += out.length;
      }
      this.gridTime = this.sim.time;
      return;
    }
    if (this._busy) return;
    this._busy = true;
    const rec = this._recycle;
    this._recycle = null;
    if (rec) this.worker.postMessage({ type: "tick", time: this.sim.time, recycle: rec }, [rec.buffer]);
    else this.worker.postMessage({ type: "tick", time: this.sim.time });
  }

  /**
   * Mirrors the shoaling curve in the ocean vertex shader.  If you change one,
   * change the other -- a hull that swells at a different rate than the water
   * it sits in reads instantly as broken.
   */
  _shoal(depth) {
    const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    return (1 + this.shoreSteepen * (1 - ss(2, 26, depth))) * ss(0.05, 2.2, depth);
  }

  _sumDisp(x, z, out) {
    let dx = 0, dy = 0, dz = 0, vy = 0, sx = 0, sz = 0;
    const g = this.grids;
    for (const l of this.layout) {
      const sub = g.subarray(l.offset, l.offset + l.N * l.N * 6);
      dx += sampleGrid(sub, l.N, l.L, x, z, 0);
      dy += sampleGrid(sub, l.N, l.L, x, z, 1);
      dz += sampleGrid(sub, l.N, l.L, x, z, 2);
      vy += sampleGrid(sub, l.N, l.L, x, z, 3);
      sx += sampleGrid(sub, l.N, l.L, x, z, 4);
      sz += sampleGrid(sub, l.N, l.L, x, z, 5);
    }
    out[0] = dx; out[1] = dy; out[2] = dz; out[3] = vy; out[4] = sx; out[5] = sz;
  }

  /**
   * Sample the water at a world position.
   * Horizontal (choppy) displacement means the surface point above (x,z) did
   * not start at (x,z); three fixed-point iterations invert that.
   */
  getSurfaceData(pos, result) {
    const BJ = B();
    const x = pos.x !== undefined ? pos.x : pos[0];
    const z = pos.z !== undefined ? pos.z : pos[2];
    const r = result || {};
    const depth = this.shoreline ? Math.max(0, this.seaLevel - this.shoreline.sample(x, z)) : 1000;
    if (!this.grids) {
      r.height = this.seaLevel;
      r.normal = r.normal || new BJ.Vector3(0, 1, 0);
      r.normal.set(0, 1, 0);
      r.velocity = r.velocity || new BJ.Vector3(0, 0, 0);
      r.velocity.set(0, 0, 0);
      r.foam = 0; r.depth = depth;
      return r;
    }
    const k = this._shoal(depth);
    const tmp = this._tmp || (this._tmp = new Float64Array(6));
    let px = x, pz = z;
    for (let it = 0; it < 3; it++) {
      this._sumDisp(px, pz, tmp);
      px = x - tmp[0] * k;
      pz = z - tmp[2] * k;
    }
    this._sumDisp(px, pz, tmp);
    const sx = tmp[4] * k, sz = tmp[5] * k;
    const inv = 1 / Math.hypot(sx, 1, sz);

    r.height = this.seaLevel + tmp[1] * k;
    r.normal = r.normal || new BJ.Vector3();
    r.normal.set(-sx * inv, inv, -sz * inv);
    r.velocity = r.velocity || new BJ.Vector3();
    r.velocity.set(0, tmp[3] * k, 0);
    // steepness is a decent proxy for where the GPU Jacobian is folding
    r.foam = Math.min(1, Math.max(0, Math.hypot(sx, sz) * 0.85 - 0.45));
    r.depth = depth;
    return r;
  }

  /** Convenience: just the height. */
  getHeight(x, z) {
    return this.getSurfaceData({ x, z }, this._scratch || (this._scratch = {})).height;
  }

  dispose() {
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    this.fallback = null;
    this.grids = null;
  }
}
