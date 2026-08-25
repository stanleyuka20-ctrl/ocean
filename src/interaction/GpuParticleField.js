// ---------------------------------------------------------------------------
//  GpuParticleField.js -- a particle system whose state never leaves the GPU.
//
//  Two RGBA32F textures hold (position, life) and (velocity, size).  A fragment
//  pass integrates them each frame; a static mesh of N quads, each vertex
//  carrying its own particle index, reads them back in the vertex shader.
//
//  The CPU only ever appends spawn GROUPS to a 64x4 request texture.  A rolling
//  window of particle indices claims them, so a player running through
//  knee-deep water for a minute allocates nothing and produces no GC spikes --
//  which is the whole reason not to build this out of Babylon particle systems
//  with per-emitter JS objects.
// ---------------------------------------------------------------------------

import { PARTICLE_UPDATE_FRAG, DROPLET_VERT, DROPLET_FRAG,
         BUBBLE_MESH_VERT, BUBBLE_MESH_FRAG, BUBBLE_MESH_VEL_VERT,
         MOTE_FRAG, PARTICLE_VEL_VERT, PARTICLE_VEL_FRAG } from "../shaders/particles.js";

const B = () => window.BABYLON;
const MAX_GROUPS = 64;
let SERIAL = 0;

export class GpuParticleField {
  /**
   * @param {object} opts count, kind ("droplet"|"bubble"), sizeScale, stretch
   */
  constructor(engine, scene, opts) {
    this.engine = engine;
    this.scene = scene;
    this.kind = opts.kind || "droplet";
    this.count = opts.count || 4096;
    this.width = 128;
    this.height = Math.max(1, Math.ceil(this.count / this.width));
    this.count = this.width * this.height;
    this.sizeScale = opts.sizeScale === undefined ? 1 : opts.sizeScale;
    this.stretch = opts.stretch === undefined ? 0.05 : opts.stretch;
    this.mistMix = opts.mist || 0;
    // metres a particle may travel in one frame before the move is treated as
    // pool reuse or wrapping rather than motion
    this.jumpLimit = opts.jumpLimit === undefined ? 3.0 : opts.jumpLimit;
    // per-kind reactivity floor: spray re-forms constantly, motes drift
    this.reactiveBase = opts.reactiveBase === undefined ? 0.35 : opts.reactiveBase;
    // fragments fainter than this leave the pixel to whatever is behind
    this.coverCut = opts.coverCut === undefined ? 0.22 : opts.coverCut;
    // screen-space size floor in pixels (0 = off); see uMinPixel in particles.js
    this.minPixel = opts.minPixel === undefined ? 0 : opts.minPixel;
    // how opaque this kind draws; scales its claim on a pixel's motion vector
    this.opacity = opts.opacity === undefined ? 1 : opts.opacity;
    this.enabled = true;
    this._cursor = 0;
    this._groups = [];
    this._spawnData = new Float32Array(MAX_GROUPS * 4 * 4);
    this._built = false;
    this.spawnedThisFrame = 0;
  }

  build(renderer) {
    const BJ = B();
    this.renderer = renderer;
    const id = `gpuPart${SERIAL++}`;
    this.id = id;

    const mk = (n) => {
      const t = new BJ.RenderTargetTexture(n, { width: this.width, height: this.height },
        this.scene, {
          generateDepthBuffer: false, generateMipMaps: false,
          type: BJ.Constants.TEXTURETYPE_FLOAT,
          format: BJ.Constants.TEXTUREFORMAT_RGBA,
          samplingMode: BJ.Constants.TEXTURE_NEAREST_SAMPLINGMODE,
        });
      t.wrapU = t.wrapV = BJ.Constants.TEXTURE_CLAMP_ADDRESSMODE;
      return t;
    };
    this.pos = [mk(id + "posA"), mk(id + "posB")];
    this.vel = [mk(id + "velA"), mk(id + "velB")];
    this.idx = 0;

    this.spawnTex = new BJ.RawTexture(this._spawnData, MAX_GROUPS, 4,
      BJ.Constants.TEXTUREFORMAT_RGBA, this.scene, false, false,
      BJ.Constants.TEXTURE_NEAREST_SAMPLINGMODE, BJ.Constants.TEXTURETYPE_FLOAT);
    this.spawnTex.wrapU = this.spawnTex.wrapV = BJ.Constants.TEXTURE_CLAMP_ADDRESSMODE;

    this.ew = new BJ.EffectWrapper({
      engine: this.engine, name: id + "update",
      fragmentShader: PARTICLE_UPDATE_FRAG,
      uniformNames: ["uDt", "uTime", "uCount", "uWidth", "uHeight", "uSpawnStart",
        "uSpawnCount", "uPerGroup", "uKind", "uTarget", "uSeaLevel", "uCascadeL0",
        "uCascadeL1", "uWaveScale", "uTurbulence", "uWind", "uCurrent"],
      samplerNames: ["uPos", "uVel", "uSpawn", "uDisp0", "uDisp1"],
    });
    this._bind = null;
    this.ew.onApplyObservable.add(() => { if (this._bind) this._bind(this.ew.effect); });

    this._buildMesh(id);
    this._built = true;
    return this;
  }

