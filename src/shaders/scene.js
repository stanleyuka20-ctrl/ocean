// ---------------------------------------------------------------------------
//  scene.js -- GLSL for everything that is not the water surface: the sky
//  dome, the island / seabed / props (one lit surface shader), and the
//  underwater full-screen pass.
//
//  They all include the same atmosphere module as the ocean, so land, sea and
//  sky are lit by one integral and the horizon cannot seam.
// ---------------------------------------------------------------------------

import { ATMO_GLSL } from "./atmosphere.js";

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
uniform float uTime;
uniform vec2  uCloudDrift;
`;

// ===========================================================================
//  SKY DOME
// ===========================================================================
export const SKY_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 viewProjection;
uniform mat4 world;
uniform vec3 uCamPos;
varying vec3 vDir;
void main(){
  // The dome is a unit sphere: its LOCAL position is the view direction.  Using
  // the world-space position instead picks up the camera translation and aims
  // every ray at the same point.
  vDir = normalize(position);
  gl_Position = viewProjection * vec4(uCamPos + vDir * 40000.0, 1.0);
  gl_Position.z = gl_Position.w * 0.999999;    // pin to the far plane
}
`;

export const SKY_FRAG = /* glsl */ `
precision highp float;
` + ATMO_GLSL + ATMO_UNIFORMS + /* glsl */ `
uniform vec3 uCamPos;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  vec3 col = skyRadiance(uCamPos, d, uSunDir, uSunColor, uSunI, uMoonDir, uMoonColor,
                         uMoonI, uTurbidity, uCloudCover, uCloudSharp, uCloudBright,
                         uStorm, uCloudDrift, uFlash, true);
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

// ===========================================================================
//  LIT SURFACE (island, seabed, rocks, pier, boat, floats)
// ===========================================================================
export const SURFACE_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
#ifdef VERTEXCOLOR
attribute vec4 color;
varying vec4 vColor;
#endif
uniform mat4 world;
uniform mat4 viewProjection;
#include<logDepthDeclaration>
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUV;
void main(){
  vec4 wp = world * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(world) * normal);
  vUV = uv;
#ifdef VERTEXCOLOR
  vColor = color;
#endif
  gl_Position = viewProjection * wp;
#include<logDepthVertex>
}
`;

// Camera-following sandy bed.  Wave physics stay deep-water; this mesh is
// only a visual floor so a dive is not a void.
export const SEAFLOOR_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
uniform mat4 world;
uniform mat4 viewProjection;
uniform float uSeaLevel;
uniform float uFloorDepth;
uniform float uDune;
#include<logDepthDeclaration>
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUV;

