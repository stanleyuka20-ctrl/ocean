// ---------------------------------------------------------------------------
//  LifeSystem.js -- coral, algae and small fish.  Ecological clustering on
//  the bathymetry (depth, slope, sun-facing, current exposure), thin instances.
// ---------------------------------------------------------------------------

import { SURFACE_VERT, SURFACE_FRAG } from "../shaders/scene.js";
import { makeLitMaterial, bindLitSurface } from "./surfaceBind.js";
import { UW, bathyY, bathyNormal, dropEdgeX } from "./bathymetry.js";

const B = () => window.BABYLON;
let SERIAL = 0;

function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function paint(mesh, rgb) {
  const BJ = B();
  const n = mesh.getTotalVertices();
  const c = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const j = hash(i * 0.31 + rgb[0] * 9);
    c[i * 4] = rgb[0] * (0.78 + 0.36 * j);
    c[i * 4 + 1] = rgb[1] * (0.78 + 0.36 * hash(i + 4));
    c[i * 4 + 2] = rgb[2] * (0.78 + 0.36 * hash(i + 9));
    c[i * 4 + 3] = 1;
  }
  mesh.setVerticesData(BJ.VertexBuffer.ColorKind, c);
}

function finish(mesh, mat) {
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.renderingGroupId = 1;
  mesh.applyFog = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.doNotSyncBoundingInfo = true;
  return mesh;
}

function merge(parts) {
  const BJ = B();
  const m = BJ.Mesh.MergeMeshes(parts, true, true, undefined, false, false);
  return m || parts[0];
}

function brain(scene) {
  const BJ = B();
  const m = BJ.MeshBuilder.CreateIcoSphere("cBrain", { radius: 0.62, subdivisions: 3 }, scene);
  const p = m.getVerticesData(BJ.VertexBuffer.PositionKind);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    const ridges = 0.11 * Math.sin((x * 22 + z * 18) + Math.sin(y * 16) * 2.4);
    const s = 1 + ridges + (hash(i) - 0.5) * 0.08;
    p[i] *= s; p[i + 1] *= s * 0.72; p[i + 2] *= s;
  }
  m.updateVerticesData(BJ.VertexBuffer.PositionKind, p);
  m.createNormals(true);
  paint(m, [0.36, 0.52, 0.16]);
  return m;
}

function staghorn(scene) {
  const BJ = B();
  const parts = [];
  const trunk = BJ.MeshBuilder.CreateCylinder("st0", {
    height: 1.05, diameterTop: 0.06, diameterBottom: 0.16, tessellation: 7,
  }, scene);
  parts.push(trunk);
  for (let i = 0; i < 11; i++) {
    const b = BJ.MeshBuilder.CreateCylinder("st" + i, {
      height: 0.38 + hash(i) * 0.55, diameterTop: 0.025, diameterBottom: 0.065, tessellation: 5,
    }, scene);
    b.position.y = 0.22 + hash(i + 2) * 0.45;
    b.rotation.z = (hash(i) - 0.5) * 1.25;
    b.rotation.y = i * 0.57;
    b.position.x = Math.sin(i * 0.57) * 0.16;
    b.position.z = Math.cos(i * 0.57) * 0.16;
    parts.push(b);
  }
  const m = merge(parts);
  paint(m, [0.68, 0.50, 0.14]);
  return m;
}

function fan(scene) {
  const BJ = B();
  const m = BJ.MeshBuilder.CreateGround("cFan", { width: 1.35, height: 1.55, subdivisions: 12 }, scene);
  const p = m.getVerticesData(BJ.VertexBuffer.PositionKind);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], z = p[i + 2];
    const r = Math.hypot(x, z * 0.55);
    const lace = 0.04 * Math.sin(x * 28) * Math.sin(z * 22);
    p[i] = x * (1 + lace);
    p[i + 1] = (0.15 - z) * 0.95 + lace;
    p[i + 2] = z * 0.12 + Math.sin(x * 9) * 0.03;
  }
  m.updateVerticesData(BJ.VertexBuffer.PositionKind, p);
  m.createNormals(true);
  paint(m, [0.72, 0.22, 0.12]);
  return m;
}

