// ---------------------------------------------------------------------------
//  WaveSimulation.js -- the spectral ocean.
//
//  Three cascades, each: JONSWAP + swell spectrum -> h0(k) (once per wind
//  change) -> time evolution -> 2D inverse FFT -> displacement + derivative +
//  foam textures.  All fragment passes, so the same GLSL runs on WebGL2 and
//  (transpiled) on WebGPU.
// ---------------------------------------------------------------------------

import { H0_FRAG, SPECTRUM_FRAG, FFT_FRAG, DISPLACE_FRAG, DERIV_FRAG } from "../shaders/oceanSim.js";
import { CASCADE_L, cascadeCutoffs } from "../core/quality.js";

const B = () => window.BABYLON;

// --- butterfly (index + twiddle) table -------------------------------------
function bitRev(i, bits) {
  let r = 0;
  for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
  return r;
}
export function buildButterflyData(N) {
  const stages = Math.round(Math.log2(N));
  const data = new Float32Array(stages * N * 4);
  for (let s = 0; s < stages; s++) {
    const span = 1 << s;
    for (let y = 0; y < N; y++) {
      const k = (y * (N >> (s + 1))) % N;
      let re = Math.cos((2 * Math.PI * k) / N);
      let im = Math.sin((2 * Math.PI * k) / N);   // + sign -> inverse transform
      const wing = y % (span * 2) < span;
      let top, bot;
      if (s === 0) {
        // stage 0 reads through the bit reversal, so no separate permute pass
        top = bitRev(wing ? y : y - 1, stages);
        bot = bitRev(wing ? y + 1 : y, stages);
      } else {
        top = wing ? y : y - span;
        bot = wing ? y + span : y;
      }
      // NOTE: no sign flip for the upper wing.  k = y*N/m already carries the
      // extra N/2 that makes exp(2*pi*i*k/N) negative there, so negating again
      // gives u + t where the transform needs u - t.  The total energy survives
      // that (Parseval), which is why it does not look like a broken FFT: the
      // sea keeps the right height and turns into white noise.  Guarded by
      // tests/fft_test.mjs.
      const o = (y * stages + s) * 4;
      data[o] = re; data[o + 1] = im; data[o + 2] = top; data[o + 3] = bot;
    }
  }
  return { data, stages };
}

// --- a fullscreen pass ------------------------------------------------------
class Pass {
  constructor(engine, name, frag, uniforms, samplers) {
    const BJ = B();
    this.ew = new BJ.EffectWrapper({
      engine, name,
      fragmentShader: frag,
      uniformNames: uniforms,
      samplerNames: samplers,
    });
    this._bind = null;
    this.ew.onApplyObservable.add(() => { if (this._bind) this._bind(this.ew.effect); });
  }
  ready() { return this.ew.isReady(); }
  run(renderer, target, bind) {
    if (!this.ew.isReady()) return false;
    this._bind = bind;
    renderer.render(this.ew, target);
    return true;
  }
  dispose() { this.ew.dispose(); }
}

export class WaveSimulation {
  constructor(engine, scene, tier) {
    this.engine = engine;
    this.scene = scene;
    this.tier = tier;
    this.time = 0;
    this.paused = false;
    this.timeScale = 1;

    this.sizes = tier.sim.slice();
    this.L = CASCADE_L.slice();
    this.cuts = cascadeCutoffs(this.sizes);
    this.enabled = [1, 1, 1];

    this.params = {
      windSpeed: 8.5,
      windDirDeg: 35,
      fetch: 180000,
      depth: 1000,
      spread: 1.0,
      swell: 0.45,
      swellPeriod: 12.5,
      swellDirDeg: 10,
      amplitude: 1.0,
      choppy: 1.15,
      waveScale: 1.0,
      seed: 7,
      foamThreshold: 0.62,
      foamInject: 1.5,
      foamDecay: 0.42,
    };

    this._needH0 = true;
    this._built = false;
    this.slopeVariance = [0.02, 0.06, 0.12];
  }

