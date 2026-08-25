// ---------------------------------------------------------------------------
//  oceanSim.js -- GLSL for the spectral (Tessendorf / JONSWAP) ocean.
//
//  Everything runs as fullscreen fragment passes so ONE shader language covers
//  WebGL2 and WebGPU (Babylon transpiles GLSL -> SPIR-V -> WGSL).  A compute
//  path would have forced a second, WGSL-only implementation.
//
//  Per cascade, per frame:
//     spectrum(0) -> spec0 , spectrum(1) -> spec1      (h(k,t) from h0)
//     fft horizontal (log2N passes) on both
//     fft vertical   (log2N passes) on both
//     displacement pass  -> RGBA16F (Dx, Dy, Dz, -)
//     derivative  pass  -> RGBA16F (dy/dx, dy/dz, jacobian, foam)
//
//  Field packing.  Two real fields ride in one complex transform (A + iB), so
//  eight real outputs need only two RGBA textures:
//     spec0.rg = Dy + i*Dx        spec0.ba = Dz     + i*dDy/dx
//     spec1.rg = dDy/dz + i*dDx/dx spec1.ba = dDz/dz + i*dDx/dz
// ---------------------------------------------------------------------------

const COMMON = /* glsl */ `
precision highp float;
precision highp int;
varying vec2 vUV;
#define PI 3.141592653589793
#define G  9.80665

vec2 cmul(vec2 a, vec2 b){ return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 cmuli(vec2 a){ return vec2(-a.y, a.x); }          // a * i
vec2 cconj(vec2 a){ return vec2(a.x, -a.y); }

// PCG integer hash.  Keyed on the WAVE NUMBER index, not the texel, and made
// of exact 32-bit integer ops -- so the 128^2 CPU mirror used for buoyancy
// draws literally the same random amplitudes as the 256^2 GPU field for every
// wave vector they share.  A float sin-hash cannot do that: f32 and f64
// diverge after the first multiply and the boat bobs to a different sea.
uint pcgHash(uint v){
  uint x = v * 747796405u + 2891336453u;
  uint s = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return (s >> 22u) ^ s;
}
uint keyHash(int nx, int ny, uint seed, uint salt){
  uint a = uint(nx + 8192);
  uint b = uint(ny + 8192);
  return pcgHash(a * 1103515245u + b * 12345u + seed * 2654435761u + salt);
}
float u2f(uint u){ return float(u & 0x00FFFFFFu) / 16777216.0; }
vec2 gaussFromIndex(int nx, int ny, uint seed){
  float u1 = max(1e-7, u2f(keyHash(nx, ny, seed, 0u)));
  float u2 = u2f(keyHash(nx, ny, seed, 5741u));
  float r = sqrt(-2.0 * log(u1));
  float a = 2.0 * PI * u2;
  return vec2(r * cos(a), r * sin(a));
}
`;