function sponge(scene) {
  const BJ = B();
  const m = BJ.MeshBuilder.CreateCylinder("cSp", {
    height: 0.82, diameterTop: 0.32, diameterBottom: 0.52, tessellation: 8,
  }, scene);
  const p = m.getVerticesData(BJ.VertexBuffer.PositionKind);
  for (let i = 0; i < p.length; i += 3) {
    const s = 0.82 + hash(i) * 0.38;
    p[i] *= s; p[i + 2] *= s;
    p[i + 1] += Math.sin(p[i] * 12) * 0.03;
  }
  m.updateVerticesData(BJ.VertexBuffer.PositionKind, p);
  m.createNormals(true);
  paint(m, [0.42, 0.18, 0.38]);
  return m;
}

function tubes(scene) {
  const BJ = B();
  const parts = [];
  for (let i = 0; i < 8; i++) {
    const h = 0.4 + hash(i) * 0.7;
    const c = BJ.MeshBuilder.CreateCylinder("tb" + i, {
      height: h, diameter: 0.07 + hash(i + 3) * 0.06, tessellation: 6,
    }, scene);
    c.position.set((hash(i) - 0.5) * 0.42, h * 0.5, (hash(i + 5) - 0.5) * 0.42);
    parts.push(c);
  }
  const m = merge(parts);
  paint(m, [0.32, 0.20, 0.12]);
  return m;
}

function grass(scene) {
  const BJ = B();
  const m = BJ.MeshBuilder.CreateGround("cGr", { width: 0.16, height: 0.7, subdivisions: 2 }, scene);
  const p = m.getVerticesData(BJ.VertexBuffer.PositionKind);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], z = p[i + 2];
    p[i] = x + Math.sin(z * 8) * 0.04;
    p[i + 1] = z + 0.35;
    p[i + 2] = 0;
  }
  m.updateVerticesData(BJ.VertexBuffer.PositionKind, p);
  m.createNormals(true);
  paint(m, [0.16, 0.34, 0.12]);
  return m;
}

function anemone(scene) {
  const BJ = B();
  const parts = [];
  const base = BJ.MeshBuilder.CreateSphere("an0", { diameter: 0.28, segments: 6 }, scene);
  base.scaling.y = 0.55;
  parts.push(base);
  for (let i = 0; i < 10; i++) {
    const t = BJ.MeshBuilder.CreateCylinder("an" + i, {
      height: 0.45, diameterTop: 0.012, diameterBottom: 0.03, tessellation: 4,
    }, scene);
    const a = i * 0.63;
    t.position.set(Math.cos(a) * 0.08, 0.28, Math.sin(a) * 0.08);
    t.rotation.z = (hash(i) - 0.5) * 0.7;
    t.rotation.x = (hash(i + 3) - 0.5) * 0.7;
    parts.push(t);
  }
  const m = merge(parts);
  paint(m, [0.62, 0.28, 0.22]);
  return m;
}

function fishBody(scene) {
  const BJ = B();
  const m = BJ.MeshBuilder.CreateSphere("fish", {
    diameterX: 0.28, diameterY: 0.13, diameterZ: 0.09, segments: 6,
  }, scene);
  paint(m, [0.78, 0.34, 0.08]);
  return m;
}

function bakeKind(proto, placements, scene, mat, name) {
  const BJ = B();
  if (!placements.length) {
    proto.dispose();
    return null;
  }
  const parts = [];
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    const c = proto.clone(name + i, null, true);
    c.position.set(p.x, p.y, p.z);
    c.scaling.set(p.sx, p.sy, p.sz);
    c.rotation.x = p.rx || 0;
    c.rotation.y = p.ry || 0;
    c.rotation.z = p.rz || 0;
    parts.push(c);
  }
  proto.dispose();
  const mesh = BJ.Mesh.MergeMeshes(parts, true, true, undefined, false, false);
  if (!mesh) return null;
  return finish(mesh, mat);
}