  // -------------------------------------------------------------------------
  build() {
    const BJ = B();
    const eng = this.engine;
    const caps = eng.getCaps();
    this.floatRT = !!(caps.textureFloatRender || caps.colorBufferFloat) || !!eng.isWebGPU;
    const F32 = BJ.Constants.TEXTURETYPE_FLOAT;
    const F16 = BJ.Constants.TEXTURETYPE_HALF_FLOAT;
    this.specType = this.floatRT ? F32 : F16;

    this.renderer = new BJ.EffectRenderer(eng);

    this.passes = {
      h0: new Pass(eng, "oceanH0", H0_FRAG,
        ["uN", "uL", "uWindSpeed", "uFetch", "uDepth", "uSpread", "uSwell", "uSwellPeriod",
          "uSeed", "uCutLow", "uCutHigh", "uAmp", "uWindDir", "uSwellDir"], []),
      spec: new Pass(eng, "oceanSpec", SPECTRUM_FRAG,
        ["uN", "uL", "uTime", "uDepth", "uChop", "uTarget"], ["uH0"]),
      fft: new Pass(eng, "oceanFFT", FFT_FRAG,
        ["uN", "uStages", "uStage", "uVertical"], ["uButterfly", "uSrc"]),
      disp: new Pass(eng, "oceanDisp", DISPLACE_FRAG,
        ["uN", "uChop", "uHeightScale"], ["uFFT0"]),
      deriv: new Pass(eng, "oceanDeriv", DERIV_FRAG,
        ["uN", "uChop", "uHeightScale", "uDt", "uFoamThreshold", "uFoamInject", "uFoamDecay"],
        ["uFFT0", "uFFT1", "uPrev"]),
    };

    this.cascades = [];
    for (let c = 0; c < 3; c++) {
      const N = this.sizes[c];
      const bf = buildButterflyData(N);
      const butterfly = new BJ.RawTexture(
        bf.data, bf.stages, N, BJ.Constants.TEXTUREFORMAT_RGBA, this.scene,
        false, false, BJ.Constants.TEXTURE_NEAREST_SAMPLINGMODE, F32);
      butterfly.wrapU = butterfly.wrapV = BJ.Constants.TEXTURE_CLAMP_ADDRESSMODE;

      const mk = (name, type, mips) => {
        const t = new BJ.RenderTargetTexture(name, { width: N, height: N }, this.scene, {
          generateDepthBuffer: false,
          generateStencilBuffer: false,
          generateMipMaps: !!mips,
          type,
          format: BJ.Constants.TEXTUREFORMAT_RGBA,
          samplingMode: mips
            ? BJ.Constants.TEXTURE_TRILINEAR_SAMPLINGMODE
            : BJ.Constants.TEXTURE_NEAREST_SAMPLINGMODE,
        });
        t.wrapU = t.wrapV = BJ.Constants.TEXTURE_WRAP_ADDRESSMODE;
        t.anisotropicFilteringLevel = mips ? 8 : 1;
        return t;
      };

      this.cascades.push({
        N, L: this.L[c], texel: this.L[c] / N,
        stages: bf.stages,
        butterfly,
        h0: mk(`h0_${c}`, this.specType, false),
        spec: [mk(`sp0_${c}`, this.specType, false), mk(`sp1_${c}`, this.specType, false)],
        pp: [mk(`pp0_${c}`, this.specType, false), mk(`pp1_${c}`, this.specType, false)],
        // Ping-ponged so the PREVIOUS frame's displacement survives.  That is
        // what makes an exact motion vector possible for the water: the same
        // texel of the same cascade, one frame apart, is the true displacement
        // of that piece of surface, horizontal choppiness included.  Deriving
        // it from a single velocity number instead would smear every crest.
        disp: [mk(`disp0_${c}`, F16, true), mk(`disp1_${c}`, F16, true)],
        dispIdx: 0,
        deriv: [mk(`dr0_${c}`, F16, true), mk(`dr1_${c}`, F16, true)],
        derivIdx: 0,
      });
    }
    this._built = true;
    this._needH0 = true;
    this.updateSlopeVariance();
  }

