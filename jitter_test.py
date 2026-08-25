#!/usr/bin/env python3
"""
jitter_test.py -- the gates that must pass before jittered TAA is worth measuring.

    py -3.14 jitter_test.py [--tier high] [--webgl]

Four things, in the order they can invalidate each other:

  1. THE SEQUENCE is deterministic, zero-mean, and expressed in pixels -- so a
     0.5 px offset is 0.5 px at 1080p and at 4K, and two runs of a test see the
     same offsets.
  2. THE COMPENSATION is applied exactly once.  A static world point's
     reprojected history position must land on where that point was drawn in
     the PREVIOUS jittered frame.  Compensating twice, or not at all, both
     leave every other number looking reasonable while the image swims -- so
     this is checked numerically against the matrices, not by eye.
  3. MOTION VECTORS stay unjittered.  The measured pan rate must not move when
     jitter is switched on: jitter is a sampling offset, not motion.
  4. A COMPLETELY STATIC SCENE CONVERGES.  With the simulation, particles,
     foam, weather and camera all frozen, jitter alone makes the raw image
     wobble; a working resolve must settle it.  If that does not converge there
     is no point measuring an ocean.
"""
import argparse
import io as _io
import sys

from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import sync_playwright

from harness import grab_img

# A world point, its two clip positions, and what the resolve will actually do.
# All of it read from the live matrices rather than recomputed here: a test that
# reimplements the transform it is auditing drifts from it and then rejects
# correct work.
# Where the resolve fetches history for a STATIC world point, frame by frame.
#
# The property that matters is not "does it land on some particular place" --
# my first version asserted it landed on the previous JITTERED sample position,
# which is the wrong target and passed to 0.0000 px while the renderer failed to
# converge.  What matters is that for a point that is not moving, in front of a
# camera that is not moving, the lookup must not MOVE between frames: the
# history lives on the pixel grid, so a stationary point must keep reading the
# same texel.  Anything else drags a static accumulation around by the jitter.
REPROJ = """(pt) => {
    const BJ = window.BABYLON, taa = window.__taa;
    const P = new BJ.Vector3(pt[0], pt[1], pt[2]);
    const w = window.__engine.getRenderWidth(), h = window.__engine.getRenderHeight();
    // TransformCoordinates divides by w, so this is NDC; jitter is a pure NDC
    // offset (see attachJitter) and ndc -> uv is 0.5.
    const uvOf = (vp, jit) => {
      const v = BJ.Vector3.TransformCoordinates(P, vp);
      return [v.x * 0.5 + 0.5 + jit[0] * 0.5, v.y * 0.5 + 0.5 + jit[1] * 0.5];
    };
    const curJit = uvOf(taa._curVPProbe, taa.jitter);
    const curUn = uvOf(taa._curVPProbe, [0, 0]);
    const prevUn = uvOf(taa._prevVPProbe, [0, 0]);
    const mv = [curUn[0] - prevUn[0], curUn[1] - prevUn[1]];
    const at = (k) => {
      const dj = [(taa.jitter[0] - taa._prevJitter[0]) * k,
                  (taa.jitter[1] - taa._prevJitter[1]) * k];
      return [curJit[0] - mv[0] - dj[0], curJit[1] - mv[1] - dj[1]];
    };
    return {
      hUV: at(taa.jitterCompensation), hUVzero: at(0.0), hUVhalf: at(0.5),
      pixels: [w, h],
    };
}"""

STAT = """(async () => {
    const t = window.__taa.velocity, a = await t.readPixels();
    let n = 0, cov = 0, mx = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (!isFinite(a[i]) || !isFinite(a[i + 1])) continue;
      n++;
      if (a[i + 3] < 0.5) continue;
      cov++;
      mx = Math.max(mx, Math.hypot(a[i], a[i + 1]));
    }
    return { max: mx, coverFrac: n ? cov / n : 0 };
})()"""

# One definition, in the app: window.__freezeWorld().  Every harness used
# to carry its own copy and they drifted -- none of them stopped the legacy
# spray systems, which advance per RENDERED frame regardless of dt and put
# ~9.9 RMS into the no-history floor.
FREEZE = """() => window.__freezeWorld()"""


# GPU readback, not page.screenshot(): the compositor lags hand-stepped
# frames and produced a fictitious 128-frame "settling".  See harness.py.
def shot(page):
    return grab_img(page)



