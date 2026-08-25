// ---------------------------------------------------------------------------
//  TerrainWorld.js -- camera-relative clipmap of the bathymetry field.
//
//  Three rings, world-anchored height, snapped in XZ.  The spectral sea is
//  unchanged: this is the visual / collision bed only.
// ---------------------------------------------------------------------------

import { SEAFLOOR_VERT, SURFACE_FRAG } from "../shaders/scene.js";
import { makeLitMaterial, bindLitSurface } from "./surfaceBind.js";
import { bathyDepth, bathyY, bathyNormal, cavernCeiling } from "./bathymetry.js";

const B = () => window.BABYLON;
let SERIAL = 0;

export class TerrainWorld {
  constructor(scene, ocean) {
    this.scene = scene;
    this.ocean = ocean;
    this.enabled = true;
    this.dune = 1.45;
    this.lodDist = 1;
    this.meshes = [];
    this.material = null;
    this.depth = 12;
  }

  build() {
    const BJ = B();
    const id = `uwbed${SERIAL++}`;
    const hi = this.ocean.tierName === "cinematic" || this.ocean.tierName === "ultra";
    const rings = hi
      ? [{ extent: 96, subdiv: 80, snap: 1 },
         { extent: 400, subdiv: 72, snap: 4 },
         { extent: 1600, subdiv: 56, snap: 16 }]
      : [{ extent: 80, subdiv: 56, snap: 1 },
         { extent: 340, subdiv: 56, snap: 4 },
         { extent: 1200, subdiv: 48, snap: 16 }];

    this.material = makeLitMaterial(this.scene, id, SEAFLOOR_VERT, SURFACE_FRAG,
      { cull: false });

    this.meshes = rings.map((r, i) => {
      const mesh = BJ.MeshBuilder.CreateGround(id + i, {
        width: r.extent, height: r.extent, subdivisions: r.subdiv,
      }, this.scene);
      mesh.material = this.material;
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.doNotSyncBoundingInfo = true;
      mesh.renderingGroupId = 1;
      mesh.applyFog = false;
      mesh.metadata = { snap: r.snap, inner: i === 0 ? 0 : rings[i - 1].extent * 0.42 };
      mesh.onBeforeRenderObservable.add(() => {
        if (this.material) this.material.setFloat("uLodInner", mesh.metadata.inner);
      });
      return mesh;
    });
    this.mesh = this.meshes[0];
    return this;
  }

  sample(x, z) { return bathyY(x, z, this.ocean.seaLevel); }
  sampleDepth(x, z) { return bathyDepth(x, z); }
  sampleNormal(x, z) { return bathyNormal(x, z); }
  ceiling(x, z) { return cavernCeiling(x, z); }

  update() {
    if (!this.material) return;
    const o = this.ocean;
    const cam = o.camera.globalPosition;
    const on = this.enabled;
      const near = cam.y < o.seaLevel + 16 || cam.y < 4;
      const above = cam.y - this.sample(cam.x, cam.z);
      const hugging = above < 55;
      const deep = cam.y < o.seaLevel - 12;
      this.meshes.forEach((mesh, i) => {
        let show = on && near;
        if (i === 2 && (hugging || deep)) show = false;
        if (i === 1 && (above < 18 || (deep && above < 90))) show = false;
        mesh.setEnabled(show);
        if (!show) return;
        const cell = mesh.metadata.snap;
        mesh.position.x = Math.floor(cam.x / cell) * cell;
        mesh.position.z = Math.floor(cam.z / cell) * cell;
        mesh.position.y = 0;
      });
    this.depth = bathyDepth(cam.x, cam.z);
    if (on) bindLitSurface(this.material, o, { kind: 0, rough: 0.84, color: [0.30, 0.25, 0.18] });
  }

  setEnabled(v) {
    this.enabled = !!v;
    for (const m of this.meshes) m.setEnabled(this.enabled);
    return this.enabled;
  }

  dispose() {
    for (const m of this.meshes) m.dispose(false, false);
    this.meshes = [];
    if (this.material) { this.material.dispose(); this.material = null; }
  }
}