  // -------------------------------------------------------------------------
  get displacement() { return this.cascades.map((c) => c.disp[c.dispIdx]); }
  /** last frame's displacement, for motion vectors */
  get displacementPrev() { return this.cascades.map((c) => c.disp[1 - c.dispIdx]); }
  get derivatives() { return this.cascades.map((c) => c.deriv[c.derivIdx]); }
  get patchSizes() { return this.cascades.map((c) => c.L); }
  get texelSizes() { return this.cascades.map((c) => c.texel); }

  setParams(p) {
    let dirty = false;
    for (const k in p) {
      if (this.params[k] !== p[k]) {
        if (["windSpeed", "windDirDeg", "fetch", "depth", "spread", "swell",
             "swellPeriod", "swellDirDeg", "amplitude", "seed"].indexOf(k) >= 0) dirty = true;
        this.params[k] = p[k];
      }
    }
    if (dirty) { this._needH0 = true; this.updateSlopeVariance(); }
  }

  /**
   * Mean-square surface slope from Cox & Munk (1954): mss = 0.003 + 0.00512*U.
   * Split across the cascades by band so the fragment shader can convert the
   * slope variance of any cascade it cannot resolve into GGX roughness.
   */
  updateSlopeVariance() {
    const u = Math.max(this.params.windSpeed, 0.5);
    const mss = (0.003 + 0.00512 * u) * this.params.waveScale * this.params.waveScale;
    const w = [0.06, 0.26, 0.68];
    this.slopeVariance = w.map((x, i) => mss * x * (this.enabled[i] ? 1 : 0));
  }

  windVector() {
    const a = (this.params.windDirDeg * Math.PI) / 180;
    return [Math.cos(a), Math.sin(a)];
  }
  swellVector() {
    const a = (this.params.swellDirDeg * Math.PI) / 180;
    return [Math.cos(a), Math.sin(a)];
  }

  // -------------------------------------------------------------------------
  _renderH0() {
    const p = this.params;
    const wd = this.windVector(), sd = this.swellVector();
    let all = true;
    for (let c = 0; c < 3; c++) {
      const cs = this.cascades[c];
      const ok = this.passes.h0.run(this.renderer, cs.h0, (e) => {
        e.setFloat("uN", cs.N);
        e.setFloat("uL", cs.L);
        e.setFloat("uWindSpeed", p.windSpeed);
        e.setFloat("uFetch", p.fetch);
        e.setFloat("uDepth", p.depth);
        e.setFloat("uSpread", p.spread);
        e.setFloat("uSwell", p.swell);
        e.setFloat("uSwellPeriod", p.swellPeriod);
        e.setFloat("uSeed", p.seed + c * 13.7);
        e.setFloat("uCutLow", this.cuts[c][0]);
        e.setFloat("uCutHigh", this.cuts[c][1]);
        e.setFloat("uAmp", p.amplitude);
        e.setFloat2("uWindDir", wd[0], wd[1]);
        e.setFloat2("uSwellDir", sd[0], sd[1]);
      });
      if (!ok) all = false;
    }
    return all;
  }

  _fft(cs, which) {
    // ping-pong: spec -> pp -> spec ...
    let src = cs.spec[which], dst = cs.pp[which];
    for (let dir = 0; dir < 2; dir++) {
      for (let s = 0; s < cs.stages; s++) {
        const S = src, D = dst;
        this.passes.fft.run(this.renderer, D, (e) => {
          e.setFloat("uN", cs.N);
          e.setFloat("uStages", cs.stages);
          e.setFloat("uStage", s);
          e.setFloat("uVertical", dir);
          e.setTexture("uButterfly", cs.butterfly);
          e.setTexture("uSrc", S);
        });
        const t = src; src = dst; dst = t;
      }
    }
    return src; // final result lives here
  }

