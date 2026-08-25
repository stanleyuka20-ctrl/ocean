// ---------------------------------------------------------------------------
//  taa.js -- motion vectors for the ocean, and the temporal resolve.
//
//  MOTION VECTORS
//  The water's motion is not the camera's.  Every texel of every cascade moves
//  with its own orbital velocity, and the choppy horizontal displacement slides
//  the surface sideways as well as up, so a crest is somewhere else next frame
//  even with the camera bolted down.  The vector is therefore taken from the
//  PREVIOUS frame's displacement textures at the same lattice point: exact for
//  height and choppiness together, where a single velocity number would smear
//  every crest into the trough behind it.
//
//  THE RESOLVE
//  Standard reprojection + neighbourhood clamp, with three things the ocean
//  specifically needs:
//
//    * a REACTIVE mask.  Foam and spray change topology every frame -- a bubble
//      bursts, a crest tears -- so their history is worthless and blending it
//      is what produces the white smears people call "foam ghosting".  Those
//      pixels take far less history and clamp far harder.
//    * VELOCITY-AWARE rejection.  Fast pixels get a tighter clamp, because the
//      neighbourhood they are being compared against is a frame stale.
//    * DISOCCLUSION from the velocity discontinuity.  A crest sliding in front
//      of a trough exposes surface that has no history at all.
//
//  Deliberately NOT a heavy blend.  Averaging hard enough to hide shimmer also
//  dissolves the thin bright crest edges that make the sea read as water, so a
//  sharpen goes back on afterwards -- but in a SEPARATE pass, never inside the
//  resolve.  Sharpening the value that becomes the next frame's history is a
//  recursive unsharp mask: high frequencies are multiplied by (1 + gain*keep)
//  every frame and grow without bound as soon as that product exceeds one.
//  The frame-to-frame difference then INCREASES with history enabled, which is
//  what a diverging temporal filter looks like from the outside.
// ---------------------------------------------------------------------------

/**
 * Velocity fragment: screen-space motion in UV, plus a REACTIVE mask.
 *
 * Reactive marks the pixels whose history is worthless -- foam and whitewater,
 * which re-form every frame rather than moving.  The resolve uses it to keep
 * almost no history there, which is what stops the white smears that read as
 * "foam ghosting" while leaving the water itself fully temporally filtered.
 */
export const VELOCITY_FRAG = /* glsl */ `
precision highp float;
varying vec4 vClipCur;
varying vec4 vClipPrev;
varying vec3 vFlat;
uniform sampler2D uDeriv0;
uniform vec3 uCascadeL;
uniform float uFoamAmount;
#include<logDepthDeclaration>

void main(){
#include<logDepthFragment>
  vec2 ndcCur = vClipCur.xy / max(vClipCur.w, 1e-6);
  vec2 ndcPrev = vClipPrev.xy / max(vClipPrev.w, 1e-6);
  // NDC is -1..1, uv is 0..1, so the screen-space delta is half the NDC delta
  vec2 mv = (ndcCur - ndcPrev) * 0.5;

  float foam = texture2D(uDeriv0, vFlat.xz / uCascadeL.x).w * uFoamAmount;
  // alpha is COVERAGE: 1 where this pixel is ocean surface and therefore has a
  // real motion vector.  Everything else -- sky, spray, bubbles, the underwater
  // volume -- has none, and blending history into it is guesswork.
  gl_FragColor = vec4(mv, clamp(foam * 1.6, 0.0, 1.0), 1.0);
}
`;