const CLUSTERS = [
  { x: 10, z: 16, r: 15, w: 3.6 },
  { x: 18, z: 10, r: 11, w: 2.0 },
  { x: 6, z: 8, r: 9, w: 1.4 },
  { x: 72, z: 38, r: 13, w: 2.4 },
  { x: 88, z: -88, r: 9, w: 1.1 },
  { x: 4, z: -6, r: 8, w: 0.9 },
];

function clusterPoint(tries, seed) {
  let tot = 0;
  for (const c of CLUSTERS) tot += c.w;
  let u = hash(tries * 1.17 + seed) * tot;
  let c = CLUSTERS[0];
  for (const k of CLUSTERS) {
    u -= k.w;
    if (u <= 0) { c = k; break; }
  }
  const a = hash(tries * 2.09 + 9) * 6.2831853;
  const rr = Math.sqrt(hash(tries * 0.41 + seed)) * c.r;
  return { x: c.x + Math.cos(a) * rr, z: c.z + Math.sin(a) * rr };
}

export class LifeSystem {
  constructor(scene, ocean) {
    this.scene = scene;
    this.ocean = ocean;
    this.meshes = [];
    this.material = null;
    this.heroMat = null;
    this.fish = null;
    this.fishBuf = null;
    this.fishN = 0;
    this.schools = [];
    this.coralDensity = 1;
    this.fishDensity = 1;
    this._clock = 0;
  }

  build() {
    const BJ = B();
    const id = `uwlife${SERIAL++}`;
    this.material = makeLitMaterial(this.scene, id, SURFACE_VERT, SURFACE_FRAG, {
      cull: false, vertexColor: true,
    });
    this.heroMat = makeLitMaterial(this.scene, id + "h", SURFACE_VERT, SURFACE_FRAG, {
      cull: false, vertexColor: true,
    });
    this.fishMat = makeLitMaterial(this.scene, id + "f", SURFACE_VERT, SURFACE_FRAG, {
      cull: false, vertexColor: true,
    });

    const makers = {
      brain, stag: staghorn, fan, sponge, tubes, grass, anemone,
    };
    const kinds = [
      { name: "brain", n: 90, minD: 5, maxD: 18, slope: 0.42 },
      { name: "stag", n: 80, minD: 6, maxD: 24, slope: 0.52 },
      { name: "fan", n: 50, minD: 7, maxD: 30, slope: 0.95, wall: true },
      { name: "sponge", n: 50, minD: 6, maxD: 26, slope: 0.65 },
      { name: "tubes", n: 45, minD: 5, maxD: 20, slope: 0.48 },
      { name: "grass", n: 140, minD: 5, maxD: 15, slope: 0.26 },
      { name: "anemone", n: 40, minD: 5, maxD: 16, slope: 0.4 },
    ];

    for (const k of kinds) {
      const proto = makers[k.name](this.scene);
      const want = Math.round(k.n * this.coralDensity);
      const places = [];
      let tries = 0;
      while (places.length < want && tries < want * 18) {
        tries++;
        const pt = clusterPoint(tries, k.n);
        const x = pt.x, z = pt.z;
        if (x > dropEdgeX(z) - 10) continue;
        const depth = -bathyY(x, z);
        if (depth < k.minD || depth > k.maxD) continue;
        const nrm = bathyNormal(x, z);
        const slope = 1 - nrm.y;
        if (k.wall) {
          if (slope < 0.28) continue;
        } else if (slope > k.slope) continue;
        const y = bathyY(x, z);
        const sc = (k.name === "grass" ? 1.1 : 1.55) + hash(tries * 3.3) * (k.name === "grass" ? 1.4 : 2.4);
        const yaw = k.wall ? Math.atan2(nrm.x, nrm.z) : hash(tries) * 6.28;
        const pitch = k.wall ? -0.4 * slope : (k.name === "fan" ? -0.15 : 0);
        places.push({
          x, y: y + (k.name === "fan" ? 0.45 : 0.04), z,
          sx: sc, sy: sc, sz: sc, ry: yaw, rx: pitch, rz: 0,
        });
      }
      const mesh = bakeKind(proto, places, this.scene, this.material, k.name);
      if (mesh) this.meshes.push(mesh);
    }

    this.fishN = Math.round(48 * this.fishDensity);
    this.fish = [];
    const protoFish = fishBody(this.scene);
    finish(protoFish, this.fishMat);
    protoFish.setEnabled(false);
    for (let i = 0; i < this.fishN; i++) {
      const f = protoFish.clone("uwFish" + i, null, true);
      finish(f, this.fishMat);
      this.fish.push(f);
      this.meshes.push(f);
    }
    protoFish.dispose();
    this.schools = [
      { x: 10, z: 18, r: 8, n0: 0, n1: 18, y: -7.4 },
      { x: UW.arch.x, z: UW.arch.z, r: 6.5, n0: 18, n1: 32, y: -6.8 },
      { x: UW.cavern.x, z: UW.cavern.z + 6, r: 8, n0: 32, n1: this.fishN, y: -10 },
    ];

    const heroes = [
      [12, 18, 2.6, "brain"], [16, 12, 2.2, "stag"], [7, 11, 2.4, "sponge"],
      [20, 17, 2.0, "stag"], [9, 22, 1.9, "anemone"], [14, 21, 2.5, "fan"],
      [68, 42, 2.8, "brain"], [76, 33, 2.3, "sponge"],
    ];
    for (let i = 0; i < heroes.length; i++) {
      const [x, z, sc, kind] = heroes[i];
      const m = makers[kind](this.scene);
      finish(m, this.heroMat);
      m.position.set(x, bathyY(x, z) + 0.18, z);
      m.scaling.set(sc, sc, sc);
      m.rotation.y = hash(i * 7) * 6.28;
      this.meshes.push(m);
    }
    return this;
  }

