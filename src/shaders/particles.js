// ---------------------------------------------------------------------------
//  particles.js -- GPU-resident droplets, mist and bubbles.
//
//  State lives entirely in two RGBA32F textures (position+life, velocity+size)
//  that a fragment pass integrates every frame.  The CPU never touches a
//  particle: it only appends spawn REQUESTS to a small 64x4 texture, and dead
//  particles inside a rolling window claim them.  That is what keeps a
//  continuous run through knee-deep water from generating garbage.
//
//  Rendering is one draw call: a static mesh of N quads whose vertices carry
//  their own particle index, read back out of the state textures.
//
//  Droplets and bubbles are shaded as actual water/air interfaces -- Fresnel,
//  a refracted view of the sky (or of the water volume, below the surface) and
//  a sun highlight -- rather than as additive white sprites.  A white dot is
//  the single most recognisable "this is a particle system" tell.
// ---------------------------------------------------------------------------

import { ATMO_GLSL } from "./atmosphere.js";

const COMMON = /* glsl */ `
precision highp float;
#define PI 3.141592653589793

// hash -> [0,1), stable per particle index
float phash(float n){
  return fract(sin(n * 127.1 + 311.7) * 43758.5453123);
}
vec3 phash3(float n){
  return vec3(phash(n), phash(n + 17.13), phash(n + 91.71));
}
`;

