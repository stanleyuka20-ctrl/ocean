// ---------------------------------------------------------------------------
//  TemporalAA.js -- jitter, velocity target, history, resolve.
//
//  Three pieces have to agree every frame or the whole thing ghosts:
//
//    1. the projection is jittered by a Halton offset, so successive frames
//       sample different sub-pixel positions;
//    2. the ocean is drawn a second time into a velocity target with the SAME
//       jitter and the SAME vertex path, so a motion vector points at the pixel
//       the history actually landed in;
//    3. the resolve reprojects, clips and reject-weights (see shaders/taa.js).
//
//  The jitter must be removed from the previous-frame matrix as well as applied
//  to this one, or every pixel carries a permanent sub-pixel motion vector and
//  the image crawls in place -- which looks exactly like a broken velocity
//  buffer and is not.
// ---------------------------------------------------------------------------

import { VELOCITY_FRAG, TAA_FRAG, TAA_SHARPEN_FRAG,
         SKY_VELOCITY_VERT, SKY_VELOCITY_FRAG } from "../shaders/taa.js";
import { OCEAN_VERT } from "../shaders/oceanSurface.js";
import { UNIFORMS, SAMPLERS } from "../ocean/OceanMaterial.js";

const B = () => window.BABYLON;

/** Halton(2,3), the usual low-discrepancy sequence for sub-pixel offsets */
function halton(i, b) {
  let f = 1, r = 0, n = i;
  while (n > 0) { f /= b; r += f * (n % b); n = Math.floor(n / b); }
  return r;
}

/**
 * The jitter sequence, in PIXELS, built once per (length) and cached.
 *
 * Two properties are deliberate:
 *
 *   ZERO MEAN.  Halton on [0,1) has mean 1/2 only in the limit; a truncated
 *   run of 8 or 16 does not, and the leftover bias is a permanent sub-pixel
 *   shift of the whole resolved image against the unjittered one.  The mean of
 *   the actual finite set is subtracted, so the sequence cannot move the image.
 *
 *   NEAREST-CENTRE FIRST.  The sample closest to the pixel centre is rotated to
 *   index 0, so the first frame after any reset -- and any single-frame capture
 *   -- is taken as close to an unjittered sample as the set allows.
 *
 * Deterministic by construction: no RNG, and the same length always yields the
 * same list, so a test run twice produces identical offsets.
 */
const JITTER_CACHE = new Map();
export function jitterSequence(length) {
  const n = Math.max(1, length | 0);
  if (JITTER_CACHE.has(n)) return JITTER_CACHE.get(n);
  const pts = [];
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) {
    const x = halton(i + 1, 2), y = halton(i + 1, 3);
    pts.push([x, y]); mx += x; my += y;
  }
  mx /= n; my /= n;
  for (const p2 of pts) { p2[0] -= mx; p2[1] -= my; }
  let best = 0, bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const d = pts[i][0] * pts[i][0] + pts[i][1] * pts[i][1];
    if (d < bestD) { bestD = d; best = i; }
  }
  const out = pts.slice(best).concat(pts.slice(0, best));
  JITTER_CACHE.set(n, out);
  return out;
}

/**
 * How the temporal filter runs.  An explicit mode, not a pair of booleans:
 * the jitter work must not be able to silently change what REPROJECT does,
 * and REPROJECT is the frozen 12/14 control this phase is measured against.
 */
export const TAA_MODE = { NONE: 0, REPROJECT: 1, JITTERED: 2 };

/**
 * The two jittered configurations, named and kept side by side.
 *
 * They differ in ONE thing -- where the display stage sources its detail -- so
 * comparing them isolates the stable-source reconstruction and nothing else:
 *
 *   A_PRE_STABLE     detail from the current frame (detailSource 0).  The
 *                    configuration the strong early shimmer results
 *                    (+23/+24/+20/+41) were measured on.
 *   B_STABLE_SOURCE  detail reconstructed from the resolved, temporally stable
 *                    image (detailSource 1, stableSharpen 1.2).  Measurably
 *                    closer to a supersampled reference at every station, but
 *                    aerial shimmer collapses to +1%.
 *
 * Neither is production until both have been through the corrected contract.
 * Applied ON TOP of the jittered parameter set, so the rest of the mode's
 * configuration stays identical between them.
 */