// ---------------------------------------------------------------------------
//  Pass 1: initial spectrum h0(k).  Recomputed only when the wind changes.
//  RGBA32F: (h0.re, h0.im, h0(-k)*.re, h0(-k)*.im)
// ---------------------------------------------------------------------------
export const H0_FRAG = COMMON + /* glsl */ `
uniform float uN;          // resolution
uniform float uL;          // patch size (m)
uniform float uWindSpeed;  // m/s at 10 m
uniform float uFetch;      // m
uniform float uDepth;      // m
uniform float uSpread;     // directional spread multiplier
uniform float uSwell;      // 0..1 amount of long swell
uniform float uSwellPeriod;
uniform float uSeed;
uniform float uCutLow;
uniform float uCutHigh;
uniform float uAmp;
uniform vec2  uWindDir;
uniform vec2  uSwellDir;

float jonswap(float w, float wp, float alpha){
  if (w < 1e-4) return 0.0;
  float sigma = (w <= wp) ? 0.07 : 0.09;
  float rr = exp(-(w - wp) * (w - wp) / (2.0 * sigma * sigma * wp * wp));
  return alpha * G * G / pow(w, 5.0) * exp(-1.25 * pow(wp / w, 4.0)) * pow(3.3, rr);
}

// Longuet-Higgins / Hasselmann cos^2s spreading with the empirical exponent.
float spreadD(float w, float wp, float theta, float u){
  float r = w / max(wp, 1e-3);
  float s;
  if (r < 1.0) s = 6.97 * pow(r, 4.06);
  else         s = 9.77 * pow(r, -2.33 - 1.45 * clamp(u * wp / G - 1.17, -0.8, 3.0));
  s = max(s * uSpread, 0.4);
  float q = sqrt(s) * 0.28209 * (1.0 + 0.375 / s);      // approx normalisation
  return q * pow(max(abs(cos(theta * 0.5)), 1e-4), 2.0 * s);
}

// Amplitude of one wave vector.  Called for +k AND -k: the directional spread
// is not symmetric, so re-using |amp(k)| for -k would quietly bias every sea
// toward the wind axis.
float ampAt(vec2 k){
  float kl = length(k);
  if (kl < 1e-6 || kl < uCutLow || kl >= uCutHigh) return 0.0;
  float dk = 2.0 * PI / uL;
  float kd = kl * min(uDepth, 4000.0);
  float th = tanh(min(kd, 20.0));
  float w  = sqrt(G * kl * th);
  float sech2 = 1.0 - th * th;
  float dwdk = G * (th + kd * sech2) / max(2.0 * w, 1e-4);

  float U  = max(uWindSpeed, 0.6);
  float F  = max(uFetch, 1000.0);
  float wp = 22.0 * pow(G * G / (U * F), 1.0 / 3.0);
  float alpha = 0.076 * pow(U * U / (F * G), 0.22);

  float theta = atan(k.y, k.x) - atan(uWindDir.y, uWindDir.x);
  float S = jonswap(w, wp, alpha) * spreadD(w, wp, theta, U);

  // Swell is specified as its own significant wave height in metres and is
  // deliberately INDEPENDENT of the local wind -- swell is weather that
  // happened somewhere else days ago.  Scaling it by the wind spectrum (the
  // easy shortcut) puts a 1.8 m swell on a dead calm day.
  if (uSwell > 0.01){
    float wps = 2.0 * PI / max(uSwellPeriod, 3.0);
    float ts  = atan(k.y, k.x) - atan(uSwellDir.y, uSwellDir.x);
    float ss  = 26.0;
    float qs  = sqrt(ss) * 0.28209 * (1.0 + 0.375 / ss);
    float Ds  = qs * pow(max(abs(cos(ts * 0.5)), 1e-4), 2.0 * ss);
    float sig = 0.085 * wps;
    float m0s = (uSwell * 0.25) * (uSwell * 0.25);      // Hs -> variance
    float A   = m0s / (sig * 1.7724539);                // Gaussian band, unit area
    S += A * exp(-pow((w - wps) / sig, 2.0)) * Ds;
  }

  float Sk = S * dwdk / max(kl, 1e-5);
  Sk *= exp(-kl * kl * 0.0004);            // surface-tension / sanity cutoff
  // E|h~(k)|^2 = S(k) dk^2 with two conjugate terms and E|xi|^2 = 2
  return sqrt(max(2.0 * Sk, 0.0)) * dk * uAmp * 0.35355339;
}

void main(){
  float N = uN;
  int hf = int(N) / 2;
  int nx = int(floor(vUV.x * N)) - hf;
  int ny = int(floor(vUV.y * N)) - hf;
  vec2 k  = 2.0 * PI * vec2(float(nx), float(ny)) / uL;

  uint seed = uint(int(uSeed));
  vec2 g1 = gaussFromIndex(nx, ny, seed);
  vec2 g2 = gaussFromIndex(-nx, -ny, seed);

  vec2 h0  = g1 * ampAt(k);
  vec2 h0m = g2 * ampAt(-k);
  gl_FragColor = vec4(h0, cconj(h0m));
}
`;