// ---------------------------------------------------------------------------
//  UPDATE.  uMode 0 = droplets (gravity, air drag), 1 = bubbles (buoyancy,
//  wobble, turbulence).  Both die at the real wave surface, sampled from the
//  same cascade textures the ocean is drawn from.
// ---------------------------------------------------------------------------
export const PARTICLE_UPDATE_FRAG = COMMON + /* glsl */ `
varying vec2 vUV;

uniform sampler2D uPos;
uniform sampler2D uVel;
uniform sampler2D uSpawn;        // 64 x 4 request table
uniform sampler2D uDisp0;
uniform sampler2D uDisp1;

uniform float uDt;
uniform float uTime;
uniform float uCount;            // total particles
uniform float uWidth;
uniform float uHeight;
uniform float uSpawnStart;
uniform float uSpawnCount;
uniform float uPerGroup;
uniform float uKind;             // 0 droplet, 1 bubble
uniform float uTarget;           // 0 -> write (pos,life), 1 -> write (vel,size)
uniform float uSeaLevel;
uniform float uCascadeL0;
uniform float uCascadeL1;
uniform float uWaveScale;
uniform float uTurbulence;
uniform vec3  uWind;
uniform vec3  uCurrent;

float waveHeightAt(vec2 p){
  float h = textureLod(uDisp0, p / uCascadeL0, 0.0).y;
  h += textureLod(uDisp1, p / uCascadeL1, 0.0).y;
  return uSeaLevel + h * uWaveScale;
}

void main(){
  vec4 A = texture2D(uPos, vUV);
  vec4 B = texture2D(uVel, vUV);

  float idx = floor(vUV.y * uHeight) * uWidth + floor(vUV.x * uWidth);

  // --- claim a spawn slot? ------------------------------------------------
  // Both targets run the same branch with the same hashes, so the position
  // and the velocity of a newly spawned particle always agree.
  // ONE exit.  Babylon wraps the entry point when it transpiles to WGSL and
  // assigns the output struct after the user body, so an early "return" leaves
  // that assignment unexecuted: on WebGPU the spawn silently writes nothing,
  // while WebGL2 does exactly what the code says.  Accumulate and write once.
  vec4 spawnPos = vec4(0.0);
  vec4 spawnVel = vec4(0.0);
  float spawned = 0.0;

  float rel = mod(idx - uSpawnStart + uCount, uCount);
  if (rel < uSpawnCount){
    float g = min(floor(rel / max(uPerGroup, 1.0)), 63.0);
    float gx = (g + 0.5) / 64.0;
    vec4 s0 = textureLod(uSpawn, vec2(gx, 0.125), 0.0);   // pos.xyz, radius
    vec4 s1 = textureLod(uSpawn, vec2(gx, 0.375), 0.0);   // vel.xyz, spread
    vec4 s2 = textureLod(uSpawn, vec2(gx, 0.625), 0.0);   // sizeMin,Max,lifeMin,Max
    vec4 s3 = textureLod(uSpawn, vec2(gx, 0.875), 0.0);   // speedJitter, -, -, seed

    vec3 r1 = phash3(idx * 1.371 + s3.w);
    vec3 r2 = phash3(idx * 2.917 + s3.w * 1.7 + 5.1);

    float rr = sqrt(r1.x) * s0.w;
    float ang = r1.y * 6.2831853;
    vec3 p = s0.xyz + vec3(cos(ang) * rr, (r1.z - 0.35) * s0.w * 0.5, sin(ang) * rr);

    // Cone around the impact direction with a randomised speed.  Every droplet
    // sharing one direction is the classic "particle effect" tell.
    float sp = length(s1.xyz);
    vec3 dir = sp > 1e-4 ? s1.xyz / sp : vec3(0.0, 1.0, 0.0);
    vec3 tangent = normalize(cross(dir, vec3(0.0, 1.0, 0.017)) + vec3(1e-5));
    vec3 bitan = cross(dir, tangent);
    vec3 v = normalize(dir + tangent * (r2.x - 0.5) * s1.w
                           + bitan * (r2.y - 0.5) * s1.w)
             * sp * (1.0 - s3.x * 0.5 + s3.x * r2.z);

    // Spray is biased tiny.  Bubbles keep the full size range so the
    // underwater field reads as rising glass, not dust.
    float szPick = (uKind > 0.5 && uKind < 1.5) ? r1.x : r1.x * r1.x;
    float sz = mix(s2.x, s2.y, szPick);
    float life = mix(s2.z, s2.w, r2.z);
    spawnPos = vec4(p, life);
    spawnVel = vec4(v, sz);
    spawned = 1.0;
  }

  // --- integrate ----------------------------------------------------------
  float life = A.w - uDt;
  vec3 p = A.xyz;
  vec3 v = B.xyz;
  float size = B.w;

  if (life > 0.0){
    float surf = waveHeightAt(p.xz);
    if (uKind < 0.5){
      v += vec3(0.0, -9.81, 0.0) * uDt;
      vec3 rel3 = v - uWind;
      v -= rel3 * min(1.0, (2.6 / max(size * 900.0, 0.35)) * uDt);
      p += v * uDt;
      // Kill only clearly BELOW the surface.  The contact point comes from the
      // CPU mirror, which is band limited and can sit a few centimetres under
      // the GPU field -- test against the exact surface and every droplet dies
      // on the frame it is born.
      if (p.y < surf - 0.05) life = 0.0;             // landed
    } else if (uKind > 1.5) {
      // Neutral drift: suspended matter, near enough weightless.  It follows
      // the current with a little wander and dies at the surface.  Motes were
      // a Babylon GPUParticleSystem, whose per-particle previous position is
      // not readable -- which is exactly why they could not be given a motion
      // vector and why they defeated the temporal filter.
      vec3 rel3 = v - uCurrent;
      v -= rel3 * min(1.0, 1.4 * uDt);
      float w = uTime * (0.5 + phash(idx) * 0.7) + idx;
      v += vec3(sin(w), cos(w * 0.83), cos(w * 1.19)) * 0.010 * uDt * 60.0;
      p += v * uDt;
      if (p.y > surf - 0.08) life = 0.0;
    } else {
      // buoyancy grows with radius, drag opposes it, and a wobble term stops
      // the column of bubbles being a set of straight vertical lines
      float buoy = 9.81 * clamp(size * 260.0, 0.35, 3.4);
      v.y += buoy * uDt;
      vec3 rel3 = v - uCurrent;
      v -= rel3 * min(1.0, (9.0 / max(size * 700.0, 0.6)) * uDt);
      float w = uTime * (2.4 + phash(idx) * 3.0) + idx;
      v += vec3(sin(w), 0.0, cos(w * 1.31)) * (0.05 + size * 6.0)
           * (0.4 + uTurbulence) * uDt;
      size += uDt * (0.004 + size * 0.028);
      size = min(size, 0.36);
      p += v * uDt;
      // A bubble that reaches the moving interface has vented into the air;
      // keeping it alive above the wave makes glass beads float in the sky.
      if (p.y > surf - max(0.025, size * 0.2)) life = 0.0;
    }
  }

  vec4 kept = (uTarget < 0.5) ? vec4(p, max(life, 0.0)) : vec4(v, size);
  vec4 born = (uTarget < 0.5) ? spawnPos : spawnVel;
  gl_FragColor = mix(kept, born, step(0.5, spawned));
}
`;

