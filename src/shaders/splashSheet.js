// ---------------------------------------------------------------------------
//  splashSheet.js -- the thin sheet of water a foot throws up.
//
//  A pool of crown patches whose vertices carry (angle, height, slot); the slot
//  data lives in a small texture so the CPU only writes 12 floats per splash.
//  The sheet rises ballistically, widens, leans along the impact direction,
//  goes ragged around its rim and breaks into holes before it disappears.
//
//  This is the piece that gives a splash VOLUME.  Billboards alone always read
//  flat, and a perfectly symmetric crown reads as a milk-drop stock photo --
//  real footfall sheets are lopsided and torn.
// ---------------------------------------------------------------------------

import { ATMO_GLSL } from "./atmosphere.js";

export const SHEET_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;        // x = angle 0..1, y = height 0..1, z = slot
uniform mat4 viewProjection;
uniform sampler2D uSlots;
uniform float uSlotCount;
uniform float uTime;
uniform float uSeaLevel;
#include<logDepthDeclaration>

varying vec3  vWorld;
varying float vAge;
varying float vHeight;
varying float vAngle;
varying float vSeed;
varying float vEnergy;

float shNoise(float x){ return fract(sin(x * 43.7583) * 43758.5453); }
float shWave(float a, float seed){
  float f = 0.0;
  f += sin(a * 3.0 + seed * 6.28) * 0.5;
  f += sin(a * 7.0 - seed * 11.3) * 0.3;
  f += sin(a * 13.0 + seed * 3.1) * 0.2;
  return f;
}

void main(){
  float slot = position.z;
  float su = (slot + 0.5) / uSlotCount;
  vec4 s0 = textureLod(uSlots, vec2(su, 0.1667), 0.0);   // origin.xyz, birth
  vec4 s1 = textureLod(uSlots, vec2(su, 0.5000), 0.0);   // dir.xyz, energy
  vec4 s2 = textureLod(uSlots, vec2(su, 0.8333), 0.0);   // r0, life, seed, spin

  float life = max(s2.y, 1e-3);
  float tt = uTime - s0.w;
  float t = tt / life;
  vAge = t;
  vSeed = s2.z;
  vEnergy = s1.w;
  vAngle = position.x;

  // Collapse an inactive slot instead of returning early.  Babylon assigns the
  // WGSL output struct after the user body, so an early return leaves the clip
  // position uninitialised and WebGPU rasterises the whole pool as garbage.
  // Test for LIVE, so a NaN slot collapses too.
  float live = (t >= 0.0 && t <= 1.0 && s1.w > 0.0) ? 1.0 : 0.0;

  float ang = position.x * 6.2831853 + s2.w * tt;
  vec2 dirXZ = s1.xz;
  float dl = length(dirXZ);
  vec2 dn = dl > 1e-4 ? dirXZ / dl : vec2(0.0);

  // Ragged rim: without this every splash is a machined ring.  Keep the
  // variation modest -- at +/-50 % adjacent angular strips differ so much that
  // the crown separates into radial spikes and reads as a feather duster
  // rather than a sheet of water.
  float wob = 0.87 + 0.17 * shWave(ang, s2.z);
  // Lean into the motion -- a foot swinging forward throws a sheet forward,
  // not an even collar.
  float bias = 1.0 + dot(vec2(cos(ang), sin(ang)), dn) * min(dl * 0.5, 0.85);

  float vRad = s1.w * 0.55;
  float r = (s2.x + vRad * tt) * wob * bias;
  float vUp = s1.w * 0.95;
  float h = max(vUp * tt - 0.5 * 9.81 * tt * tt, 0.0);

  float v = position.y;
  float rr = mix(s2.x * 0.55, r, v) * live;
  vec3 p = s0.xyz * live + vec3(cos(ang) * rr, h * v * v * live, sin(ang) * rr);
  // the sheet is dragged along the motion as it rises
  p.xz += dn * dl * tt * 0.35 * v * live;

  vHeight = v * live;
  vWorld = p;
  gl_Position = viewProjection * vec4(p, 1.0);
#include<logDepthVertex>
}
`;

export const SHEET_FRAG = /* glsl */ `
precision highp float;
#define SKY_VIEW_STEPS 3
#define SKY_LIGHT_STEPS 2
#define CLOUD_STEPS 2
#define NO_STARS
#include<logDepthDeclaration>
` + ATMO_GLSL + /* glsl */ `
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uMoonDir;
uniform vec3  uMoonColor;
uniform float uSunI;
uniform float uMoonI;
uniform float uTurbidity;
uniform float uCloudCover;
uniform float uCloudSharp;
uniform float uCloudBright;
uniform float uStorm;
uniform float uFlash;
uniform vec2  uCloudDrift;
uniform vec3  uCamPos;
uniform vec3  uWaterTint;