  _icoUnit(subdiv) {
    const t = (1 + Math.sqrt(5)) / 2;
    const nrm = (p) => {
      const l = Math.hypot(p[0], p[1], p[2]) || 1;
      return [p[0] / l, p[1] / l, p[2] / l];
    };
    let verts = [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
      [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ].map(nrm);
    let faces = [
      [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
      [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
      [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    for (let s = 0; s < subdiv; s++) {
      const midAt = new Map();
      const mid = (a, b) => {
        const key = a < b ? a + ":" + b : b + ":" + a;
        if (midAt.has(key)) return midAt.get(key);
        const i = verts.length;
        verts.push(nrm([
          (verts[a][0] + verts[b][0]) * 0.5,
          (verts[a][1] + verts[b][1]) * 0.5,
          (verts[a][2] + verts[b][2]) * 0.5,
        ]));
        midAt.set(key, i);
        return i;
      };
      const next = [];
      for (const f of faces) {
        const d = mid(f[0], f[1]), e = mid(f[1], f[2]), g = mid(f[2], f[0]);
        next.push([f[0], d, g], [f[1], e, d], [f[2], g, e], [d, e, g]);
      }
      faces = next;
    }
    return { verts, faces };
  }

  _buildMesh(id) {
    const BJ = B();
    const n = this.count;
    const isBubble = this.kind === "bubble";
    const isMote = this.kind === "neutral";
    const underLit = isBubble || isMote;
    this._sphereMesh = isBubble;

    const mesh = new BJ.Mesh(id + "mesh", this.scene);
    const vd = new BJ.VertexData();
    if (isBubble) {
      const ico = this._icoUnit(2);
      const nv = ico.verts.length, nf = ico.faces.length;
      const pos = new Float32Array(n * nv * 3);
      const uvs = new Float32Array(n * nv * 2);
      const ind = new Uint32Array(n * nf * 3);
      for (let i = 0; i < n; i++) {
        const bo = i * nv * 3, uo = i * nv * 2, io = i * nf * 3, vb = i * nv;
        for (let v = 0; v < nv; v++) {
          const p = ico.verts[v];
          pos[bo + v * 3] = p[0];
          pos[bo + v * 3 + 1] = p[1];
          pos[bo + v * 3 + 2] = p[2];
          uvs[uo + v * 2] = i;
          uvs[uo + v * 2 + 1] = 0;
        }
        for (let f = 0; f < nf; f++) {
          const face = ico.faces[f];
          ind[io + f * 3] = vb + face[0];
          ind[io + f * 3 + 1] = vb + face[1];
          ind[io + f * 3 + 2] = vb + face[2];
        }
      }
      vd.positions = pos;
      vd.uvs = uvs;
      vd.indices = ind;
    } else {
      const pos = new Float32Array(n * 4 * 3);
      const ind = new Uint32Array(n * 6);
      const cx = [-1, 1, 1, -1], cy = [-1, -1, 1, 1];
      for (let i = 0; i < n; i++) {
        for (let v = 0; v < 4; v++) {
          const o = (i * 4 + v) * 3;
          pos[o] = cx[v]; pos[o + 1] = cy[v]; pos[o + 2] = i;
        }
        const b = i * 4, o = i * 6;
        ind[o] = b; ind[o + 1] = b + 1; ind[o + 2] = b + 2;
        ind[o + 3] = b; ind[o + 4] = b + 2; ind[o + 5] = b + 3;
      }
      vd.positions = pos;
      vd.indices = ind;
    }
    vd.applyToMesh(mesh, false);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.doNotSyncBoundingInfo = true;
    mesh.renderingGroupId = 2;
    mesh.freezeWorldMatrix();

    BJ.Effect.ShadersStore[`${id}VertexShader`] = isBubble ? BUBBLE_MESH_VERT : DROPLET_VERT;
    BJ.Effect.ShadersStore[`${id}FragmentShader`] =
      isMote ? MOTE_FRAG : (isBubble ? BUBBLE_MESH_FRAG : DROPLET_FRAG);

    const uniforms = ["viewProjection", "logarithmicDepthConstant", "uCamRight",
      "uCamUp", "uCamPos", "uWidth", "uHeight", "uStretch", "uSizeScale",
      "uSunDir", "uSunColor", "uSunI", "uWaterTint", "uMinPixel", "uPxScale"];
    if (underLit) uniforms.push("uAmbient");
    if (isBubble) uniforms.push("uTime");
    if (!underLit) uniforms.push("uMoonDir", "uMoonColor", "uMoonI", "uTurbidity",
      "uCloudCover", "uCloudSharp", "uCloudBright", "uStorm", "uFlash",
      "uCloudDrift", "uMist");

    const mat = new BJ.ShaderMaterial(id + "mat", this.scene,
      { vertex: id, fragment: id },
      {
        attributes: isBubble ? ["position", "uv"] : ["position"],
        uniforms,
        samplers: ["uPos", "uVel"],
        defines: ["#define LOGARITHMICDEPTH"],
        needAlphaBlending: true,
      });
    mat.backFaceCulling = !isBubble;
    mat.alphaMode = BJ.Constants.ALPHA_COMBINE;
    mat.disableDepthWrite = true;
    mesh.material = mat;
    this.mesh = mesh;
    this.material = mat;

    BJ.Effect.ShadersStore[`${id}VelVertexShader`] =
      isBubble ? BUBBLE_MESH_VEL_VERT : PARTICLE_VEL_VERT;
    BJ.Effect.ShadersStore[`${id}VelFragmentShader`] = PARTICLE_VEL_FRAG;
    this.velMaterial = new BJ.ShaderMaterial(id + "velmat", this.scene,
      { vertex: id + "Vel", fragment: id + "Vel" },
      {
        attributes: isBubble ? ["position", "uv"] : ["position"],
        uniforms: ["uCurViewProjection", "uPrevViewProjection", "logarithmicDepthConstant",
          "uCamRight", "uCamUp", "uCamPos", "uWidth", "uHeight", "uSizeScale",
          "uJumpLimit", "uReactiveBase", "uCoverCut", "uMinPixel", "uPxScale", "uPartDebug", "uOpacity",
          "uStretch"].concat(isBubble ? ["uTime"] : []),
        samplers: ["uPos", "uPosPrev", "uVel"],
        defines: ["#define LOGARITHMICDEPTH"],
      });
    this.velMaterial.backFaceCulling = !isBubble;
    this.velMaterial.disableDepthWrite = true;
  }

  /**
   * Bind the velocity variant.  Reads the SAME slot from both state textures,
   * so the vector is the particle's own motion and owes nothing to the water
   * underneath it.
   */
  /** world metres per screen pixel at unit distance */
  _pxScale(cam) {
    return 2 * Math.tan((cam.fov || 0.9) * 0.5) / Math.max(1, this.engine.getRenderHeight());
  }

  bindVelocity(curVP, prevVP, cam) {
    const m = this.velMaterial;
    if (!m || !this.pos) return;
    const BJ = B();
    m.setMatrix("uCurViewProjection", curVP);
    m.setMatrix("uPrevViewProjection", prevVP);
    m.setVector3("uCamRight", cam.getDirection(BJ.Axis.X));
    m.setVector3("uCamUp", cam.getDirection(BJ.Axis.Y));
    m.setVector3("uCamPos", cam.globalPosition);
    m.setFloat("uWidth", this.width);
    m.setFloat("uHeight", this.height);
    m.setFloat("uSizeScale", this.sizeScale);
    m.setFloat("uJumpLimit", this.jumpLimit);
    m.setFloat("uReactiveBase", this.reactiveBase);
    m.setFloat("uCoverCut", this.coverCut);
    m.setFloat("uPartDebug", this.partDebug || 0);
    m.setFloat("uOpacity", this.opacity);
    m.setFloat("uStretch", this.stretch);
    m.setFloat("uMinPixel", this.minPixel);
    m.setFloat("uPxScale", this._pxScale(cam));
    m.setFloat("uTime", this._velTime || 0);
    m.setFloat("logarithmicDepthConstant",
      2.0 / (Math.log(cam.maxZ + 1.0) / Math.LN2));
    m.setTexture("uPos", this.pos[this.idx]);
    m.setTexture("uPosPrev", this.pos[1 - this.idx]);
    m.setTexture("uVel", this.vel[this.idx]);
  }

  /**
   * Request a burst.  Cheap: this only appends a descriptor, and at most 64
   * survive per frame.
   *   position  Vector3|array  centre of the contact patch
   *   radius    m              spawn disc
   *   velocity  Vector3|array  mean ejection velocity (direction AND speed)
   *   spread    0..2           cone half-width
   *   count     particles
   *   size      [min, max] m
   *   life      [min, max] s
   *   jitter    0..1           speed randomisation
   */
  emit(o) {
    if (!this.enabled || !this._built) return;
    if (this._groups.length >= MAX_GROUPS) return;
    const p = o.position, v = o.velocity || [0, 1, 0];
    this._groups.push({
      px: p.x !== undefined ? p.x : p[0],
      py: p.y !== undefined ? p.y : p[1],
      pz: p.z !== undefined ? p.z : p[2],
      r: o.radius || 0.05,
      vx: v.x !== undefined ? v.x : v[0],
      vy: v.y !== undefined ? v.y : v[1],
      vz: v.z !== undefined ? v.z : v[2],
      spread: o.spread === undefined ? 0.5 : o.spread,
      s0: o.size ? o.size[0] : 0.004,
      s1: o.size ? o.size[1] : 0.02,
      l0: o.life ? o.life[0] : 0.3,
      l1: o.life ? o.life[1] : 1.0,
      jitter: o.jitter === undefined ? 0.6 : o.jitter,
      n: Math.max(1, Math.round(o.count || 12)),
    });
  }

  update(dt, ctx) {
    if (!this._built) { this._groups.length = 0; return; }
    if (!this.enabled) {
      this._groups.length = 0;
      if (this.mesh) this.mesh.setEnabled(false);
      return;
    }
    if (this.mesh) this.mesh.setEnabled(true);
    if (!this.ew.isReady()) { this._groups.length = 0; return; }
    const g = this._groups;
    let total = 0;
    for (let i = 0; i < g.length; i++) total += g[i].n;
    total = Math.min(total, Math.floor(this.count * 0.30));
    this.spawnedThisFrame = total;

    let perGroup = 0;
    if (g.length && total > 0) {
      perGroup = Math.max(1, Math.floor(total / g.length));
      total = perGroup * g.length;
      const d = this._spawnData;
      d.fill(0);
      const row = MAX_GROUPS * 4;
      for (let i = 0; i < g.length && i < MAX_GROUPS; i++) {
        const q = g[i], o = i * 4;
        d[o] = q.px; d[o + 1] = q.py; d[o + 2] = q.pz; d[o + 3] = q.r;
        d[row + o] = q.vx; d[row + o + 1] = q.vy; d[row + o + 2] = q.vz; d[row + o + 3] = q.spread;
        d[2 * row + o] = q.s0; d[2 * row + o + 1] = q.s1;
        d[2 * row + o + 2] = q.l0; d[2 * row + o + 3] = q.l1;
        d[3 * row + o] = q.jitter;
        d[3 * row + o + 3] = (this._cursor + i * 37.7) % 997;
      }
      this.spawnTex.update(d);
    }
    g.length = 0;

    const start = this._cursor;
    this._cursor = (this._cursor + total) % this.count;

    const src = this.idx, dst = 1 - this.idx;
    const kind = this.kind === "bubble" ? 1 : (this.kind === "neutral" ? 2 : 0);
    for (let target = 0; target < 2; target++) {
      this._bind = (e) => {
        e.setFloat("uDt", Math.min(dt, 0.05));
        e.setFloat("uTime", ctx.time);
        e.setFloat("uCount", this.count);
        e.setFloat("uWidth", this.width);
        e.setFloat("uHeight", this.height);
        e.setFloat("uSpawnStart", start);
        e.setFloat("uSpawnCount", total);
        e.setFloat("uPerGroup", perGroup);
        e.setFloat("uKind", kind);
        e.setFloat("uTarget", target);
        e.setFloat("uSeaLevel", ctx.seaLevel);
        e.setFloat("uCascadeL0", ctx.cascadeL[0]);
        e.setFloat("uCascadeL1", ctx.cascadeL[1]);
        e.setFloat("uWaveScale", ctx.waveScale);
        e.setFloat("uTurbulence", ctx.turbulence);
        e.setFloat3("uWind", ctx.wind[0], ctx.wind[1], ctx.wind[2]);
        e.setFloat3("uCurrent", ctx.current[0], ctx.current[1], ctx.current[2]);
        e.setTexture("uPos", this.pos[src]);
        e.setTexture("uVel", this.vel[src]);
        e.setTexture("uSpawn", this.spawnTex);
        e.setTexture("uDisp0", ctx.disp[0]);
        e.setTexture("uDisp1", ctx.disp[1]);
      };
      this.renderer.render(this.ew, target === 0 ? this.pos[dst] : this.vel[dst]);
    }
    this.idx = dst;

    // --- render uniforms ---------------------------------------------------
    const m = this.material;
    const cam = ctx.camera;
    m.setFloat("logarithmicDepthConstant", 2.0 / (Math.log(cam.maxZ + 1.0) / Math.LN2));
    const BJ = B();
    // Camera basis in WORLD space.  Digging the rows out of the view matrix by
    // index is a coin flip on layout convention, and getting it wrong makes the
    // billboards degenerate -- zero-area quads that render perfectly and show
    // nothing at all.
    m.setVector3("uCamRight", cam.getDirection(BJ.Axis.X));
    m.setVector3("uCamUp", cam.getDirection(BJ.Axis.Y));
    m.setVector3("uCamPos", cam.globalPosition);
    m.setFloat("uWidth", this.width);
    m.setFloat("uHeight", this.height);
    m.setFloat("uStretch", this.stretch);
    m.setFloat("uSizeScale", this.sizeScale);
    m.setFloat("uMinPixel", this.minPixel);
    m.setFloat("uPxScale", this._pxScale(cam));
    m.setTexture("uPos", this.pos[this.idx]);
    m.setTexture("uVel", this.vel[this.idx]);
    m.setVector3("uWaterTint", ctx.waterTint);
    if (this.kind === "neutral") {
      m.setFloat("uAmbient", ctx.underwaterAmbient);
    } else if (this.kind === "bubble") {
      m.setVector3("uSunDir", ctx.sky.sunDir);
      m.setColor3("uSunColor", ctx.sky.sunColor);
      m.setFloat("uSunI", ctx.sky.sunI);
      m.setFloat("uAmbient", ctx.underwaterAmbient);
      m.setFloat("uTime", ctx.time || 0);
      this._velTime = ctx.time || 0;
    } else {
      ctx.sky.bindTo(m);
      m.setVector3("uCamPos", cam.globalPosition);
      m.setFloat("uMist", this.mistMix);
    }
  }

  setEnabled(v) {
    this.enabled = v;
    if (this.mesh) this.mesh.setEnabled(v);
  }

  /** number of live particles, read back from the state texture */
  async liveCount() {
    if (!this.pos) return 0;
    const a = await this.pos[this.idx].readPixels();
    let n = 0;
    for (let i = 0; i < a.length; i += 4) if (a[i + 3] > 0) n++;
    return n;
  }

  dispose() {
    if (!this._built) return;
    this.pos.forEach((t) => t.dispose());
    this.vel.forEach((t) => t.dispose());
    this.spawnTex.dispose();
    this.ew.dispose();
    this.mesh.dispose(false, true);
    this._built = false;
  }
}
