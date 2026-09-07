// ---------------------------------------------------------------------------
//  atmosphere.js -- ONE scattering / sky / cloud model, shared as a GLSL
//  include by the sky dome, the ocean surface, the terrain and the underwater
//  pass.  Sharing the *function* (rather than re-tuning a look-alike per
//  material) is what keeps the horizon seamless: the reflected sky in the
//  water and the dome behind it are literally the same integral.
//
//  Uniforms expected by every material that includes this:
//     vec3  uSunDir, uSunColor, uMoonDir, uMoonColor
//     float uSunI, uMoonI, uTurbidity, uCloudCover, uCloudSharp, uCloudBright
//     float uStorm, uFlash
//     vec2  uCloudDrift
//  Compile-time knobs: SKY_VIEW_STEPS, SKY_LIGHT_STEPS, CLOUD_STEPS, NO_STARS
// ---------------------------------------------------------------------------

export const ATMO_GLSL = /* glsl */ `
#ifndef ATMO_INCLUDED
#define ATMO_INCLUDED

// Shared by every atmospheric material. No additional texture bindings.
uniform vec4 uWeather;
uniform vec3 uLightningDir;

#define PI  3.141592653589793
#define I_PI 0.3183098861837907

#ifndef SKY_VIEW_STEPS
  #define SKY_VIEW_STEPS 8
#endif
#ifndef SKY_LIGHT_STEPS
  #define SKY_LIGHT_STEPS 4
#endif
#ifndef CLOUD_STEPS
  #define CLOUD_STEPS 5
#endif
#ifndef MULTI_SCATTER
  #define MULTI_SCATTER 1.9
#endif

// Solar irradiance in this project's units.  EVERY material that lights
// something with the sun must use this and nothing else: sky radiance, the lit
// island, the water volume and the glitter all derive from it, and the moment
// two of them use different constants the sea stops belonging to its own sky.
#define SUN_E 22.0

// --- planetary constants (metres) -----------------------------------------
const float R_GROUND = 6371000.0;
const float R_TOP    = 6471000.0;
const float H_RAY    = 8000.0;
const float H_MIE    = 1200.0;
// Bruneton coefficients, per metre
const vec3  BETA_RAY = vec3(5.802e-6, 13.558e-6, 33.100e-6);
const float BETA_MIE = 3.996e-6;
const vec3  BETA_OZO = vec3(0.650e-6, 1.881e-6, 0.085e-6);

// ---------------------------------------------------------------------------
//  hashes + value noise
// ---------------------------------------------------------------------------
float ahash1(float n){ return fract(sin(n) * 43758.5453123); }
float ahash21(vec2 p){
  vec2 q = fract(p * vec2(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}
vec3 ahash33(vec3 p){
  vec3 q = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
                dot(p, vec3(269.5, 183.3, 246.1)),
                dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(q) * 43758.5453123);
}
float vnoise2(vec2 x){
  vec2 p = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = ahash21(p), b = ahash21(p + vec2(1.0, 0.0));
  float c = ahash21(p + vec2(0.0, 1.0)), d = ahash21(p + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float vnoise3(vec3 x){
  vec3 p = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n = p.x + p.y * 157.0 + 113.0 * p.z;
  return mix(mix(mix(ahash1(n +   0.0), ahash1(n +   1.0), f.x),
                 mix(ahash1(n + 157.0), ahash1(n + 158.0), f.x), f.y),
             mix(mix(ahash1(n + 113.0), ahash1(n + 114.0), f.x),
                 mix(ahash1(n + 270.0), ahash1(n + 271.0), f.x), f.y), f.z);
}
float fbm2(vec2 p, int oct){
  float a = 0.5, s = 0.0;
  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
  vec2 q = p;
  for (int i = 0; i < 8; ++i){
    if (i >= oct) break;
    s += a * vnoise2(q);
    q = rot * q * 2.03 + 11.7;
    a *= 0.5;
  }
  return s;
}
float fbm3(vec3 p, int oct){
  float a = 0.5, s = 0.0;
  vec3 q = p;
  for (int i = 0; i < 8; ++i){
    if (i >= oct) break;
    s += a * vnoise3(q);
    q = q * 2.02 + vec3(7.3, 11.1, 3.7);
    a *= 0.5;
  }
  return s;
}

// ---------------------------------------------------------------------------
//  ray / sphere.  Closest-approach form -- the naive quadratic cancels
//  catastrophically in f32 at planetary ray origins.
// ---------------------------------------------------------------------------
// On a miss the sentinel must be UNORDERED AND NEGATIVE-ENTRY: a positive
// first component reads as "hit at 1 metre" to any caller that only tests
// t.x > 0, which truncated every near-horizontal sky ray to one metre of
// atmosphere and drew a 0.2 deg black band right along the horizon.
const vec2 RAY_MISS = vec2(1e30, -1e30);
vec2 raySphere(vec3 ro, vec3 rd, float rad){
  float b = dot(ro, rd);
  vec3  q = ro - rd * b;              // closest approach
  float h = rad * rad - dot(q, q);
  if (h < 0.0) return RAY_MISS;
  float sh = sqrt(h);
  return vec2(-b - sh, -b + sh);
}
bool rayHit(vec2 t){ return t.y > t.x; }

float rayleighPhase(float mu){ return 3.0 / (16.0 * PI) * (1.0 + mu * mu); }
float hgPhase(float mu, float g){
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}

vec3 atmoDensity(float h){
  float hr = exp(-max(h, 0.0) / H_RAY);
  float hm = exp(-max(h, 0.0) / H_MIE);
  // crude ozone bump around 25 km -- it is what makes twilight go violet
  float ho = max(0.0, 1.0 - abs(h - 25000.0) / 15000.0);
  return vec3(hr, hm, ho);
}

vec3 opticalDepth(vec3 p, vec3 dir, float turbidity){
  vec2 t = raySphere(p, dir, R_TOP);
  if (t.y < 0.0) return vec3(1e5);
  float len = t.y / float(SKY_LIGHT_STEPS);
  vec3 od = vec3(0.0);
  for (int i = 0; i < SKY_LIGHT_STEPS; ++i){
    vec3 s = p + dir * (float(i) + 0.5) * len;
    od += atmoDensity(length(s) - R_GROUND) * len;
  }
  return BETA_RAY * od.x + (BETA_MIE * turbidity * 1.1) * od.y + BETA_OZO * od.z * 0.6;
}

// Single-scattering integral.  Returns in-scattered radiance and writes the
// transmittance to the far end of the ray (used for aerial perspective).
vec3 scatter(vec3 ro, vec3 rd, vec3 sunDir, float maxDist, float turbidity,
             out vec3 transmittance)
{
  vec2 t = raySphere(ro, rd, R_TOP);
  float tEnd = min(t.y, maxDist);
  vec2 tg = raySphere(ro, rd, R_GROUND);
  if (rayHit(tg) && tg.x > 0.0) tEnd = min(tEnd, tg.x);
  float tStart = max(t.x, 0.0);
  transmittance = vec3(1.0);
  if (tEnd <= tStart) return vec3(0.0);

  float seg = (tEnd - tStart) / float(SKY_VIEW_STEPS);
  float mu  = dot(rd, sunDir);
  float pr  = rayleighPhase(mu);
  float pm  = hgPhase(mu, 0.76);

  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  vec3 msR  = vec3(0.0), msM  = vec3(0.0);
  vec3 odV  = vec3(0.0);
  float bMie = BETA_MIE * turbidity * 1.1;

  for (int i = 0; i < SKY_VIEW_STEPS; ++i){
    vec3 s = ro + rd * (tStart + (float(i) + 0.5) * seg);
    vec3 d = atmoDensity(length(s) - R_GROUND) * seg;
    odV += BETA_RAY * d.x + bMie * d.y + BETA_OZO * d.z * 0.6;
    vec3 tView = exp(-odV);
    vec3 tSun  = exp(-opticalDepth(s, sunDir, turbidity));
    // soft planetary shadow so the light does not switch off in one step
    float sh = smoothstep(-0.06, 0.06, dot(normalize(s), sunDir) + 0.02);
    vec3 tr = tView * tSun * sh;
    sumR += tr * d.x;
    sumM += tr * d.y;
    // Multiple-scatter carrier.  Higher orders arrive from every direction, so
    // they have NOT run the full sun-facing column and are not reddened the way
    // single scattering is -- carrying the full transmittance here is what
    // leaves a midday horizon orange instead of white.
    vec3 trMS = pow(tView, vec3(0.7)) * pow(tSun, vec3(0.28)) * sh;
    msR += trMS * d.x;
    msM += trMS * d.y;
  }
  transmittance = exp(-odV);
  // Single scattering alone leaves the horizon orange and the zenith too dark
  // against a sunlit surface -- the whiteness of a real sky IS the second and
  // higher orders.  Isotropic phase (1/4pi) with gain 1/(1-f), f = 0.42.
  vec3 ms = (msR * BETA_RAY + msM * bMie) * (0.0796 * 1.72 * MULTI_SCATTER);
  return (sumR * BETA_RAY * pr + sumM * bMie * pm) + ms;
}

// ---------------------------------------------------------------------------
//  clouds -- a lit slab at ~1.5 km plus cirrus at 7 km, marched on a
//  spherical shell so decks converge at the horizon instead of running off a
//  flat plane.
// ---------------------------------------------------------------------------
float cloudCoverageField(vec2 q, float cover, float storm){
  // Multi-scale coverage.  A single large octave gives either "all clear" or
  // "all overcast" for any near view -- scattered cumulus needs energy down to
  // a few km of wavelength.
  float b = fbm2(q * 0.55, 4);
  b = mix(b, fbm2(q * 1.9 + 31.7, 3), 0.35);
  b += 0.14 * fbm2(q * 5.3 - 8.1, 2);
  float band = fbm2(q * 0.19 + vec2(0.0, 3.0), 2);   // storms organise into bands
  b = mix(b, mix(b, band, 0.45) + 0.13, storm);
  float thr = mix(0.74, 0.20, clamp(cover, 0.0, 1.0));
  return clamp((b - thr) / max(0.34 - 0.10 * cover, 0.10), 0.0, 1.0);
}

float cloudDensityAt(vec3 pos, float base, float top, float cover,
                     float sharp, float storm, vec2 drift)
{
  float h = (pos.y - base) / max(top - base, 1.0);
  if (h < 0.0 || h > 1.0) return 0.0;
  vec2 shear = drift * (1.0 + h * 0.18) + vec2(sin(uWeather.z * 0.014 + h * 3.0),
    cos(uWeather.z * 0.011 + h * 2.0)) * (45.0 + 100.0 * h);
  vec2 q = (pos.xz + shear) * 0.00042;
  float cov = cloudCoverageField(q, cover, storm);
  if (cov <= 0.001) return 0.0;
  float deck = smoothstep(0.62, 0.92, cover) * (0.6 + 0.4 * storm);
  float prof = smoothstep(0.0, 0.065, h) * (1.0 - smoothstep(mix(0.48, 0.78, deck), 1.0, h));
  vec3 wp = vec3(pos.x + shear.x, pos.y, pos.z + shear.y) * 0.00085;
  float det = fbm3(wp * 3.1, 3);
  float ero = fbm3(wp * 11.0 + 4.3, 3);
  // THICKNESS carries the variation once coverage saturates.  At cover 1 the
  // coverage field is 1 everywhere, if that is the only thing feeding density,
  // an overcast sky becomes one flat grey slab with a ruler-straight edge at
  // the horizon.  Erosion also has to keep biting at full cover, not fade out.
  float thick = 0.35 + 0.95 * fbm2(q * 2.7 + 5.1, 3);
  float billow = cov + (det - 0.36) * 0.65 - h * h * 0.12;
  float d = mix(billow, cov, deck) * prof * thick;
  d -= ero * mix(0.24 + 0.18 * h, 0.12, deck);
  d = max(d, 0.0);
  d = pow(d, mix(1.5, 0.85, sharp));
  return d * mix(1.0, 1.7, storm);
}

// Macro density for shadow rays: fine erosion belongs only on the view ray.
float cloudLightDensity(vec3 p, float base, float top, float cover, float storm, vec2 drift){
  float h = (p.y - base) / max(top - base, 1.0);
  float profile = smoothstep(0.0, 0.08, h) * (1.0 - smoothstep(0.68, 1.0, h));
  vec2 q = (p.xz + drift * (1.0 + clamp(h, 0.0, 1.0) * 0.18)) * 0.00042;
  return cloudCoverageField(q, cover, storm) * profile * mix(0.48, 0.95, storm);
}

// Cheap 2D version used for cloud shadows on the sea.
float cloudShadow(vec2 worldXZ, vec3 sunDir, float cover, float storm, vec2 drift){
  if (sunDir.y < 0.03 || cover < 0.02) return 1.0;
  vec2 p = worldXZ + sunDir.xz / max(sunDir.y, 0.06) * (1500.0 - 500.0 * storm);
  float cov = cloudCoverageField((p + drift) * 0.00042, cover, storm);
  return 1.0 - cov * mix(0.62, 0.92, storm);
}

// Raymarched slab.  rgb = scattered light, a = coverage along the ray.
vec4 cloudLayer(vec3 ro, vec3 rd, vec3 sunDir, vec3 sunCol, float cover,
                float sharp, float bright, float storm, vec2 drift, float flash)
{
  if (cover <= 0.002) return vec4(0.0);
  // Do NOT cut the deck off near the horizon.  A deck that stops at half a
  // degree leaves a bright strip of clear sky along the whole horizon under a
  // full overcast -- a lit line drawn under a storm.  Clamp the direction
  // instead, so the last shallow angle is carried continuously down to 0.
  vec3 rdc = normalize(vec3(rd.x, max(rd.y, 0.0016), rd.z));
  float base = 1500.0 - 500.0 * storm;
  float top  = base + 900.0 + 1500.0 * storm;

  vec3 o = vec3(0.0, R_GROUND + max(ro.y, 0.0), 0.0);
  float t0 = raySphere(o, rdc, R_GROUND + base).y;
  float t1 = raySphere(o, rdc, R_GROUND + top ).y;
  if (t1 <= 0.0) return vec4(0.0);
  t0 = max(t0, 0.0);
  float span = min(t1 - t0, 26000.0);
  if (span <= 0.0) return vec4(0.0);

  float dt = span / float(CLOUD_STEPS);
  float transm = 1.0;
  vec3  acc = vec3(0.0);
  float mu = dot(rd, sunDir);
  float ph = mix(hgPhase(mu, 0.72), hgPhase(mu, -0.28), 0.42) * 4.0;

  for (int i = 0; i < CLOUD_STEPS; ++i){
    if (transm < 0.02) break;
    vec3 p = ro + rdc * (t0 + (float(i) + 0.4) * dt);
    // re-map height onto the slab (the shell march is nearly tangential far out)
    float hh = base + (top - base) * ((float(i) + 0.4) / float(CLOUD_STEPS));
    p.y = mix(p.y, hh, clamp(1.0 - rdc.y * 3.0, 0.0, 1.0));
    float d = cloudDensityAt(p, base, top, cover, sharp, storm, drift);
    if (d <= 0.001) continue;

    float ls = 0.0;
    float lightPath = clamp((top - p.y) / max(sunDir.y, 0.08), 200.0, 7000.0);
    for (int j = 0; j < 2; ++j){
      vec3 lp = p + sunDir * lightPath * (0.18 + 0.48 * float(j));
      ls += cloudLightDensity(lp, base, top, cover, storm, drift) * lightPath * 0.0006;
    }
    float beer   = exp(-ls * 1.15);
    float powder = 1.0 - exp(-d * 3.4);
    // Cloud interiors are lit almost entirely by multiple scattering, a beer
    // term alone leaves every base a flat dark slab.
    vec3 lit = sunCol * (beer * ph * powder + 0.30 + 0.22 * beer) * mix(1.0, 0.26, storm);
    // Ambient must follow how much light there actually IS.  A fixed ambient
    // makes clouds self-luminous, which is invisible by day and turns the
    // whole night sky into a white sheet once auto exposure opens up.
    float lightLevel = clamp(dot(sunCol, vec3(0.3333)) * 1.3, 0.0, 1.4);
    lit += vec3(0.40, 0.48, 0.62) * (0.42 + 0.30 * (1.0 - storm))
           * (0.3 + 0.7 * max(sunDir.y, 0.0)) * lightLevel;
    // A storm deck is DARK.  Attenuating only the direct term leaves an
    // extreme storm as bright as a midday sky, which is the one thing a storm
    // must not look like.
    lit *= mix(1.0, 0.28, storm);
    float cellFlash = pow(max(dot(rd, uLightningDir), 0.0), 24.0);
    lit += vec3(0.72, 0.83, 1.0) * flash * (0.08 + 3.2 * cellFlash);

    float a = 1.0 - exp(-d * dt * 0.0012);
    acc += lit * a * transm * bright;
    transm *= 1.0 - a;
  }

  float ci = 0.0;
  float tc = raySphere(o, rd, R_GROUND + 7200.0).y;
  if (tc > 0.0){
    vec3 p = ro + rdc * tc;
    vec2 q = (p.xz + drift * 2.2) * 0.000085;
    float s = fbm2(q * vec2(1.0, 3.4), 4);
    ci = smoothstep(0.52, 0.78, s) * (0.30 + 0.30 * cover) * (1.0 - storm * 0.7);
    ci *= smoothstep(0.0, 0.13, rdc.y);
  }
  float cirLight = clamp(dot(sunCol, vec3(0.3333)) * 1.3, 0.0, 1.4);
  vec3 cirCol = sunCol * (0.55 + 0.45 * max(mu, 0.0)) + vec3(0.30, 0.40, 0.55) * cirLight;
  float alpha = 1.0 - transm;
  acc = acc + cirCol * ci * (1.0 - alpha) * 0.55;
  alpha = alpha + ci * (1.0 - alpha) * 0.8;
  return vec4(acc, clamp(alpha, 0.0, 1.0));
}

// ---------------------------------------------------------------------------
//  stars + celestial bodies
// ---------------------------------------------------------------------------
vec3 starField(vec3 dir){
#ifdef NO_STARS
  return vec3(0.0);
#else
  vec3 acc = vec3(0.0);
  for (int L = 0; L < 2; ++L){
    float sc = (L == 0) ? 260.0 : 520.0;
    vec3 p = dir * sc;
    vec3 c = floor(p), f = fract(p);
    for (int i = 0; i < 8; ++i){
      vec3 o = vec3(float(i - (i / 2) * 2), float((i / 2) - (i / 4) * 2), float(i / 4));
      vec3 h = ahash33(c + o);
      if (h.z > 0.968 - 0.012 * float(L)){
        vec3 sp = o + h * 0.86;
        float d = length(f - sp);
        float b = pow(fract(h.x * 91.7), 6.0);
        float tw = 0.72 + 0.28 * sin(h.y * 51.0 + h.x * 30.0);
        vec3 tint = mix(vec3(0.62, 0.74, 1.0), vec3(1.0, 0.82, 0.62), fract(h.y * 17.3));
        acc += tint * b * tw * exp(-d * d * 1600.0) * 26.0;
      }
    }
  }
  float g = pow(max(0.0, 1.0 - abs(dot(dir, normalize(vec3(0.42, 0.30, -0.86)))) * 3.1), 3.0);
  acc += vec3(0.34, 0.38, 0.52) * g * (0.16 + 0.30 * fbm2(dir.xz * 9.0 + dir.y * 4.0, 3));
  return acc * 0.02;
#endif
}

vec3 celestialBodies(vec3 dir, vec3 sunDir, vec3 sunCol, float sunI,
                     vec3 moonDir, vec3 moonCol, float moonI)
{
  vec3 c = vec3(0.0);
  float cs = dot(dir, sunDir);
  float sr = 0.9999894;                       // cos(0.264 deg)
  if (cs > sr - 0.00004){
    float x = clamp((1.0 - cs) / (1.0 - sr), 0.0, 1.0);
    float limb = pow(max(1.0 - x * x, 0.0), 0.28);
    c += sunCol * sunI * 42.0 * limb * smoothstep(sr - 0.00004, sr + 0.00002, cs);
  }
  float cm = dot(dir, moonDir);
  float mr = 0.99996;
  if (cm > mr){
    float x = clamp((1.0 - cm) / (1.0 - mr), 0.0, 1.0);
    float mare = fbm2(dir.xz * 620.0 + dir.y * 300.0, 3);
    float phase = clamp(dot(moonDir, -sunDir) * 0.5 + 0.5, 0.0, 1.0);
    float lit = smoothstep(-0.25, 0.35,
                dot(normalize(dir - moonDir * 0.995), -sunDir) + phase - 0.5);
    c += moonCol * moonI * 30.0 * (0.65 + 0.5 * mare) * mix(0.06, 1.0, lit) * sqrt(1.0 - x * 0.85);
  }
  // glare halos -- an honest 0.5 deg disc is an invisible speck otherwise
  c += moonCol * moonI * 0.020 * pow(max(cm, 0.0), 2200.0);
  c += sunCol  * sunI  * 0.030 * pow(max(cs, 0.0), 1400.0);
  return c;
}

// ---------------------------------------------------------------------------
//  the one entry point everything uses
// ---------------------------------------------------------------------------
vec3 marineFogLight(float sunI, float cover, float storm){
  float daylight = sunI * mix(0.72, 0.28, storm) * mix(1.0, 0.72, cover);
  return vec3(0.58, 0.66, 0.73) * daylight + vec3(0.0015, 0.0020, 0.0030);
}

float marineTransmission(vec3 ro, vec3 rd, float distanceM){
  // Low marine layer, integrated with fixed samples; sigma is inverse metres.
  float sigma = uWeather.y * 0.011 + uWeather.x * 0.00018;
  float height = mix(320.0, 85.0, uWeather.y);
  float path = min(max(distanceM, 0.0), 40000.0);
  float column = 0.0;
  for (int i = 0; i < 3; ++i){
    float y = max(ro.y + rd.y * path * (float(i) + 0.5) / 3.0, 0.0);
    column += exp(-y / height);
  }
  return exp(-min(sigma * path * column / 3.0, 60.0));
}

vec3 skyRadiance(vec3 ro, vec3 rd, vec3 sunDir, vec3 sunCol, float sunI,
                 vec3 moonDir, vec3 moonCol, float moonI, float turbidity,
                 float cover, float sharp, float bright, float storm,
                 vec2 drift, float flash, bool withBodies)
{
  vec3 o = vec3(0.0, R_GROUND + max(ro.y, 0.5), 0.0);
  vec3 tr, trm;
  vec3 col = scatter(o, rd, sunDir, 1e7, turbidity, tr) * sunCol * sunI * SUN_E;
  col += scatter(o, rd, moonDir, 1e7, turbidity, trm) * moonCol * moonI * SUN_E;

  float nightF = 1.0 - smoothstep(-0.06, 0.10, sunDir.y);
  col += starField(rd) * nightF * tr;
  if (withBodies)
    col += celestialBodies(rd, sunDir, sunCol, sunI, moonDir, moonCol, moonI) * tr;

  vec3 cloudSunT = exp(-opticalDepth(vec3(0.0, R_GROUND + 1800.0, 0.0), sunDir, turbidity));
  vec3 cloudDir = sunI > moonI ? sunDir : moonDir;
  vec4 cl = cloudLayer(ro, rd, cloudDir, sunCol * sunI * cloudSunT + moonCol * moonI * 0.9,
                       cover, sharp, bright, storm, drift, flash);
  // cloudLayer already accumulates premultiplied radiance.
  col = col * (1.0 - cl.a) + cl.rgb;
  col += vec3(0.72, 0.83, 1.0) * flash * 0.24 * pow(max(dot(rd, uLightningDir), 0.0), 16.0);
  if (uWeather.x > 0.001){
    // Distant precipitation columns, advected with the same cloud field.
    float rayLength = min(1800.0 / max(rd.y, 0.06), 22000.0);
    vec2 rainXZ = ro.xz + rd.xz * rayLength;
    float shafts = cloudCoverageField((rainXZ + drift) * 0.00042, cover, storm);
    shafts *= 0.35 + 0.65 * fbm2((rainXZ + drift) * vec2(0.0008, 0.00022), 2);
    float rainT = exp(-uWeather.x * shafts * 2.0 * (1.0 - smoothstep(0.06, 0.52, rd.y)));
    col = col * rainT + marineFogLight(sunI, cover, storm) * (1.0 - rainT);
  }
  float fogT = marineTransmission(ro, rd, 30000.0);
  col = col * fogT + marineFogLight(sunI, cover, storm) * (1.0 - fogT);
  return max(col, vec3(0.0));
}

// Aerial perspective for surfaces: how a distant point reaches the eye.
void aerial(vec3 ro, vec3 rd, float dist, vec3 sunDir, vec3 sunCol, float sunI,
            float turbidity, float storm, float cover, out vec3 inscat, out vec3 trans)
{
  vec3 o = vec3(0.0, R_GROUND + max(ro.y, 0.5), 0.0);
  inscat = scatter(o, rd, sunDir, dist, turbidity, trans) * sunCol * sunI * SUN_E;
  // Display-referred: the full physical inscatter over a few hundred metres of
  // sea-level air milks out every surface at midday.  The sky dome keeps the
  // whole integral, surfaces get 0.6 of it.
  inscat *= 0.60 * mix(1.0, 0.42, storm);
  // The haze a distant surface fades INTO is lit by whatever is overhead.  This
  // integral is clear-sky: under an overcast the sky dome goes dark while the
  // haze does not, and the two meet as a bright band ruled along the horizon --
  // exactly the artefact an overcast is supposed to remove.  Cover has to dim
  // the surface haze the same way it dims the dome.
  inscat *= mix(1.0, mix(0.72, 0.42, storm), cover);
  float fogT = marineTransmission(ro, rd, dist);
  inscat = inscat * fogT + marineFogLight(sunI, cover, storm) * (1.0 - fogT);
  trans *= fogT;
}
#endif
`;
