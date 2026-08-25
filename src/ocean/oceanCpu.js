// ---------------------------------------------------------------------------
//  oceanCpu.js -- a small CPU mirror of the spectral ocean, used off the main
//  thread for buoyancy, floating objects and spray emission.
//
//  It is NOT an approximation of the look: it evaluates the same JONSWAP
//  spectrum at the same wave vectors with the same integer-hashed random
//  amplitudes as the GPU (see gaussFromIndex in oceanSim.js).  At 128^2 for a
//  513 m patch it therefore reproduces the GPU field low-pass filtered to
//  wavelengths above ~8 m, which is exactly the part a hull responds to.
//
//  Reading the GPU textures back instead would stall the pipeline every frame;
//  a separate "gameplay wave function" would drift from the drawn surface.
// ---------------------------------------------------------------------------

const G = 9.80665;
const TAU = Math.PI * 2;

// --- 32-bit integer hash, bit-identical to the GLSL version ----------------
function pcgHash(v) {
  let x = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const sh = ((x >>> 28) + 4) >>> 0;
  let s = Math.imul(((x >>> sh) ^ x) >>> 0, 277803737) >>> 0;
  return ((s >>> 22) ^ s) >>> 0;
}
function keyHash(nx, ny, seed, salt) {
  const a = (nx + 8192) >>> 0;
  const b = (ny + 8192) >>> 0;
  const v = (Math.imul(a, 1103515245) + Math.imul(b, 12345) +
             Math.imul(seed, 2654435761 | 0) + salt) >>> 0;
  return pcgHash(v);
}
const u2f = (u) => (u & 0x00ffffff) / 16777216;

export function gaussFromIndex(nx, ny, seed) {
  const u1 = Math.max(1e-7, u2f(keyHash(nx, ny, seed, 0)));
  const u2 = u2f(keyHash(nx, ny, seed, 5741));
  const r = Math.sqrt(-2 * Math.log(u1));
  const a = TAU * u2;
  return [r * Math.cos(a), r * Math.sin(a)];
}

// --- spectrum (mirror of ampAt in oceanSim.js) -----------------------------
function jonswap(w, wp, alpha) {
  if (w < 1e-4) return 0;
  const sigma = w <= wp ? 0.07 : 0.09;
  const rr = Math.exp((-(w - wp) * (w - wp)) / (2 * sigma * sigma * wp * wp));
  return ((alpha * G * G) / Math.pow(w, 5)) * Math.exp(-1.25 * Math.pow(wp / w, 4)) *
         Math.pow(3.3, rr);
}
function spreadD(w, wp, theta, u, spread) {
  const r = w / Math.max(wp, 1e-3);
  let s = r < 1 ? 6.97 * Math.pow(r, 4.06)
    : 9.77 * Math.pow(r, -2.33 - 1.45 * Math.min(3, Math.max(-0.8, (u * wp) / G - 1.17)));
  s = Math.max(s * spread, 0.4);
  const q = Math.sqrt(s) * 0.28209 * (1 + 0.375 / s);
  return q * Math.pow(Math.max(Math.abs(Math.cos(theta * 0.5)), 1e-4), 2 * s);
}