float hash21(vec2 p){
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float duneH(vec2 p){
  float h = 0.0, w = 0.55;
  vec2 q = p * 0.028;
  for (int i = 0; i < 4; i++){
    h += w * vnoise(q);
    q *= 2.07;
    w *= 0.5;
  }
  return (h - 0.5) * 2.0;
}

void main(){
  vec4 wp = world * vec4(position, 1.0);
  float e = 1.6;
  float h0 = duneH(wp.xz);
  float hx = duneH(wp.xz + vec2(e, 0.0));
  float hz = duneH(wp.xz + vec2(0.0, e));
  wp.y = uSeaLevel - uFloorDepth + h0 * uDune;
  vec3 n = normalize(vec3(-(hx - h0) * uDune / e, 1.0, -(hz - h0) * uDune / e));
  vWorld = wp.xyz;
  vNormal = n;
  vUV = uv;
  gl_Position = viewProjection * wp;
#include<logDepthVertex>
}
`;

export const SURFACE_FRAG = /* glsl */ `
precision highp float;
#define SKY_VIEW_STEPS 5
#define SKY_LIGHT_STEPS 3
#define CLOUD_STEPS 3
#include<logDepthDeclaration>
` + ATMO_GLSL + ATMO_UNIFORMS + /* glsl */ `
uniform vec3  uCamPos;
uniform float uSeaLevel;
uniform float uClipMode;
uniform float uClipTop;   // metres of wave crest the refraction clip allows
uniform float uKind;
uniform float uRough;
uniform float uMetal;
uniform vec3  uBaseColor;
uniform vec3 uAbsorb;
uniform vec3 uScatterCol;
uniform float uScatterAmt;
uniform float uTurbid;
uniform float uCaustics;
uniform float uWetness;
uniform float uUnderwaterView;
uniform float uWetTop;      // world Y of the highest point that has been wet
uniform float uWetAmt;      // 0..1, dries off over time
uniform float uWetSoak;     // per-material: cotton drinks, rubber does not
uniform sampler2D uFootprint;
uniform vec4  uFootRect;
// ocean cascades, used for caustics and for the wet/foam line
uniform sampler2D uDeriv1;
uniform sampler2D uDeriv2;
uniform vec3  uCascadeL;
uniform float uWaveScale;
uniform float uCamDepth;
uniform float uMaxCausticDepth;

varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUV;
#ifdef VERTEXCOLOR
varying vec4 vColor;
#endif

// --- procedural ground -----------------------------------------------------
vec3 groundAlbedo(vec3 p, vec3 n, out float rough){
  float slope = 1.0 - clamp(n.y, 0.0, 1.0);
  float h = p.y - uSeaLevel;

  float gn = fbm2(p.xz * 0.09, 4);
  float fine = fbm2(p.xz * 1.7, 3);

  // Sand is not a flat colour: shell grit, damp patches and drift lines are
  // what stop a wide beach reading as a white plane.
  float grit = fbm2(p.xz * 5.5, 3);
  float drift = fbm2(p.xz * vec2(0.35, 0.9) + 17.0, 3);
  vec3 sandDry = vec3(0.345, 0.305, 0.238)
                 * (0.72 + 0.36 * fine + 0.22 * grit)
                 * (0.88 + 0.24 * smoothstep(0.42, 0.62, drift));
  vec3 sandWet = vec3(0.24, 0.20, 0.15) * (0.9 + 0.2 * fine);
  vec3 rock    = mix(vec3(0.27, 0.25, 0.24), vec3(0.40, 0.38, 0.35), gn) * (0.8 + 0.4 * fine);
  vec3 grass   = mix(vec3(0.16, 0.24, 0.10), vec3(0.28, 0.34, 0.15), gn);
  vec3 seabed  = mix(vec3(0.62, 0.50, 0.32), vec3(0.38, 0.32, 0.20), clamp(-h / 28.0, 0.0, 1.0));
  float rip = 0.86 + 0.22 * sin(dot(p.xz, vec2(0.72, 0.54)) * 1.8 + fbm2(p.xz * 0.40, 2) * 3.1);
  float shells = smoothstep(0.72, 0.92, grit);
  seabed *= (0.84 + 0.28 * grit) * rip;
  seabed = mix(seabed, vec3(0.46, 0.40, 0.30), shells * 0.35);
  seabed = mix(seabed, rock * 0.78, smoothstep(0.38, 0.78, slope));
  // sedimentary benches and vertical grooves on cliffs (triplanar so steep
  // faces do not stretch the XZ grain into stripes)
  float layers = 0.5 + 0.5 * sin(p.y * 0.42 + fbm2(p.xz * 0.05, 2) * 2.4);
  float grooves = fbm2(vec2(p.y * 0.55, p.z * 0.18 + p.x * 0.18), 3);
  float cliff = smoothstep(0.42, 0.82, slope);
  rock = mix(rock, rock * (0.72 + 0.40 * layers) * (0.82 + 0.28 * grooves), cliff);
  vec3 mud = vec3(0.16, 0.15, 0.12) * (0.85 + 0.25 * fine);
  float deepBed = smoothstep(80.0, 420.0, max(-h, 0.0));
  seabed = mix(seabed, mix(rock, mud, 0.45), cliff);
  seabed = mix(seabed, mud * 0.9, deepBed * (1.0 - cliff * 0.5));

  float rockM  = smoothstep(0.30, 0.62, slope + gn * 0.22 - 0.08);
  float grassM = smoothstep(5.0, 13.0, h) * (1.0 - rockM) * smoothstep(0.55, 0.2, slope);

  vec3 c;
  if (h > 0.0){
    float wet = smoothstep(uWetness + 0.35, uWetness - 0.55, h);
    c = mix(sandDry, sandWet, wet);
    c = mix(c, rock, rockM);
    c = mix(c, grass, grassM);
    rough = mix(mix(0.86, 0.30, wet), 0.75, rockM);
  } else {
    c = seabed;
    rough = 0.80;
  }
  return c;
}

// Optical caustics from the REAL wave slopes.  Sample first, gate after:
// WGSL rejects textureSample in non-uniform control flow, and a mip of the
// FFT lattice is an axis-aligned square that 1/|J| paints white.
float causticsAt(vec3 p){
  float depth = uSeaLevel - p.y;
  vec3 sd = uSunDir;
  vec2 entry = p.xz + sd.xz / max(sd.y, 0.06) * max(depth, 0.05);
  vec2 warp = vec2(fbm2(entry * 0.065 + 4.1, 3), fbm2(entry * 0.065 + 19.7, 3)) - 0.5;
  entry += warp * (2.4 + depth * 0.14);

  float soft = 3.6 + max(depth, 0.0) * 0.72;
  vec2 t0 = vec2(1.0, 0.0);
  vec2 t1 = vec2(0.70710678, 0.70710678);
  vec2 t2 = vec2(0.9238795, 0.3826834);
  vec2 t3 = vec2(-0.3826834, 0.9238795);

  float L1 = max(uCascadeL.y, 1.0);
  float e1 = soft / 256.0;
  vec2 uv1 = entry / L1;
  float d1 = 0.0;
  d1 += dot(textureLod(uDeriv1, uv1 + t0 * e1, 0.0).xy - textureLod(uDeriv1, uv1 - t0 * e1, 0.0).xy, t0);
  d1 += dot(textureLod(uDeriv1, uv1 + t1 * e1, 0.0).xy - textureLod(uDeriv1, uv1 - t1 * e1, 0.0).xy, t1);
  d1 += dot(textureLod(uDeriv1, uv1 + t2 * e1, 0.0).xy - textureLod(uDeriv1, uv1 - t2 * e1, 0.0).xy, t2);
  d1 += dot(textureLod(uDeriv1, uv1 + t3 * e1, 0.0).xy - textureLod(uDeriv1, uv1 - t3 * e1, 0.0).xy, t3);
  d1 *= 0.125 / max(e1, 1e-5);

  float L2 = max(uCascadeL.z, 1.0);
  float e2 = soft / 256.0;
  vec2 uv2 = entry / L2;
  float d2v = 0.0;
  d2v += dot(textureLod(uDeriv2, uv2 + t0 * e2, 0.0).xy - textureLod(uDeriv2, uv2 - t0 * e2, 0.0).xy, t0);
  d2v += dot(textureLod(uDeriv2, uv2 + t1 * e2, 0.0).xy - textureLod(uDeriv2, uv2 - t1 * e2, 0.0).xy, t1);
  d2v += dot(textureLod(uDeriv2, uv2 + t2 * e2, 0.0).xy - textureLod(uDeriv2, uv2 - t2 * e2, 0.0).xy, t2);
  d2v += dot(textureLod(uDeriv2, uv2 + t3 * e2, 0.0).xy - textureLod(uDeriv2, uv2 - t3 * e2, 0.0).xy, t3);
  d2v *= 0.125 / max(e2, 1e-5);

  float w2 = smoothstep(14.0, 4.0, depth);
  float div = (d1 + d2v * w2) / max(1.0 + w2, 1e-4) * uWaveScale;
  float k = 0.255 * max(depth, 0.0);
  float jOpt = 1.0 + k * div;
  float focus = inversesqrt(jOpt * jOpt + 0.28 * 0.28);
  float ca = smoothstep(0.68, 1.42, focus);
  ca *= ca * (3.0 - 2.0 * ca);
  ca *= 0.62 + 0.38 * fbm2(entry * 0.17, 2);
  ca *= exp(-max(depth, 0.0) * (0.032 + uTurbid * 0.50));
  ca *= smoothstep(max(uMaxCausticDepth, 8.0), 6.0, depth);
  ca = ca / (1.0 + ca * 0.95);
  float gate = step(0.01, uCaustics) * step(0.05, depth)
             * step(depth, max(uMaxCausticDepth, 8.0) + 4.0) * step(0.06, sd.y);
  return ca * uCaustics * gate;
}

void main(){
#include<logDepthFragment>
  vec3 n = normalize(vNormal);
  // Only thin double-sided props need the facing flip.  The terrain carries
  // authored, always-upward normals from seabedNormal(), flipping those on a
  // back-facing triangle turns the whole island away from the sun and leaves
  // it lit by blue sky alone -- which reads as haze, not as a bug.
  if (uKind > 0.5 && !gl_FrontFacing) n = -n;

  // Clip planes for the reflection / refraction passes.
  //
  // The refraction clip has to allow for the WAVE CREST, not the flat sea
  // level: with Hs near 2 m the surface stands a metre above uSeaLevel, so
  // clipping at +0.02 cuts every bit of beach between the two out of the
  // buffer while water is still drawn in front of it.  The water shader then
  // finds no coverage there, falls back to its analytic seabed, and the sea
  // fills with straight-edged regions of the wrong colour along the terrain
  // triangles.  Keeping the terrain up to the crest costs nothing -- where it
  // is genuinely dry the water is not drawn over it anyway.
  if (uClipMode > 1.5 && vWorld.y > uSeaLevel + uClipTop) discard;   // refraction: below only
  if (uClipMode > 0.5 && uClipMode < 1.5 && vWorld.y < uSeaLevel - 0.6) discard;

  float rough = uRough;
  vec3 albedo;
  if (uKind < 0.5){
    albedo = groundAlbedo(vWorld, n, rough);
    // millimetre grain so the bed never reads as a painted plane
    float gx = fbm2(vWorld.xz * 9.5, 3);
    float gz = fbm2(vWorld.xz * 9.5 + 17.0, 3);
    n = normalize(n + vec3((gx - 0.5) * 0.28, 0.0, (gz - 0.5) * 0.28));
    // wet footprints: a stamped, decaying field, so prints fade with each step
    // and evaporate instead of accumulating forever
    if (uFootRect.w > 0.5){
      vec2 fuv = (vWorld.xz - uFootRect.xy) / uFootRect.z + 0.5;
      vec2 fe = abs(fuv - 0.5) * 2.0;
      float inF = 1.0 - smoothstep(0.78, 0.99, max(fe.x, fe.y));
      float fp = texture2D(uFootprint, clamp(fuv, 0.0, 1.0)).x * inF
                 * step(uSeaLevel + 0.02, vWorld.y);
      albedo *= mix(1.0, 0.46, fp);
      rough = mix(rough, 0.20, fp);
    }
  } else {
    albedo = uBaseColor;
#ifdef VERTEXCOLOR
    albedo *= vColor.rgb;
#endif
    // Wetness is a LINE -- the highest point that has actually been under
    // water -- not a uniform coat.  Wade to the waist and you are wet to the
    // waist.  uWetSoak is how much this material drinks: cotton goes almost
    // black, rubber barely changes, skin sits between.
    bool dynamicWet = uWetTop > -900.0;
    float wetLine = dynamicWet ? uWetTop : uSeaLevel + uWetness;
    float edge = 0.05 + 0.09 * fbm2(vWorld.xz * 7.0 + vWorld.y * 4.0, 2);
    float wet = smoothstep(wetLine + edge, wetLine - edge - 0.09, vWorld.y);
    if (dynamicWet) wet *= uWetAmt * uWetSoak;
    albedo *= mix(1.0, mix(0.70, 0.30, uWetSoak), wet);
    rough = mix(rough, 0.09 + 0.16 * (1.0 - uWetSoak), wet);
  }

  vec3 V = normalize(uCamPos - vWorld);
  float dist = length(uCamPos - vWorld);

  // --- direct sun --------------------------------------------------------
  vec3 sunT = exp(-opticalDepth(vec3(0.0, R_GROUND + max(vWorld.y, 1.0), 0.0), uSunDir, uTurbidity));
  vec3 sunE = uSunColor * uSunI * sunT * SUN_E * max(uSunDir.y, 0.0);
  sunE *= cloudShadow(vWorld.xz, uSunDir, uCloudCover, uStorm, uCloudDrift);
  float ndl = max(dot(n, uSunDir), 0.0);

  // --- ambient: one sky evaluation along the normal -----------------------
  vec3 amb = skyRadiance(vWorld, normalize(n * 0.6 + vec3(0.0, 0.85, 0.0)), uSunDir, uSunColor,
                         uSunI, uMoonDir, uMoonColor, uMoonI, uTurbidity, uCloudCover,
                         uCloudSharp, uCloudBright, uStorm, uCloudDrift, uFlash, false);
  float ao = 0.55 + 0.45 * clamp(n.y * 0.5 + 0.5, 0.0, 1.0);

  vec3 col = albedo * (sunE * ndl * I_PI + amb * 0.55 * ao);
  col += albedo * uMoonColor * uMoonI * max(dot(n, uMoonDir), 0.0) * 0.35;

  // --- specular ----------------------------------------------------------
  vec3 Rv = reflect(-V, n);
  vec3 skyR = skyRadiance(vWorld, normalize(Rv + vec3(0.0, 0.12, 0.0)), uSunDir, uSunColor, uSunI,
                          uMoonDir, uMoonColor, uMoonI, uTurbidity, uCloudCover, uCloudSharp,
                          uCloudBright, uStorm, uCloudDrift, uFlash, false);
  float f0 = mix(0.035, 0.9, uMetal);
  float fres = f0 + (1.0 - f0) * pow(1.0 - max(dot(n, V), 0.0), 5.0);
  vec3 H = normalize(V + uSunDir);
  float a = max(rough * rough, 1e-3);
  float dterm = a * a / (PI * pow(max(dot(n, H), 0.0) * max(dot(n, H), 0.0) * (a * a - 1.0) + 1.0, 2.0));
  col += (skyR * fres * (1.0 - rough * 0.85) + sunE * dterm * fres * 0.10 * ndl);

  // --- underwater tint + caustics ----------------------------------------
  float depth = uSeaLevel - vWorld.y;
  // Fetch before the depth gate so WGSL sees uniform control flow.
  float ca = causticsAt(vWorld);
  if (depth > 0.0){
    if (uUnderwaterView > 0.5){
      ca *= smoothstep(48.0, 10.0, dist);
      col += albedo * uScatterCol * uScatterAmt * uSunI * max(uSunDir.y, 0.12) * 3.4;
      // Modulate, then add a rolled-off filament.  Multiplying by a clipped
      // 1/|J| is how whole texels went to pure white.
      float filament = ca / (1.0 + ca);
      col *= 1.0 + filament * 0.55;
      col += albedo * sunE * I_PI * filament * 0.55;
    } else {
      float filament = ca / (1.0 + ca);
      col += albedo * sunE * I_PI * filament * 1.15;
    }
    // Beer-Lambert along the eye path and the sun path
    float eyePath = uUnderwaterView > 0.5 ? dist : min(depth / max(0.25, abs(normalize(uCamPos - vWorld).y)), 400.0);
    float sunPath = min(depth / max(uSunDir.y, 0.15), 400.0);
    vec3 ext = uAbsorb + vec3(uTurbid * 0.05);
    // Close underwater views: the bed has to stay a colour, not a black
    // plate with neon caustics.  Full eye+sun extinction over 8-15 m of
    // Atlantic kills every channel but blue.  Caustics already carry the
    // focused sun, so the albedo only pays a display-scaled eye path.
    float path = uUnderwaterView > 0.5 ? eyePath * 0.32 : (eyePath + sunPath * 0.6);
    vec3 tw = exp(-ext * path);
    // Hide the camera-snapped tile edge in the haze so the bed never ends
    // as a straight horizon line.
    float vis = uUnderwaterView > 0.5 ? smoothstep(140.0, 22.0, dist) : 1.0;
    vec3 inScat = uScatterCol * uScatterAmt * I_PI * SUN_E *
                  (uSunColor * uSunI * max(uSunDir.y, 0.03) * 0.55 +
                   uMoonColor * uMoonI * 0.5 + 0.004);
    float deepFade = exp(-max(uCamDepth, 0.0) * 0.0065);
    inScat *= deepFade;
    col = col * tw * vis + inScat * (1.0 - exp(-ext * eyePath * 1.4));
  } else {
    vec3 inscat, trans;
    aerial(uCamPos, -V, dist, uSunDir, uSunColor, uSunI, uTurbidity, uStorm, uCloudCover, inscat, trans);
    col = col * trans + inscat;
  }
  col += vec3(0.9, 0.95, 1.05) * uFlash * 0.22;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

// ===========================================================================
//  UNDERWATER FULL-SCREEN PASS
// ===========================================================================
export const UNDERWATER_FRAG = /* glsl */ `
precision highp float;
#define SKY_VIEW_STEPS 4
#define SKY_LIGHT_STEPS 3
#define CLOUD_STEPS 2
#define NO_STARS
` + ATMO_GLSL + /* glsl */ `
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunI;
uniform float uTurbidity;
uniform float uStorm;
uniform float uFlash;
uniform float uTime;
uniform vec3 uAbsorb;
uniform vec3 uScatterCol;
uniform float uScatterAmt;
uniform float uTurbid;
uniform float uSubmerged;
uniform float uDroplets;
uniform float uCamDepth;
uniform vec2  uSunScreen;
// Independent switches so each screen-space effect can be measured against the
// temporal filter on its own.  All three animate in SCREEN space with no world
// coupling, which is why the ocean's motion vectors cannot describe them.
uniform float uGodRays;
uniform float uMotes;
uniform float uCausticShimmer;
// World anchoring for the caustics: a ray is rebuilt from the camera basis so
// the pattern can be sampled from the ACTUAL wave field rather than from
// screen coordinates and a clock.
uniform vec3  uUwCamPos;
uniform vec3  uUwRight;
uniform vec3  uUwUp;
uniform vec3  uUwFwd;
uniform float uUwTanHalf;
uniform float uUwAspect;
uniform sampler2D uUwDeriv;
uniform float uUwCascadeL;
uniform float uSeaLevel;

// NOTE: absorption along the view ray is NOT applied here.  The water surface
// and the sea floor each attenuate their own radiance with the real path
// length they know (see oceanSurface.js / SURFACE_FRAG); doing it again from a
// screen-space depth buffer would double the extinction, and the depth
// renderer does not even know about the wave displacement.  This pass only
// adds what genuinely lives between the eye and the scene.
void main(){
  vec2 uv = vUV;

  // --- lens droplets after surfacing --------------------------------------
  if (uDroplets > 0.001){
    vec2 q = uv * vec2(9.0, 5.0);
    vec2 c = floor(q), f = fract(q);
    float h = ahash21(c * 3.7);
    if (h < 0.55){
      vec2 cen = vec2(0.3 + 0.4 * h, 0.3 + 0.4 * fract(h * 7.3));
      float d = length((f - cen) * vec2(1.0, 0.75));
      float r = 0.16 + 0.16 * fract(h * 13.1);
      float m = smoothstep(r, r * 0.25, d) * uDroplets;
      uv += (f - cen) * m * 0.11;
    }
    uv.y += uDroplets * 0.004 * sin(uTime * 1.7 + uv.x * 22.0);
  }

  vec3 col = texture2D(textureSampler, clamp(uv, 0.0, 1.0)).rgb;
  // Single exit.  With an early return here the above-water case falls through
  // into the god rays when this is transpiled to WGSL, and every frame shot
  // from dry land gets a starburst of shafts composited over it.
  vec3 dry = col;
  if (uSubmerged >= 0.5){

  // --- god rays: a short screen-space march toward the sun disc.  The
  // phase-2 world-space occlusion (bathymetry + cavern SDF, 48 samples)
  // is gone with that world.
  if (uSunDir.y > 0.04 && uGodRays > 0.001){
    vec2 dscr = uv - uSunScreen;
    float distS = length(dscr);
    float occ = 0.0;
    for (int i = 0; i < 6; i++){
      float t = float(i) / 6.0;
      vec2 suv = mix(uv, uSunScreen, t);
      occ += texture2D(textureSampler, clamp(suv, 0.0, 1.0)).g;
    }
    occ /= 6.0;
    vec3 rd = normalize(uUwFwd
            + uUwRight * ((uv.x * 2.0 - 1.0) * uUwTanHalf * uUwAspect)
            + uUwUp * ((uv.y * 2.0 - 1.0) * uUwTanHalf));
    float mu = clamp(dot(rd, uSunDir), -1.0, 1.0);
    float g = 0.68;
    float g2 = g * g;
    float hg = (1.0 - g2) / (12.5663706 * pow(max(1e-4, 1.0 + g2 - 2.0 * g * mu), 1.5));
    float ang = atan(dscr.y, dscr.x);
    float chop = 0.55 + 0.45 * fbm2(vec2(ang * 5.5, uTime * 0.22), 3);
    float depthFade = exp(-max(uCamDepth, 0.0) * 0.055);
    float falloff = exp(-distS * 3.4);
    col += uSunColor * uSunI * hg * occ * chop * depthFade * falloff
         * uScatterAmt * 1.85 * uGodRays;
  }

  // --- suspended matter ----------------------------------------------------
  // Deliberately NOT drawn here any more.  This was a screen-space fbm at 90
  // cycles scrolling on a clock: it belongs to no point in the world, so no
  // motion vector can describe it and the temporal filter can only smear it.
  // Suspended matter is now real geometry (OceanEffects.motes, a GpuParticleField)
  // which writes its own per-particle screen-space velocity.  uMotes survives as
  // the A/B switch the harness needs; it gates the particle field.

  // --- caustic shimmer, anchored to the WAVE FIELD ------------------------
  //
  // This used to be sin(uv.x*40 + t) * sin(uv.y*31 - t): a full-screen sinusoid
  // at 40x31 cycles animating on a clock, multiplying every pixel by +/-14%.
  // Nothing about it corresponded to the world, so no motion vector could
  // describe it and the temporal filter could only smear it -- measured, it was
  // the SOLE screen-space contributor to underwater instability, raising the
  // frame-to-frame difference 8.5x while god rays and motes contributed
  // nothing at all.
  //
  // Now the ray is rebuilt from the camera basis, a point is taken a fixed
  // distance along it, and the focusing is read from the same cascade
  // derivative the surface uses: 1/|J| is where the refracted sun converges.
  // It therefore moves with the waves and with the camera, coherently.
  float nearSurf = exp(-max(uCamDepth, 0.0) * 0.5);
  if (uCausticShimmer > 0.001 && nearSurf > 0.004){
    vec3 rd = normalize(uUwFwd
            + uUwRight * ((uv.x * 2.0 - 1.0) * uUwTanHalf * uUwAspect)
            + uUwUp * ((uv.y * 2.0 - 1.0) * uUwTanHalf));
    vec3 wp = uUwCamPos + rd * 16.0;
    vec3 d1 = texture2D(uUwDeriv, wp.xz / max(uUwCascadeL, 1.0)).xyz;
    float focus = inversesqrt(d1.z * d1.z + 0.22 * 0.22);
    float ca = smoothstep(0.70, 1.35, focus);
    col *= 1.0 + 0.10 * nearSurf * uCausticShimmer * (ca - 0.12);
  }

    float deep = clamp(uCamDepth / 220.0, 0.0, 1.0);
    col = mix(col, col * vec3(0.55, 0.88, 1.04), deep * 0.50);
    col *= mix(1.0, 0.18, clamp((uCamDepth - 80.0) / 1600.0, 0.0, 1.0));

  col += vec3(0.5, 0.8, 1.0) * uFlash * 0.10;
  float vig = smoothstep(1.15, 0.32, length((uv - 0.5) * vec2(1.15, 1.0)));
  col *= mix(0.55, 1.0, vig);
  }

  gl_FragColor = vec4(max(mix(dry, col, step(0.5, uSubmerged)), 0.0), 1.0);
}
`;
