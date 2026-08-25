// ---------------------------------------------------------------------------
//  oceanSurface.js -- vertex + fragment GLSL for the water surface.
//
//  Vertex   : CDLOD geo-clipmap.  Every vertex carries (cellSize, halfExtent)
//             so the whole 13-level clipmap is ONE mesh in ONE draw call and
//             each level derives its own camera-snapped origin in the shader.
//  Fragment : Fresnel + planar reflection + analytic sky + GGX sun glitter
//             driven by unresolved slope variance + Beer-Lambert depth colour
//             + refraction + dynamic foam + aerial perspective, and an
//             underwater branch with a real Snell window.
// ---------------------------------------------------------------------------

import { ATMO_GLSL } from "./atmosphere.js";
import { SURF_GLSL } from "./surf.js";

const SHARED_UNIFORMS = /* glsl */ `
uniform vec3  uCamPos;
uniform vec2  uCamXZ;
uniform float uTime;
uniform float uSeaLevel;

// --- cascades -------------------------------------------------------------
#ifdef OCEAN_VELOCITY
uniform mat4 uPrevViewProjection;
uniform mat4 uCurViewProjection;   // UNJITTERED: see the note in TemporalAA
uniform sampler2D uDispPrev0;
uniform sampler2D uDispPrev1;
uniform sampler2D uDispPrev2;
varying vec4 vClipCur;
varying vec4 vClipPrev;
#endif
uniform sampler2D uDisp0;
uniform sampler2D uDisp1;
uniform sampler2D uDisp2;
uniform sampler2D uDeriv0;
uniform sampler2D uDeriv1;
uniform sampler2D uDeriv2;
uniform vec3  uCascadeL;      // patch size per cascade (m)
uniform vec3  uCascadeTexel;  // L / N per cascade (m)
uniform vec3  uCascadeOn;     // 0/1 enable
uniform vec3  uSlopeVar;      // slope variance carried by each cascade

// --- seabed ---------------------------------------------------------------
uniform sampler2D uDepthMap;  // r = seabed height (m, negative below sea)
uniform vec4  uDepthMapRect;  // xy = origin, zw = size (m)
uniform float uDepthMapSize;  // texels per side
uniform float uHasDepthMap;   // 0 = pure deep ocean, no bathymetry at all
uniform float uDeepDepth;

// --- disturbance fields (coarse: wakes/rain, fine: the player) -------------
uniform sampler2D uDisturb;
uniform sampler2D uRipple;
uniform vec4  uDisturbRect;     // xy centre, z size, w enabled
uniform vec4  uRippleRect;

// --- shaping --------------------------------------------------------------
uniform float uChoppy;
uniform float uWaveScale;
uniform float uMorphStart;
uniform float uShoreSteepen;
uniform vec2  uWindDir;
uniform float uWindSpeed;
`;

const ATMO_UNIFORMS = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform float uSunI;
uniform float uMoonI;
uniform float uTurbidity;
uniform float uCloudCover;
uniform float uCloudSharp;
uniform float uCloudBright;
uniform float uStorm;
uniform float uFlash;
uniform vec2  uCloudDrift;

`;

const DEPTH_BILINEAR = /* glsl */ `
// Bilinear by hand.  The seabed map is r32float, and WebGPU cannot FILTER a
// 32-bit float texture without the optional float32-filterable feature -- it
// silently falls back to NEAREST.  The seabed height then becomes a staircase
// on the map's ~2.2 m grid, and since water colour, absorption, transparency
// and the shoreline foam band are all functions of depth, the sea fills with
// hard-edged stepped regions that read as broken tiles.  WebGL2's
// OES_texture_float_linear hides it completely, so it only ever appears on one
// backend.  Filtering here instead of relying on the sampler is exact on both.
vec2 depthMapBilinear(vec2 duv){
  vec2 t = duv * uDepthMapSize - 0.5;
  vec2 f = fract(t);
  vec2 b = (floor(t) + 0.5) / uDepthMapSize;
  float e = 1.0 / uDepthMapSize;
  vec2 h00 = texture2D(uDepthMap, b).rg;
  vec2 h10 = texture2D(uDepthMap, b + vec2(e, 0.0)).rg;
  vec2 h01 = texture2D(uDepthMap, b + vec2(0.0, e)).rg;
  vec2 h11 = texture2D(uDepthMap, b + vec2(e, e)).rg;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}
