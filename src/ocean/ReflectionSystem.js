// ---------------------------------------------------------------------------
//  ReflectionSystem.js -- planar reflection of the *geometry* only.
//
//  The sky is never rendered into this buffer: the water shader evaluates the
//  same analytic sky the dome uses, at full angular resolution, so a 512 px
//  reflection map cannot blur the horizon or the sun.  The mirror buffer is
//  cleared to alpha 0 and the shader composites it over the analytic sky by
//  its own coverage -- which also means "no geometry nearby" costs nothing.
// ---------------------------------------------------------------------------

const B = () => window.BABYLON;

export const REFLECT_QUALITY = ["off", "low", "medium", "high", "ultra"];

export class ReflectionSystem {
  constructor(scene, engine, tier) {
    this.scene = scene;
    this.engine = engine;
    this.tier = tier;
    this.texture = null;
    this.renderList = [];
    this.enabled = tier.mirror > 0;
    this.quality = tier.mirror > 0.85 ? "ultra" : tier.mirror > 0.6 ? "high"
      : tier.mirror > 0.4 ? "medium" : tier.mirror > 0 ? "low" : "off";
    this.seaLevel = 0;
    this.maxDistance = 2600;
  }

  // Width only -- the height is derived from the screen aspect in _create(),
  // because the buffer is read with screen uv and has to share its shape.
  // (Passing `ratio` to MirrorTexture makes it ignore the size entirely, which
  // is how this ran at full backbuffer resolution AND the wrong shape.)
  _size() {
    const f = { off: 0, low: 0.3, medium: 0.5, high: 0.7, ultra: 1.0 }[this.quality];
    if (!f) return 0;
    const w = this.engine.getRenderWidth() * f;
    return Math.max(256, Math.min(this.tier.mirrorMax, Math.round(w / 2) * 2));
  }

  build(meshes) {
    this.renderList = meshes.slice();
    this._create();
  }

  _create() {
    const BJ = B();
    this.destroyTexture();
    const size = this._size();
    if (!size) { this.enabled = false; return; }
    this.enabled = true;

    // Sampled with SCREEN uv, so it must carry the screen's aspect -- a square
    // mirror read through screen coordinates misplaces every reflected pixel,
    // and the error grows with how far the window is from square.
    const mh = Math.max(64, Math.round(size *
      (this.engine.getRenderHeight() / Math.max(this.engine.getRenderWidth(), 1))));
    const mt = new BJ.MirrorTexture("oceanMirror", { width: size, height: mh },
      this.scene, true, BJ.Constants.TEXTURETYPE_HALF_FLOAT);
    mt.mirrorPlane = new BJ.Plane(0, -1, 0, this.seaLevel);
    mt.renderList = this.renderList.slice();
    mt.clearColor = new BJ.Color4(0, 0, 0, 0);
    mt.adaptiveBlurKernel = 0;
    mt.refreshRate = 1;
    mt.ignoreCameraViewport = true;
    mt.renderParticles = false;
    mt.renderSprites = false;
    mt.wrapU = mt.wrapV = BJ.Constants.TEXTURE_CLAMP_ADDRESSMODE;

    // Above-water geometry only: a reflected pier piling that pokes below the
    // waterline would otherwise reappear upside down inside the wave.
    mt.onBeforeRenderObservable.add(() => { this._setClip(1); });
    mt.onAfterRenderObservable.add(() => { this._setClip(0); });

    this.scene.customRenderTargets.push(mt);
    this.texture = mt;
  }

  _setClip(mode) {
    for (const m of this.renderList) {
      const mat = m.material;
      if (mat && mat.setFloat) mat.setFloat("uClipMode", mode);
    }
  }

  setQuality(q) {
    if (q === this.quality) return;
    this.quality = q;
    this._create();
  }

  setSeaLevel(y) {
    this.seaLevel = y;
    if (this.texture) this.texture.mirrorPlane = new (B().Plane)(0, -1, 0, y);
  }

  /** Drop distant objects: at 3 km their reflection is a couple of pixels. */
  update(camera) {
    if (this.subsystemEnabled === false) return;
    this.updateCount = (this.updateCount || 0) + 1;
    if (!this.texture) return;
    const list = this.texture.renderList;
    list.length = 0;
    for (const m of this.renderList) {
      if (!m.isEnabled()) continue;
      const p = m.getBoundingInfo ? m.getBoundingInfo().boundingSphere.centerWorld : m.position;
      const r = m.getBoundingInfo ? m.getBoundingInfo().boundingSphere.radiusWorld : 10;
      if (BABYLON.Vector3.Distance(p, camera.globalPosition) - r < this.maxDistance) list.push(m);
    }
  }

  destroyTexture() {
    if (this.texture) {
      const i = this.scene.customRenderTargets.indexOf(this.texture);
      if (i >= 0) this.scene.customRenderTargets.splice(i, 1);
      this.texture.dispose();
      this.texture = null;
    }
  }
  dispose() { this.destroyTexture(); }
  /**
   * Real disable hook.  The update path READS this flag and the counter proves
   * it stopped -- a bisection that merely sets a property nobody reads produces
   * rows identical to the baseline and looks like a diffuse cause, which is
   * exactly what happened here once already.
   */
  setEnabled(v) { this.subsystemEnabled = !!v; return this.subsystemEnabled; }
  subsystemStats() {
    return { enabled: this.subsystemEnabled !== false,
             updates: this.updateCount || 0 };
  }

}