export function ampAt(kx, ky, cfg) {
  const p = cfg.params;
  const kl = Math.hypot(kx, ky);
  if (kl < 1e-6 || kl < cfg.cutLow || kl >= cfg.cutHigh) return 0;
  const dk = TAU / cfg.L;
  const kd = kl * Math.min(p.depth, 4000);
  const th = Math.tanh(Math.min(kd, 20));
  const w = Math.sqrt(G * kl * th);
  const sech2 = 1 - th * th;
  const dwdk = (G * (th + kd * sech2)) / Math.max(2 * w, 1e-4);

  const U = Math.max(p.windSpeed, 0.6);
  const F = Math.max(p.fetch, 1000);
  const wp = 22 * Math.pow((G * G) / (U * F), 1 / 3);
  const alpha = 0.076 * Math.pow((U * U) / (F * G), 0.22);

  const wdir = (p.windDirDeg * Math.PI) / 180;
  const theta = Math.atan2(ky, kx) - wdir;
  let S = jonswap(w, wp, alpha) * spreadD(w, wp, theta, U, p.spread);

  if (p.swell > 0.01) {
    const wps = TAU / Math.max(p.swellPeriod, 3);
    const sdir = (p.swellDirDeg * Math.PI) / 180;
    const ts = Math.atan2(ky, kx) - sdir;
    const ss = 26;
    const qs = Math.sqrt(ss) * 0.28209 * (1 + 0.375 / ss);
    const Ds = qs * Math.pow(Math.max(Math.abs(Math.cos(ts * 0.5)), 1e-4), 2 * ss);
    const sig = 0.085 * wps;
    const m0s = (p.swell * 0.25) * (p.swell * 0.25);
    const A = m0s / (sig * 1.7724539);
    S += A * Math.exp(-Math.pow((w - wps) / sig, 2)) * Ds;
  }

  let Sk = (S * dwdk) / Math.max(kl, 1e-5);
  Sk *= Math.exp(-kl * kl * 0.0004);
  return Math.sqrt(Math.max(2 * Sk, 0)) * dk * p.amplitude * 0.35355339;
}

// --- radix-2 FFT ------------------------------------------------------------
function makeTwiddles(N) {
  const c = new Float64Array(N), s = new Float64Array(N);
  for (let i = 0; i < N; i++) { c[i] = Math.cos((TAU * i) / N); s[i] = Math.sin((TAU * i) / N); }
  return { c, s };
}
function fft1(re, im, off, stride, N, tw) {
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = off + i * stride, b = off + j * stride;
      let t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1, step = N / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = tw.c[k * step], wi = tw.s[k * step];   // + sign: inverse
        const a = off + (i + k) * stride, b = off + (i + k + half) * stride;
        const vr = re[b] * wr - im[b] * wi;
        const vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
      }
    }
  }
}
function ifft2(re, im, N, tw) {
  for (let y = 0; y < N; y++) fft1(re, im, y * N, 1, N, tw);
  for (let x = 0; x < N; x++) fft1(re, im, x, N, N, tw);
}

// ---------------------------------------------------------------------------
//  One CPU cascade
// ---------------------------------------------------------------------------
export class CpuCascade {
  constructor(N, L, cutLow, cutHigh, params) {
    this.N = N;
    this.cfg = { L, cutLow, cutHigh, params };
    this.tw = makeTwiddles(N);
    const n2 = N * N;
    this.h0 = new Float64Array(n2 * 4);      // (re, im) of h0(k) and conj h0(-k)
    this.re = [new Float64Array(n2), new Float64Array(n2), new Float64Array(n2)];
    this.im = [new Float64Array(n2), new Float64Array(n2), new Float64Array(n2)];
    // outputs: dispX, dispY, dispZ, velY, slopeX, slopeZ
    this.out = new Float32Array(n2 * 6);
    this.buildH0();
  }

  setParams(params) { this.cfg.params = params; this.buildH0(); }

  buildH0() {
    const { N, cfg } = this;
    const half = N >> 1;
    const seed = cfg.params.seed | 0;
    for (let j = 0; j < N; j++) {
      const ny = j - half;
      for (let i = 0; i < N; i++) {
        const nx = i - half;
        const kx = (TAU * nx) / cfg.L, ky = (TAU * ny) / cfg.L;
        const g1 = gaussFromIndex(nx, ny, seed);
        const g2 = gaussFromIndex(-nx, -ny, seed);
        const a1 = ampAt(kx, ky, cfg);
        const a2 = ampAt(-kx, -ky, cfg);
        const o = (j * N + i) * 4;
        this.h0[o] = g1[0] * a1;
        this.h0[o + 1] = g1[1] * a1;
        this.h0[o + 2] = g2[0] * a2;
        this.h0[o + 3] = -g2[1] * a2;         // conjugate
      }
    }
  }