export const TAA_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;   // this frame
uniform sampler2D uHistory;         // last frame's RESOLVE (never sharpened)
uniform sampler2D uVelocity;        // rg = motion, b = reactive, a = coverage
uniform vec2  uTexel;
uniform float uEnabled;             // 0 disables history entirely
uniform float uKeepCeil;            // history ceiling, 0.97 in production
uniform float uHistoryMin;          // floor: what a fully distrusted pixel keeps
uniform float uHistoryMax;          // ceiling: what a fully trusted pixel keeps
uniform float uMotionFalloff;       // confidence lost per pixel/frame of motion
uniform float uEdgeFalloff;         // confidence lost per unit of local contrast
uniform float uVarHistScale;        // confidence lost per unit of neighbourhood sigma
uniform float uReactiveScale;       // confidence lost to the reactive mask
uniform float uGhostRejection;      // confidence lost to velocity divergence
uniform float uUncoveredConf;       // confidence where nothing wrote a vector
uniform float uClipSpace;           // 0 = clip in RGB, 1 = clip in YCoCg
uniform float uSnapTexels;          // below this motion, do not resample at all
// 0: restore in proportion to the history that was blended IN (what a
// reprojection-only filter suppressed).  1: in proportion to what was NOT --
// see the note where detail is computed.  Continuous, so it can be measured
// rather than assumed.
uniform float uRestoreLaw;
uniform float uHistoryFilter;       // 0 bilinear, 1 Catmull-Rom
// 0: alpha carries the CURRENT frame's suppressed high frequency (the
// reprojection-mode source).  1: alpha carries the pixel's CONVERGENCE, and the
// display pass reconstructs detail spatially from the resolved, temporally
// stable image instead.  See the note in TAA_SHARPEN_FRAG.
uniform float uDetailSource;
uniform vec2  uSize;                // render target size in texels
uniform float uConfMotionGate;      // how fast a pixel must move before spatial
                                    // structure counts against its history
uniform float uReset;               // 1 = discard history entirely
uniform float uGamma;               // variance clipping width
uniform float uDebug;               // 0 off, see the switch at the end
uniform vec2  uJitterDelta;         // (jitterCur - jitterPrev) * 0.5, in uv