// r = sea bed height (m), g = swell travel time (s)
float seabedOnly(vec2 duv){ return depthMapBilinear(duv).r; }
`;

// ---------------------------------------------------------------------------
//  VERTEX
// ---------------------------------------------------------------------------
export const OCEAN_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;          // x = cell size (m), y = level half extent (m)

uniform mat4 viewProjection;
#include<logDepthDeclaration>
` + SHARED_UNIFORMS + DEPTH_BILINEAR + SURF_GLSL + /* glsl */ `

varying vec3  vWorld;
varying vec3  vFlat;        // undisplaced world position
varying float vDist;
varying float vLevel;
varying float vDepth;
varying float vShoal;
varying float vBrk;         // 0..1 breaking intensity of the surf train
varying float vSurfAmp;     // local surf wave height (m)
varying float vLipT;        // 0..1 how far up the thrown lip this vertex is

float travelAt(vec2 p){
  if (uHasDepthMap < 0.5) return 0.0;
  vec2 uvd = (p - uDepthMapRect.xy) / uDepthMapRect.zw;
  return depthMapBilinear(clamp(uvd, 0.0, 1.0)).g;
}

float seabedAt(vec2 p){
  if (uHasDepthMap < 0.5) return -uDeepDepth;   // open ocean: no sea bed
  vec2 uvd = (p - uDepthMapRect.xy) / uDepthMapRect.zw;
  if (uvd.x < 0.0 || uvd.x > 1.0 || uvd.y < 0.0 || uvd.y > 1.0) return -uDeepDepth;
  return seabedOnly(uvd);
}

void main(){
  float cell = uv.x;
  float halfExtent = uv.y;

  // Each level snaps to its own 2-cell grid, the ring geometry overlaps its
  // inner neighbour by one cell so the two can never open a gap.
  vec2 origin = floor(uCamXZ / (2.0 * cell)) * (2.0 * cell);
  vec2 local  = position.xz;

  // CDLOD morph: within the outer band, odd vertices slide onto the even
  // (coarser) lattice so the level boundary matches its neighbour exactly.
  float cheb  = max(abs(local.x), abs(local.y));
  float morph = clamp((cheb / halfExtent - uMorphStart) / max(1.0 - uMorphStart, 1e-3), 0.0, 1.0);
  vec2 g = local / cell;
  local -= fract(g * 0.5) * 2.0 * cell * morph;

  // EFFECTIVE spacing after the morph.  Matching grid positions across a level
  // boundary is not enough: every distance-dependent term (which cascades this
  // vertex may displace by, which mip it reads) must be continuous too, or the
  // two levels agree on where the vertex is and disagree on how high the water
  // is there -- which tears a lit crack right around the ring.
  float cellEff = cell * (1.0 + morph);

  vec2 world2 = origin + local;
  vFlat = vec3(world2.x, uSeaLevel, world2.y);

  float dist = length(vec3(world2.x, uSeaLevel, world2.y) - uCamPos);
  vDist = dist;
  vLevel = log2(max(cell / uCascadeTexel.x, 1.0));
  // (cellEff is computed above, after the morph)

  // --- shoaling: waves grow then are cut off as the seabed rises ----------
  float seabed = seabedAt(world2);
  float depth = max(uSeaLevel - seabed, 0.0);
  vDepth = depth;
  // Ks = sqrt(c0/cg) grows into shallow water, clamp so nothing clips the beach
  float shoal = 1.0 + uShoreSteepen * (1.0 - smoothstep(2.0, 26.0, depth));
  shoal *= smoothstep(0.05, 2.2, depth);
  vShoal = shoal;

  // --- displacement from the cascades ------------------------------------
  vec3 disp = vec3(0.0);
  for (int c = 0; c < 3; ++c){
    float L = (c == 0) ? uCascadeL.x : ((c == 1) ? uCascadeL.y : uCascadeL.z);
    float tx = (c == 0) ? uCascadeTexel.x : ((c == 1) ? uCascadeTexel.y : uCascadeTexel.z);
    float on = (c == 0) ? uCascadeOn.x : ((c == 1) ? uCascadeOn.y : uCascadeOn.z);
    if (on < 0.5) continue;
    // a cascade whose detail the mesh cannot resolve is faded out here and
    // its slope variance is handed to the fragment roughness instead
    float w = clamp(L / (cellEff * 6.0) - 0.25, 0.0, 1.0);
    if (w <= 0.001) continue;
    float lod = max(0.0, log2(cellEff / tx));
    vec2 duv = world2 / L;
    vec3 d;
    if (c == 0)      d = textureLod(uDisp0, duv, lod).xyz;
    else if (c == 1) d = textureLod(uDisp1, duv, lod).xyz;
    else             d = textureLod(uDisp2, duv, lod).xyz;
    disp += d * w;
  }
  disp *= shoal;      // choppiness and wave scale are already baked in

  // --- shoaling / refracting / BREAKING shore waves -----------------------
  // The shore direction comes from the sea bed gradient, so the crest throws
  // itself up the slope wherever that happens to point -- around a headland it
  // fans out on its own.  Two extra depth taps buy the whole refraction.
  float dstep = max(uDepthMapRect.z / uDepthMapSize, 1.0) * 1.5;
  float dxp = max(uSeaLevel - seabedAt(world2 + vec2(dstep, 0.0)), 0.0);
  float dxm = max(uSeaLevel - seabedAt(world2 - vec2(dstep, 0.0)), 0.0);
  float dzp = max(uSeaLevel - seabedAt(world2 + vec2(0.0, dstep)), 0.0);
  float dzm = max(uSeaLevel - seabedAt(world2 - vec2(0.0, dstep)), 0.0);
  vec2 gradD = vec2(dxp - dxm, dzp - dzm);       // points toward deeper water
  float gl2 = length(gradD);
  vec2 shoreDir = gl2 > 1e-5 ? -gradD / gl2 : vec2(0.0, 0.0);

  float sEta, sBrk, sAmp, sCrest;
  vec2 sLean;
  surfWave(world2, depth, travelAt(world2), shoreDir, uTime,
           sEta, sBrk, sLean, sAmp, sCrest);
  vBrk = sBrk;
  vSurfAmp = sAmp;
  float crestT = sCrest;
  vLipT = crestT;

  disp.y += sEta;
  disp.xz += sLean;
  disp.y -= surfHook(sBrk, crestT, sAmp);

  // The player ripple field is NOT displaced as geometry.  Its texels are
  // 5 cm and the clipmap cells near the player are 25-50 cm, so the mesh
  // cannot resolve a footstep ring anyway -- and the edge of the field then
  // creases the surface into two dark wings trailing off to the horizon.
  // The ring is carried by the fragment SLOPE instead, which is local and
  // continuous, and by the foam channel.

  vec3 world = vec3(world2.x + disp.x, uSeaLevel + disp.y, world2.y + disp.z);
  vWorld = world;

#ifdef OCEAN_VELOCITY
  // The same lattice point, one frame earlier.  Sampling the previous
  // displacement rather than integrating a velocity keeps the horizontal
  // choppiness in the vector, which is most of a crest's screen motion.
  vec3 dispPrev = vec3(0.0);
  for (int c = 0; c < 3; ++c){
    float L = (c == 0) ? uCascadeL.x : ((c == 1) ? uCascadeL.y : uCascadeL.z);
    float tx = (c == 0) ? uCascadeTexel.x : ((c == 1) ? uCascadeTexel.y : uCascadeTexel.z);
    float on = (c == 0) ? uCascadeOn.x : ((c == 1) ? uCascadeOn.y : uCascadeOn.z);
    if (on < 0.5) continue;
    float w = clamp(L / (cellEff * 6.0) - 0.25, 0.0, 1.0);
    if (w <= 0.001) continue;
    float lod = max(0.0, log2(cellEff / tx));
    vec2 duv = world2 / L;
    vec3 d;
    if (c == 0)      d = textureLod(uDispPrev0, duv, lod).xyz;
    else if (c == 1) d = textureLod(uDispPrev1, duv, lod).xyz;
    else             d = textureLod(uDispPrev2, duv, lod).xyz;
    dispPrev += d * w;
  }
  dispPrev *= shoal;
  dispPrev.y += sEta;
  dispPrev.xz += sLean;
  vec3 worldPrev = vec3(world2.x + dispPrev.x, uSeaLevel + dispPrev.y,
                        world2.y + dispPrev.z);
  // Both clip positions come from UNJITTERED matrices.  Jitter is a sampling
  // offset, not motion: leaving it in gives every pixel a permanent sub-pixel
  // velocity, the history reprojects to the wrong texel every frame, and the
  // image crawls in place -- which reads as a broken velocity buffer and is
  // actually a correct one being asked the wrong question.
  vClipCur = uCurViewProjection * vec4(world, 1.0);
  vClipPrev = uPrevViewProjection * vec4(worldPrev, 1.0);
#endif

  gl_Position = viewProjection * vec4(world, 1.0);
#include<logDepthVertex>
  // Rings overlap by one cell so a half-cell difference in snapping origin can
  // never open a gap.  Resolve that tie in DEPTH, not in geometry: a relative
  // nudge is scale invariant, where a fixed vertical offset is invisible up
  // close and metres wrong at the far rings.
#ifdef LOGARITHMICDEPTH
  vFragmentDepth *= 1.0 + 4.0e-5 * (log2(cell) + 4.0);
#endif
}
`;