export const JITTER_PROFILES = {
  A_PRE_STABLE: { detailSource: 0.0, stableSharpen: 0.0,
                  restoreLaw: 1.0, sharpenAmount: 0.35 },
  B_STABLE_SOURCE: { detailSource: 1.0, stableSharpen: 1.2,
                     restoreLaw: 1.0, sharpenAmount: 0.35 },
};

export class TemporalAA {
  constructor(engine, scene, camera, ocean) {
    this.engine = engine;
    this.scene = scene;
    this.camera = camera;
    this.ocean = ocean;
    // Off in the constructor.  App._applyTaa() turns it on when the quality
    // tier asks for it (ultra = REPROJECT, cinematic = JITTERED).  Harnesses
    // that boot `?tier=high` therefore still start with no history, which is
    // the control every measurement file uses.  Do not enable here.
    this.enabled = false;

    // --- history confidence -------------------------------------------------
    // How much history a pixel keeps is not one number.  A uniform weight has
    // to be set low enough for the worst pixel in the frame -- a tearing crest,
    // a spray edge, a disocclusion -- and then flat water, which could safely
    // accumulate for many frames, gets the same timid blend and the sea stays
    // noisy while the detail is smoothed away anyway.
    //
    // So the weight is derived per pixel from five independent confidences,
    // multiplied (see shaders/taa.js): any one of them being certain the
    // history is stale is enough.  These names are the sweep's search space --
    // see sweep.py, which is the only honest way to set fifteen coupled knobs.
    //
    // These values are candidate M3 from that search, chosen off the Pareto
    // set rather than by best-of-one-number.  The search rejects on exactly the
    // thresholds taa_test.py enforces and measures at exactly its stations, so
    // a candidate that survives there is predicted to survive there too -- an
    // earlier round that used its own stations nominated a configuration
    // measured at water +19% which the acceptance test then read at +7%.
    this.historyMin = 0.30;      // what a fully distrusted pixel still keeps
    this.historyMax = 0.97;      // what a fully trusted one may reach
    this.motionFalloff = 0.008;  // per pixel/frame of screen motion
    this.edgeFalloff = 1.60;     // per unit of local contrast
    this.varHistScale = 3.0;     // per unit of neighbourhood sigma
    this.reactiveScale = 0.85;   // per unit of the reactive mask
    this.ghostRejection = 0.16;  // per unit of velocity divergence
    this.uncoveredConf = 0.45;   // where nothing wrote a vector at all
    this.varianceGamma = 0.90;
    // 0 = clip in RGB, 1 = clip in YCoCg.  Deliberately a parameter: YCoCg is
    // the usual choice because it rejects impossible luminance while leaving
    // chroma alone, but on a sea that is mostly specular highlight that is an
    // assumption, not a result.  sweep.py measures both.
    this.clipSpace = 1;
    // motion below this many texels is treated as none, so a near-static view
    // is not resampled every frame (see uSnapTexels in shaders/taa.js)
    this.snapTexels = 0.5;
    // how fast a pixel must move before its spatial structure is allowed to
    // count against its history (see uConfMotionGate in shaders/taa.js)
    this.confMotionGate = 1.2;
    // see uRestoreLaw in shaders/taa.js; 0 is the reprojection law
    this.restoreLaw = 0.0;
    // 0 bilinear, 1 Catmull-Rom.  Bilinear for the frozen control, where the
    // cubic was measured and rejected; see historyCatmullRom in shaders/taa.js.
    this.historyFilter = 0.0;
    // 0 = sharpen from the current frame (reprojection mode), 1 = from the
    // resolved, temporally stable image (jittered mode).
    this.detailSource = 0.0;
    this.stableSharpen = 0.0;

    // --- detail restoration -------------------------------------------------
    // Alpha carries what the blend SUPPRESSED, so 1.0 would mean "put back
    // exactly what was taken".  Slightly under that measures better: restoring
    // the last quarter costs more frame-to-frame stability than it returns in
    // detail, which is the trade the whole filter exists to make.
    this.sharpenAmount = 0.85;
    this.detailMotion = 0.010;   // gain lost per pixel/frame of motion
    // Deliberately well under 1: a reactive pixel is current-frame dominant in
    // the RESOLVE, but that is not a reason to withhold its detail as well.
    // At 0.8 a fully reactive pixel kept only a fifth of its restoration, and
    // the underwater station -- which is dense with suspended matter, all of it
    // marked reactive -- measured 65% detail retention against an 82% floor
    // while every other station passed comfortably.
    this.detailReactive = 0.60;  // gain lost to the reactive mask
    this.debug = 0;
    // ndc -> uv is 0.5, but the SIGN depends on the projection's w convention,
    // so this is measured rather than derived: see taa_test.py.
    // ZERO, and this is the single most important number in the jitter work.
    //
    // The history is stored ON THE PIXEL GRID: texel (i,j) holds the
    // accumulated estimate of the scene at pixel centre (i,j), because that is
    // where the resolve wrote it.  It is NOT stored in the previous frame's
    // jittered sample space.  So the lookup for a surface point is
    //     hUV = uv - mv
    // with the unjittered motion vector and NO jitter term.  The current
    // frame's sample being off-centre is not something to correct for -- it is
    // the supersampling, and blending is what consumes it.
    //
    // I derived 0.5 first, from the other convention, and wrote a numerical
    // test that confirmed the lookup landed on the previous JITTERED position.
    // The test was right about the implementation and wrong about the target.
    // What exposed it was measuring the history buffer two ways on a frozen
    // scene: sampled at vUV it was perfectly static (0.000 LSB), sampled at
    // hUV it moved (1.338 LSB) -- so the accumulation was fine and the LOOKUP
    // was injecting the entire residual.  Measured end to end on that scene:
    //     k = 0.5   1.410 LSB, 25.9% of pixels moving 2+ LSB
    //     k = 0.25  0.772 LSB, 16.8%
    //     k = 0.0   0.081 LSB,  0.5%      <- converged
    //     k = -0.5  1.278 LSB, 24.4%
    // This is the "compensating twice" failure the plan warns about, arriving
    // as a wrong storage convention rather than as a duplicated line.
    this.jitterCompensation = 0.0;
    // TAA_MODE.REPROJECT is the frozen control: history reprojection only, no
    // projection jitter, and it must keep reproducing the measured 12/14
    // baseline.  JITTERED adds real sub-pixel sampling on top of the same
    // adaptive resolve -- it extends it, it does not replace it with a uniform
    // accumulator.
    this.mode = TAA_MODE.REPROJECT;
    // History ceiling.  A uniform so a harness can build a control that
    // genuinely exceeds it; production never moves it.
    this.keepCeil = 0.97;
    // Amplitude in PIXELS, half-width of the offset.  Pixels, not NDC, because
    // the whole point is that half a pixel stays half a pixel at 1080p and at
    // 4K; the conversion uses the render target's real size every frame.
    this.jitterPixels = 0.5;
    this.samples = 8;
    this._i = 0;
    // set true while the clean projection is being read; see update()
    this._suspendJitter = false;
    this._reset = 1;
    this.jitter = [0, 0];
    this._prevJitter = [0, 0];
    this._prevVP = null;
    this._built = false;
  }