// ---------------------------------------------------------------------------
//  RENDER -- droplets
// ---------------------------------------------------------------------------
export const DROPLET_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;      // corner offset in x,y , z = particle index
uniform mat4 viewProjection;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamPos;
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform float uWidth;
uniform float uHeight;
uniform float uStretch;
uniform float uSizeScale;
// A particle smaller than a pixel cannot be filtered by ANY method: it is a
// point sample of a moving delta function, so it twinkles no matter how good
// the motion vector is.  Expanding it to a floor of uMinPixel pixels and
// dividing the brightness by the area gained keeps the same total light while
// giving the resolve something band-limited to work with.
//
// It also keeps the DRAWN footprint and the VELOCITY footprint the same shape.
// Without a floor, a distant droplet still shades its pixel but its velocity
// fragment falls under the coverage cut and is discarded -- so the pixel shows
// spray and is reprojected as if it were the water behind it.  Measured, the
// covered-pixel count in a storm swung between 70 and 8250 frame to frame
// because of exactly that.
uniform float uMinPixel;
uniform float uPxScale;   // 2*tan(fov/2) / screenHeightPixels
#include<logDepthDeclaration>

varying vec2 vCorner;
varying vec3 vWorld;
varying float vSize;
varying float vLife;
varying float vSeed;
varying float vDim;       // energy conservation for the size floor

void main(){
  float idx = position.z;
  vec2 uv = vec2(mod(idx, uWidth) + 0.5, floor(idx / uWidth) + 0.5) / vec2(uWidth, uHeight);
  vec4 A = textureLod(uPos, uv, 0.0);
  vec4 B = textureLod(uVel, uv, 0.0);
  vLife = A.w;
  vSize = B.w * uSizeScale;
  vDim = 1.0;
  if (uMinPixel > 0.0){
    float floorW = uPxScale * distance(uCamPos, A.xyz) * uMinPixel;
    float grown = max(vSize, floorW);
    vDim = (vSize * vSize) / max(grown * grown, 1e-12);
    vSize = grown;
  }
  vSeed = fract(idx * 0.6180339);
  vCorner = position.xy;

  // Cull dead particles by COLLAPSING them, never with an early return.
  // Babylon assigns the WGSL output struct after the user body, so a return in
  // the middle leaves the clip position uninitialised -- on WebGPU the whole
  // capacity then rasterises as huge garbage quads, while every particle still
  // reads as dead.  With size forced to zero all four corners land on the same
  // clip position and the quad has no area, on either backend.
  //
  // Test for ALIVE, not for dead: a NaN fails every comparison, so 'dead' would
  // be false for it and the garbage would render.
  float alive = (A.w > 1e-6 && vSize > 1e-6) ? 1.0 : 0.0;
  vSize *= alive;

  // stretch along the velocity: a fast droplet is a streak, not a disc
  vec3 vd = B.xyz;
  float sp = length(vd);
  vec3 right = uCamRight, up = uCamUp;
  if (sp > 1.2){
    vec3 axis = normalize(vd);
    vec3 sideAxis = normalize(cross(axis, uCamPos - A.xyz) + 1e-5);
    float st = 1.0 + min(sp * uStretch, 4.0);
    right = sideAxis;
    up = axis * st;
  }
  vec3 base = A.xyz * alive;          // a NaN position cannot leak either
  vec3 wp = base + right * position.x * vSize + up * position.y * vSize;
  vWorld = wp;
  gl_Position = viewProjection * vec4(wp, 1.0);
#include<logDepthVertex>
}
`;

export const DROPLET_FRAG = /* glsl */ `
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
uniform float uMist;

varying vec2 vCorner;
varying vec3 vWorld;
varying float vSize;
varying float vLife;
varying float vSeed;