vec3 rgb2ycocg(vec3 c){
  return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
              0.5 * c.r - 0.5 * c.b,
             -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
vec3 ycocg2rgb(vec3 c){
  return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

/**
 * Catmull-Rom history fetch, as nine bilinear taps.
 *
 * Under projection jitter the history is almost never sampled at a texel
 * centre -- the compensation offsets it by the difference between two
 * sub-pixel positions -- so the fetch filter is applied to the accumulator
 * every single frame.  A bilinear tap is a small blur, and iterated it is a
 * low-pass that the accumulation can never climb back out of: on a completely
 * frozen scene, where a correct filter should converge to nearly zero motion,
 * bilinear left 38% of the jitter wobble in place with detail restoration
 * already ruled out as the cause.
 *
 * This was REJECTED for the non-jittered renderer, and that rejection stands:
 * there the history is fetched at whole-texel offsets most of the time, the
 * extra taps bought nothing measurable, and the negative lobes cost stability
 * in storm.  It is re-tested here because jitter changes the premise, not
 * because the earlier result was wrong.  Selected by uHistoryFilter so it
 * remains a measurement.
 */
// NOTE: no sampler PARAMETER.  WGSL does not permit passing a texture or
// sampler into a function the way GLSL does, and Babylon's transpiler fails the
// whole shader on it -- which surfaces as "GLSL compilation failed" with the
// post-process silently absent, not as an error pointing at this line.  The
// history sampler is referenced directly instead.
vec3 historyCatmullRom(vec2 uv, vec2 texSize){
  vec2 samplePos = uv * texSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 off12 = w2 / max(w12, vec2(1e-5));
  vec2 p0 = (texPos1 - 1.0) / texSize;
  vec2 p3 = (texPos1 + 2.0) / texSize;
  vec2 p12 = (texPos1 + off12) / texSize;
  vec3 r = vec3(0.0);
  r += texture2D(uHistory, vec2(p0.x,  p0.y)).rgb  * (w0.x  * w0.y);
  r += texture2D(uHistory, vec2(p12.x, p0.y)).rgb  * (w12.x * w0.y);
  r += texture2D(uHistory, vec2(p3.x,  p0.y)).rgb  * (w3.x  * w0.y);
  r += texture2D(uHistory, vec2(p0.x,  p12.y)).rgb * (w0.x  * w12.y);
  r += texture2D(uHistory, vec2(p12.x, p12.y)).rgb * (w12.x * w12.y);
  r += texture2D(uHistory, vec2(p3.x,  p12.y)).rgb * (w3.x  * w12.y);
  r += texture2D(uHistory, vec2(p0.x,  p3.y)).rgb  * (w0.x  * w3.y);
  r += texture2D(uHistory, vec2(p12.x, p3.y)).rgb  * (w12.x * w3.y);
  r += texture2D(uHistory, vec2(p3.x,  p3.y)).rgb  * (w3.x  * w3.y);
  // the kernel has negative lobes; without this they ring into black
  return max(r, vec3(0.0));
}

void main(){
  vec3 cur = texture2D(textureSampler, vUV).rgb;
  vec4 velS = texture2D(uVelocity, vUV);
  vec3 vel = velS.rgb;
  // NaN in a velocity buffer is silent and total: clamp(NaN,0,1) samples a
  // corner texel, so the history reads black everywhere and the resolve
  // quietly turns into "blend with black" while every weight still looks sane.
  bool velOk = all(equal(vel, vel));
  vec2 mv = velOk ? clamp(vel.rg, vec2(-0.25), vec2(0.25)) : vec2(0.0);
  float reactive = velOk ? clamp(vel.b, 0.0, 1.0) : 0.0;
  float velBad = velOk ? 0.0 : 1.0;
  float covered = clamp(velS.a, 0.0, 1.0);

  // --- current neighbourhood --------------------------------------------
  // Gathered once and read three ways: the clip box, the variance confidence
  // and the edge confidence are all statistics of the same 3x3.
  bool ycocg = uClipSpace > 0.5;
  vec3 c0 = ycocg ? rgb2ycocg(cur) : cur;
  vec3 mn = c0;
  vec3 mx = c0;
  vec3 m1 = c0;
  vec3 m2 = c0 * c0;
  float lc = luma(cur);
  float lmn = lc;
  float lmx = lc;
  float detailLo = lc;
  for (int y = -1; y <= 1; ++y){
    for (int x = -1; x <= 1; ++x){
      if (x == 0 && y == 0) continue;
      vec3 raw = texture2D(textureSampler, vUV + vec2(float(x), float(y)) * uTexel).rgb;
      vec3 sm = ycocg ? rgb2ycocg(raw) : raw;
      mn = min(mn, sm); mx = max(mx, sm);
      m1 += sm; m2 += sm * sm;
      float lr = luma(raw);
      lmn = min(lmn, lr); lmx = max(lmx, lr);
      detailLo += lr;
    }
  }
  vec3 mu = m1 / 9.0;
  vec3 sigma = sqrt(max(m2 / 9.0 - mu * mu, 0.0));
  detailLo /= 9.0;

  // --- reproject ---------------------------------------------------------
  // The motion vector is built from UNJITTERED matrices, so it carries no
  // jitter -- but the two IMAGES do differ by one, because each was rendered
  // through a different sub-pixel offset.  Exactly once: adding it on both the
  // velocity and the lookup cancels it back out.
  // Below a fraction of a texel, do not resample the history AT ALL.
  //
  // A bilinear tap at a fractional offset is a small blur, and on a nearly
  // static view -- the aerial station, where the water is 220 m away and moves
  // a fraction of a pixel per frame -- that blur is applied to its own output
  // every frame while the image underneath barely changes.  The result is that
  // history makes a static scene measurably WORSE: aerial reproducibly scored
  // -9% before this.  Snapping sub-texel motion to zero costs nothing and
  // cannot affect a pixel that is actually moving.
  vec2 mvPx = mv / max(uTexel, vec2(1e-6));
  vec2 mvSnap = (length(mvPx) < uSnapTexels) ? vec2(0.0) : mv;
  vec2 hUV = vUV - mvSnap - uJitterDelta;
  // Both fetched, then selected: a texture read behind non-uniform control
  // flow is invalid in WGSL, and this shader has to compile on both backends.
  vec2 hClamped = clamp(hUV, vec2(0.0), vec2(1.0));
  vec3 histBilinear = texture2D(uHistory, hClamped).rgb;
  vec3 histCubic = historyCatmullRom(hClamped, uSize);
  vec3 hist = mix(histBilinear, histCubic, clamp(uHistoryFilter, 0.0, 1.0));
  vec3 h0 = ycocg ? rgb2ycocg(hist) : hist;

  // Clip the reprojected history into the current neighbourhood BEFORE it is
  // weighed.  A hard min/max box keeps outliers, and on a sea full of specular
  // sparkle that means the box does almost nothing -- so bound it by variance
  // as well.  Both colour spaces are built identically and selected by
  // uClipSpace: which one wins on water highlights is a measurement, not a rule.
  float gamma = uGamma * mix(1.0, 0.45, reactive);
  vec3 lo = max(mn, mu - gamma * sigma);
  vec3 hi = min(mx, mu + gamma * sigma);
  vec3 clipped = clamp(h0, lo, hi);

  // --- per-pixel history confidence --------------------------------------
  // Five independent readings, multiplied.  The product matters: any ONE of
  // them being certain the history is stale should be enough, and a sum lets
  // four confident terms outvote the one that is right.

  // 1. motion.  A fast pixel is compared against a neighbourhood that is a
  //    frame out of date, so the comparison itself is worth less.  It also
  //    gates terms 2 and 3, below.
  float speedPx = length(mvPx);
  float motionConf = exp(-speedPx * uMotionFalloff);

  // 2. edge.  Local CONTRAST in the current frame -- spatial structure, not
  //    temporal disagreement.  That is the distinction from the reverted
  //    luminance-difference experiment: a moving sea disagrees with its history
  //    a little everywhere, because glitter is view dependent, so any temporal
  //    test strong enough to catch a crest collapses the whole frame.  Local
  //    contrast says only "there is fine structure HERE", which is exactly
  //    where blending costs detail and nowhere else.
  float contrast = (lmx - lmn) / max(lmx + lmn, 1e-3);
  // Gated by motion, and this is the whole point of the term.  Fine structure
  // is dangerous only because a slightly wrong vector lands it in the wrong
  // place -- with no motion there is no such risk, and penalising contrast
  // anyway suppresses history exactly where reprojection is safest.  That is
  // not hypothetical: the aerial station is a nearly static view of sparkling
  // water, the one case where averaging is both safe and the only thing that
  // helps, and ungated this term made temporal filtering there reproducibly
  // NEGATIVE while every other station gained.
  float mGate = clamp(speedPx * uConfMotionGate, 0.0, 1.0);
  float edgeConf = exp(-contrast * uEdgeFalloff * mGate);

  // 3. neighbourhood variance.  Flat water is predictable and may accumulate
  //    hard; a churning neighbourhood may not.
  float varConf = 1.0 / (1.0 + luma(abs(sigma)) * uVarHistScale * mGate);

  // 4. reactive.  Foam, spray and newborn particles re-form rather than move.
  float reactConf = clamp(1.0 - uReactiveScale * reactive, 0.0, 1.0);

  // 5. velocity divergence.  Where neighbouring vectors disagree this pixel is
  //    on a motion boundary: a disocclusion, a particle edge, or a crest
  //    changing topology.  This is the term aimed at the ghost trail, because a
  //    trail is exactly history that survived a boundary it should not have.
  vec2 vN = texture2D(uVelocity, vUV + vec2(uTexel.x, 0.0)).rg;
  vec2 vS = texture2D(uVelocity, vUV - vec2(uTexel.x, 0.0)).rg;
  vec2 vE = texture2D(uVelocity, vUV + vec2(0.0, uTexel.y)).rg;
  vec2 vW = texture2D(uVelocity, vUV - vec2(0.0, uTexel.y)).rg;
  float diverge = max(max(length(vN - mv), length(vS - mv)),
                      max(length(vE - mv), length(vW - mv)))
                / max(length(uTexel), 1e-6);
  float divConf = clamp(1.0 - diverge * uGhostRejection, 0.0, 1.0);

  // coverage: nothing wrote a vector here at all, so reprojection is a guess
  float covConf = mix(uUncoveredConf, 1.0, covered);

  float offscreen = (hUV.x < 0.0 || hUV.x > 1.0 || hUV.y < 0.0 || hUV.y > 1.0) ? 1.0 : 0.0;

  float confidence = clamp(motionConf * edgeConf * varConf
                         * reactConf * divConf * covConf, 0.0, 1.0);

  float keep = uHistoryMin + confidence * (uHistoryMax - uHistoryMin);
  keep *= 1.0 - offscreen;
  keep *= 1.0 - uReset;
  keep *= uEnabled;
  // Ceiling as a UNIFORM (0.97 in production, unchanged).  Hard-coded, it
  // silently defeated the persistence instrument's own broken control:
  // BROKEN_0.995 sets historyMin=historyMax=0.995 and the clamp put it
  // straight back to 0.97, so the 'deliberately broken' build was really
  // production at maximum history and could not be the worst persistence
  // in the matrix -- which is exactly what the certification measured.
  keep = clamp(keep, 0.0, uKeepCeil);

  vec3 blended = mix(c0, clipped, keep);
  vec3 outC = ycocg ? ycocg2rgb(blended) : blended;
  outC = max(outC, 0.0);

  // What the blend just cost this pixel, handed to the sharpen pass in alpha.
  //
  // WHICH WEIGHT depends on what the history contains, and the two modes differ:
  //
  //   Reprojection only -- every frame samples the same grid, so the history
  //   holds the same detail the current frame does and blending it away is a
  //   pure loss.  Restore in proportion to keep, the amount lost.
  //
  //   Jittered -- each frame samples a DIFFERENT sub-pixel position, so the
  //   accumulation holds more information than any single frame.  The current
  //   frame's high frequency is then largely aliasing, and adding it back puts
  //   the wobble in again: measured on a completely frozen scene, restoration
  //   at the reprojection law removed only 24% of the jitter wobble against 58%
  //   with restoration switched off entirely.  Restore in proportion to
  //   (1 - keep) instead, so a well-accumulated pixel is left alone and a
  //   freshly disoccluded one -- which has no accumulation to rely on -- still
  //   gets its detail from the frame it can see.  A global sharpen cannot serve both
  // ends of this renderer at once -- at water level, where motion is fast and
  // keep is low, a gain large enough to matter pushed detail retention to 103%
  // and left the frame-to-frame difference almost unchanged (+1%), while the
  // same gain underwater, where keep runs near its ceiling, recovered only 78%
  // of the detail.  Scaling by keep makes the restoration proportional to the
  // loss, per pixel, and removes the global compromise entirely.
  //
  // It still comes from the CURRENT frame: reconstructing detail from the
  // resolved image can only re-amplify what survived, which is the recursive
  // unsharp mask this architecture exists to avoid.  History reads .rgb only,
  // so nothing here feeds back.
  float detail = (lc - detailLo) * mix(keep, 1.0 - keep, clamp(uRestoreLaw, 0.0, 1.0));
  // With a stable source the display pass does not need the current frame's
  // high frequency at all -- it needs to know how converged this pixel is, so
  // it can sharpen a well-accumulated estimate hard and leave a fresh one
  // alone.  keep is the available proxy for that until a real per-pixel sample
  // count exists: a pixel that has been holding history is a pixel that has
  // been accumulating.
  detail = mix(detail, keep, clamp(uDetailSource, 0.0, 1.0));

  // --- debug views --------------------------------------------------------
  if (uDebug > 0.5){
    if (uDebug < 1.5)      outC = cur;
    else if (uDebug < 2.5) outC = texture2D(uHistory, vUV).rgb;
    else if (uDebug < 3.5) outC = vec3(abs(mv) * 220.0, 0.0);
    else if (uDebug < 4.5) outC = hist;
    else if (uDebug < 5.5) outC = vec3(length(cur - hist) * 6.0);
    else if (uDebug < 6.5) outC = vec3(reactive);
    else if (uDebug < 7.5) outC = vec3(keep);
    else if (uDebug < 8.5) outC = vec3(offscreen, divConf, motionConf);
    else if (uDebug < 9.5) outC = vec3(velBad);       // NaN mask
    // identical expression to ch4 except the uv: isolates hUV from the sampler
    else if (uDebug < 10.5) outC = texture2D(uHistory, clamp(vUV, vec2(0.0), vec2(1.0))).rgb;
    else if (uDebug < 11.5) outC = vec3(abs(hUV - vUV) * 400.0, 0.0);
    else if (uDebug < 12.5) outC = vec3(covered);
    else if (uDebug < 13.5) outC = velS.rgb;          // raw velocity target
    // 14: what the ghost metric is MADE OF.  A trail is the resolved pixel
    // sitting far from the untemporal one, so this says which content trails
    // rather than only how much of it does.
    else if (uDebug < 14.5) outC = vec3(length(outC - cur) * 8.0);
    else if (uDebug < 15.5) outC = vec3(confidence);
    else if (uDebug < 16.5) outC = vec3(edgeConf, varConf, reactConf);
    else if (uDebug < 17.5) outC = vec3(abs(detail) * 8.0);
    // 18: how far the history lookup lands from a texel CENTRE, 0..0.5 texels
    // scaled to 0..1.  Repeated fractional reads are a repeated resampling
    // filter; correlating this with where detail is lost says whether the
    // softness comes from reprojection or from the temporal average itself.
    else {
      // distance from the nearest texel CENTRE, 0 = aligned, 1 = worst.
      // hUV * size gives texel coordinates whose centres are at i + 0.5, so
      // the fractional part must be measured about 0.5 -- taking it about 0
      // reports a perfectly aligned lookup as the worst possible one.
      vec2 tp = hUV * uSize;
      vec2 frac = abs(fract(tp) - 0.5);
      outC = vec3(length(vec2(0.5) - frac) * 2.828);
    }
  }
  gl_FragColor = vec4(outC, detail);
}
`;

/**
 * Display sharpen, applied AFTER the history has been captured.
 *
 * A 3x3 clip is a low-pass, so something has to put the high frequency back or
 * the sea stops shimmering and also stops looking wet.  It must not live inside
 * the resolve: see the note at the top of this file.
 *
 * Two things make this more than an unsharp mask.  The high frequency comes
 * from the CURRENT frame, carried through in the resolve's alpha, rather than
 * from the resolved image -- reconstructing it from the resolve can only
 * re-amplify what the blend kept.  And the gain is per-pixel: strong where the
 * surface is stable, weak where it is moving fast or reactive.
 */
export const TAA_SHARPEN_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;   // the resolve, unsharpened
uniform sampler2D uVelocity;
uniform vec2 uTexel;
uniform float uAmount;              // base gain, current-frame source
uniform float uDetailMotion;        // gain lost per pixel/frame of motion
uniform float uDetailReactive;      // gain lost to the reactive mask
uniform float uDetailSource;        // 0 current-frame, 1 stable resolved
uniform float uStableSharpen;       // base gain, stable source

void main(){
  vec4 r = texture2D(textureSampler, vUV);
  vec3 res = r.rgb;
  // alpha is the current frame's suppressed high frequency, OR this pixel's
  // convergence, depending on uDetailSource (see the resolve).
  float carried = r.a;

  vec4 velS = texture2D(uVelocity, vUV);
  bool ok = all(equal(velS.rgb, velS.rgb));
  vec2 mv = ok ? velS.rg : vec2(0.0);
  float reactive = ok ? clamp(velS.b, 0.0, 1.0) : 1.0;
  float speedPx = length(mv / max(uTexel, vec2(1e-6)));

  // --- source A: the current frame -----------------------------------------
  // Correct for reprojection-only, where every frame samples the same grid and
  // the history holds the same detail the current frame does.
  float gainA = uAmount
              * exp(-speedPx * uDetailMotion)
              * clamp(1.0 - uDetailReactive * reactive, 0.0, 1.0);
  float lum = dot(res, vec3(0.2126, 0.7152, 0.0722));
  vec3 outA = res + res * (gainA * carried / max(lum, 1e-3));

  // --- source B: the resolved image itself ---------------------------------
  // Under jitter the current frame is a DIFFERENT sub-pixel sample every frame,
  // so sharpening from it puts back exactly the wobble the accumulation just
  // removed.  The resolved image does not have that problem: it is the stable
  // supersampled estimate, and a spatial high-pass of it is stable too.
  //
  // The convergence weighting is the opposite way round from source A, and
  // deliberately so.  A fresh or reactive pixel has no accumulation yet, so its
  // resolved value is still close to a single aliased sample and sharpening it
  // amplifies aliasing; a well-converged pixel holds the best estimate
  // available and is the safe one to sharpen.
  vec3 lo = (texture2D(textureSampler, vUV + vec2(uTexel.x, 0.0)).rgb
           + texture2D(textureSampler, vUV - vec2(uTexel.x, 0.0)).rgb
           + texture2D(textureSampler, vUV + vec2(0.0, uTexel.y)).rgb
           + texture2D(textureSampler, vUV - vec2(0.0, uTexel.y)).rgb) * 0.25;
  vec3 stableDetail = res - lo;
  float convergence = clamp(carried, 0.0, 1.0);
  float gainB = uStableSharpen * convergence
              * clamp(1.0 - uDetailReactive * reactive, 0.0, 1.0)
              * exp(-speedPx * uDetailMotion);
  // bounded: the display stage must never be able to recover arbitrary
  // amplitude, however converged the pixel claims to be
  vec3 outB = res + clamp(stableDetail * gainB, -0.35 * (res + 0.05),
                          0.35 * (res + 0.05));

  vec3 outC = mix(outA, outB, clamp(uDetailSource, 0.0, 1.0));
  gl_FragColor = vec4(max(outC, 0.0), r.a);
}
`;

/**
 * Sky velocity.
 *
 * The sky cannot inherit the ocean's vector and it cannot be left uncovered:
 * with projection jitter on, an uncovered pixel wobbles by the jitter amplitude
 * every frame with nothing to reproject it by, and above the horizon that is
 * most of the frame.
 *
 * The dome is drawn with infiniteDistance, so the view matrix's TRANSLATION is
 * removed: camera movement does not move an infinitely distant sky, camera
 * rotation does.  Both matrices here are rotation-only for that reason, and
 * both are unjittered, like every other velocity in this renderer.
 *
 * Depth is forced to the far plane (just inside it, so the test against a
 * cleared buffer still passes) -- the dome is a unit sphere sitting on the
 * camera, and drawn at its true depth it would cover the ocean's vectors.
 */
export const SKY_VELOCITY_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 uCurViewRotProj;
uniform mat4 uPrevViewRotProj;
varying vec4 vClipCur;
varying vec4 vClipPrev;

void main(){
  vClipCur = uCurViewRotProj * vec4(position, 1.0);
  vClipPrev = uPrevViewRotProj * vec4(position, 1.0);
  vec4 p = vClipCur;
  p.z = p.w * 0.999999;
  gl_Position = p;
}
`;

export const SKY_VELOCITY_FRAG = /* glsl */ `
precision highp float;
varying vec4 vClipCur;
varying vec4 vClipPrev;
uniform float uReactive;

void main(){
  vec2 ndcCur = vClipCur.xy / max(abs(vClipCur.w), 1e-6) * sign(vClipCur.w);
  vec2 ndcPrev = vClipPrev.xy / max(abs(vClipPrev.w), 1e-6) * sign(vClipPrev.w);
  vec2 mv = (ndcCur - ndcPrev) * 0.5;
  // coverage 1: the sky has a real vector, so its history is usable.  It is
  // also the most temporally stable thing in the frame, hence no reactivity.
  gl_FragColor = vec4(mv, uReactive, 1.0);
}
`;