  build() {
    const BJ = B();
    const w = this.engine.getRenderWidth();
    const h = this.engine.getRenderHeight();

    // --- velocity target -------------------------------------------------
    this.velocity = new BJ.RenderTargetTexture("oceanVelocity",
      { width: w, height: h }, this.scene, {
        generateDepthBuffer: true, generateMipMaps: false,
        type: BJ.Constants.TEXTURETYPE_HALF_FLOAT,
        format: BJ.Constants.TEXTUREFORMAT_RGBA,
        samplingMode: BJ.Constants.TEXTURE_NEAREST_SAMPLINGMODE,
      });
    // alpha 0 = no coverage; the ocean fragment writes 1
    this.velocity.clearColor = new BJ.Color4(0, 0, 0, 0);
    this.velocity.refreshRate = 1;
    this.velocity.renderParticles = false;
    this.velocity.ignoreCameraViewport = true;

    BJ.Effect.ShadersStore["oceanVelVertexShader"] = OCEAN_VERT;
    BJ.Effect.ShadersStore["oceanVelFragmentShader"] = VELOCITY_FRAG;
    const uni = UNIFORMS.concat(["uPrevViewProjection", "uCurViewProjection"]);
    this.velMat = new BJ.ShaderMaterial("oceanVelMat", this.scene,
      { vertex: "oceanVel", fragment: "oceanVel" }, {
        attributes: ["position", "uv"],
        uniforms: uni,
        samplers: SAMPLERS.concat(["uDispPrev0", "uDispPrev1", "uDispPrev2"]),
        defines: ["#define OCEAN_VELOCITY", "#define LOGARITHMICDEPTH"],
      });
    this.velMat.backFaceCulling = false;
    this.velocity.setMaterialForRendering(this.ocean.mesh, this.velMat);
    this.velocity.renderList = [this.ocean.mesh];

    // Particles render into the SAME target, after the ocean, so wherever one
    // is visible its own vector replaces the water's.  Leaving the water's
    // velocity under a mote is what made underwater TAA negative: the pixel
    // shows a particle and gets reprojected as if it were the sea.
    // Isolation switches for the debug views: with oceanVelocity off the
    // target holds ONLY the particles' vectors, and vice versa.  Without this
    // a wrong particle vector is invisible -- it sits inside a full-screen
    // field of correct water vectors.
    this.oceanVelocity = true;
    this.particleVelocity = true;
    this.skyVelocity = true;
    // 0 real vectors, 1 current position, 2 previous position, 3 birth/reuse/
    // alive, 4 coverage, 5 velocity magnitude.  Read it on TAA debug channel 13.
    this.particleDebug = 0;
    // --- sky ---------------------------------------------------------------
    const dome = this.ocean.sky && this.ocean.sky.dome;
    if (dome) {
      BJ.Effect.ShadersStore["oceanSkyVelVertexShader"] = SKY_VELOCITY_VERT;
      BJ.Effect.ShadersStore["oceanSkyVelFragmentShader"] = SKY_VELOCITY_FRAG;
      this.skyVelMat = new BJ.ShaderMaterial("oceanSkyVelMat", this.scene,
        { vertex: "oceanSkyVel", fragment: "oceanSkyVel" }, {
          attributes: ["position"],
          uniforms: ["uCurViewRotProj", "uPrevViewRotProj", "uReactive"],
        });
      this.skyVelMat.backFaceCulling = false;
      this.skyVelMat.disableDepthWrite = true;
      this.velocity.setMaterialForRendering(dome, this.skyVelMat);
      this.skyDome = dome;
    }

    this.particleFields = this.particleFields || [];
    const eff = this.ocean.effects;
    if (eff && eff.fields) {
      for (const f of eff.fields) {
        if (!f.mesh || !f.velMaterial) continue;
        this.velocity.renderList.push(f.mesh);
        this.velocity.setMaterialForRendering(f.mesh, f.velMaterial);
        this.particleFields.push(f);
      }
    }
    this.scene.customRenderTargets.push(this.velocity);

    // --- history + resolve ----------------------------------------------
    BJ.Effect.ShadersStore["oceanTaaFragmentShader"] = TAA_FRAG;
    BJ.Effect.ShadersStore["oceanTaaSharpFragmentShader"] = TAA_SHARPEN_FRAG;

    const mkHist = (n) => {
      const t = new BJ.RenderTargetTexture(n, { width: w, height: h }, this.scene, {
        generateDepthBuffer: false, generateMipMaps: false,
        // HDR history: an 8-bit one quantises the sun glitter and the
        // whitewater into steps that then flicker between frames
        type: BJ.Constants.TEXTURETYPE_HALF_FLOAT,
        samplingMode: BJ.Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
      });
      t.wrapU = t.wrapV = BJ.Constants.TEXTURE_CLAMP_ADDRESSMODE;
      return t;
    };
    // Two buffers, read one write the other, swapped every frame.  Sampling
    // and writing one texture in the same frame is undefined, and on a
    // temporal filter it shows up as slow corruption rather than an error.
    this.hist = [mkHist("taaHistA"), mkHist("taaHistB")];
    this.histIdx = 0;

    this.pp = new BJ.PostProcess("oceanTAA", "oceanTaa",
      ["uTexel", "uEnabled", "uHistoryMin", "uHistoryMax", "uMotionFalloff",
       "uEdgeFalloff", "uVarHistScale", "uReactiveScale", "uGhostRejection",
       "uUncoveredConf", "uClipSpace", "uSnapTexels", "uConfMotionGate",
       "uRestoreLaw", "uHistoryFilter", "uSize", "uDetailSource",
       "uReset", "uGamma", "uDebug", "uKeepCeil",
       "uJitterDelta"],
      ["uHistory", "uVelocity"], 1.0, this.camera,
      BJ.Constants.TEXTURE_BILINEAR_SAMPLINGMODE, this.engine, false, null,
      BJ.Constants.TEXTURETYPE_HALF_FLOAT);
    this.pp.onApply = (e) => {
      e.setFloat2("uTexel", 1 / this.engine.getRenderWidth(),
                            1 / this.engine.getRenderHeight());
      // MODE, not just the flag.  Gating on `enabled` alone meant
      // TAA_MODE.NONE still ran the full history blend -- it only
      // suppressed the jitter -- so every "TAA_NONE" control in the
      // harnesses was really the reprojection filter, and the "renderer
      // settling after a camera stop" was that filter converging, which
      // is exactly what it is supposed to do.
      const live = this.enabled && this.mode !== TAA_MODE.NONE;
      e.setFloat("uEnabled", live ? 1 : 0);
      e.setFloat("uKeepCeil", this.keepCeil);
      e.setFloat("uHistoryMin", this.historyMin);
      e.setFloat("uHistoryMax", this.historyMax);
      e.setFloat("uMotionFalloff", this.motionFalloff);
      e.setFloat("uEdgeFalloff", this.edgeFalloff);
      e.setFloat("uVarHistScale", this.varHistScale);
      e.setFloat("uReactiveScale", this.reactiveScale);
      e.setFloat("uGhostRejection", this.ghostRejection);
      e.setFloat("uUncoveredConf", this.uncoveredConf);
      e.setFloat("uClipSpace", this.clipSpace);
      e.setFloat("uSnapTexels", this.snapTexels);
      e.setFloat("uConfMotionGate", this.confMotionGate);
      e.setFloat("uRestoreLaw", this.restoreLaw);
      e.setFloat("uHistoryFilter", this.historyFilter);
      e.setFloat("uDetailSource", this.detailSource);
      e.setFloat2("uSize", this.engine.getRenderWidth(),
                           this.engine.getRenderHeight());
      e.setFloat("uReset", this._reset);
      e.setFloat("uGamma", this.varianceGamma);
      e.setFloat("uDebug", this.debug);
      // jitter is in NDC; ndc -> uv is a factor of 0.5
      const k = this.jitterCompensation;
      e.setFloat2("uJitterDelta", (this.jitter[0] - this._prevJitter[0]) * k,
                                  (this.jitter[1] - this._prevJitter[1]) * k);
      e.setTexture("uHistory", this.hist[this.histIdx]);      // READ
      e.setTexture("uVelocity", this.velocity);
    };

    // The sharpen pass doubles as the history capture: its INPUT is the
    // unsharpened resolve, which is exactly what the next frame must read.
    this.sharpen = new BJ.PostProcess("oceanTaaSharp", "oceanTaaSharp",
      ["uTexel", "uAmount", "uDetailMotion", "uDetailReactive",
       "uDetailSource", "uStableSharpen"],
      ["uVelocity"], 1.0, this.camera,
      BJ.Constants.TEXTURE_BILINEAR_SAMPLINGMODE, this.engine, false, null,
      BJ.Constants.TEXTURETYPE_HALF_FLOAT);
    this.sharpen.onApply = (e) => {
      e.setFloat2("uTexel", 1 / this.engine.getRenderWidth(),
                            1 / this.engine.getRenderHeight());
      const liveS = this.enabled && this.mode !== TAA_MODE.NONE;
      e.setFloat("uAmount", liveS ? this.sharpenAmount : 0);
      e.setFloat("uDetailMotion", this.detailMotion);
      e.setFloat("uDetailReactive", this.detailReactive);
      e.setFloat("uDetailSource", this.detailSource);
      e.setFloat("uStableSharpen", liveS ? this.stableSharpen : 0);
      e.setTexture("uVelocity", this.velocity);
    };
    // After the pass has rendered, never inside onApply: a copy issued while a
    // pass is still binding its framebuffer tears down the chain and the frame
    // comes out blank.
    this.sharpen.onAfterRenderObservable.add(() => {
      const src = this.sharpen.inputTexture;      // = the resolve's output
      if (!src) return;
      // A debug channel REPLACES the resolve's colour output.  Copying that
      // into the history makes the next frame blend against the visualisation,
      // and after a hundred frames the buffer is a recursive image of itself --
      // which reads as the history having lost 92% of its detail when in fact
      // the measurement destroyed it.  Freeze the history while a channel is
      // being displayed: converge first with debug off, then look.
      // OBSERVATIONAL ONLY.  A debug view replaces the resolve's colour, so
      // writing it to history makes the visualisation part of the algorithm it
      // is measuring: after a hundred frames the buffer is a recursive image of
      // itself, which read as the history having lost 92% of its detail when
      // the measurement had destroyed it.  Guarded by selftest.py, which checks
      // that production output is unchanged by having a channel enabled.
      if (this.debugOverridesResolve()) { this._historyHeld = true; return; }
      this._historyHeld = false;
      try {
        this._copy(src, this.hist[1 - this.histIdx]);   // WRITE the other one
        this.histIdx = 1 - this.histIdx;
        this._reset = 0;
      } catch (e) { this._copyFailed = e.message; this.enabled = false; }
    });

    this._built = true;
    return this;
  }