  /**
   * Freeze the spectral pipeline.  Read by update() itself, so the textures
   * already produced stay bound and keep rendering -- the ocean does NOT
   * disappear.  The point is to move the camera across an identical wave field.
   *
   * The counters exist so a probe can prove the pipeline stopped: a bisection
   * row that merely sets a flag nobody reads produced seven identical rows
   * once and was mistaken for a diffuse cause.
   */
  setFrozen(v) { this.frozen = !!v; return this.frozen; }
  setEnabled(v) { return !this.setFrozen(!v); }
  simStats() {
    return {
      enabled: !this.frozen,
      updates: this.fftUpdateCount || 0,
      cascades: (this.cascades || []).map((c) => c.updateCount || 0),
      dispIdx: (this.cascades || []).map((c) => c.dispIdx),
      derivIdx: (this.cascades || []).map((c) => c.derivIdx),
    };
  }

  update(dt) {
    if (this.frozen) return;
    this.fftUpdateCount = (this.fftUpdateCount || 0) + 1;
    if (!this._built) return;
    if (!this.paused) this.time += dt * this.timeScale;
    const p = this.params;

    if (this._needH0) {
      if (this._renderH0()) this._needH0 = false;
      else return;                        // shaders still compiling
    }
    if (!this.passes.spec.ready() || !this.passes.fft.ready() ||
        !this.passes.disp.ready() || !this.passes.deriv.ready()) return;

    for (let c = 0; c < 3; c++) {
      if (!this.enabled[c]) continue;
      const cs = this.cascades[c];
      for (let t = 0; t < 2; t++) {
        this.passes.spec.run(this.renderer, cs.spec[t], (e) => {
          e.setFloat("uN", cs.N);
          e.setFloat("uL", cs.L);
          e.setFloat("uTime", this.time);
          e.setFloat("uDepth", p.depth);
          e.setFloat("uChop", p.choppy);
          e.setFloat("uTarget", t);
          e.setTexture("uH0", cs.h0);
        });
      }
      cs.updateCount = (cs.updateCount || 0) + 1;
      const f0 = this._fft(cs, 0);
      const f1 = this._fft(cs, 1);

      this.passes.disp.run(this.renderer, cs.disp[1 - cs.dispIdx], (e) => {
        e.setFloat("uN", cs.N);
        e.setFloat("uChop", p.choppy);
        e.setFloat("uHeightScale", p.waveScale);
        e.setTexture("uFFT0", f0);
      });

      const prev = cs.deriv[cs.derivIdx];
      const next = cs.deriv[1 - cs.derivIdx];
      this.passes.deriv.run(this.renderer, next, (e) => {
        e.setFloat("uN", cs.N);
        e.setFloat("uChop", p.choppy);
        e.setFloat("uHeightScale", p.waveScale);
        e.setFloat("uDt", Math.min(dt, 0.05));
        e.setFloat("uFoamThreshold", p.foamThreshold);
        e.setFloat("uFoamInject", p.foamInject);
        e.setFloat("uFoamDecay", p.foamDecay);
        e.setTexture("uFFT0", f0);
        e.setTexture("uFFT1", f1);
        e.setTexture("uPrev", prev);
      });
      cs.dispIdx = 1 - cs.dispIdx;
      cs.derivIdx = 1 - cs.derivIdx;
    }
  }

  /** Everything the CPU mirror (buoyancy worker) needs to reproduce the sea. */
  spectrumConfig() {
    return {
      L: this.L.slice(),
      cuts: this.cuts.map((c) => c.slice()),
      params: JSON.parse(JSON.stringify(this.params)),
    };
  }

  dispose() {
    if (!this._built) return;
    for (const c of this.cascades) {
      c.butterfly.dispose();
      c.h0.dispose();
      c.spec.forEach((t) => t.dispose());
      c.pp.forEach((t) => t.dispose());
      c.disp.forEach((t) => t.dispose());
      c.deriv.forEach((t) => t.dispose());
    }
    for (const k in this.passes) this.passes[k].dispose();
    this.renderer.dispose();
    this.cascades = [];
    this._built = false;
  }
}
