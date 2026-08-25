// ---------------------------------------------------------------------------
//  Presentation.js -- output resolution, device pixel ratio and dynamic
//  resolution scaling.
//
//  Babylon renders at cssSize / hardwareScalingLevel, so everything here comes
//  down to choosing that one number honestly:
//
//      backbuffer = cssSize * devicePixelRatio * renderScale
//      hardwareScalingLevel = 1 / (devicePixelRatio * renderScale)
//
//  A "4K target" therefore means the BACKBUFFER is 3840 wide, not that a
//  1080p image is stretched to a 4K window -- on a 1080p display that is
//  2x supersampling and it is genuinely sharper; on a 4K display it is native.
//  `outputResolution` reports what is actually being rendered, so the claim is
//  checkable rather than asserted.
//
//  Dynamic resolution moves renderScale toward whatever holds the frame time
//  target.  It moves in SMALL STEPS and only after a sustained trend, because
//  the failure mode of an eager controller is a scale that oscillates once per
//  second, and a resolution that visibly pumps is worse than one that is
//  simply lower.
// ---------------------------------------------------------------------------

import { isMobileDevice } from "./quality.js";

export class OceanPresentation {
  constructor(engine, canvas) {
    this.engine = engine;
    this.canvas = canvas;

    this.devicePixelRatio = Math.min(window.devicePixelRatio || 1, isMobileDevice() ? 1.5 : 2);
    this.renderScale = 1.0;
    this.minRenderScale = isMobileDevice() ? 0.5 : 0.62;
    this.maxRenderScale = 2.0;
    // Off by default and switched on explicitly.  A resolution that changes
    // under a measurement makes every image comparison non-reproducible, and
    // this project's verification is image based.  Mobile play turns it on
    // in main.js after boot.
    this.dynamicResolution = false;
    this.targetFrameRate = 60;
    this.resolutionAdaptationSpeed = 1.0;
    /** cap on the rendered pixel count, so 4K stays a target and not a hang */
    this.maxPixels = isMobileDevice() ? 1920 * 1080 : 3840 * 2160;

    this._ema = 16.7;
    this._acc = 0;
    this._settle = 0;
    this._pollMs = isMobileDevice() ? 500 : 350;
    this._over = isMobileDevice() ? 1.18 : 1.12;
    this._under = isMobileDevice() ? 0.75 : 0.82;
    this.applied = { width: 0, height: 0, scale: 1 };
  }

  get targetFrameTime() { return 1000 / Math.max(this.targetFrameRate, 15); }

  /** what is actually being rendered, in real pixels */
  get outputResolution() {
    return { width: this.engine.getRenderWidth(), height: this.engine.getRenderHeight() };
  }

  /**
   * Aim the backbuffer at a width in real pixels (3840 for 4K).  Returns the
   * renderScale that gets there, clamped so a small window does not ask for a
   * 6x supersample.
   */
  targetWidth(px) {
    // Derived from what is CURRENTLY rendered, not from the canvas CSS size.
    // The canvas layout width can follow the backbuffer, so dividing by it
    // makes this non-idempotent: call it twice and the scale walks away from
    // the target instead of staying on it.  Scaling the current result is
    // self-correcting and converges whatever the canvas does.
    const now = this.applied.width || this.engine.getRenderWidth() || 1280;
    const cur = this.applied.scale || this.renderScale || 1;
    const want = cur * (px / now);
    // The ceiling exists to stop the dynamic controller running away, not to
    // refuse a deliberate request.  The pixel budget is what really bounds it.
    this.maxRenderScale = Math.max(this.maxRenderScale, want);
    this.renderScale = Math.max(this.minRenderScale, want);
    this.apply();
    return this.renderScale;
  }

  /**
   * Queue a resize.  It must NOT happen in the middle of a frame: changing the
   * backbuffer size destroys the swapchain texture, and WebGPU then rejects the
   * submit that is already using it ("Destroyed texture used in a submit").
   * applyNow() is called once at the top of the render loop instead.
   */
  apply() { this._pending = true; }

  applyNow() {
    if (!this._pending) return false;
    this._pending = false;
    let s = Math.min(this.maxRenderScale, Math.max(this.minRenderScale, this.renderScale));
    this.engine.setHardwareScalingLevel(1 / Math.max(this.devicePixelRatio * s, 0.05));
    // Enforce the pixel budget against the size the engine ACTUALLY produced.
    // Predicting it from canvas.clientWidth/clientHeight is not safe: those
    // follow layout, and a canvas whose CSS height is not what you assume
    // quietly scales the whole backbuffer down while every setting still
    // reads correct.
    const w = this.engine.getRenderWidth(), h = this.engine.getRenderHeight();
    if (w * h > this.maxPixels) {
      s *= Math.sqrt(this.maxPixels / (w * h));
      this.engine.setHardwareScalingLevel(1 / Math.max(this.devicePixelRatio * s, 0.05));
    }
    this.applied = {
      width: this.engine.getRenderWidth(),
      height: this.engine.getRenderHeight(),
      scale: s,
    };
    return true;
  }

  /**
   * @param dtMs measured frame time
   * Smooth first, then move: a controller that reacts to one slow frame turns
   * a garbage-collection hiccup into a visible resolution change.
   */
  update(dtMs) {
    if (!this.dynamicResolution) return;
    this._ema += (Math.min(dtMs, 200) - this._ema) * 0.08;
    this._acc += dtMs;
    if (this._acc < this._pollMs) return;
    this._acc = 0;

    const target = this.targetFrameTime;
    const over = this._ema / target;
    const step = 0.045 * this.resolutionAdaptationSpeed;
    let s = this.renderScale;

    if (over > this._over) {
      this._settle = Math.max(-3, this._settle - 1);
      if (this._settle <= -2) s -= step * Math.min(2.0, over - 1.0);
    } else if (over < this._under) {
      this._settle = Math.min(3, this._settle + 1);
      // climb back slowly: a scale that ramps up the instant the frame is
      // cheap will drop again on the next wave and pump forever
      if (this._settle >= 3) s += step * 0.5;
    } else {
      this._settle = 0;
    }

    s = Math.min(this.maxRenderScale, Math.max(this.minRenderScale, s));
    if (Math.abs(s - this.renderScale) > 1e-3) {
      this.renderScale = s;
      this.apply();
    }
  }

  stats() {
    const r = this.outputResolution;
    return {
      output: `${r.width} x ${r.height}`,
      renderScale: +this.applied.scale.toFixed(3),
      devicePixelRatio: this.devicePixelRatio,
      dynamicResolution: this.dynamicResolution,
      targetFrameRate: this.targetFrameRate,
      frameMs: +this._ema.toFixed(2),
      megapixels: +((r.width * r.height) / 1e6).toFixed(2),
    };
  }
}