  /**
   * One parameter set per mode.
   *
   * REPROJECT is a frozen control and its numbers must not move, but jitter
   * genuinely wants different ones -- the neighbourhood clamp has to be wider
   * (under jitter the current sample legitimately differs from the
   * accumulation by the aliasing being removed, and a tight box clips the
   * accumulation back to the aliased sample every frame), and the restoration
   * law inverts.  Keeping two sets means the jitter search cannot quietly
   * rewrite the control it is being compared against.
   */
  _defaultParamSets() {
    const frozen = this.params();
    return {
      [TAA_MODE.REPROJECT]: frozen,
      [TAA_MODE.JITTERED]: Object.assign({}, frozen, {
        varianceGamma: 2.0,     // the clamp must admit the accumulated value
        restoreLaw: 1.0,        // restore what was NOT accumulated
        sharpenAmount: 0.35,    // accumulation supplies most of the detail
        historyFilter: 0.0,     // re-tested under jitter, bilinear still won
        // PROFILE A.  The stable-source sharpen (detailSource 1.0 with
        // stableSharpen 1.2) rings catastrophically -- measured against a
        // supersampled reference it overshoots on 53% of pixels at water
        // level, 67% aerial, 53% storm and 90% underwater, and sits 3.1x the
        // best mode's RMS from the truth. With it off: 0.51 / 0.00 / 0.88 /
        // 0.02% overshoot and 1.14x. It was only ever "swept" through a
        // capture path that was reading the wrong buffer.
        detailSource: 0.0,
        stableSharpen: 0.0,
      }),
    };
  }