  update(dt) {
    this._clock += dt;
    if (this.material) {
      bindLitSurface(this.material, this.ocean, {
        kind: 1, rough: 0.48, color: [0.55, 0.52, 0.32],
      });
    }
    if (this.heroMat) {
      bindLitSurface(this.heroMat, this.ocean, {
        kind: 1, rough: 0.48, color: [0.55, 0.52, 0.32],
      });
    }
    if (this.fishMat) {
      bindLitSurface(this.fishMat, this.ocean, {
        kind: 1, rough: 0.32, color: [0.85, 0.42, 0.12],
      });
    }
    const cam = this.ocean.camera.globalPosition;
    const reefOn = Math.hypot(cam.x, cam.z) < 260 && cam.y > -90;
    const fishSet = this.fish || [];
    for (const m of this.meshes) {
      if (fishSet.indexOf(m) >= 0) continue;
      m.setEnabled(reefOn && this.coralDensity > 0.02);
    }

    const near = cam.y > -90 && Math.hypot(cam.x, cam.z) < 280 && this.fishDensity > 0.02;
    const t = this._clock;
    for (let i = 0; i < fishSet.length; i++) {
      const f = fishSet[i];
      f.setEnabled(near);
      if (!near) continue;
      let school = this.schools[0];
      for (const s of this.schools) if (i >= s.n0 && i < s.n1) school = s;
      const u = i * 0.37;
      const a = t * (0.35 + hash(i) * 0.25) + u;
      const x = school.x + Math.cos(a) * school.r * (0.55 + hash(i + 2) * 0.55);
      const z = school.z + Math.sin(a) * school.r * (0.55 + hash(i + 3) * 0.55);
      let y = school.y + Math.sin(t * 1.3 + i) * 0.7;
      const bed = bathyY(x, z) + 0.55;
      if (y < bed) y = bed;
      const vx = -Math.sin(a), vz = Math.cos(a);
      f.position.set(x, y, z);
      const sc = 1.05 + hash(i) * 0.55;
      f.scaling.set(sc, 1, 1);
      f.rotation.y = Math.atan2(vx, vz);
      f.rotation.x = 0.1;
    }
  }

  dispose() {
    for (const m of this.meshes) m.dispose(false, false);
    this.meshes = [];
    if (this.material) { this.material.dispose(); this.material = null; }
    if (this.heroMat) { this.heroMat.dispose(); this.heroMat = null; }
    if (this.fishMat) { this.fishMat.dispose(); this.fishMat = null; }
  }
}