// ---------------------------------------------------------------------------
//  Pass 2: time evolution.  uTarget selects which packed pair to emit.
// ---------------------------------------------------------------------------
export const SPECTRUM_FRAG = COMMON + /* glsl */ `
uniform sampler2D uH0;
uniform float uN;
uniform float uL;
uniform float uTime;
uniform float uDepth;
uniform float uChop;
uniform float uTarget;
void main(){
  float N = uN;
  vec2 id = floor(vUV * N);
  vec2 n  = id - N * 0.5;
  vec2 k  = 2.0 * PI * n / uL;
  float kl = length(k);

  vec4 h0 = texture2D(uH0, vUV);
  // Single exit: an early return here is skipped when Babylon transpiles to
  // WGSL (the output struct is assigned after the body), so the k=0 bin would
  // fall through and divide by zero.  Guard the value, mask the result.
  float valid = step(1e-6, kl);
  kl = max(kl, 1e-6);

  float w = sqrt(G * kl * tanh(min(kl * min(uDepth, 4000.0), 20.0)));
  float c = cos(w * uTime), s = sin(w * uTime);
  vec2 e  = vec2(c, s);
  vec2 h  = cmul(h0.xy, e) + cmul(h0.zw, vec2(c, -s));

  vec2 kn = k / kl;
  vec2 ih = cmuli(h);            // i * h

  if (uTarget < 0.5){
    vec2 Dy = h;
    vec2 Dx = -kn.x * ih;        // -i kx/|k| h
    vec2 Dz = -kn.y * ih;
    vec2 dYdx = k.x * ih;
    gl_FragColor = vec4(Dy + cmuli(Dx), Dz + cmuli(dYdx)) * valid;
  } else {
    vec2 dYdz  = k.y * ih;
    vec2 dXdx  = (k.x * k.x / kl) * h;
    vec2 dZdz  = (k.y * k.y / kl) * h;
    vec2 dXdz  = (k.x * k.y / kl) * h;
    gl_FragColor = vec4(dYdz + cmuli(dXdx), dZdz + cmuli(dXdz)) * valid;
  }
}
`;

// ---------------------------------------------------------------------------
//  Pass 3: Cooley-Tukey butterfly, one stage per draw, driven by a
//  precomputed index/twiddle texture (see buildButterflyData in fft.js).
//  Both packed complex pairs (rg and ba) transform in the same draw.
// ---------------------------------------------------------------------------
export const FFT_FRAG = COMMON + /* glsl */ `
uniform sampler2D uButterfly;   // (log2N x N) : (twRe, twIm, idxTop, idxBottom)
uniform sampler2D uSrc;
uniform float uN;
uniform float uStages;
uniform float uStage;
uniform float uVertical;
void main(){
  float N = uN;
  vec2 px = floor(vUV * N);
  float coord = (uVertical < 0.5) ? px.x : px.y;
  vec4 bf = texture2D(uButterfly, vec2((uStage + 0.5) / uStages, (coord + 0.5) / N));
  vec2 w = bf.xy;

  vec2 uvA, uvB;
  if (uVertical < 0.5){
    uvA = vec2((bf.z + 0.5) / N, vUV.y);
    uvB = vec2((bf.w + 0.5) / N, vUV.y);
  } else {
    uvA = vec2(vUV.x, (bf.z + 0.5) / N);
    uvB = vec2(vUV.x, (bf.w + 0.5) / N);
  }
  vec4 a = texture2D(uSrc, uvA);
  vec4 b = texture2D(uSrc, uvB);
  gl_FragColor = vec4(a.xy + cmul(w, b.xy), a.zw + cmul(w, b.zw));
}
`;

// ---------------------------------------------------------------------------
//  Pass 4a: displacement.  Applies the 1/N^2 normalisation and the
//  (-1)^(x+y) shift that undoes the centred wave-number layout.
// ---------------------------------------------------------------------------
export const DISPLACE_FRAG = COMMON + /* glsl */ `
uniform sampler2D uFFT0;
uniform float uN;
uniform float uChop;
uniform float uHeightScale;
void main(){
  vec2 px = floor(vUV * uN);
  // No 1/N^2 here: the butterfly evaluates h(x) = sum_k h~(k) e^{ikx}, which is
  // the UNNORMALISED inverse transform.  Dividing by N^2 (the usual DFT
  // convention) scales the whole sea down by 65536 and reads as dead calm.
  float perm = (mod(px.x + px.y, 2.0) < 0.5) ? 1.0 : -1.0;
  float sc = perm;
  vec4 f0 = texture2D(uFFT0, vUV) * sc;
  // f0 = (Dy, Dx, Dz, dDy/dx)
  // one place applies choppiness and wave scale: here and in the derivative
  // pass, so the Jacobian that drives foam always matches the drawn surface
  gl_FragColor = vec4(f0.y * uChop * uHeightScale, f0.x * uHeightScale,
                      f0.z * uChop * uHeightScale, f0.w);
}
`;