  /**
   * True when a diagnostic view is replacing the resolve's colour output.
   * While this holds, the history must not be written -- see the guard in the
   * sharpen pass's after-render hook.
   */
  debugOverridesResolve() { return this.debug > 0.5; }

  /** true when the projection should carry a sub-pixel offset this frame */
  get jittering() {
    return this.enabled && this.mode === TAA_MODE.JITTERED && !this._suspendJitter;
  }

  /**
   * Switch mode.  Always resets: history sampled under a different sampling
   * regime is not history, and the sequence must restart deterministically so
   * two runs of a test see the same offsets from the same point.
   */
  setMode(m) {
    if (this.mode === m) return this.mode;
    if (!this.paramSets) this.paramSets = this._defaultParamSets();
    // remember whatever was live, so switching away and back is lossless
    if (this.paramSets[this.mode]) this.paramSets[this.mode] = this.params();
    this.mode = m;
    if (this.paramSets[m]) this.setParams(this.paramSets[m]);
    this._i = 0;
    this.jitter = [0, 0];
    this._prevJitter = [0, 0];
    this.reset();
    return this.mode;
  }

  /** the jitter state a harness needs to check the compensation numerically */
  jitterState() {
    const w = this.engine.getRenderWidth(), h = this.engine.getRenderHeight();
    const seq = jitterSequence(this.samples);
    return {
      mode: this.mode, samples: this.samples, index: this._i,
      pixels: this.jitterPixels,
      currentNdc: [this.jitter[0], this.jitter[1]],
      previousNdc: [this._prevJitter[0], this._prevJitter[1]],
      currentPixels: [this.jitter[0] * w * 0.5, this.jitter[1] * h * 0.5],
      previousPixels: [this._prevJitter[0] * w * 0.5, this._prevJitter[1] * h * 0.5],
      deltaUv: [(this.jitter[0] - this._prevJitter[0]) * this.jitterCompensation,
                (this.jitter[1] - this._prevJitter[1]) * this.jitterCompensation],
      sequencePixels: seq.map((q) => [q[0] * 2 * this.jitterPixels,
                                      q[1] * 2 * this.jitterPixels]),
      renderSize: [w, h],
    };
  }

