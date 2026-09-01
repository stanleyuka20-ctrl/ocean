// ---------------------------------------------------------------------------
//  RefractionSystem.js -- what is visible *through* the water.
//
//  Only submerged geometry is rendered, against alpha 0.  The water shader
//  therefore never risks sampling a sky or beach pixel through a wave (the
//  classic screen-space refraction artefact): where coverage is zero it falls
//  back to the analytic volume colour instead.
// ---------------------------------------------------------------------------

const B = () => window.BABYLON;

export class RefractionSystem {
  constructor(scene, engine, tier) {
    this.scene = scene;
    this.engine = engine;
    this.tier = tier;
    this.texture = null;
    this.renderList = [];
    this.quality = tier.refract > 0.65 ? "ultra" : tier.refract > 0.45 ? "high"
      : tier.refract > 0 ? "medium" : "off";
    this.enabled = tier.refract > 0;
  }

  _size() {
    const f = { off: 0, medium: 0.4, high: 0.6, ultra: 0.8 }[this.quality];
    if (!f) return 0;
    return Math.max(128, Math.min(this.tier.refractMax,
      Math.round((this.engine.getRenderWidth() * f) / 2) * 2));
  }

  build(meshes) {
    this.renderList = meshes.slice();
    this._create();
  }

  _dimensions() {
    const width = this._size();
    if (!width) return { width: 0, height: 0 };
    return {
      width,
      height: Math.max(64, Math.round(width *
        (this.engine.getRenderHeight() / Math.max(this.engine.getRenderWidth(), 1)))),
    };
  }

  _create() {
    const BJ = B();
    this.destroyTexture();
    const size = this._dimensions();
    if (!size.width || !this.renderList.length) { this.enabled = false; return; }
    this.enabled = true;

    const rt = new BJ.RenderTargetTexture("oceanRefract",
      // The water samples this with SCREEN uv, so it must have the screen's
      // aspect.  A fixed ratio renders the scene at a different shape and every
      // sample lands on the wrong pixel -- worse the wider the window is, which
      // is why an ultrawide display shows it and a 16:9 test does not.
      size,
      this.scene, {
        generateDepthBuffer: true,
        generateMipMaps: false,
        type: BJ.Constants.TEXTURETYPE_HALF_FLOAT,
        samplingMode: BJ.Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
      });
    rt.renderList = this.renderList.slice();
    rt.clearColor = new BJ.Color4(0, 0, 0, 0);
    rt.refreshRate = this.subsystemEnabled === false ? 0 : 1;
    rt.renderParticles = false;
    rt.renderSprites = false;
    rt.ignoreCameraViewport = true;
    rt.wrapU = rt.wrapV = BJ.Constants.TEXTURE_CLAMP_ADDRESSMODE;

    rt.onBeforeRenderObservable.add(() => { this._setClip(2); });
    rt.onAfterRenderObservable.add(() => { this._setClip(0); });

    this.scene.customRenderTargets.push(rt);
    this.texture = rt;
  }

  /** metres above the flat sea level the refraction clip keeps (wave crest) */
  clipTop = 0.02;

  _setClip(mode) {
    const top = mode > 1.5 ? this.clipTop : 0.02;
    for (const m of this.renderList) {
      const mat = m.material;
      if (mat && mat.setFloat) {
        mat.setFloat("uClipMode", mode);
        mat.setFloat("uClipTop", top);
      }
    }
  }

  setQuality(q) { if (q !== this.quality) { this.quality = q; this._create(); } }

  resizeIfNeeded() {
    const want = this._dimensions();
    if (!this.texture) {
      if (want.width && this.renderList.length) this._create();
      return;
    }
    const have = this.texture.getSize();
    if (have.width !== want.width || have.height !== want.height) this._create();
  }

  destroyTexture() {
    if (this.texture) {
      const i = this.scene.customRenderTargets.indexOf(this.texture);
      if (i >= 0) this.scene.customRenderTargets.splice(i, 1);
      this.texture.dispose();
      this.texture = null;
    }
    this.enabled = false;
  }
  dispose() { this.destroyTexture(); }
  /**
   * Real disable hook.  This system has no per-frame update -- it is a render
   * target -- so disabling means stopping its refresh, and the counter is the
   * target's own refresh id.  A probe must be able to prove it stopped.
   */
  setEnabled(v) {
    this.subsystemEnabled = !!v;
    if (this.texture) this.texture.refreshRate = this.subsystemEnabled ? 1 : 0;
    return this.subsystemEnabled;
  }
  subsystemStats() {
    return { enabled: this.subsystemEnabled !== false,
             updates: this.texture ? (this.texture.getRefreshRate ?
                                 this.texture.getRefreshRate() : this.texture.refreshRate) : -1 };
  }

}
