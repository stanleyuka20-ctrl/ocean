// ---------------------------------------------------------------------------
//  bathymetry.js -- one height function, JS and GLSL, world metres.
//
//  Sea level is y = 0.  Positive depth is metres below the surface.  The FFT
//  sea stays a deep-water spectrum; this field is visual + collision only.
//
//  Layout (demonstration sectors, not a planet):
//    origin          shallow reef lagoon ~8-16 m
//    +X ~170 m       noisy drop-off into a ~400 m wall
//    (72, 38)        natural rock arch (extra mesh)
//    (88, -95)       skylight cavern
//    (44, -28)       vent field
//    SE canyon       groove from the shelf into a 4000 m trench
// ---------------------------------------------------------------------------

export const UW = {
  maxDepth: 4000,
  arch: { x: 72, z: 38 },
  cavern: { x: 88, z: -95, inner: 6.8, outer: 34, ceil: -2.35 },
  vents: [
    { x: 42, z: -28, r: 0.55 },
    { x: 48, z: -22, r: 0.40 },
    { x: 36, z: -32, r: 0.35 },
    { x: 51, z: -31, r: 0.28 },
  ],
  canyonA: { x: 205, z: -12 },
  canyonB: { x: 525, z: -265 },
};

function fract(x) { return x - Math.floor(x); }
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

