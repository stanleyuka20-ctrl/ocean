// ---------------------------------------------------------------------------
//  OceanLODManager.js -- the geo-clipmap.
//
//  A camera-centred set of nested square rings.  Every ring has the SAME
//  vertex count but twice the cell size of the one inside it, so triangle
//  density falls off with distance automatically and the sea can run to
//  262 km without a uniformly subdivided plane.
//
//  The whole clipmap is ONE mesh in ONE draw call: each vertex carries
//  (cellSize, halfExtent) in uv, and the vertex shader derives that level's
//  camera-snapped origin itself.  Cracks are removed by CDLOD morphing (the
//  outer band of a level slides onto the coarser lattice), plus a one-cell
//  overlap so a half-cell snapping difference between neighbouring levels can
//  never open a hole.
// ---------------------------------------------------------------------------

const B = () => window.BABYLON;

export class OceanLODManager {
  constructor(scene, opts) {
    this.scene = scene;
    this.res = opts.clipRes;      // cells per quadrant of a block
    this.cell0 = opts.cell0;      // finest cell size (m)
    this.levels = opts.levels;
    this.mesh = null;
    this.stats = { vertices: 0, triangles: 0, levels: this.levels };
  }

  build(name = "oceanSurface") {
    const BJ = B();
    const res = this.res;
    const positions = [];
    const uvs = [];
    const indices = [];

    for (let L = 0; L < this.levels; L++) {
      const cell = this.cell0 * Math.pow(2, L);
      const half = 2 * res * cell;
      // ring index of the innermost included cell (0 for the solid centre)
      const inner = L === 0 ? 0 : res - 1;

      const map = new Map();
      const vid = (i, j) => {
        const key = i * 100003 + j;
        let v = map.get(key);
        if (v === undefined) {
          v = positions.length / 3;
          positions.push(i * cell, 0, j * cell);
          uvs.push(cell, half);
          map.set(key, v);
        }
        return v;
      };

      for (let i = -2 * res; i < 2 * res; i++) {
        const ci = i < 0 ? -i - 1 : i;
        for (let j = -2 * res; j < 2 * res; j++) {
          const cj = j < 0 ? -j - 1 : j;
          if (Math.max(ci, cj) < inner) continue;
          const a = vid(i, j), b = vid(i + 1, j), c = vid(i + 1, j + 1), d = vid(i, j + 1);
          indices.push(a, b, c, a, c, d);
        }
      }
    }

    const mesh = new BJ.Mesh(name, this.scene);
    const vd = new BJ.VertexData();
    vd.positions = new Float32Array(positions);
    vd.uvs = new Float32Array(uvs);
    vd.indices = new Uint32Array(indices);
    vd.applyToMesh(mesh, false);

    // The vertex shader moves every vertex, so ordinary frustum culling would
    // be lying to us; the clipmap always follows the camera anyway.
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.doNotSyncBoundingInfo = true;
    mesh.receiveShadows = false;
    mesh.freezeWorldMatrix();

    this.mesh = mesh;
    this.stats.vertices = positions.length / 3;
    this.stats.triangles = indices.length / 3;
    this.stats.extent = 2 * res * this.cell0 * Math.pow(2, this.levels - 1);
    return mesh;
  }

  dispose() {
    // OceanMaterial owns the shader; this object owns geometry only.
    if (this.mesh) {
      this.mesh.material = null;
      this.mesh.dispose(false, false);
      this.mesh = null;
    }
  }
}