// ---------------------------------------------------------------------------
//  FRAGMENT
// ---------------------------------------------------------------------------
export const OCEAN_FRAG = /* glsl */ `
precision highp float;
#include<logDepthDeclaration>
` + ATMO_GLSL + SHARED_UNIFORMS + DEPTH_BILINEAR + SURF_GLSL + ATMO_UNIFORMS + /* glsl */ `

uniform sampler2D uMirror;      // planar reflection (rgb, a = coverage)
uniform sampler2D uRefract;     // submerged geometry (rgb, a = coverage)
uniform vec2  uScreen;
uniform float uProjScale;   // 0.5 / tan(fovY/2)

uniform vec3  uAbsorb;          // per-channel extinction (1/m)
uniform vec3  uScatterCol;      // volume scattering albedo
uniform float uScatterAmt;
uniform float uTurbid;
uniform float uFoamAmount;
uniform float uFoamShore;
uniform float uReflectAmount;
uniform float uRefractStrength;
uniform float uSSS;
uniform float uRainAmount;
uniform float uUnderwater;
uniform float uDebug;
uniform float uMirrorOn;
uniform float uRefractOn;
uniform float uMicroDetail;
uniform float uCapillaryVar;
uniform float uGlitter;
uniform float uFloorDepth;      // visual sandy bed, 0 = use uDeepDepth only
varying vec3  vWorld;
varying vec3  vFlat;
varying float vDist;
varying float vLevel;
varying float vDepth;
varying float vShoal;
varying float vBrk;
varying float vSurfAmp;
varying float vLipT;

// ---------------------------------------------------------------------------
// Sample first, branch second.  WGSL only allows an implicit-derivative
// texture read from UNIFORM control flow, so an early return in front of the
// fetch compiles fine on WebGL2 and fails outright on WebGPU.
// ---------------------------------------------------------------------------
// Screen-space offset for a lateral displacement measured in METRES.
//
// The naive version multiplies the wave slope straight into a screen UV.  Slope
// is a dimensionless gradient that routinely exceeds 1, so at close range that
// samples a fifth of the screen away: the buffer is read from somewhere else
// entirely, it clamps at the border, and the sea fills with hard-edged regions
// of the wrong colour and transparency -- exactly the screen-space refraction
// artefact this system exists to avoid.  A world length has to be converted by
// the real projection, and then bounded, because beyond a few percent of the
// screen there is nothing correct left to sample.
vec2 screenOffset(vec2 lateralM, float dist){
  float uvPerM = uProjScale / max(dist, 0.5);
  vec2 o = vec2(lateralM.x * uvPerM * (uScreen.y / max(uScreen.x, 1.0)),
                lateralM.y * uvPerM);
  return clamp(o, vec2(-0.03), vec2(0.03));
}

float seabedAtF(vec2 p){
  vec2 uvd = (p - uDepthMapRect.xy) / uDepthMapRect.zw;
  float inside = step(0.0, uvd.x) * step(uvd.x, 1.0) *
                 step(0.0, uvd.y) * step(uvd.y, 1.0) * step(0.5, uHasDepthMap);
  float h = seabedOnly(clamp(uvd, 0.0, 1.0));
  return mix(-uDeepDepth, h, inside);
}

// Rain rings: hashed cells each spawning an expanding ring.  GPU only -- the
// alternative (thousands of ripple meshes) is a CPU death sentence.
vec2 rainRipple(vec2 p, float t, float amount){
  if (amount < 0.01) return vec2(0.0);
  vec2 acc = vec2(0.0);
  for (int L = 0; L < 2; ++L){
    float sc = (L == 0) ? 1.6 : 3.7;
    vec2 q = p * sc;
    vec2 c = floor(q), f = fract(q);
    for (int j = 0; j < 4; ++j){
      vec2 o = vec2(float(j - (j / 2) * 2), float(j / 2));
      vec2 id = c + o;
      float h = ahash21(id * 1.13 + float(L) * 7.7);
      float h2 = ahash21(id * 2.71 + float(L) * 3.1);
      float life = fract(t * (0.85 + 0.4 * h2) + h);
      if (h2 > amount * 0.85) continue;
      vec2 cen = o + vec2(h, h2) * 0.8;
      float d = length(f - cen);
      float r = life * 0.42;
      float ring = exp(-pow((d - r) * 26.0, 2.0)) * (1.0 - life) * (1.0 - life);
      acc += normalize(f - cen + 1e-5) * ring;
    }
  }
  return acc * 0.9 * amount;
}

// GGX with a spherical light source (the sun subtends 0.53 deg) -- this is
// what turns a single hot spot into the recognisable glitter path.
float ggxSun(vec3 N, vec3 V, vec3 L, float rough){
  float a = max(rough * rough, 1.6e-4);
  vec3 H = normalize(V + L);
  float NoH = max(dot(N, H), 0.0);
  float NoV = max(dot(N, V), 1e-4);
  float NoL = max(dot(N, L), 0.0);
  // widen the distribution by the sun disc solid angle
  float aw = clamp(a + 0.0038, 0.0, 1.0);
  float d = (NoH * NoH * (aw * aw - 1.0) + 1.0);
  float D = aw * aw / (PI * d * d);
  float k = a * 0.5;
  float gv = NoV / (NoV * (1.0 - k) + k);
  float gl = NoL / (NoL * (1.0 - k) + k);
  return D * gv * gl / max(4.0 * NoV * NoL, 1e-4) * NoL;
}

vec3 fresnelSchlick(float c, vec3 f0, float rough){
  return f0 + (max(vec3(1.0 - rough), f0) - f0) * pow(clamp(1.0 - c, 0.0, 1.0), 5.0);
}

void main(){
#include<logDepthFragment>
  vec3 V = uCamPos - vWorld;
  float dist = length(V);
  V /= max(dist, 1e-4);

  // ---- pixel footprint drives every band limit ---------------------------
  float fp = max(fwidth(vFlat.x), fwidth(vFlat.z)) + 1e-4;

  // ---- normal from the cascades -----------------------------------------
  vec2 slope = vec2(0.0);
  float jac = 1.0, foamW = 0.0, lostVar = 0.0;
  for (int c = 0; c < 3; ++c){
    float L  = (c == 0) ? uCascadeL.x : ((c == 1) ? uCascadeL.y : uCascadeL.z);
    float tx = (c == 0) ? uCascadeTexel.x : ((c == 1) ? uCascadeTexel.y : uCascadeTexel.z);
    float on = (c == 0) ? uCascadeOn.x : ((c == 1) ? uCascadeOn.y : uCascadeOn.z);
    float sv = (c == 0) ? uSlopeVar.x : ((c == 1) ? uSlopeVar.y : uSlopeVar.z);
    if (on < 0.5) continue;
    float w = clamp(1.6 - fp / (tx * 2.2), 0.0, 1.0);
    lostVar += (1.0 - w) * sv;
    vec2 duv = vFlat.xz / L;
    // no early-out around the fetch: see seabedAtF above
    vec4 d;
    if (c == 0)      d = texture2D(uDeriv0, duv);
    else if (c == 1) d = texture2D(uDeriv1, duv);
    else             d = texture2D(uDeriv2, duv);
    slope += d.xy * w;
    jac = min(jac, mix(1.0, d.z, step(0.001, w)));
    foamW = max(foamW, d.w * w);
  }
  // Shoaling must kill the DISPLACEMENT at the waterline (or waves poke
  // through the sand) but not the NORMAL: 20 cm of water over sand is still
  // covered in ripples.  Scaling both by the same factor planes every shallow
  // shot into a flat pale sheet -- which is where a beach scene spends all of
  // its time, so it is the first thing anyone sees.
  slope *= max(vShoal, 0.38);

  // sub-texel ripple detail: keeps close-ups from going glassy without ever
  // stretching one normal map over the sea
  if (uMicroDetail > 0.01 && fp < 0.35){
    float md = clamp(1.0 - fp / 0.35, 0.0, 1.0) * uMicroDetail;
    vec2 w1 = uWindDir * uTime * 0.9;
    float e = 0.06;
    vec2 p = vFlat.xz;
    float n0 = fbm2((p + w1) * 1.35, 3);
    float nx = fbm2((p + vec2(e, 0.0) + w1) * 1.35, 3);
    float nz = fbm2((p + vec2(0.0, e) + w1) * 1.35, 3);
    slope += vec2(nx - n0, nz - n0) / e * 0.085 * md * (0.35 + 0.65 * min(uWindSpeed / 12.0, 1.0));
  }

  // rain rings + wake ripples
  vec2 dist2 = rainRipple(vFlat.xz, uTime, uRainAmount);
  slope += dist2 * clamp(1.0 - fp / 0.6, 0.0, 1.0);

  float wake = 0.0;
  {
    // coarse field: boat wakes, rain rings, anything far from the player
    vec2 duv = (vFlat.xz - uDisturbRect.xy) / uDisturbRect.z + 0.5;
    vec2 de = abs(duv - 0.5) * 2.0;
    float inD = (1.0 - smoothstep(0.62, 0.96, max(de.x, de.y))) * step(0.5, uDisturbRect.w);
    vec2 cd = clamp(duv, 0.0, 1.0);
    vec4 dd = texture2D(uDisturb, cd);
    float hx = texture2D(uDisturb, cd + vec2(1.0 / 512.0, 0.0)).y;
    float hz = texture2D(uDisturb, cd + vec2(0.0, 1.0 / 512.0)).y;
    wake = dd.x * inD;
    float t = uDisturbRect.z / 512.0;
    slope += vec2(hx - dd.y, hz - dd.y) / max(t, 1e-3) * 0.7 * inD;

    // fine field: the player.  Centimetre texels, so its slope contribution is
    // the one that actually shows a footstep ring.
    vec2 ruv = (vFlat.xz - uRippleRect.xy) / uRippleRect.z + 0.5;
    vec2 re = abs(ruv - 0.5) * 2.0;
    float inR = (1.0 - smoothstep(0.55, 0.95, max(re.x, re.y))) * step(0.5, uRippleRect.w);
    vec2 cr = clamp(ruv, 0.0, 1.0);
    vec4 rr = texture2D(uRipple, cr);
    float rx = texture2D(uRipple, cr + vec2(1.0 / 512.0, 0.0)).y;
    float rz = texture2D(uRipple, cr + vec2(0.0, 1.0 / 512.0)).y;
    wake = max(wake, rr.x * inR);
    float tr = uRippleRect.z / 512.0;
    slope += vec2(rx - rr.y, rz - rr.y) / max(tr, 1e-3) * 0.9 * inR;
  }

  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  bool underwater = uUnderwater > 0.5 || uCamPos.y < uSeaLevel;
  vec3 Ns = N;
  if (underwater) N = -N;

  // ---- water depth -------------------------------------------------------
  float seabed = seabedAtF(vFlat.xz);
  float depth = max(uSeaLevel - seabed, 0.0);
  // The FFT sea is deep water.  The sandy bed is a VISUAL floor so a dive
  // has something to look at -- it must not shoal the vertices, but the
  // optical path through the water has to stop there or the bottom is
  // attenuated to black (220 m of Atlantic) and the sand never reads.
  float column = (uFloorDepth > 0.5) ? min(depth, uFloorDepth) : depth;

  // ---- roughness ---------------------------------------------------------
  // Unresolved slope variance becomes microfacet roughness: the physically
  // honest way to keep distant water from aliasing AND to grow the glitter
  // path.  uCapillaryVar is the variance the SIMULATION never had -- ripples
  // below the finest cascade texel.  Without that floor the near surface is a
  // perfect mirror and the sun reflection blows out half the frame.
  // Do NOT double the variance: *2 pushed near-camera alpha to ~0.16, the GGX
  // lobe went dull, and the glitter vanished into the body colour.
  float rough = sqrt(clamp(lostVar + uCapillaryVar, 0.0, 0.28));
  rough += 0.040 * uStorm + 0.028 * uRainAmount;
  rough = clamp(rough, 0.018, 0.55);

  vec3 sunCol = uSunColor * uSunI;
  vec3 moonCol = uMoonColor * uMoonI;
  float shadow = cloudShadow(vFlat.xz, uSunDir, uCloudCover, uStorm, uCloudDrift);

  // =======================================================================
  //  UNDERWATER side of the surface
  // =======================================================================
  // ONE exit for the whole shader.  Babylon assigns the WGSL output struct
  // after the user body when it transpiles, so an early return in the
  // underwater branch is skipped and the above-water code runs on top of it --
  // the underwater view is then simply wrong on WebGPU and right on WebGL2.
  vec3 outCol = vec3(0.0);
  if (underwater){
    vec3 I = -V;
    float eta = 1.0 / 1.333;
    vec3 R = refract(I, N, 1.0 / eta);   // water -> air
    float cosI = dot(-I, N);
    vec3 col;
    if (dot(R, R) < 1e-5 || cosI <= 0.0){
      // total internal reflection: the sea floor mirrored back down
      col = uScatterCol * uScatterAmt * I_PI * SUN_E * (0.15 + 0.35 * max(uSunDir.y, 0.0));
    } else {
      vec3 sky = skyRadiance(vec3(vWorld.x, 0.6, vWorld.z), R, uSunDir, uSunColor, uSunI,
                             uMoonDir, uMoonColor, uMoonI, uTurbidity, uCloudCover,
                             uCloudSharp, uCloudBright, uStorm, uCloudDrift, uFlash, true);
      float f = clamp(pow(1.0 - cosI, 5.0), 0.0, 1.0);
      col = sky * (1.0 - f * 0.9);
      // Snell window rim
      col += sunCol * 0.5 * pow(clamp(1.0 - abs(dot(R, N)), 0.0, 1.0), 8.0);
    }
    col += foamW * uFoamAmount * (sunCol * 0.25 + vec3(0.05, 0.09, 0.12)) * 0.7;
    // attenuate over the distance from the eye to the surface
    float d2 = min(dist, 220.0);
    vec3 tw = exp(-(uAbsorb + uTurbid * 0.06) * d2);
    vec3 inScat = uScatterCol * uScatterAmt * I_PI * SUN_E *
                  (sunCol * max(uSunDir.y, 0.05) * 0.6 + 0.06);
    col = col * tw + inScat * (1.0 - tw);
    outCol = max(col, 0.0);
  }

  // =======================================================================
  //  ABOVE water
  // =======================================================================
  if (!underwater){
  float NoV = clamp(dot(N, V), 1e-3, 1.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) * 0.06 + R.y * 0.94 + 0.006;   // keep grazing rays off the ground
  R = normalize(R);

  // ---- reflection: analytic sky, planar mirror where geometry exists -----
  vec3 refl = skyRadiance(vec3(vWorld.x, max(vWorld.y, 0.4), vWorld.z), R,
                          uSunDir, uSunColor, uSunI, uMoonDir, uMoonColor, uMoonI,
                          uTurbidity, uCloudCover, uCloudSharp, uCloudBright,
                          uStorm, uCloudDrift, uFlash, false);
  // roughness blurs the reflection toward the average sky
  vec3 upSky = skyRadiance(vec3(vWorld.x, max(vWorld.y, 0.4), vWorld.z),
                           normalize(vec3(R.x * 0.35, 0.55, R.z * 0.35)),
                           uSunDir, uSunColor, uSunI, uMoonDir, uMoonColor, uMoonI,
                           uTurbidity, uCloudCover, uCloudSharp, uCloudBright,
                           uStorm, uCloudDrift, uFlash, false);
  refl = mix(refl, upSky, clamp(rough * 1.15, 0.0, 0.62));

  vec2 sUV = gl_FragCoord.xy / uScreen;
  if (uMirrorOn > 0.5){
    // the mirror ripple is the surface tilt seen over the reflected path
    vec2 off = screenOffset(vec2(-slope.x, -slope.y) * min(dist, 30.0) * 0.05, dist);
    vec4 mrOff = texture2D(uMirror, clamp(sUV + off, 0.002, 0.998));
    vec4 mrStr = texture2D(uMirror, sUV);
    vec4 mr = mix(mrStr, mrOff, step(0.5, mrOff.a));
    refl = mix(refl, mr.rgb, mr.a * uReflectAmount * clamp(1.0 - rough * 1.4, 0.0, 1.0));
  }

  // ---- sun + moon glitter ------------------------------------------------
  // Direct sun uses the SAME irradiance unit as every other lit surface
  // (SUN_E).  The earlier disc-radiance * solid-angle form (42 * 6.8e-5) was
  // physically tidy and ~8000x too dim after ACES: the sea read as matte
  // plastic while the sky disc stayed a white fireball.  VoH is the microfacet
  // Fresnel argument, not NoV -- NoV made every nadir pixel F0 = 0.02 even
  // where a facet was actually reflecting the sun.
  vec3 Hsun = normalize(V + uSunDir);
  vec3 Fspec = fresnelSchlick(NoV, vec3(0.020, 0.020, 0.021), rough);
  vec3 Fsun  = fresnelSchlick(max(dot(V, Hsun), 0.0), vec3(0.020, 0.020, 0.021), rough);
  vec3 sunWarm = mix(vec3(1.0, 0.52, 0.22), vec3(1.0, 0.97, 0.92),
                     smoothstep(0.06, 0.42, uSunDir.y));
  // Two lobes: a sharp one for the thousands of glints, a wider one that
  // grows with unresolved slope variance so the glitter PATH appears at
  // distance instead of a single blown-out disc.
  float gSharp = ggxSun(N, V, uSunDir, max(rough * 0.42, 0.016));
  float gWide  = ggxSun(N, V, uSunDir, clamp(rough * 1.65, 0.05, 0.48));
  vec3 spec = sunCol * sunWarm * SUN_E
              * (gSharp * 1.65 + gWide * (0.35 + 2.4 * rough))
              * Fsun * shadow * uGlitter;
  spec += moonCol * SUN_E * ggxSun(N, V, uMoonDir, rough)
          * Fspec * uGlitter * 0.35;
  float specL = dot(spec, vec3(0.299, 0.587, 0.114));
  spec *= 1.0 / (1.0 + specL * 0.045);

  // ---- refraction / body colour -----------------------------------------
  vec3 refrDir = refract(-V, N, 1.0 / 1.333);
  float downY = max(-refrDir.y, 0.12);
  float pathLen = min(column / downY, 320.0);
  float sunPath = min(column / max(uSunDir.y, 0.18), 420.0);
  vec3 ext = uAbsorb + vec3(uTurbid * 0.05);

  vec3 seabedCol = vec3(0.0);
  float seabedA = 0.0;
  if (uRefractOn > 0.5){
    // Snell: the ray bends by ~(1 - 1/1.333) of the slope, over the water
    // column below this point, so the lateral shift is a real length in metres.
    float lateral = uRefractStrength * min(depth, 8.0) * 0.25;
    vec2 roff = screenOffset(vec2(-slope.x, -slope.y) * lateral, dist);
    // A screen-space fetch has no data outside the frame.  Clamping the offset
    // uv to the border reads whatever happens to be in the edge texels, and
    // where that is uncovered the shader switches to the ANALYTIC seabed --
    // a different colour and transparency, with a hard edge, in a band that
    // hugs the side of the screen.  Fall back to the UN-OFFSET sample instead:
    // slightly less refracted, still the same seabed.  Both fetches are
    // unconditional because WGSL only allows implicit derivatives in uniform
    // control flow.
    vec4 rfOff = texture2D(uRefract, clamp(sUV + roff, 0.002, 0.998));
    vec4 rfStr = texture2D(uRefract, sUV);
    vec4 rf = mix(rfStr, rfOff, step(0.5, rfOff.a));
    seabedCol = rf.rgb;
    // Feather the COVERAGE.  Its edge is the real waterline silhouette on the
    // sea bed, but on one side the shader uses the rendered buffer and on the
    // other an analytic sand model, and the two do not land on the same colour
    // -- so a correct silhouette still draws a hard-edged region across the
    // water.  Averaging the alpha over a few texels turns the switch into a
    // gradient, which is what a metre of water either side of a waterline
    // actually looks like.
    vec2 fe = 2.0 / uScreen;
    float aSum = rf.a
      + texture2D(uRefract, clamp(sUV + vec2( fe.x,  fe.y), 0.002, 0.998)).a
      + texture2D(uRefract, clamp(sUV + vec2(-fe.x,  fe.y), 0.002, 0.998)).a
      + texture2D(uRefract, clamp(sUV + vec2( fe.x, -fe.y), 0.002, 0.998)).a
      + texture2D(uRefract, clamp(sUV + vec2(-fe.x, -fe.y), 0.002, 0.998)).a;
    seabedA = aSum * 0.2;
  }
  // Irradiance reaching the surface, in the ONE unit the sky uses (SUN_E).
  vec3 sunE = sunCol * SUN_E * max(uSunDir.y, 0.0) * shadow;
  vec3 skyE = upSky * 3.1 + moonCol * SUN_E * max(uMoonDir.y, 0.0) * 0.4;

  // fallback: analytic sand once the refraction buffer has nothing there
  // the bed under water is WET sand: albedo ~0.2, not the 0.35 of dry sand
  vec3 sandCol = vec3(0.215, 0.195, 0.150) * I_PI * (sunE + skyE);
  seabedCol = mix(sandCol * clamp(1.0 - column / 30.0, 0.0, 1.0), seabedCol, seabedA);

  vec3 through = exp(-ext * (pathLen + sunPath * 0.55));
  // uScatterCol is a diffuse water-leaving REFLECTANCE (a few per cent, blue
  // biased) -- the sea is dark, and everything that makes it look bright is
  // reflection.  Treating it as an emissive colour is what produces poster
  // paint blue.
  vec3 volume = uScatterCol * uScatterAmt * I_PI * (sunE * 0.62 + skyE);
  vec3 body = seabedCol * through + volume * (1.0 - exp(-ext * pathLen * 1.6));

  // subsurface glow on the sun-facing back of a crest
  float hAbove = clamp((vWorld.y - uSeaLevel) / max(uWaveScale, 0.2), 0.0, 2.0);
  float back = pow(clamp(dot(V, -normalize(vec3(uSunDir.x, -abs(uSunDir.y) * 0.35, uSunDir.z))), 0.0, 1.0), 3.0);
  body += uScatterCol * sunE * I_PI * back * hAbove * uSSS * 6.0;

  // ---- Fresnel -----------------------------------------------------------
  float fAmt = clamp(Fspec.g, 0.0, 1.0);
  vec3 col = mix(body, refl, fAmt) + spec;

  // ---- foam --------------------------------------------------------------
  float shoreBand = 0.0;
  float dbgN = 0.0, dbgNear = 0.0, dbgBand = 0.0;
  if (depth < 60.0){
    // phase advances with the shallow-water celerity, so foam lines follow the
    // real depth contours -- i.e. the actual coastline, never a straight band
    float cel = sqrt(9.81 * max(depth, 0.12));
    float ph = depth * 0.62 - uTime * cel * 0.16;
    float n = fbm2(vFlat.xz * 0.16, 3);
    float band = sin(ph * 3.1 + n * 3.4);
    band = pow(clamp(band * 0.5 + 0.5, 0.0, 1.0), 2.6);
    float near = smoothstep(9.0, 0.4, depth);
    dbgN = n; dbgNear = near; dbgBand = band;
    shoreBand = band * near * uFoamShore;
    shoreBand += smoothstep(1.4, 0.02, depth) * uFoamShore * (0.55 + 0.45 * n);
    shoreBand *= 1.0 - smoothstep(0.35, 0.0, depth);   // dry sand keeps no foam
    // Where the surf train is running it OWNS the foam: this analytic band was
    // a stand-in for breaking waves before there were any, and left at full
    // strength it stacks on top of them and washes the whole surf zone pale.
    shoreBand *= clamp(1.0 - vSurfAmp * 0.75, 0.18, 1.0);
  }

  // Whitewater from the breaker itself.  vBrk is the physical breaking
  // intensity (how far the wave is past the depth limit) and vLipT says how far
  // up the thrown crest this fragment sits, so the foam lands ON the lip and
  // the face below it stays clear -- not a white band along every crest.
  float ww = vBrk * smoothstep(0.30, 0.92, vLipT) * uWhitewater;
  // break it up so it never reads as paint: holes, cores and torn edges
  float wn = fbm2(vFlat.xz * 0.9 + uWindDir * uTime * 0.35, 4);
  float wn2 = fbm2(vFlat.xz * 3.7 - uWindDir * uTime * 0.9, 3);
  ww *= clamp(0.35 + 1.5 * wn, 0.0, 1.4) * clamp(0.55 + 0.9 * wn2, 0.0, 1.35);
  ww = clamp(ww, 0.0, 1.0);

  float foam = clamp(foamW * uFoamAmount + shoreBand + wake * 0.9 + ww, 0.0, 1.0);
  foam *= clamp(0.35 + 0.65 * fbm2(vFlat.xz * 1.6 + uWindDir * uTime * 0.4, 3) * 2.0, 0.0, 1.0);
  foam = clamp(foam, 0.0, 1.0);
  if (foam > 0.001){
    float fn = fbm2(vFlat.xz * 5.5 + uWindDir * uTime * 0.5, 3);
    vec3 foamN = normalize(vec3(-slope.x * 0.3 + (fn - 0.5) * 0.6, 1.0, -slope.y * 0.3));
    // Dense whitewater is a lit volume of air and water, so it darkens inside
    // and keeps a blue ambient -- foam that is uniformly white reads as paint.
    float dense = clamp(ww * 1.4, 0.0, 1.0);
    vec3 foamCol = (sunCol * (0.25 + 0.65 * max(dot(foamN, uSunDir), 0.0)) * shadow
                    + refl * 0.16 + moonCol * 0.30) * (0.78 + 0.22 * fn);
    foamCol *= mix(1.0, 0.62 + 0.38 * wn2, dense);          // internal shadow
    foamCol += uScatterCol * sunE * I_PI * dense * 0.35;     // scattered through
    col = mix(col, foamCol, foam * smoothstep(0.0, 0.2, foam + 0.05));
  }

  // ---- aerial perspective (cover-matched -> no bright horizon band) -----
  vec3 inscat, trans;
  aerial(uCamPos, -V, dist, uSunDir, uSunColor, uSunI, uTurbidity, uStorm, uCloudCover, inscat, trans);
  col = col * trans + inscat;

  // rain veil, range limited or every storm becomes a grey pancake from above
  if (uRainAmount > 0.01){
    float veil = uRainAmount * 0.30 * (1.0 - exp(-dist / 900.0)) * smoothstep(3000.0, 300.0, dist);
    col = mix(col, (sunCol * 0.10 + vec3(0.05, 0.07, 0.09)) * (0.4 + 0.6 * shadow), veil);
  }
  col += vec3(0.85, 0.9, 1.0) * uFlash * 0.20 * (0.3 + 0.7 * fAmt);

  // ---- debug channels ----------------------------------------------------
  if (uDebug > 0.5){
    if (uDebug < 1.5)      col = vec3(vWorld.y - uSeaLevel) * 0.25 + 0.5;
    else if (uDebug < 2.5) col = Ns * 0.5 + 0.5;
    else if (uDebug < 3.5) col = vec3(clamp(1.0 - jac, 0.0, 1.0));
    else if (uDebug < 4.5) col = vec3(foam);
    else if (uDebug < 5.5) col = vec3(depth / 60.0, depth / 300.0, 1.0 - depth / 20.0);
    else if (uDebug < 6.5){
      float l = vLevel;
      col = 0.5 + 0.5 * cos(6.2831 * (l * 0.14 + vec3(0.0, 0.33, 0.67)));
      col *= 0.35 + 0.65 * fract(vFlat.x / max(fp * 40.0, 0.01));
    }
    else if (uDebug < 7.5) col = refl;
    else if (uDebug < 8.5) col = mix(vec3(0.0), seabedCol, seabedA);
    else if (uDebug < 9.5) col = vec3(rough * 4.0);
    else if (uDebug < 10.5) col = vec3(shoreBand, foamW, wake);
    else if (uDebug < 11.5) col = vec3(dbgN, dbgNear, dbgBand);
    else                   col = vec3(vBrk, vLipT, clamp(vSurfAmp * 0.5, 0.0, 1.0));
  }

  outCol = max(col, 0.0);
  }

  gl_FragColor = vec4(outCol, 1.0);
}
`;