varying vec3  vWorld;
varying float vAge;
varying float vHeight;
varying float vAngle;
varying float vSeed;
varying float vEnergy;

void main(){
#include<logDepthFragment>
  // Tear the sheet apart as it ages: holes open from the top edge and from
  // random angular sectors, so it becomes lace and then droplets rather than
  // fading out as a whole ring.
  float tear = ahash21(vec2(floor(vAngle * 34.0), floor(vSeed * 97.0)));
  float top = smoothstep(0.35, 1.0, vHeight);
  float open = vAge * (0.55 + 0.9 * top) + tear * 0.55 * vAge * 2.2;
  if (open > 0.92) discard;

  vec3 V = normalize(uCamPos - vWorld);
  // A thin sheet has no meaningful normal of its own, use the view-facing
  // shell plus a slope from the rim so highlights still travel across it.
  vec3 n = normalize(vec3(cos(vAngle * 6.2831853) * 0.55, 1.0,
                          sin(vAngle * 6.2831853) * 0.55));
  float ndv = clamp(dot(n, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  vec3 refl = skyRadiance(vWorld, reflect(-V, n), uSunDir, uSunColor, uSunI,
                          uMoonDir, uMoonColor, uMoonI, uTurbidity, uCloudCover,
                          uCloudSharp, uCloudBright, uStorm, uCloudDrift, uFlash, false);
  vec3 thru = uWaterTint * (0.30 + 0.9 * max(uSunDir.y, 0.02))
              + uSunColor * uSunI * 0.02;
  // aerated water is white: the thinner and more torn it gets, the more of the
  // sheet is actually foam.  Held back from saturation -- a sheet that is
  // entirely foam is an opaque white surface, and opaque is the one thing
  // half a litre of airborne water never looks like.
  float aer = clamp(0.06 + vAge * 0.40 + top * 0.26, 0.0, 0.70);
  vec3 foamCol = (uSunColor * uSunI * SUN_E * max(uSunDir.y, 0.03)
                  + uMoonColor * uMoonI * SUN_E * 0.4) * I_PI * 0.72
                 + refl * 0.20;

  vec3 col = mix(mix(thru, refl, F), foamCol, aer);
  float a = (1.0 - open) * (0.18 + 0.40 * F + 0.22 * aer) * smoothstep(0.0, 0.08, vAge);
  a *= 1.0 - smoothstep(0.72, 1.0, vAge);
  // A film is as opaque as the path length through it: nearly invisible seen
  // face on, bright at a grazing angle.  Without this the sheet is a constant
  // wash and every splash looks like cut paper.
  a *= mix(0.34, 1.0, pow(1.0 - ndv, 1.4));
  // and it thins toward the torn upper edge instead of ending in a hard rim
  a *= 1.0 - 0.55 * smoothstep(0.5, 1.0, vHeight);
  gl_FragColor = vec4(max(col, 0.0), clamp(a, 0.0, 0.58));
}
`;
