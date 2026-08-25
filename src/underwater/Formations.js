// ---------------------------------------------------------------------------
//  Formations.js -- arches, cavern, drop-off walls, canyon boulders.
//  Large geological forms first, then erosion, then rubble.  Not a tiled box.
// ---------------------------------------------------------------------------

import { SURFACE_VERT, SURFACE_FRAG } from "../shaders/scene.js";
import { makeLitMaterial, bindLitSurface } from "./surfaceBind.js";
import { UW, bathyY, dropEdgeX, bathyDepth } from "./bathymetry.js";

const B = () => window.BABYLON;
let SERIAL = 0;

function hash(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

function applyVD(mesh, positions, indices, uvs) {
  const BJ = B();
  const vd = new BJ.VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.uvs = uvs;
  const nrm = [];
  BJ.VertexData.ComputeNormals(positions, indices, nrm);
  vd.normals = nrm;
  vd.applyToMesh(mesh, true);
  return mesh;
}

function finish(mesh, mat) {
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = false;
  mesh.doNotSyncBoundingInfo = false;
  mesh.renderingGroupId = 1;
  mesh.applyFog = false;
  mesh.receiveShadows = false;
  return mesh;
}

function buildArch(scene, mat) {
  const BJ = B();
  const ox = UW.arch.x, oz = UW.arch.z;
  const bed = bathyY(ox, oz);
  const nu = 56, nv = 20;
  const R0 = 9.4, r0 = 2.35;
  const pos = [], ind = [], uv = [];
  for (let i = 0; i <= nu; i++) {
    const th = (i / nu) * Math.PI;
    const tx = -Math.sin(th), ty = Math.cos(th);
    const cx = Math.cos(th) * R0;
    const cy = Math.sin(th) * R0;
    for (let j = 0; j <= nv; j++) {
      const ph = (j / nv) * Math.PI * 2;
      const nse = hash(i * 19.1 + j * 7.3);
      const R = R0 + (nse - 0.5) * 2.15 + Math.sin(th * 3.0 + nse * 4.0) * 0.7
        + Math.sin(th * 7.0) * 0.28;
      const rr = r0 * (0.78 + 0.32 * hash(j * 5.1 + i)) * (0.7 + 0.4 * Math.sin(ph * 2.0 + th));
      const bx = 0, by = 0, bz = 1;
      const nx = ty * bz, ny = -tx * bz, nz = tx * by - ty * bx;
      let px = cx + (nx * Math.cos(ph) + bx * Math.sin(ph)) * rr;
      let py = cy + (ny * Math.cos(ph) + by * Math.sin(ph)) * rr;
      let pz = (nz * Math.cos(ph) + bz * Math.sin(ph)) * rr * 1.22;
      px += (hash(i * 3.7 + j) - 0.5) * 0.7;
      py += (hash(i * 8.1 + j * 2.2) - 0.5) * 0.55;
      pz += (hash(j * 11.3 + i) - 0.5) * 0.85;
      pos.push(ox + px, bed + 0.4 + py, oz + pz);
      uv.push(i / nu, j / nv);
    }
  }
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = i * (nv + 1) + j;
      const b = a + nv + 1;
      ind.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const mesh = new BJ.Mesh("uwArch", scene);
  applyVD(mesh, pos, ind, uv);
  return finish(mesh, mat);
}

function buildCliff(scene, mat) {
  const BJ = B();
  const cols = 22;
  const zs = [];
  for (let z = -380; z <= 380; z += 3.5) zs.push(z);
  const pos = [], ind = [], uv = [];
  for (let i = 0; i < zs.length; i++) {
    const z = zs[i];
    const edge = dropEdgeX(z);
    const yTop = bathyY(edge - 16, z) - 0.2;
    const yBot = Math.min(bathyY(edge + 48, z), yTop - 40);
    for (let c = 0; c < cols; c++) {
      const t = c / (cols - 1);
      const y = yTop + (yBot - yTop) * t;
      const over = Math.sin(t * Math.PI) * (2.8 + 3.6 * hash(z * 0.07 + c));
      const nse = (hash(z * 0.031 + t * 8) - 0.5) * 6.2;
      const ledges = t > 0.12 && t < 0.62 && hash(Math.floor(z / 12) * 9 + c) > 0.68 ? 4.1 : 0;
      const collapse = t > 0.35 && t < 0.7 && hash(Math.floor(z / 22) * 3) > 0.82 ? -2.8 : 0;
      const x = edge + 1.8 + nse - over + ledges * 0.45 + collapse;
      pos.push(x, y, z);
      uv.push(i * 0.028, t);
    }
  }
  for (let i = 0; i < zs.length - 1; i++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = i * cols + c;
      const b = a + cols;
      ind.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const mesh = new BJ.Mesh("uwCliff", scene);
  applyVD(mesh, pos, ind, uv);
  return finish(mesh, mat);
}

function buildCavern(scene, mat) {
  const BJ = B();
  const c = UW.cavern;
  const segs = 48;
  const pos = [], ind = [], uv = [];
  const rings = [
    { r: c.inner, y: c.ceil + 0.15 },
    { r: c.inner + 2.4, y: c.ceil - 0.4 },
    { r: (c.inner + c.outer) * 0.5, y: c.ceil - 0.15 },
    { r: c.outer - 1.2, y: c.ceil + 0.35 },
    { r: c.outer, y: c.ceil + 0.8 },
  ];
  const nr = rings.length;
  for (let k = 0; k < nr; k++) {
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const nse = (hash(i * 0.7 + k * 4.2) - 0.5) * 1.4;
      const r = rings[k].r + nse;
      const y = rings[k].y + (hash(i * 2.1 + k) - 0.5) * 0.55;
      pos.push(c.x + Math.cos(a) * r, y, c.z + Math.sin(a) * r);
      uv.push(i / segs, k / (nr - 1));
    }
  }
  for (let k = 0; k < nr - 1; k++) {
    for (let i = 0; i < segs; i++) {
      const a = k * (segs + 1) + i;
      const b = a + segs + 1;
      ind.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  // walls from ceiling outer ring down to the bed
  const wall0 = pos.length / 3;
  const wcols = 7;
  for (let s = 0; s <= segs; s++) {
    const a = (s / segs) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const r = c.outer + (hash(s * 1.3) - 0.5) * 2.2;
    const x = c.x + ca * r, z = c.z + sa * r;
    const yTop = c.ceil + 0.6;
    const yBot = bathyY(x, z) - 0.4;
    for (let k = 0; k < wcols; k++) {
      const t = k / (wcols - 1);
      const over = Math.sin(t * Math.PI) * 1.6 * hash(s + 3);
      pos.push(x - ca * over, yTop + (yBot - yTop) * t, z - sa * over);
      uv.push(s / segs, t);
    }
  }
  for (let s = 0; s < segs; s++) {
    for (let k = 0; k < wcols - 1; k++) {
      const a = wall0 + s * wcols + k;
      const b = a + wcols;
      ind.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const mesh = new BJ.Mesh("uwCavern", scene);
  applyVD(mesh, pos, ind, uv);
  return finish(mesh, mat);
}

function buildCanyonWalls(scene, mat) {
  const BJ = B();
  const ax = UW.canyonA.x, az = UW.canyonA.z;
  const bx = UW.canyonB.x, bz = UW.canyonB.z;
  const steps = 56;
  const cols = 18;
  const pos = [], ind = [], uv = [];
  const sides = [-1, 1];
  for (const side of sides) {
    const base = pos.length / 3;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = ax + (bx - ax) * t;
      const cz = az + (bz - az) * t;
      const dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz) || 1;
      const px = -dz / len * side, pz = dx / len * side;
      const half = 14 + 26 * t;
      for (let c = 0; c < cols; c++) {
        const u = c / (cols - 1);
        const x = cx + px * (half + (hash(i * 5 + c + side) - 0.5) * 4.5);
        const z = cz + pz * (half + (hash(i * 9 + c) - 0.5) * 4.5);
        const yTop = bathyY(cx + px * (half + 8), cz + pz * (half + 8));
        const yBot = bathyY(cx, cz) - 2;
        const y = yTop + (yBot - yTop) * u;
        const over = Math.sin(u * Math.PI) * (1.8 + 3.2 * hash(i + side * 7));
        const ledge = u > 0.2 && u < 0.55 && hash(i * 3 + c) > 0.74 ? 2.4 : 0;
        pos.push(x - px * (over - ledge), y, z - pz * (over - ledge));
        uv.push(t * 4, u);
      }
    }
    for (let i = 0; i < steps; i++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = base + i * cols + c;
        const b = a + cols;
        if (side > 0) ind.push(a, b, a + 1, a + 1, b, b + 1);
        else ind.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  const mesh = new BJ.Mesh("uwCanyon", scene);
  applyVD(mesh, pos, ind, uv);
  return finish(mesh, mat);
}

function buildBoulders(scene, mat) {
  const BJ = B();
  const proto = BJ.MeshBuilder.CreateIcoSphere("uwBoulderP", { radius: 1, subdivisions: 2 }, scene);
  const pos = proto.getVerticesData(BJ.VertexBuffer.PositionKind);
  for (let i = 0; i < pos.length; i += 3) {
    const n = hash(i * 0.17);
    pos[i] *= 0.75 + n * 0.7;
    pos[i + 1] *= 0.55 + hash(i + 3) * 0.5;
    pos[i + 2] *= 0.8 + hash(i + 9) * 0.55;
  }
  proto.updateVerticesData(BJ.VertexBuffer.PositionKind, pos);
  proto.createNormals(true);
  const N = 48;
  const parts = [];
  for (let i = 0; i < N; i++) {
    const t = (i / (N - 1)) * 0.92 + 0.04;
    const cx = UW.canyonA.x + (UW.canyonB.x - UW.canyonA.x) * t;
    const cz = UW.canyonA.z + (UW.canyonB.z - UW.canyonA.z) * t;
    const side = i % 2 ? 1 : -1;
    const off = 4 + hash(i * 1.7) * 18;
    const dx = UW.canyonB.x - UW.canyonA.x, dz = UW.canyonB.z - UW.canyonA.z;
    const len = Math.hypot(dx, dz) || 1;
    const x = cx + (-dz / len) * side * off;
    const z = cz + (dx / len) * side * off;
    const y = bathyY(x, z) + 0.4 + hash(i * 3.1) * 1.8;
    const sc = 1.1 + hash(i * 4.4) * 3.8;
    const c = proto.clone("uwB" + i, null, true);
    c.position.set(x, y, z);
    c.scaling.set(sc * (0.8 + hash(i) * 0.5), sc * (0.45 + hash(i + 2) * 0.4), sc * (0.7 + hash(i + 5) * 0.5));
    c.rotation.set(hash(i + 8) * 0.8, hash(i) * 6.28, hash(i + 3) * 6.28);
    parts.push(c);
  }
  proto.dispose();
  const mesh = BJ.Mesh.MergeMeshes(parts, true, true, undefined, false, false);
  mesh.name = "uwBoulderP";
  return finish(mesh, mat);
}

function buildRubble(scene, mat) {
  const BJ = B();
  const proto = BJ.MeshBuilder.CreateIcoSphere("uwRubble", { radius: 0.45, subdivisions: 1 }, scene);
  const N = 40;
  const parts = [];
  for (let i = 0; i < N; i++) {
    const a = hash(i * 2.2) * Math.PI * 2;
    const r = 4 + hash(i * 5.1) * 16;
    const x = UW.arch.x + Math.cos(a) * r;
    const z = UW.arch.z + Math.sin(a) * r * 0.7;
    const c = proto.clone("uwR" + i, null, true);
    c.position.set(x, bathyY(x, z) + 0.12, z);
    const sc = 0.35 + hash(i * 7) * 1.1;
    c.scaling.set(sc, sc * 0.55, sc * 0.9);
    c.rotation.set(0.2, hash(i) * 6, hash(i + 1) * 6);
    parts.push(c);
  }
  proto.dispose();
  const mesh = BJ.Mesh.MergeMeshes(parts, true, true, undefined, false, false);
  mesh.name = "uwRubble";
  return finish(mesh, mat);
}

export class Formations {
  constructor(scene, ocean) {
    this.scene = scene;
    this.ocean = ocean;
    this.meshes = [];
    this.material = null;
    this.instMat = null;
  }

  build() {
    const id = `uwrock${SERIAL++}`;
    this.material = makeLitMaterial(this.scene, id, SURFACE_VERT, SURFACE_FRAG, { cull: false });
    this.meshes = [
      buildArch(this.scene, this.material),
      buildCliff(this.scene, this.material),
      buildCavern(this.scene, this.material),
      buildCanyonWalls(this.scene, this.material),
      buildBoulders(this.scene, this.material),
      buildRubble(this.scene, this.material),
    ];
    return this;
  }

  update() {
    if (this.material) {
      bindLitSurface(this.material, this.ocean, {
        kind: 1, rough: 0.72, color: [0.22, 0.20, 0.18],
      });
    }
    const cam = this.ocean.camera.globalPosition;
    const x = cam.x, z = cam.z;
    for (const m of this.meshes) {
      const n = m.name || "";
      let on = true;
      if (n === "uwArch" || n === "uwRubble") on = Math.hypot(x - UW.arch.x, z - UW.arch.z) < 220;
      else if (n === "uwCavern") on = Math.hypot(x - UW.cavern.x, z - UW.cavern.z) < 260;
      else if (n === "uwCanyon" || n === "uwBoulderP") on = x > 140 || Math.hypot(x - 360, z + 140) < 420;
      else if (n === "uwCliff") on = x > 40 && x < 420;
      m.setEnabled(on);
    }
  }

  dispose() {
    for (const m of this.meshes) m.dispose(false, false);
    this.meshes = [];
    if (this.material) { this.material.dispose(); this.material = null; }
    if (this.instMat) { this.instMat.dispose(); this.instMat = null; }
  }
}

void bathyDepth;