  /**
   * Select a named jittered profile.  Switches to JITTERED if not already
   * there, then applies the profile's overrides; the mode's own parameter set
   * is updated so switching away and back is lossless.
   */
  setProfile(name) {
    const prof = JITTER_PROFILES[name];
    if (!prof) return null;
    if (this.mode !== TAA_MODE.JITTERED) this.setMode(TAA_MODE.JITTERED);
    this.setParams(prof);
    if (this.paramSets) this.paramSets[TAA_MODE.JITTERED] = this.params();
    this.reset();
    this.profile = name;
    return this.params();
  }

  /** apply a candidate configuration; keys are the field names above */
  setParams(o) {
    for (const k in o) {
      if (typeof this[k] === "number") this[k] = o[k];
    }
    return this.params();
  }

  /** the current search space, in the shape setParams accepts */
  params() {
    const keys = ["historyMin", "historyMax", "motionFalloff", "edgeFalloff",
      "varHistScale", "reactiveScale", "ghostRejection", "uncoveredConf",
      "varianceGamma", "clipSpace", "snapTexels", "confMotionGate",
      "sharpenAmount", "detailMotion",
      "detailReactive", "jitterPixels", "samples", "restoreLaw",
      "historyFilter", "detailSource", "stableSharpen", "keepCeil"];
    const o = {};
    for (const k of keys) o[k] = this[k];
    return o;
  }

