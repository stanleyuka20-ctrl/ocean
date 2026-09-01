// ---------------------------------------------------------------------------
//  SeafloorSystem.js -- a camera-following sandy bed.
//
//  The spectral sea has no bathymetry (that is what keeps the waves a deep-
//  water FFT).  Underwater that reads as a void: god rays in empty water,
//  nothing for caustics to land on.  This mesh is the missing bottom --
//  procedural dunes, the same lit-surface shader the old island used, and
//  focusing from the REAL wave slopes so the caustic pattern agrees with
//  the surface overhead.
// ---------------------------------------------------------------------------

import { SEAFLOOR_VERT, SURFACE_FRAG } from "../shaders/scene.js";

const B = () => window.BABYLON;
let SERIAL = 0;

export class SeafloorSystem {
  constructor(scene, ocean) {
    this.scene = scene;
    this.ocean = ocean;
    this.enabled = true;
    this.depth = 7.8;       // metres below sea level (mean)
    this.dune = 1.45;       // dune amplitude (m)
    this.extent = 640;
    this.mesh = null;
    this.material = null;
  }

  build() {
    const BJ = B();
    const id = `seafloor${SERIAL++}`;

    BJ.Effect.ShadersStore[`${id}VertexShader`] = SEAFLOOR_VERT;
    BJ.Effect.ShadersStore[`${id}FragmentShader`] = SURFACE_FRAG;

    const mat = new BJ.ShaderMaterial(id, this.scene,
      { vertex: id, fragment: id },
      {
        attributes: ["position", "normal", "uv"],
        uniforms: [
          "world", "viewProjection", "logarithmicDepthConstant",
          "uCamPos", "uSeaLevel", "uClipMode", "uClipTop", "uKind",
          "uRough", "uMetal", "uBaseColor",
          "uAbsorb", "uScatterCol", "uScatterAmt", "uTurbid",
          "uCaustics", "uWetness", "uUnderwaterView",
          "uWetTop", "uWetAmt", "uWetSoak", "uFootRect",
          "uCascadeL", "uWaveScale", "uFloorDepth", "uDune", "uCamDepth",
          "uMaxCausticDepth", "uTime",
          "uSunDir", "uSunColor", "uMoonDir", "uMoonColor",
          "uSunI", "uMoonI", "uTurbidity", "uCloudCover", "uCloudSharp",
          "uCloudBright", "uStorm", "uFlash", "uCloudDrift",
        ],
        samplers: ["uFootprint", "uDeriv1", "uDeriv2"],
        defines: ["#define LOGARITHMICDEPTH"],
      });
    mat.backFaceCulling = false;

    const mesh = BJ.MeshBuilder.CreateGround(id, {
      width: this.extent, height: this.extent, subdivisions: 64,
    }, this.scene);
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    mesh.renderingGroupId = 1;
    mesh.applyFog = false;

    this.mesh = mesh;
    this.material = mat;
    this._base = new BJ.Vector3(0.28, 0.24, 0.18);
    this._absorb = new BJ.Vector3();
    this._scatter = new BJ.Vector3();
    this._cascadeL = new BJ.Vector3();
    this._footRect = new BJ.Vector4(0, 0, 1, 0);
    return this;
  }

  update() {
    if (!this.mesh || !this.material) return;
    const o = this.ocean;
    const cam = o.camera.globalPosition;
    const on = this.enabled && this.depth > 0.4;
    // Hide the tile from the air once you are high enough that a 500 m
    // square of sand would read as a moving patch.  Refraction still needs
    // it at boat height, so the cut is just above a standing camera.
    const near = cam.y < o.seaLevel + 14;
    this.mesh.setEnabled(on && near);
    if (!on) return;
    const cell = 2.0;
    this.mesh.position.x = Math.floor(cam.x / cell) * cell;
    this.mesh.position.z = Math.floor(cam.z / cell) * cell;
    this.mesh.position.y = 0;

    const m = this.material;
    const w = o.water;
    m.setFloat("logarithmicDepthConstant",
      2.0 / (Math.log(o.camera.maxZ + 1.0) / Math.LN2));
    m.setVector3("uCamPos", cam);
    m.setFloat("uSeaLevel", o.seaLevel);
    m.setFloat("uFloorDepth", this.depth);
    m.setFloat("uDune", this.dune);
    m.setFloat("uCamDepth", Math.max(0, o.seaLevel - cam.y));
    m.setFloat("uMaxCausticDepth", 70);
    m.setFloat("uKind", 0);
    m.setFloat("uRough", 0.82);
    m.setFloat("uMetal", 0);
    m.setVector3("uBaseColor", this._base);
    m.setVector3("uAbsorb", this._absorb.set(w.absorb[0], w.absorb[1], w.absorb[2]));
    m.setVector3("uScatterCol", this._scatter.set(w.scatterCol[0], w.scatterCol[1], w.scatterCol[2]));
    m.setFloat("uScatterAmt", w.scatterAmt);
    m.setFloat("uTurbid", w.turbid);
    m.setFloat("uWetness", 0);
    m.setFloat("uUnderwaterView", o.underwater && o.underwater.submerged ? 1 : 0);
    m.setFloat("uWetTop", -1000);
    m.setFloat("uWetAmt", 0);
    m.setFloat("uWetSoak", 0);
    m.setVector4("uFootRect", this._footRect);
    const L = o.sim.patchSizes;
    m.setVector3("uCascadeL", this._cascadeL.set(L[0], L[1], L[2]));
    m.setFloat("uWaveScale", o.sim.params.waveScale);
    m.setFloat("uTime", o.sim.time);
    m.setFloat("uClipMode", 0);
    m.setFloat("uClipTop", 0.02);
    o.sky.bindTo(m);
    const dummy = o.sim.displacement[0];
    m.setTexture("uFootprint", dummy);
    // uDeriv / uCaustics come from CausticsSystem.update on registered mats
  }

  setEnabled(v) {
    this.enabled = !!v;
    if (this.mesh) this.mesh.setEnabled(this.enabled);
    return this.enabled;
  }

  dispose() {
    if (this.mesh) {
      this.mesh.material = null;
      this.mesh.dispose(false, false);
      this.mesh = null;
    }
    if (this.material) this.material.dispose(true, false);
    this.material = null;
  }
}