  /** Evolve to time t and inverse-transform into this.out. */
  evolve(t) {
    const { N, cfg } = this;
    const p = cfg.params;
    const half = N >> 1;
    const chop = p.choppy * p.waveScale;
    const hs = p.waveScale;

    for (let j = 0; j < N; j++) {
      const ny = j - half;
      const ky = (TAU * ny) / cfg.L;
      for (let i = 0; i < N; i++) {
        const nx = i - half;
        const kx = (TAU * nx) / cfg.L;
        const idx = j * N + i;
        const o = idx * 4;
        const kl = Math.hypot(kx, ky);
        if (kl < 1e-6) {
          for (let f = 0; f < 3; f++) { this.re[f][idx] = 0; this.im[f][idx] = 0; }
          continue;
        }
        const w = Math.sqrt(G * kl * Math.tanh(Math.min(kl * Math.min(p.depth, 4000), 20)));
        const c = Math.cos(w * t), s = Math.sin(w * t);
        // h = h0*e^{iwt} + conj(h0(-k))*e^{-iwt}
        const hr = this.h0[o] * c - this.h0[o + 1] * s + this.h0[o + 2] * c + this.h0[o + 3] * s;
        const hi = this.h0[o] * s + this.h0[o + 1] * c - this.h0[o + 2] * s + this.h0[o + 3] * c;
        const nkx = kx / kl, nky = ky / kl;

        // field 0: Dy + i*Dx      (Dx = -i kx/|k| h)
        const dxr = nkx * hi, dxi = -nkx * hr;
        this.re[0][idx] = hr * hs - dxi * chop;
        this.im[0][idx] = hi * hs + dxr * chop;
        // field 1: Dz + i*(dDy/dt)   (dh/dt = i w h)
        const dzr = nky * hi, dzi = -nky * hr;
        const vr = -w * hi, vi = w * hr;
        this.re[1][idx] = dzr * chop - vi * hs;
        this.im[1][idx] = dzi * chop + vr * hs;
        // field 2: dDy/dx + i*dDy/dz   (= i k h)
        const sxr = -kx * hi, sxi = kx * hr;
        const szr = -ky * hi, szi = ky * hr;
        this.re[2][idx] = sxr * hs - szi * hs;
        this.im[2][idx] = sxi * hs + szr * hs;
      }
    }

    for (let f = 0; f < 3; f++) ifft2(this.re[f], this.im[f], N, this.tw);

    const sc = 1;   // unnormalised inverse transform, as on the GPU
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const idx = j * N + i;
        const perm = (i + j) % 2 === 0 ? sc : -sc;
        const o = idx * 6;
        this.out[o] = this.im[0][idx] * perm;      // Dx
        this.out[o + 1] = this.re[0][idx] * perm;  // Dy
        this.out[o + 2] = this.re[1][idx] * perm;  // Dz
        this.out[o + 3] = this.im[1][idx] * perm;  // dDy/dt
        this.out[o + 4] = this.re[2][idx] * perm;  // dDy/dx
        this.out[o + 5] = this.im[2][idx] * perm;  // dDy/dz
      }
    }
    return this.out;
  }
}

// --- sampling helpers shared by the worker and the main thread -------------
export function sampleGrid(out, N, L, x, z, comp) {
  let u = (x / L) % 1; if (u < 0) u += 1;
  let v = (z / L) % 1; if (v < 0) v += 1;
  const fx = u * N, fz = v * N;
  const i = Math.floor(fx), j = Math.floor(fz);
  const tx = fx - i, tz = fz - j;
  const i1 = (i + 1) % N, j1 = (j + 1) % N;
  const a = out[(j * N + i) * 6 + comp];
  const b = out[(j * N + i1) * 6 + comp];
  const c = out[(j1 * N + i) * 6 + comp];
  const d = out[(j1 * N + i1) * 6 + comp];
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}