  _copy(src, dst) {
    const BJ = B();
    if (!this._copier) this._copier = new BJ.CopyTextureToTexture(this.engine);
    // src is a RenderTargetWrapper; the copier wants the InternalTexture on
    // one side and a wrapper on the other.
    const from = src.texture || src;
    this._copier.copy(from, dst.renderTarget || dst);
  }

  /** call once per frame, with the same ctx the surface material was bound with */
  update(ctx) {
    if (!this._built) return;
    const BJ = B();
    const cam = this.camera;
    const w = this.engine.getRenderWidth();
    const h = this.engine.getRenderHeight();

    if (this.velocity.getSize().width !== w) {
      this.velocity.resize({ width: w, height: h });
      this.hist[0].resize({ width: w, height: h });
      this.hist[1].resize({ width: w, height: h });
      // History sampled on a different pixel grid is not history, and the
      // jitter offsets were computed against the old size.
      this._reset = 1;
      this._i = 0;
      this.jitter = [0, 0];
      this._prevJitter = [0, 0];
    }

    // --- sub-pixel jitter -------------------------------------------------
    // Pixels first, then converted with the render target's ACTUAL size, so
    // half a pixel is half a pixel at every resolution.
    this._prevJitter = [this.jitter[0], this.jitter[1]];
    if (this.enabled && this.mode === TAA_MODE.JITTERED) {
      const seq = jitterSequence(this.samples);
      this._i = (this._i + 1) % this.samples;
      const q = seq[this._i];
      const jxPx = q[0] * 2 * this.jitterPixels;
      const jyPx = q[1] * 2 * this.jitterPixels;
      this.jitter = [jxPx * 2 / w, jyPx * 2 / h];   // pixels -> NDC
    } else {
      this.jitter = [0, 0];
    }

    // The UNJITTERED view-projection is what motion vectors must be built
    // from: jitter is a sampling offset, not motion, and leaving it in makes
    // every pixel carry a permanent sub-pixel velocity that crawls.
    // Suspend the jitter rather than the whole filter: toggling `enabled` here
    // also toggled the resolve's own uniforms for anything that read them
    // during this window.
    this._suspendJitter = true;
    const proj = cam.getProjectionMatrix(true).clone();
    this._suspendJitter = false;
    const vp = cam.getViewMatrix().multiply(proj);
    if (!this._prevVP) this._prevVP = vp.clone();
    this.velMat.setMatrix("uCurViewProjection", vp);
    this.velMat.setMatrix("uPrevViewProjection", this._prevVP);
    this._prevVPBound = this._prevVP;      // particles use the same pair
    this._prevVP = vp.clone();

    // renderList membership is the isolation switch: a mesh left in the list
    // with a zeroed material still writes coverage, which is not "off".
    const list = this.velocity.renderList;
    const want = [];
    if (this.oceanVelocity) want.push(this.ocean.mesh);
    // after the ocean: it is depth-tested to the far plane, so it fills only
    // what the ocean did not cover
    if (this.skyVelocity && this.skyDome) want.push(this.skyDome);
    if (this.particleVelocity) {
      for (const f of this.particleFields)
        if (f.mesh && f.mesh.isEnabled()) want.push(f.mesh);
    }
    if (list.length !== want.length || want.some((m, i) => list[i] !== m)) {
      list.length = 0;
      for (const m of want) list.push(m);
    }

    const d = this.ocean.sim.displacementPrev;
    if (d && d.length === 3) {
      this.velMat.setTexture("uDispPrev0", d[0]);
      this.velMat.setTexture("uDispPrev1", d[1]);
      this.velMat.setTexture("uDispPrev2", d[2]);
    }
    this.ocean.material.bind(ctx, this.velMat);
    this.ocean.bindOceanTextures(this.velMat);
    this.velMat.setTexture("uDeriv0", this.ocean.sim.derivatives[0]);
    // rotation-only view matrices, for the infinitely distant sky
    if (this.skyVelMat) {
      const vr = cam.getViewMatrix().clone();
      vr.setTranslationFromFloats(0, 0, 0);
      const vpRot = vr.multiply(proj);
      if (!this._prevVPRot) this._prevVPRot = vpRot.clone();
      this.skyVelMat.setMatrix("uCurViewRotProj", vpRot);
      this.skyVelMat.setMatrix("uPrevViewRotProj", this._prevVPRot);
      this.skyVelMat.setFloat("uReactive", 0.0);
      this._prevVPRot = vpRot.clone();
    }
    for (const f of this.particleFields) f.partDebug = this.particleDebug;
    for (const f of this.particleFields) f.bindVelocity(vp, this._prevVPBound, cam);
  }