// ---------------------------------------------------------------------------
//  Pass 4b: slopes, Jacobian (wave folding) and accumulated foam.
// ---------------------------------------------------------------------------
export const DERIV_FRAG = COMMON + /* glsl */ `
uniform sampler2D uFFT0;
uniform sampler2D uFFT1;
uniform sampler2D uPrev;
uniform float uN;
uniform float uChop;
uniform float uHeightScale;
uniform float uDt;
uniform float uFoamThreshold;
uniform float uFoamInject;
uniform float uFoamDecay;
void main(){
  vec2 px = floor(vUV * uN);
  float perm = (mod(px.x + px.y, 2.0) < 0.5) ? 1.0 : -1.0;
  float sc = perm;
  vec4 f0 = texture2D(uFFT0, vUV) * sc;   // (Dy, Dx, Dz, dDy/dx)
  vec4 f1 = texture2D(uFFT1, vUV) * sc;   // (dDy/dz, dDx/dx, dDz/dz, dDx/dz)

  float dXdx = f1.y * uChop * uHeightScale;
  float dZdz = f1.z * uChop * uHeightScale;
  float dXdz = f1.w * uChop * uHeightScale;

  // slopes of the *displaced* surface: divide out the horizontal stretch
  float sx = f0.w * uHeightScale / max(1.0 + dXdx, 0.08);
  float sz = f1.x * uHeightScale / max(1.0 + dZdz, 0.08);

  float J = (1.0 + dXdx) * (1.0 + dZdz) - dXdz * dXdz;

  float prev = texture2D(uPrev, vUV).w;
  float inj  = clamp((uFoamThreshold - J) * uFoamInject, 0.0, 1.0);
  float foam = max(prev * exp(-uFoamDecay * uDt), inj);
  foam = clamp(foam + inj * uDt * 2.2, 0.0, 1.0);

  gl_FragColor = vec4(sx, sz, J, foam);
}
`;

