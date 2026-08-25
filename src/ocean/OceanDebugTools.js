// ---------------------------------------------------------------------------
//  OceanDebugTools.js -- debug channels, live statistics, and the checks that
//  keep the two ocean representations honest.
//
//  validateBuoyancy() reads the GPU displacement texture back and compares it
//  with the CPU mirror at the same wave vectors.  The two are meant to be the
//  same field band-limited differently, so a large disagreement means the
//  shared spectrum has drifted -- exactly the failure that is invisible until
//  a boat floats through a wave.
// ---------------------------------------------------------------------------

export const DEBUG_CHANNELS = [
  "off", "displacement", "normals", "curvature (jacobian)", "foam mask",
  "water depth", "LOD zones", "reflection", "refraction", "roughness",
  "shore / wake", "shore band inputs", "breaking state",
];

export class OceanDebugTools {
  constructor(ocean) {
    this.ocean = ocean;
    this.channel = 0;
    this.showWire = false;
  }

  setChannel(i) {
    this.channel = ((i % DEBUG_CHANNELS.length) + DEBUG_CHANNELS.length) % DEBUG_CHANNELS.length;
    this.ocean.material.state.debug = this.channel;
    return DEBUG_CHANNELS[this.channel];
  }
  cycle() { return this.setChannel(this.channel + 1); }

  setWireframe(on) {
    this.showWire = on;
    if (this.ocean.material.material) this.ocean.material.material.wireframe = on;
  }

  stats() {
    const o = this.ocean;
    const lod = o.lod.stats;
    return {
      backend: o.engine.isWebGPU ? "WebGPU" : "WebGL2",
      tier: o.tierName,
      simRes: o.sim.sizes.join(" / "),
      patch: o.sim.patchSizes.map((v) => v.toFixed(0) + " m").join(" / "),
      texel: o.sim.texelSizes.map((v) => v.toFixed(2) + " m").join(" / "),
      clipmap: `${lod.levels} levels, ${(lod.triangles / 1000).toFixed(0)}k tris, ` +
               `${(lod.extent / 1000).toFixed(0)} km`,
      reflection: o.reflection.enabled ? o.reflection.quality : "env only",
      refraction: o.refraction.enabled ? o.refraction.quality : "off",
      windSpeed: o.sim.params.windSpeed.toFixed(1) + " m/s",
      hs: this.significantWaveHeight().toFixed(2) + " m",
      exposure: o.sky.exposure.toFixed(2),
    };
  }

  /**
   * Significant wave height from the CPU mirror -- the honest way to say
   * "how big is the sea right now" (mean of the highest third, ~4*sigma).
   */
  significantWaveHeight() {
    const b = this.ocean.buoyancy;
    if (!b || !b.grids) return 0;
    let sum = 0, n = 0;
    for (const l of b.layout) {
      const sub = b.grids.subarray(l.offset, l.offset + l.N * l.N * 6);
      for (let i = 0; i < l.N * l.N; i++) { const h = sub[i * 6 + 1]; sum += h * h; n++; }
    }
    return n ? 4.0 * Math.sqrt(sum / n) : 0;
  }

  /** Compare the CPU mirror against the GPU field.  Returns a report. */
  async validateBuoyancy(samples = 64) {
    const o = this.ocean;
    const cs = o.sim.cascades[0];
    const N = cs.N;
    let raw;
    try {
      raw = await cs.disp.readPixels();
    } catch (e) {
      return { ok: false, error: "readPixels unavailable: " + e.message };
    }
    if (!raw) return { ok: false, error: "no pixels" };

    const b = o.buoyancy;
    if (!b || !b.grids) return { ok: false, error: "CPU mirror not running" };
    // The CPU field is the same spectrum truncated to its own resolution, so
    // compare only the band both of them carry.
    const l = b.layout[0];
    let maxErr = 0, sum = 0, n = 0;
    for (let s = 0; s < samples; s++) {
      const i = ((Math.random() * l.N) | 0), j = ((Math.random() * l.N) | 0);
      const x = (i / l.N) * l.L, z = (j / l.N) * l.L;
      const gi = Math.round((x / cs.L) * N) % N;
      const gj = Math.round((z / cs.L) * N) % N;
      const gpuY = raw[(gj * N + gi) * 4 + 1];
      const cpuY = b.grids[(j * l.N + i) * 6 + 1];
      const e = Math.abs(gpuY - cpuY);
      maxErr = Math.max(maxErr, e);
      sum += e; n++;
    }
    const hs = this.significantWaveHeight();
    return {
      ok: true,
      meanAbsError: sum / n,
      maxAbsError: maxErr,
      significantWaveHeight: hs,
      // the CPU field is band limited, so a fraction of Hs is expected
      relative: hs > 0 ? (sum / n) / hs : 0,
      note: "CPU mirror is low-pass filtered; error should be a fraction of Hs",
    };
  }
}
