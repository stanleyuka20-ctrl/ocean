// ---------------------------------------------------------------------------
//  SplashSheets.js -- pool of GPU-deformed water sheets.
//
//  One mesh, one draw call, N slots.  Firing a splash writes 12 floats into a
//  small texture; everything after that is the vertex shader's job.
// ---------------------------------------------------------------------------

import { SHEET_VERT, SHEET_FRAG } from "../shaders/splashSheet.js";

const B = () => window.BABYLON;
let SERIAL = 0;

export class SplashSheets {
  constructor(engine, scene, opts = {}) {
    this.engine = engine;
    this.scene = scene;
    this.slots = opts.slots || 24;
    this.rings = opts.rings || 4;        // vertical subdivisions
    this.segs = opts.segs || 28;         // angular subdivisions
    this.enabled = true;
    this._next = 0;
    this._dirty = false;
    this._built = false;
  }

  build() {
    const BJ = B();
    const id = `splashSheet${SERIAL++}`;
    const S = this.slots, R = this.rings, A = this.segs;

    const nVert = S * (A + 1) * (R + 1);
    const pos = new Float32Array(nVert * 3);
    const ind = [];
    let p = 0;
    for (let s = 0; s < S; s++) {
      const base = s * (A + 1) * (R + 1);
      for (let j = 0; j <= R; j++) {
        for (let i = 0; i <= A; i++) {
          pos[p++] = i / A;          // angle
          pos[p++] = j / R;          // height
          pos[p++] = s;              // slot
        }
      }
      for (let j = 0; j < R; j++) {
        for (let i = 0; i < A; i++) {
          const a = base + j * (A + 1) + i;
          const b = a + 1, c = a + (A + 1), d = c + 1;
          ind.push(a, b, d, a, d, c);
        }
      }
    }

    const mesh = new BJ.Mesh(id, this.scene);
    const vd = new BJ.VertexData();
    vd.positions = pos;
    vd.indices = new Uint32Array(ind);
    vd.applyToMesh(mesh, false);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.doNotSyncBoundingInfo = true;
    mesh.renderingGroupId = 2;

    this._slotData = new Float32Array(S * 3 * 4);
    this.slotTex = new BJ.RawTexture(this._slotData, S, 3,
      BJ.Constants.TEXTUREFORMAT_RGBA, this.scene, false, false,
      BJ.Constants.TEXTURE_NEAREST_SAMPLINGMODE, BJ.Constants.TEXTURETYPE_FLOAT);
    this.slotTex.wrapU = this.slotTex.wrapV = BJ.Constants.TEXTURE_CLAMP_ADDRESSMODE;

    BJ.Effect.ShadersStore[`${id}VertexShader`] = SHEET_VERT;
    BJ.Effect.ShadersStore[`${id}FragmentShader`] = SHEET_FRAG;
    const mat = new BJ.ShaderMaterial(id + "mat", this.scene,
      { vertex: id, fragment: id },
      {
        attributes: ["position"],
        uniforms: ["viewProjection", "logarithmicDepthConstant", "uSlotCount",
          "uTime", "uSeaLevel", "uCamPos", "uWaterTint",
          "uSunDir", "uSunColor", "uMoonDir", "uMoonColor", "uSunI", "uMoonI",
          "uTurbidity", "uCloudCover", "uCloudSharp", "uCloudBright", "uStorm",
          "uFlash", "uCloudDrift", "uWeather", "uLightningDir"],
        samplers: ["uSlots"],
        defines: ["#define LOGARITHMICDEPTH"],
        needAlphaBlending: true,
      });
    mat.backFaceCulling = false;
    mat.alphaMode = BJ.Constants.ALPHA_COMBINE;
    mat.disableDepthWrite = true;
    mesh.material = mat;

    this.mesh = mesh;
    this.material = mat;
    this._built = true;
    return this;
  }

  /**
   * @param o position, direction (Vector3|array, magnitude = lateral speed),
   *          energy (m/s of upward throw), radius, life, spin
   */
  fire(o) {
    if (!this._built || !this.enabled) return;
    const s = this._next % this.slots;
    this._next++;
    const d = this._slotData;
    const row = this.slots * 4;
    const p = o.position, v = o.direction || [0, 0, 0];
    const off = s * 4;
    d[off] = p.x !== undefined ? p.x : p[0];
    d[off + 1] = p.y !== undefined ? p.y : p[1];
    d[off + 2] = p.z !== undefined ? p.z : p[2];
    d[off + 3] = o.time;
    d[row + off] = v.x !== undefined ? v.x : v[0];
    d[row + off + 1] = v.y !== undefined ? v.y : v[1];
    d[row + off + 2] = v.z !== undefined ? v.z : v[2];
    d[row + off + 3] = o.energy || 1.4;
    d[2 * row + off] = o.radius || 0.10;
    d[2 * row + off + 1] = o.life || 0.5;
    d[2 * row + off + 2] = Math.random();
    d[2 * row + off + 3] = (Math.random() - 0.5) * 2.2;
    this._dirty = true;
  }

  update(ctx) {
    if (!this._built) return;
    if (this._dirty) { this.slotTex.update(this._slotData); this._dirty = false; }
    const m = this.material;
    const cam = ctx.camera;
    m.setFloat("logarithmicDepthConstant", 2.0 / (Math.log(cam.maxZ + 1.0) / Math.LN2));
    m.setFloat("uSlotCount", this.slots);
    m.setFloat("uTime", ctx.time);
    m.setFloat("uSeaLevel", ctx.seaLevel);
    m.setVector3("uCamPos", cam.globalPosition);
    m.setVector3("uWaterTint", ctx.waterTint);
    m.setTexture("uSlots", this.slotTex);
    ctx.sky.bindTo(m);
  }

  setEnabled(v) { this.enabled = v; if (this.mesh) this.mesh.setEnabled(v); }

  dispose() {
    if (!this._built) return;
    this.slotTex.dispose();
    this.mesh.dispose(false, true);
    this._built = false;
  }
}