// ---------------------------------------------------------------------------
//  Dynamic disturbance field (boat wakes, splashes, rain).  A camera-following
//  world-space texture, ping-ponged: rgb = (foam, ripple height, ripple vel).
// ---------------------------------------------------------------------------
export const DISTURB_FRAG = COMMON + /* glsl */ `
uniform sampler2D uPrev;
uniform sampler2D uInjectTex;
uniform float uDt;
uniform float uSize;
uniform float uDecay;
uniform float uInjectCount;
uniform float uRes;
uniform float uMode;          // 0 = propagating ripples, 1 = stamps only
uniform float uSpeed;         // ripple propagation speed
uniform vec2  uCentre;
uniform vec2  uPrevCentre;
uniform vec2  uDrift;

void main(){
  // resample the previous frame in world space so the field is world-anchored
  vec2 world = uCentre + (vUV - 0.5) * uSize - uDrift * uDt;
  vec2 pUV = (world - uPrevCentre) / uSize + 0.5;
  float inP = step(0.001, pUV.x) * step(pUV.x, 0.999) *
              step(0.001, pUV.y) * step(pUV.y, 0.999);
  vec2 cUV = clamp(pUV, 0.001, 0.999);
  vec4 prev = texture2D(uPrev, cUV) * inP;

  float foam = prev.x * exp(-uDecay * uDt);
  float h = prev.y, v = prev.z;
  // The explicit wave update is only stable while c*dt <= dx, i.e.
  // dt <= 1/sqrt(uSpeed) -- and uSpeed is large because the texels are small
  // (2422 on the 5 cm fine field, so the limit is 20 ms).  Any frame slower
  // than that and the integration diverges: v and h run away to the clamp and
  // the field becomes a saturated PLATEAU that follows the character, flat
  // inside with a cliff at its rim.  It reads as a grey wedge in tow, not as
  // an unstable solver, which is what makes it worth stating.  Stepping short
  // on a slow frame only slows propagation slightly; it never explodes.
  float dt = min(min(uDt, 0.033), 0.85 / sqrt(max(uSpeed, 1e-6)));

  if (uMode < 0.5){
    // 2D wave equation for the ripple rings
    float e = 1.0 / uRes;
    float l = texture2D(uPrev, clamp(cUV + vec2(-e, 0.0), 0.001, 0.999)).y;
    float r = texture2D(uPrev, clamp(cUV + vec2( e, 0.0), 0.001, 0.999)).y;
    float d = texture2D(uPrev, clamp(cUV + vec2(0.0, -e), 0.001, 0.999)).y;
    float u = texture2D(uPrev, clamp(cUV + vec2(0.0,  e), 0.001, 0.999)).y;
    // uSpeed is c^2/dx^2 in texel units: the propagation speed has to be set
    // from the TEXEL SIZE of this particular field.  Too slow and injected
    // energy never leaves the injection point -- it just piles up until the
    // clamp, which spikes the ocean surface into a cone that follows the
    // character around.
    float lap = (l + r + d + u) - 4.0 * h;
    v = (v + lap * uSpeed * dt) * exp(-1.7 * dt);
    h = (h + v * dt) * exp(-1.15 * dt);
  } else {
    h = prev.y * exp(-uDecay * 0.6 * uDt);
    v = 0.0;
  }

  for (int i = 0; i < 16; ++i){
    if (float(i) >= uInjectCount) break;
    float ix = (float(i) + 0.5) / 16.0;
    vec4 inj  = textureLod(uInjectTex, vec2(ix, 0.25), 0.0);  // xy pos, z radius, w strength
    vec4 inj2 = textureLod(uInjectTex, vec2(ix, 0.75), 0.0);  // xy velocity, z lift, w -
    vec2 d = world - inj.xy;
    // Elongate along the motion.  A ripple left by a foot swinging through
    // water is not a circle, and a field of perfect circles is the fastest way
    // to make an interaction read as a decal.
    float vl = length(inj2.xy);
    if (vl > 1e-3){
      vec2 a = inj2.xy / vl;
      float along = dot(d, a), across = dot(d, vec2(-a.y, a.x));
      d = vec2(along / (1.0 + min(vl, 6.0) * 0.22), across);
    }
    float dd = length(d);
    float f = 1.0 - smoothstep(inj.z * 0.30, inj.z, dd);
    foam = max(foam, f * abs(inj.w));
    // Drive the VELOCITY channel, not the height.  A continuous emitter that
    // adds height every frame integrates into a static dome that follows the
    // character; an impulse into velocity radiates away as rings, which is
    // what a disturbance in water actually does.
    //
    // Scale matters as much as channel.  A running character injects tens of
    // times a second into the same few texels, so an impulse sized to be
    // clearly visible on its own saturates h against the clamp within a
    // stride.  A saturated field is a PLATEAU: flat inside, a cliff at its
    // edge, and since the plateau follows the runner it reads as a smooth
    // grey wedge towing behind them.  A footfall in ankle water raises
    // centimetres, so keep the peak there and let the clamp stay unreachable.
    h += f * inj2.z * 0.015;
    v += f * inj2.z * 2.2;
  }
  // a physical bound: surface disturbance from a person is decimetres
  // Taper the whole field to zero at its OWN border.  The resample brings in
  // clamped edge values from the previous frame, which leaves a step in h
  // right at the boundary of a square that follows the character -- in
  // perspective that step reads as two dark wings running to the horizon.
  // Fading it in the consumer is not enough: the discontinuity has to not
  // exist in the field.
  vec2 be = abs(vUV - 0.5) * 2.0;
  float border = 1.0 - smoothstep(0.82, 0.995, max(be.x, be.y));
  gl_FragColor = vec4(clamp(foam, 0.0, 1.0) * border, clamp(h, -0.45, 0.45) * border,
                      clamp(v, -8.0, 8.0) * border, 1.0);
}
`;