  /**
   * Sub-pixel jitter on the projection.  Wrapping getProjectionMatrix is the
   * reliable hook: Babylon calls it several times a frame, so the wrapper
   * recomputes a clean base every call and adds the offset once, rather than
   * accumulating it.
   */
  attachJitter(camera) {
    if (camera.__taaJitter) return;
    const orig = camera.getProjectionMatrix.bind(camera);
    const self = this;
    camera.getProjectionMatrix = function (force) {
      const m = orig(true);
      if (self._built && self.jittering) {
        // m[8], m[9] are the third column's x and y: clip.xy += j * clip.w,
        // i.e. a pure NDC offset, independent of depth.
        m.addAtIndex(8, self.jitter[0]);
        m.addAtIndex(9, self.jitter[1]);
      }
      return m;
    };
    camera.__taaJitter = true;
  }

  reset() { this._reset = 1; }

  dispose() {
    if (!this._built) return;
    const i = this.scene.customRenderTargets.indexOf(this.velocity);
    if (i >= 0) this.scene.customRenderTargets.splice(i, 1);
    this.velocity.dispose();
    this.hist.forEach((t) => t.dispose());
    if (this._copyPP) this._copyPP.dispose();
    this.pp.dispose();
    if (this.sharpen) this.sharpen.dispose();
    this._built = false;
  }
}