function bhash(x, z) {
  return fract(Math.sin(x * 127.1 + z * 311.7) * 43758.5453);
}
function bnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = bhash(ix, iz), b = bhash(ix + 1, iz);
  const c = bhash(ix, iz + 1), d = bhash(ix + 1, iz + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
function bfbm(x, z, oct) {
  let a = 0, w = 0.5, px = x, pz = z;
  const n = oct | 0;
  for (let i = 0; i < n; i++) {
    a += w * bnoise(px, pz);
    px *= 2.07; pz *= 2.07; w *= 0.52;
  }
  return a;
}

export function dropEdgeX(z) {
  return 168 + (bfbm(z * 0.012, 3.1, 4) - 0.45) * 44 + Math.sin(z * 0.031) * 9;
}

function canyonCarve(x, z) {
  const ax = UW.canyonA.x, az = UW.canyonA.z;
  const bx = UW.canyonB.x, bz = UW.canyonB.z;
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = ((x - ax) * dx + (z - az) * dz) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + dx * t, pz = az + dz * t;
  const d = Math.hypot(x - px, z - pz);
  const width = 16 + 28 * t + 9 * bfbm(x * 0.021, z * 0.021, 3);
  const carve = smoothstep(width, width * 0.18, d);
  const deep = 35 + t * t * 3550;
  return carve * deep * (0.88 + 0.12 * bfbm(x * 0.01, z * 0.01, 2));
}

/** Metres of water above the bed at (x, z). */
export function bathyDepth(x, z) {
  let d = 10.5 + (bfbm(x * 0.018, z * 0.018, 5) - 0.5) * 5.5;
  d += (bfbm(x * 0.07, z * 0.07, 3) - 0.5) * 1.55;
  d += Math.sin(x * 0.62 + bfbm(x * 0.11, z * 0.11, 2) * 3.1) * 0.07;
  d += Math.sin(z * 0.91 + 2.4) * 0.04;

  const edge = dropEdgeX(z);
  const wall = smoothstep(edge - 22, edge + 18, x);
  const wallH = 320 + bfbm(z * 0.008, 9.2, 3) * 90;
  d += wall * wallH;

  const beyond = smoothstep(edge + 20, edge + 220, x);
  d += beyond * (180 + bfbm(x * 0.006, z * 0.006, 3) * 80);

  d += canyonCarve(x, z);

  const tx = x - 470, tz = z + 250;
  const tr = Math.hypot(tx * 0.7, tz);
  d += smoothstep(220, 40, tr) * 800 * beyond;

  const shelf = 1 - wall;
  const pin = Math.max(0, bfbm(x * 0.045, z * 0.045, 4) - 0.62) * 7 * shelf;
  d -= pin;

  const cx = x - UW.cavern.x, cz = z - UW.cavern.z;
  const cr = Math.hypot(cx, cz);
  d += smoothstep(28, 8, cr) * 6;

  if (d < 4.2) d = 4.2;
  if (d > UW.maxDepth) d = UW.maxDepth;
  return d;
}

export function bathyY(x, z, sea) {
  return (sea || 0) - bathyDepth(x, z);
}

export function bathyNormal(x, z, e) {
  const eps = e || 0.7;
  const h = bathyY(x, z);
  const hx = bathyY(x + eps, z);
  const hz = bathyY(x, z + eps);
  const nx = -(hx - h) / eps;
  const nz = -(hz - h) / eps;
  const len = Math.hypot(nx, 1, nz) || 1;
  return { x: nx / len, y: 1 / len, z: nz / len };
}

export function cavernCeiling(x, z) {
  const c = UW.cavern;
  const r = Math.hypot(x - c.x, z - c.z);
  if (r > c.inner && r < c.outer + 2) return c.ceil;
  return null;
}

export const BATHY_GLSL = /* glsl */ `
float bhash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float bnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = bhash(i), b = bhash(i + vec2(1.0, 0.0));
  float c = bhash(i + vec2(0.0, 1.0)), d = bhash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float bfbm(vec2 p, int oct){
  float a = 0.0, w = 0.5;
  for (int i = 0; i < 6; i++){
    if (i >= oct) break;
    a += w * bnoise(p);
    p *= 2.07;
    w *= 0.52;
  }
  return a;
}
float dropEdgeX(float z){
  return 168.0 + (bfbm(vec2(z * 0.012, 3.1), 4) - 0.45) * 44.0 + sin(z * 0.031) * 9.0;
}
float canyonCarve(vec2 p){
  vec2 a = vec2(205.0, -12.0);
  vec2 b = vec2(525.0, -265.0);
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1.0), 0.0, 1.0);
  vec2 pr = a + ab * t;
  float d = length(p - pr);
  float width = 16.0 + 28.0 * t + 9.0 * bfbm(p * 0.021, 3);
  float carve = smoothstep(width, width * 0.18, d);
  float deep = 35.0 + t * t * 3550.0;
  return carve * deep * (0.88 + 0.12 * bfbm(p * 0.01, 2));
}
float bathyDepth(vec2 p){
  float d = 10.5 + (bfbm(p * 0.018, 5) - 0.5) * 5.5;
  d += (bfbm(p * 0.07, 3) - 0.5) * 1.55;
  d += sin(p.x * 0.62 + bfbm(p * 0.11, 2) * 3.1) * 0.07;
  d += sin(p.y * 0.91 + 2.4) * 0.04;
  float edge = dropEdgeX(p.y);
  float wall = smoothstep(edge - 22.0, edge + 18.0, p.x);
  float wallH = 320.0 + bfbm(vec2(p.y * 0.008, 9.2), 3) * 90.0;
  d += wall * wallH;
  float beyond = smoothstep(edge + 20.0, edge + 220.0, p.x);
  d += beyond * (180.0 + bfbm(p * 0.006, 3) * 80.0);
  d += canyonCarve(p);
  vec2 tq = vec2((p.x - 470.0) * 0.7, p.y + 250.0);
  d += smoothstep(220.0, 40.0, length(tq)) * 800.0 * beyond;
  float shelf = 1.0 - wall;
  d -= max(0.0, bfbm(p * 0.045, 4) - 0.62) * 7.0 * shelf;
  float cr = length(p - vec2(88.0, -95.0));
  d += smoothstep(28.0, 8.0, cr) * 6.0;
  return clamp(d, 4.2, 4000.0);
}
float bathyDepthCoarse(vec2 p){
  float d = 10.5;
  float edge = dropEdgeX(p.y);
  float wall = smoothstep(edge - 22.0, edge + 18.0, p.x);
  d += wall * 360.0;
  d += smoothstep(edge + 20.0, edge + 220.0, p.x) * 200.0;
  d += canyonCarve(p);
  return clamp(d, 4.2, 4000.0);
}
`;