def wobble(page, frames=8):
    """Mean frame-to-frame difference of a frozen scene.  With the world stopped
    this is not shimmer -- it is only the sampling offset moving."""
    page.evaluate("window.__pauseRender()")
    try:
        page.evaluate("window.__advance(8)")
        prev = shot(page)
        acc = 0.0
        for _ in range(frames):
            page.evaluate("window.__advance(1)")
            cur = shot(page)
            acc += ImageStat.Stat(ImageChops.difference(cur, prev)).mean[0]
            prev = cur
        return acc / frames
    finally:
        page.evaluate("window.__resumeRender()")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="high")
    ap.add_argument("--webgl", action="store_true")
    a = ap.parse_args()

    flags = ["--ignore-gpu-blocklist", "--use-angle=default"]
    url = f"http://127.0.0.1:5390/index.html?tier={a.tier}"
    if a.webgl:
        url += "&webgl=1"
    else:
        flags += ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"]

    fails = []

    def check(name, ok, why=""):
        print(f"{'PASS' if ok else 'FAIL'}  {name:48s} {why}")
        if not ok:
            fails.append(name)

    with sync_playwright() as pw:
        br = pw.chromium.launch(channel="chrome", headless=True, args=flags)
        page = br.new_page(viewport={"width": 1280, "height": 720})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_function("window.__booted === true", timeout=300000)
        page.wait_for_function("window.__ready === true", timeout=300000)

        # ---- 1. the sequence ------------------------------------------------
        page.evaluate("window.__taa.enabled = true; window.__taaMode(2)")
        for n in (8, 16, 32):
            page.evaluate(f"window.__taa.samples = {n}")
            st = page.evaluate("window.__jitterState()")
            seq = st["sequencePixels"]
            mx = sum(q[0] for q in seq) / len(seq)
            my = sum(q[1] for q in seq) / len(seq)
            amp = max(max(abs(q[0]), abs(q[1])) for q in seq)
            first = (seq[0][0] ** 2 + seq[0][1] ** 2) ** 0.5
            worst = max((q[0] ** 2 + q[1] ** 2) ** 0.5 for q in seq)
            check(f"{n}-sample sequence is zero-mean",
                  abs(mx) < 1e-6 and abs(my) < 1e-6,
                  f"mean ({mx:+.2e}, {my:+.2e}) px, amplitude {amp:.3f} px")
            check(f"{n}-sample sequence starts near the pixel centre",
                  first <= worst * 0.6,
                  f"|sample 0| {first:.3f} px vs worst {worst:.3f} px")
        page.evaluate("window.__taa.samples = 8")

        # determinism: the same length must give byte-identical offsets
        s1 = page.evaluate("window.__jitterState()")["sequencePixels"]
        page.evaluate("window.__taa.samples = 16")
        page.evaluate("window.__taa.samples = 8")
        s2 = page.evaluate("window.__jitterState()")["sequencePixels"]
        check("sequence is deterministic", s1 == s2,
              f"{len(s1)} offsets, identical on re-read")

        # ---- 2. resolution independence -------------------------------------
        # Compare the LIVE offset against the sequence entry it came from, at
        # each size.  Comparing the raw current offsets across resolutions is
        # meaningless -- the sequence index advances between the readings, so
        # that measures three different samples and calls the difference a bug.
        errs_px = {}
        for px in (1920, 2560, 3840):
            page.evaluate(f"window.__setOutput({px})")
            page.wait_for_timeout(800)
            page.evaluate("window.__pauseRender(); window.__advance(2);"
                          "window.__resumeRender();")
            st = page.evaluate("window.__jitterState()")
            want = st["sequencePixels"][st["index"]]
            got = st["currentPixels"]
            errs_px[st["renderSize"][0]] = max(abs(got[0] - want[0]),
                                               abs(got[1] - want[1]))
        page.evaluate("window.__setRenderScale(1)")
        page.wait_for_timeout(700)
        check("jitter amplitude is resolution independent",
              max(errs_px.values()) < 0.002,
              ", ".join(f"{w}px wide: {v:.4f} px error"
                        for w, v in sorted(errs_px.items())))

        # ---- 3. (the per-point reprojection check lived here) ---------------
        # Removed deliberately, and not because it failed.
        #
        # It asserted that the history lookup for a fixed world point does not
        # move between frames.  That quantity legitimately moves: the shader is
        # evaluated at PIXEL CENTRES, and the surface point sampled at a pixel
        # is not at a pixel centre in either frame, so the fetch sits half a
        # jitter offset away under any convention.  Its own control said so --
        # 0.81 px for the convention that converges and 0.63 px for the one that
        # does not, which is no discriminating power at all.
        #
        # The property it was reaching for -- is the compensation applied the
        # right number of times -- is measured in section 6 instead, by sweeping
        # the constant on a frozen scene where the correct answer is known:
        # a static accumulation must stay static.  That instrument separates the
        # two conventions by 17x rather than by nothing.
        page.evaluate("""window.__taaProbe = () => {
            const t = window.__taa, cam = window.__app.camera.camera;
            t._suspendJitter = true;
            const proj = cam.getProjectionMatrix(true).clone();
            t._suspendJitter = false;
            t._curVPProbe = cam.getViewMatrix().multiply(proj);
            t._prevVPProbe = t._prevVPBound || t._curVPProbe;
            return true;
        }""")

        # ---- 4. motion vectors are not contaminated -------------------------
        def pan_rate():
            page.evaluate("""window.__spin = () => {
                window.__app.camera.camera.rotation.y += 0.02;
                window.__spinId = requestAnimationFrame(window.__spin); };
                window.__spin();""")
            page.wait_for_timeout(700)
            v = page.evaluate(STAT)
            page.evaluate("cancelAnimationFrame(window.__spinId)")
            page.wait_for_timeout(400)
            return v

        page.evaluate("window.__taaMode(1)")
        page.wait_for_timeout(400)
        off = pan_rate()
        page.evaluate("window.__taaMode(2)")
        page.wait_for_timeout(400)
        on = pan_rate()
        check("jitter does not inflate the measured pan rate",
              abs(on["max"] - off["max"]) < 0.004
              and 0.012 < on["max"] < 0.040,
              f"reproject {off['max']:.4f} -> jittered {on['max']:.4f} uv/frame, "
              f"predicted ~0.022")

        # ---- 5. sky coverage -------------------------------------------------
        page.evaluate("window.__setView(0,6,0,14,30)")
        page.wait_for_function("window.__ready === true", timeout=180000)
        page.wait_for_timeout(600)
        page.evaluate("window.__taa.skyVelocity = false")
        page.wait_for_timeout(400)
        no_sky = page.evaluate(STAT)
        page.evaluate("window.__taa.skyVelocity = true")
        page.wait_for_timeout(400)
        with_sky = page.evaluate(STAT)
        check("the sky writes velocity where nothing else does",
              with_sky["coverFrac"] > no_sky["coverFrac"] + 0.03,
              f"coverage {100 * no_sky['coverFrac']:.1f}% -> "
              f"{100 * with_sky['coverFrac']:.1f}% of the frame")
        # rotation must move the sky; translation must not
        page.evaluate("window.__taa.oceanVelocity = false;"
                      "window.__taa.particleVelocity = false")
        page.wait_for_timeout(400)
        page.evaluate("window.__pauseRender(); window.__advance(4)")
        # EXACTLY one frame after each change.  The previous-frame matrix is
        # replaced every frame, so two frames later it already equals the
        # current one and every velocity reads zero -- which looks like the sky
        # ignoring both translation and rotation rather than like a stale test.
        page.evaluate("window.__app.camera.camera.position.x += 400.0")
        page.evaluate("window.__advance(1)")
        moved = page.evaluate(STAT)
        page.evaluate("window.__advance(1)")
        page.evaluate("window.__app.camera.camera.rotation.y += 0.02")
        page.evaluate("window.__advance(1)")
        turned = page.evaluate(STAT)
        # report the matrices too, so a zero here says WHICH half is wrong
        mats = page.evaluate("""() => {
            const m = window.__taa.skyVelMat;
            if (!m || !m._matrices) return {err: 'no sky velocity material'};
            const c = m._matrices['uCurViewRotProj'], p = m._matrices['uPrevViewRotProj'];
            if (!c || !p) return {err: 'matrices unbound'};
            let d = 0;
            for (let i = 0; i < 16; i++) d = Math.max(d, Math.abs(c.m[i] - p.m[i]));
            return {maxDiff: d};
        }""")
        page.evaluate("window.__resumeRender()")
        page.evaluate("window.__taa.oceanVelocity = true;"
                      "window.__taa.particleVelocity = true")
        check("sky ignores camera translation, follows rotation",
              moved["max"] < 0.002 and turned["max"] > 0.010,
              f"400 m sideways -> {moved['max']:.2e}, "
              f"0.02 rad -> {turned['max']:.4f} uv/frame, "
              f"matrices {mats}")

        # ---- 6. the static convergence gate ---------------------------------
        # THE gate: with the world stopped, the only thing that can move the
        # image is the sampling offset.  Three cases, and the middle one is the
        # control -- without it a converged reading proves nothing, because a
        # scene that never wobbled would score the same.
        page.evaluate("window.__setView(0,3,0,3,30)")
        page.wait_for_function("window.__ready === true", timeout=180000)
        page.evaluate(FREEZE)
        page.wait_for_timeout(900)
        saved = page.evaluate("window.__taa.params()")

        def settle_and_measure():
            page.evaluate("window.__taa.reset()")
            page.wait_for_timeout(250)
            page.evaluate("window.__pauseRender(); window.__advance(96);"
                          "window.__resumeRender();")
            return wobble(page)

        # A: no jitter, no history -- the frozen scene itself
        page.evaluate("window.__taa.enabled = true")
        page.evaluate("window.__taaMode(0)")
        frozen = settle_and_measure()

        # B: jitter on, history forced off -- what the resolve has to remove
        page.evaluate("window.__taaMode(2)")
        page.evaluate("window.__taa.setParams({historyMin: 0, historyMax: 0,"
                      " sharpenAmount: 0})")
        raw_jitter = settle_and_measure()

        # C: jitter on, the real adaptive resolve
        import json as _json
        page.evaluate("window.__taa.setParams(%s)" % _json.dumps(saved))
        converged = settle_and_measure()

        # D: the same, with detail restoration switched off.  This separates
        # the two things that can stop a frozen scene converging -- history
        # being rejected, or the sharpen pass re-injecting the current frame's
        # aliasing after the accumulation removed it.  Under jitter the current
        # frame's high frequency is DIFFERENT every frame, so restoring it is
        # not restoring detail, it is putting the wobble back.
        page.evaluate("window.__taa.setParams({sharpenAmount: 0})")
        no_sharpen = settle_and_measure()
        page.evaluate("window.__taa.setParams(%s)" % _json.dumps(saved))

        # E/F: the two other things that can stop a frozen scene converging --
        # the neighbourhood clamp clipping the accumulation back to the
        # aliased sample, and the history FETCH filter blurring the
        # accumulator every frame because jitter never lands on a texel centre.
        page.evaluate("window.__taa.setParams({varianceGamma: 40.0})")
        no_clamp = settle_and_measure()
        page.evaluate("window.__taa.setParams(%s)" % _json.dumps(saved))
        page.evaluate("window.__taa.setParams({historyFilter: %g})"
                      % (0.0 if saved.get("historyFilter", 0) > 0.5 else 1.0))
        other_filter = settle_and_measure()
        page.evaluate("window.__taa.setParams(%s)" % _json.dumps(saved))

        check("a frozen scene is still when nothing is jittered",
              frozen < 0.06,
              f"frame-to-frame {frozen:.4f}/255 with the world stopped")
        check("jitter alone visibly moves a frozen scene",
              raw_jitter > max(frozen * 4.0, 0.15),
              f"{frozen:.4f} -> {raw_jitter:.4f}/255 with history disabled")
        # The compensation constant, measured where the right answer is known:
        # a static accumulation sampled correctly must stay static.  This is
        # the check that catches applying the jitter correction twice, or with
        # the wrong sign, or at all.
        comp = {}
        # captured BEFORE the sweep: reading it afterwards restores whichever
        # value the loop happened to end on, which left the renderer at k=-0.5
        # for every test that followed
        live = page.evaluate("window.__taa.jitterCompensation")
        for k in (0.0, 0.5, -0.5):
            page.evaluate("window.__taa.setParams(%s)" % _json.dumps(saved))
            page.evaluate("window.__taa.setParams({sharpenAmount: 0})")
            page.evaluate(f"window.__taa.jitterCompensation = {k}")
            comp[k] = settle_and_measure()
        page.evaluate("window.__taa.setParams(%s)" % _json.dumps(saved))
        page.evaluate(f"window.__taa.jitterCompensation = {live}")
        best = min(comp, key=lambda q: comp[q])
        check("the history lookup is compensated the right number of times",
              best == 0.0 and comp[0.0] < comp[0.5] * 0.35,
              ", ".join(f"k={k}: {v:.4f}" for k, v in sorted(comp.items()))
              + f"  (live k={live})")

        check("jittered TAA converges on a frozen scene",
              converged < raw_jitter * 0.35,
              f"{raw_jitter:.4f} -> {converged:.4f}/255 "
              f"({100 * (1 - converged / max(raw_jitter, 1e-9)):.0f}% of the "
              f"wobble removed)")
        def pct(v):
            return 100 * (1 - v / max(raw_jitter, 1e-9))
        print(f"      isolation: restoration off {no_sharpen:.4f} ({pct(no_sharpen):.0f}%), "
              f"clamp off {no_clamp:.4f} ({pct(no_clamp):.0f}%), "
              f"other history filter {other_filter:.4f} ({pct(other_filter):.0f}%)")
        page.evaluate("window.__lockStep(1/60)")

        check("no page errors", not errs, errs[0][:110] if errs else "")
        br.close()

    if fails:
        print("\nFAILED: " + ", ".join(fails))
        sys.exit(1)
    print("\njitter is deterministic, compensated exactly once, and covered")


if __name__ == "__main__":
    main()