void main(){
#include<logDepthFragment>
  float r2 = dot(vCorner, vCorner);
  if (r2 > 1.0) discard;

  vec3 V = normalize(uCamPos - vWorld);
  // sphere normal across the billboard
  vec3 N = normalize(vec3(vCorner, sqrt(max(1.0 - r2, 0.0))));
  // rotate the local normal into view space around the billboard
  vec3 up = normalize(cross(V, vec3(0.0, 1.0, 0.001)));
  vec3 rt = cross(up, V);
  vec3 n = normalize(rt * N.x + up * N.y + V * N.z);

  float ndv = clamp(dot(n, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  vec3 refl = skyRadiance(vWorld, reflect(-V, n), uSunDir, uSunColor, uSunI,
                          uMoonDir, uMoonColor, uMoonI, uTurbidity, uCloudCover,
                          uCloudSharp, uCloudBright, uStorm, uCloudDrift, uFlash, false);
  // refracted view: a droplet inverts and compresses whatever is behind it
  vec3 rd = refract(-V, n, 1.0 / 1.333);
  if (dot(rd, rd) < 1e-5) rd = reflect(-V, n);
  // A drop inverts and compresses what is behind it, and most of what is
  // behind it is sky.  Letting the refracted ray dive into the ground half of
  // the sky model turns every droplet into a black bead.
  rd = normalize(vec3(rd.x, max(rd.y, -0.12), rd.z));
  vec3 thru = skyRadiance(vWorld, rd, uSunDir, uSunColor, uSunI,
                          uMoonDir, uMoonColor, uMoonI, uTurbidity, uCloudCover,
                          uCloudSharp, uCloudBright, uStorm, uCloudDrift, uFlash, false);
  thru = mix(thru, refl * 0.70 + uWaterTint * 0.30, 0.32);

  // the caustic-bright spot a real drop throws toward the sun
  vec3 h = normalize(V + uSunDir);
  float spec = pow(max(dot(n, h), 0.0), 220.0);
  vec3 col = mix(thru, refl, F) + uSunColor * uSunI * SUN_E * spec * 0.010;

  float edge = smoothstep(1.0, 0.55, r2);
  float fade = smoothstep(0.0, 0.16, vLife);
  // A water droplet is mostly TRANSPARENT with a bright rim: opaque beads are
  // the thing that reads as "particle sprite" rather than water.
  float rim = pow(clamp(r2, 0.0, 1.0), 1.6);
  float a = mix(0.30 + 0.62 * F + 0.35 * rim, 0.30, uMist) * edge * fade;
  // mist is a haze, not a droplet: flatten it toward the ambient
  col = mix(col, refl * 0.9, uMist * 0.7);
  gl_FragColor = vec4(max(col, 0.0), clamp(a, 0.0, 1.0));
}
`;

// ---------------------------------------------------------------------------
//  RENDER -- bubbles (seen from under water)
// ---------------------------------------------------------------------------
export const BUBBLE_FRAG = /* glsl */ `
precision highp float;
#define SKY_VIEW_STEPS 3
#define SKY_LIGHT_STEPS 2
#define CLOUD_STEPS 2
#define NO_STARS
#include<logDepthDeclaration>
` + ATMO_GLSL + /* glsl */ `
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunI;
uniform vec3  uCamPos;
uniform vec3  uWaterTint;
uniform float uAmbient;

varying vec2 vCorner;
varying vec3 vWorld;
varying float vSize;
varying float vLife;
varying float vSeed;

void main(){
#include<logDepthFragment>
  float r2 = dot(vCorner, vCorner);
  if (r2 > 1.05) discard;
  float r = sqrt(r2);

  vec3 V = normalize(uCamPos - vWorld);
  vec3 N = normalize(vec3(vCorner, sqrt(max(1.0 - r2, 0.0))));
  vec3 up = normalize(cross(V, vec3(0.0, 1.0, 0.001)));
  vec3 rt = cross(up, V);
  vec3 n = normalize(rt * N.x + up * N.y + V * N.z);
  float ndv = clamp(dot(n, V), 0.0, 1.0);

  // An air sphere inside water: light going water->air totally internally
  // reflects past the critical angle, which is exactly why a real bubble is a
  // bright RING with a nearly transparent middle.
  float F = 0.02 + 0.98 * pow(1.0 - ndv, 4.0);
  float rim = smoothstep(0.62, 0.99, r);
  float rimHi = pow(rim, 2.0);

  vec3 lit = uWaterTint * uAmbient;
  vec3 col = lit * (0.22 + 0.78 * F);
  col += uSunColor * uSunI * (0.08 + 1.15 * rimHi) * 0.07 * max(uSunDir.y, 0.05);
  vec3 h = normalize(V + uSunDir);
  col += uSunColor * uSunI * pow(max(dot(n, h), 0.0), 70.0) * 0.055;

  float fade = smoothstep(0.0, 0.10, vLife);
  float edge = 1.0 - smoothstep(0.72, 0.98, r2);
  float alpha = (0.12 + 0.82 * F + 0.62 * rimHi) * fade * edge;
  gl_FragColor = vec4(max(col, 0.0), clamp(alpha, 0.0, 0.88));
}
`;

// ---------------------------------------------------------------------------
//  RENDER -- 3D bubble spheres (air in water)
//
//  Billboard rings read as a particle effect: they stretch with velocity,
//  have no silhouette in depth, and grow under the screen-space size floor.
//  These are real unit spheres instanced per GPU particle.  A ray-ellipsoid
//  in the fragment shader gives a smooth silhouette (the hull is only a
//  bounding mesh) and the shading is a water-to-air interface: Snell's-window
//  interior, Fresnel silver, TIR rim, sun spec.  The CGTrader pack this
//  replaces is a textured rising mesh behind a login wall.  The motion is
//  the same -- streams lifting off the bed -- the shading is the physical
//  model that pack's texture fakes.
// ---------------------------------------------------------------------------
export const BUBBLE_MESH_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 viewProjection;
uniform vec3 uCamPos;
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform float uWidth;
uniform float uHeight;
uniform float uSizeScale;
uniform float uTime;
#include<logDepthDeclaration>

varying vec3 vWorld;
varying vec3 vCenter;
varying vec3 vRadii;
varying float vLife;
varying float vSeed;
varying float vAlive;

void main(){
  float idx = uv.x;
  vec2 st = vec2(mod(idx, uWidth) + 0.5, floor(idx / uWidth) + 0.5) / vec2(uWidth, uHeight);
  vec4 A = textureLod(uPos, st, 0.0);
  vec4 B = textureLod(uVel, st, 0.0);
  vLife = A.w;
  vSeed = fract(idx * 0.6180339);
  float alive = (A.w > 1e-6 && B.w * uSizeScale > 1e-6) ? 1.0 : 0.0;
  vAlive = alive;
  float size = B.w * uSizeScale;
  float wob = 0.055 * sin(uTime * (2.4 + vSeed * 1.8) + vSeed * 6.28318);
  vec3 sc = vec3(1.0 + wob, 1.0 - wob * 0.32, 1.0 - wob * 0.55);
  vRadii = sc * size;
  vCenter = A.xyz;
  vec3 hull = position * vRadii * 1.20;
  vec3 wp = A.xyz + hull;
  vWorld = wp;
  vec4 clip = viewProjection * vec4(wp, 1.0);
  gl_Position = mix(vec4(2.0, 2.0, 2.0, 1.0), clip, alive);
#include<logDepthVertex>
}
`;

export const BUBBLE_MESH_FRAG = /* glsl */ `
precision highp float;
#include<logDepthDeclaration>
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunI;
uniform vec3  uCamPos;
uniform vec3  uWaterTint;
uniform float uAmbient;

varying vec3 vWorld;
varying vec3 vCenter;
varying vec3 vRadii;
varying float vLife;
varying float vSeed;
varying float vAlive;

void main(){
#include<logDepthFragment>
  vec3 rd = vWorld - uCamPos;
  float rdL = length(rd);
  rd *= 1.0 / max(rdL, 1e-6);

  vec3 radii = max(vRadii, vec3(1e-5));
  vec3 o = (uCamPos - vCenter) / radii;
  vec3 d = rd / radii;
  float qa = dot(d, d);
  float qb = 2.0 * dot(o, d);
  float qc = dot(o, o) - 1.0;
  float disc = qb * qb - 4.0 * qa * qc;
  float hit = step(0.0, disc) * vAlive * float(gl_FrontFacing);
  float sq = sqrt(max(disc, 0.0));
  float inv = 0.5 / max(qa, 1e-8);
  float t0 = (-qb - sq) * inv;
  float t1 = (-qb + sq) * inv;
  float tNear = mix(t1, t0, step(0.0, t0));
  hit *= step(0.0, max(t0, t1));

  vec3 pHit = uCamPos + rd * tNear;
  vec3 n = normalize((pHit - vCenter) / (radii * radii));
  vec3 V = -rd;
  float ndv = clamp(dot(n, V), 0.0, 1.0);

  float F = 0.020 + 0.980 * pow(1.0 - ndv, 5.0);
  float tir = smoothstep(0.52, 0.20, ndv);

  vec3 T = refract(rd, n, 1.333);
  float hasT = step(1e-4, dot(T, T));
  float window = smoothstep(-0.12, 0.72, T.y);
  vec3 deep = uWaterTint * (0.12 + 0.55 * uAmbient);
  vec3 skyWin = uSunColor * uSunI * 0.42
              + vec3(0.22, 0.48, 0.82) * (0.18 + 0.82 * uAmbient);
  vec3 interior = mix(deep, skyWin, window) * hasT;
  interior += deep * (1.0 - hasT) * 0.35;

  vec3 silver = vec3(0.82, 0.91, 1.0);
  vec3 col = interior * (0.70 + 0.40 * ndv);
  col += skyWin * pow(ndv, 6.0) * 0.28 * hasT;
  col = mix(col, silver * (0.30 + 0.70 * uSunI), F * 0.88);
  col += silver * uSunI * tir * 0.18;
  vec3 H = normalize(V + uSunDir);
  col += uSunColor * uSunI * pow(max(dot(n, H), 0.0), 320.0) * 2.1;
  col += uSunColor * uSunI * pow(max(dot(n, H), 0.0), 24.0) * 0.10;

  float fade = smoothstep(0.0, 0.10, vLife) * smoothstep(0.012, 0.045, radii.x);
  float bodyA = 0.30 + 0.22 * ndv;
  float rimA = 0.16 + 0.70 * F + 0.32 * tir;
  float alpha = mix(bodyA, rimA, clamp(F + tir * 0.45, 0.0, 1.0)) * fade * hit;
  gl_FragColor = vec4(max(col, 0.0) * hit, clamp(alpha, 0.0, 0.90));
}
`;

export const BUBBLE_MESH_VEL_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 uCurViewProjection;
uniform mat4 uPrevViewProjection;
uniform vec3 uCamPos;
uniform sampler2D uPos;
uniform sampler2D uPosPrev;
uniform sampler2D uVel;
uniform float uWidth;
uniform float uHeight;
uniform float uSizeScale;
uniform float uJumpLimit;
uniform float uTime;
#include<logDepthDeclaration>

varying vec4 vCur;
varying vec4 vPrev;
varying float vDisc;
varying float vAlive;
varying vec2 vVCorner;
varying vec3 vWorldCur;
varying vec3 vWorldPrev;
varying float vBorn;
varying float vReused;

void main(){
  float idx = uv.x;
  vec2 st = vec2(mod(idx, uWidth) + 0.5, floor(idx / uWidth) + 0.5) / vec2(uWidth, uHeight);
  vec4 A = textureLod(uPos, st, 0.0);
  vec4 P = textureLod(uPosPrev, st, 0.0);
  vec4 B = textureLod(uVel, st, 0.0);
  float alive = (A.w > 1e-6 && B.w * uSizeScale > 1e-6) ? 1.0 : 0.0;
  vAlive = alive;
  float born = (P.w <= 1e-6) ? 1.0 : 0.0;
  float lifeUp = step(P.w - 1e-5, A.w);
  float jump = distance(A.xyz, P.xyz);
  float reused = clamp(lifeUp + step(uJumpLimit, jump), 0.0, 1.0);
  vDisc = clamp(born + reused, 0.0, 1.0);
  vBorn = born; vReused = reused;
  vWorldCur = A.xyz; vWorldPrev = P.xyz;
  float size = B.w * uSizeScale;
  float seed = fract(idx * 0.6180339);
  float wob = 0.055 * sin(uTime * (2.4 + seed * 1.8) + seed * 6.28318);
  vec3 sc = vec3(1.0 + wob, 1.0 - wob * 0.32, 1.0 - wob * 0.55);
  vec3 hull = position * sc * size * 1.20;
  vec3 wp = A.xyz * alive + hull * alive;
  vec3 prevBase = mix(P.xyz, A.xyz, vDisc) * alive;
  vec3 wpPrev = prevBase + hull * alive;
  vVCorner = vec2(0.0);
  vCur = uCurViewProjection * vec4(wp, 1.0);
  vPrev = uPrevViewProjection * vec4(wpPrev, 1.0);
  gl_Position = mix(vec4(2.0, 2.0, 2.0, 1.0), vCur, alive);
#include<logDepthVertex>
}
`;

// ---------------------------------------------------------------------------
//  PARTICLE VELOCITY
//
//  Particles draw over the ocean but move independently of it, so reprojecting
//  them with the water's velocity is simply wrong -- measured, the underwater
//  motes alone flipped TAA from +56% to negative.  The state textures are
//  already ping-ponged, so the previous position of the SAME slot is available
//  for free; nothing has to be inferred.
//
//  Three cases the vector must not be trusted:
//    birth       no previous position exists at all
//    pool reuse  slot 51 dies here and respawns 100 m away next frame, which
//                would otherwise emit an enormous cross-screen vector
//    wrapping    a camera-local particle repositioned around the view volume
//  All three are detected from the two state textures and reported as
//  discontinuities: zero velocity, maximum reactivity, no history.
// ---------------------------------------------------------------------------
export const PARTICLE_VEL_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 uCurViewProjection;
uniform mat4 uPrevViewProjection;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamPos;
uniform sampler2D uPos;
uniform sampler2D uPosPrev;
uniform sampler2D uVel;
uniform float uWidth;
uniform float uHeight;
uniform float uSizeScale;
uniform float uMinPixel;      // must match the draw pass or the vector misses
uniform float uPxScale;
uniform float uJumpLimit;     // metres/frame beyond which this is not motion
uniform float uStretch;       // must match the draw pass: see the note below
#include<logDepthDeclaration>

varying vec4 vCur;
varying vec4 vPrev;
varying float vDisc;          // 1 = discontinuity, history is invalid
varying float vAlive;
varying vec2 vVCorner;        // for the round coverage footprint
varying vec3 vWorldCur;       // debug: where this particle IS
varying vec3 vWorldPrev;      // debug: where it WAS
varying float vBorn;
varying float vReused;

void main(){
  float idx = position.z;
  vec2 uv = vec2(mod(idx, uWidth) + 0.5, floor(idx / uWidth) + 0.5) / vec2(uWidth, uHeight);
  vec4 A = textureLod(uPos, uv, 0.0);
  vec4 P = textureLod(uPosPrev, uv, 0.0);
  vec4 B = textureLod(uVel, uv, 0.0);

  float size = B.w * uSizeScale;
  if (uMinPixel > 0.0)
    size = max(size, uPxScale * distance(uCamPos, A.xyz) * uMinPixel);
  float alive = (A.w > 1e-6 && B.w * uSizeScale > 1e-6) ? 1.0 : 0.0;
  vAlive = alive;

  // no previous life -> born this frame -> there is no history to reproject
  float born = (P.w <= 1e-6) ? 1.0 : 0.0;
  // Pool reuse detected by LIFE, which is exact.  A continuing particle's life
  // only ever decreases, by dt, so life that failed to decrease means this slot
  // was handed to a different particle.  A distance test alone cannot see that:
  // a burst that respawns a slot a few centimetres from where the old particle
  // stood is a completely new object with a jump of nearly zero, and it would
  // be reprojected as if it had been there all along.  The distance test stays
  // as well, for the one case life misses -- a respawn whose fresh lifetime
  // happens to be shorter than what the previous occupant had left.
  float lifeUp = step(P.w - 1e-5, A.w);
  float jump = distance(A.xyz, P.xyz);
  float reused = clamp(lifeUp + step(uJumpLimit, jump), 0.0, 1.0);
  vDisc = clamp(born + reused, 0.0, 1.0);
  vBorn = born; vReused = reused;
  vWorldCur = A.xyz; vWorldPrev = P.xyz;

  vec3 base = A.xyz * alive;
  vec3 prevBase = mix(P.xyz, A.xyz, vDisc) * alive;   // discontinuity -> no motion

  size *= alive;
  // The same velocity stretch the draw pass applies.  A fast droplet is drawn
  // as a streak leaning along its motion, and if the velocity pass keeps it a
  // camera-aligned disc the two footprints disagree exactly where the particle
  // is moving fastest -- so the far end of every streak is reprojected as the
  // water behind it.
  vec3 right = uCamRight, up = uCamUp;
  float sp = length(B.xyz);
  if (sp > 1.2){
    vec3 axis = normalize(B.xyz);
    vec3 sideAxis = normalize(cross(axis, uCamPos - A.xyz) + 1e-5);
    right = sideAxis;
    up = axis * (1.0 + min(sp * uStretch, 4.0));
  }
  vec3 wp = base + right * position.x * size + up * position.y * size;
  vec3 wpPrev = prevBase + right * position.x * size + up * position.y * size;

  vVCorner = position.xy;
  vCur = uCurViewProjection * vec4(wp, 1.0);
  vPrev = uPrevViewProjection * vec4(wpPrev, 1.0);
  gl_Position = uCurViewProjection * vec4(wp, 1.0);
#include<logDepthVertex>
}
`;

export const PARTICLE_VEL_FRAG = /* glsl */ `
precision highp float;
varying vec4 vCur;
varying vec4 vPrev;
varying float vDisc;
varying float vAlive;
varying vec2 vVCorner;
varying vec3 vWorldCur;
varying vec3 vWorldPrev;
varying float vBorn;
varying float vReused;
uniform float uReactiveBase;   // per-kind floor: spray high, motes moderate
uniform float uCoverCut;       // below this footprint the water still owns the pixel
// How opaque this kind of particle actually draws.  A pixel's motion vector
// belongs to whatever DOMINATES its radiance, and mist is a translucent veil:
// geometrically it covers half a storm, but what you see through it is the
// water.  Letting it claim the vector on footprint alone hands the sea the
// mist's wind-driven velocity, the history is then fetched from the wrong
// place, and the water resolves blurred -- measured, detail retention fell to
// 68% at water level and the frame-to-frame difference went UP underwater.
uniform float uOpacity;
// 0 = write the real vector.  Non-zero replaces rgb with a diagnostic, so the
// velocity target itself can be inspected rather than trusted.
uniform float uPartDebug;
#include<logDepthDeclaration>

void main(){
#include<logDepthFragment>
  // The quad is square; the particle inside it is round and soft.  Writing a
  // vector across the whole quad would hand the water's pixels a particle's
  // motion, which is the same class of error as the reverse.
  float r2 = dot(vVCorner, vVCorner);
  float cover = pow(clamp(1.0 - r2, 0.0, 1.0), 1.6) * vAlive * uOpacity;
  if (cover < uCoverCut) discard;

  vec2 ndcCur = vCur.xy / max(vCur.w, 1e-6);
  vec2 ndcPrev = vPrev.xy / max(vPrev.w, 1e-6);
  vec2 mv = (ndcCur - ndcPrev) * 0.5;
  // A discontinuity is not motion: emit zero and let reactivity reject it.
  mv *= (1.0 - vDisc);
  // Alpha is "this pixel has a real motion vector", and it does -- the
  // particle's.  Partial coverage does not make the vector unknown, it makes
  // the pixel a MIXTURE of two motions, which is what reactivity is for.
  float mixed = 1.0 - smoothstep(0.25, 0.80, cover);
  float reactive = clamp(max(max(uReactiveBase, vDisc), 0.65 * mixed), 0.0, 1.0);
  vec3 outv = vec3(mv, reactive);
  if (uPartDebug > 0.5){
    if (uPartDebug < 1.5)      outv = fract(vWorldCur * 0.25);
    else if (uPartDebug < 2.5) outv = fract(vWorldPrev * 0.25);
    else if (uPartDebug < 3.5) outv = vec3(vBorn, vReused, vAlive);
    else if (uPartDebug < 4.5) outv = vec3(cover);
    else if (uPartDebug < 5.5) outv = vec3(abs(mv) * 220.0, 0.0);
    // the raw world-space step this particle took, in metres: the one view
    // that says whether uPos and uPosPrev are actually two different frames
    else                       outv = vec3(distance(vWorldCur, vWorldPrev) * 4.0);
  }
  gl_FragColor = vec4(outv, 1.0);
}
`;

/**
 * Suspended matter (motes).  A dim soft speck, not a lit sphere: this is silt
 * and plankton, so what it does is scatter whatever light reaches its depth
 * back at the camera.  Brightness is a RADIANCE handed down from the sky and
 * attenuated by depth -- a fixed colour looks painted on at night and vanishes
 * at midday.
 */
export const MOTE_FRAG = /* glsl */ `
precision highp float;
#include<logDepthDeclaration>
uniform vec3  uWaterTint;
uniform float uAmbient;
uniform vec3  uCamPos;

varying vec2 vCorner;
varying vec3 vWorld;
varying float vSize;
varying float vLife;
varying float vSeed;
varying float vDim;

void main(){
#include<logDepthFragment>
  float r2 = dot(vCorner, vCorner);
  if (r2 > 1.0) discard;
  // soft core with a wide falloff, the way an out-of-focus speck reads
  float a = pow(1.0 - clamp(r2, 0.0, 1.0), 1.6);
  // vLife is REMAINING seconds, so this is a fade-out only: a mote drifting
  // into existence full strength is invisible against the haze anyway.
  float fade = smoothstep(0.0, 0.8, vLife);
  vec3 col = uWaterTint * uAmbient * (0.55 + 0.9 * fract(vSeed * 7.31));
  gl_FragColor = vec4(col, a * fade * 0.30 * vDim);
}
`;
