#!/usr/bin/env python3
"""
taa_test.py -- motion vectors and temporal stability.

    py -3.14 taa_test.py [--tier high] [--webgl]

Two things have to be true and they pull against each other: the image must
stop shimmering, and it must not go soft or leave trails. So every check here
is comparative -- TAA on against TAA off, at the same camera, on the same sea --
rather than a threshold picked to pass.

Cases: stationary camera, panning camera, water level, aerial, storm spray and
underwater, per the brief.
"""
import argparse
import io as _io
import sys
from statistics import median

from stations import STATIONS

from PIL import Image, ImageChops, ImageFilter, ImageStat
from playwright.sync_api import sync_playwright

from harness import grab_img

STAT = """(async () => {
    const t = window.__taa.velocity, a = await t.readPixels();
    let n = 0, sx = 0, sy = 0, mx = 0, react = 0;
    for (let i = 0; i < a.length; i += 4) {
      const vx = a[i], vy = a[i + 1];
      if (!isFinite(vx) || !isFinite(vy)) continue;
      sx += Math.abs(vx); sy += Math.abs(vy);
      mx = Math.max(mx, Math.hypot(vx, vy));
      react = Math.max(react, a[i + 2]); n++;
    }
    return { meanAbsX: sx / n, meanAbsY: sy / n, max: mx, maxReactive: react };
})()"""

# Stepped, not timed.  Driving the pan from requestAnimationFrame ties the
# degrees turned per RENDERED frame to how the two loops happen to interleave,
# and the same 0.02 rad/frame pan then measured 0.0249 on one run and 0.0369 on
# the next against a prediction of 0.022.  Here one rotation is one frame, by
# construction.
# Reports how many frames the renderer ACTUALLY drew, so a doubled pan rate can
# be told apart from a doubled rotation: if drawn == n the vector is wrong, if
# drawn < n the harness turned the camera without rendering.
PAN = """window.__panStep = (n, rate) => {
    const c = window.__app.camera.camera;
    const before = window.__app.frames;
    for (let i = 0; i < n; i++) { c.rotation.y += rate; window.__advance(1); }
    return { requested: n, drawn: window.__app.frames - before };
};"""


# GPU readback, not page.screenshot(): the compositor lags hand-stepped
# frames and produced a fictitious 128-frame "settling".  See harness.py.
def shot(page):
    return grab_img(page)



def shimmer(page, frames=6, step=1):
    """Mean absolute difference between consecutive frames -- the thing TAA
    exists to reduce, measured on a scene that is genuinely moving.

    Deterministic: the render loop is stopped and frames are issued one at a
    time, at the fixed simulated timestep set by __lockStep.  Timed with
    wall-clock waits instead, this measures how many frames elapsed as much as
    how unstable they were, and a temporal filter improves its own score simply
    by costing GPU time.  selftest.py is the guard on that -- it repeats this
    exact measurement and fails if the spread is wide.
    """
    page.evaluate("window.__pauseRender()")
    try:
        page.evaluate("window.__advance(%d)" % (4 * step))
        prev = shot(page)
        acc = 0.0
        for _ in range(frames):
            page.evaluate("window.__advance(%d)" % step)
            cur = shot(page)
            acc += ImageStat.Stat(ImageChops.difference(cur, prev)).mean[0]
            prev = cur
        return acc / frames
    finally:
        page.evaluate("window.__resumeRender()")


def detail(img):
    """High-frequency energy: falls if the resolve is just blurring."""
    hi = img.filter(ImageFilter.GaussianBlur(1.2))
    return ImageStat.Stat(ImageChops.difference(img, hi)).mean[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="high")
    ap.add_argument("--mode", default="reproject",
                    choices=["none", "reproject", "jittered"],
                    help="which temporal mode to measure; reproject is the "
                         "frozen control this phase must not disturb")
    ap.add_argument("--reps", type=int, default=0,
                    help="repetitions per station; the MEDIAN is what is judged")
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
        print(f"{'PASS' if ok else 'FAIL'}  {name:42s} {why}")
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
        # fixed simulated timestep, and no lightning: a stroke rewrites the
        # exposure of the whole frame and reads as a 40x outlier
        page.evaluate("window.__lockStep(1/60)")
        page.evaluate("window.__setLightning(false)")
        page.evaluate("window.__taaMode(%d)"
                      % {"none": 0, "reproject": 1, "jittered": 2}[a.mode])
        print(f"mode: {a.mode}")
        page.evaluate("window.__setSea('rough')")
        page.evaluate("window.__settleSea(60)")

        def station(x, y, z, pit, yaw, settle=True):
            page.evaluate(f"window.__setView({x},{y},{z},{pit},{yaw})")
            page.wait_for_function("window.__ready === true", timeout=180000)
            page.evaluate("window.__app.sky.autoExposure = false")
            if settle:
                # camera-local particle fields start empty at a new viewpoint
                st = page.evaluate("window.__settleScene(90)")
                page.wait_for_function("window.__ready === true", timeout=180000)
                return st
            page.wait_for_timeout(700)
            return None

        def rewind():
            """Put the wave field back to a fixed phase.

            Without this the harness is not an instrument.  The sea evolves
            between measurements, so TAA-off baselines wandered by 3x between
            runs of identical code (storm 24.7 vs 8.2) and the same build
            measured +56% and -362% on consecutive runs.  Anchoring sim.time
            makes every comparison read the same ocean.

            It is NOT sufficient on its own: sim.time is a phase, and the foam
            field is an accumulator that keeps filling for about a minute of
            rough seas independently of it.  __settleSea gates on both, and
            must have been called before any measurement here -- without it the
            measured difference stepped 4x partway through an A/B and the two
            halves read as -288% and +7% for identical code.
            """
            # Two pieces of state, not one.  sim.time is the wave PHASE; the
            # foam field is an ACCUMULATOR that keeps filling independently of
            # it, and left alone it drifted the storm baseline 282% across a
            # single run.  Cleared and re-filled for a fixed number of frames,
            # the whole visible scene becomes a function of the frame count.
            page.evaluate("window.__ocean.sim.time = 137.0")
            page.evaluate("window.__resetFoam(90)")
            page.wait_for_timeout(250)

        def taa(on):
            page.evaluate(f"window.__taa.enabled = {'true' if on else 'false'};"
                          "window.__taa.reset();")
            page.wait_for_timeout(400)
            # an accumulation buffer converges in FRAMES, not milliseconds
            page.evaluate("window.__pauseRender(); window.__advance(48);"
                          "window.__resumeRender();")

        # ---- motion vectors -------------------------------------------------
        # The water only.  Particles are in this target too now and they move
        # far faster than the sea does, so a whole-buffer maximum would be
        # measuring spray while claiming to measure waves.  particle_test.py
        # covers the particles, on the same buffer with the ocean excluded.
        station(0, 3, 0, 4, 30)
        page.evaluate("window.__taa.particleVelocity = false")
        page.evaluate(PAN)
        page.wait_for_timeout(400)
        rough_still = page.evaluate(STAT)

        # the same still camera on a calm sea: the water's own motion is a sea
        # state, so the only threshold-free way to show the buffer is not just
        # camera motion is to order the three cases
        page.evaluate("window.__setSea('calm')")
        page.evaluate("window.__settleSea(90)")
        page.wait_for_function("window.__ready === true", timeout=180000)
        page.wait_for_timeout(600)
        calm_still = page.evaluate(STAT)
        page.evaluate("window.__setSea('rough')")
        page.evaluate("window.__settleSea(90)")
        page.wait_for_function("window.__ready === true", timeout=180000)

        page.evaluate("window.__pauseRender()")
        panInfo = page.evaluate("window.__panStep(8, 0.02)")
        moving = page.evaluate(STAT)
        page.evaluate("window.__resumeRender()")
        page.evaluate("window.__taa.particleVelocity = true")
        page.wait_for_timeout(400)
        still = rough_still

        # Relational, not absolute.  These were once fixed numbers, calibrated
        # on a sea that had never been allowed to finish developing: with the
        # spin-up gated on convergence the same code reads Hs 3.9 m instead of
        # 1.9 m, the water genuinely moves faster, and a threshold that encoded
        # the old sea state failed on a correct renderer.  What the checks
        # actually mean is that the water's own motion is small COMPARED TO a
        # camera pan, and that the vectors respond to one.
        check("water velocity follows the sea state, not the camera",
              calm_still["max"] < rough_still["max"] * 0.6
              and rough_still["max"] < moving["max"] * 0.75,
              f"still calm {calm_still['max']:.2e} < still rough "
              f"{rough_still['max']:.2e} < panning {moving['max']:.2e} uv/frame")
        check("water velocity tracks camera motion",
              moving["meanAbsX"] > still["meanAbsX"] * 8,
              f"mean |vx| {still['meanAbsX']:.2e} -> {moving['meanAbsX']:.2e}")
        # 0.02 rad/frame over a ~0.9 rad fov is ~0.022 uv.  This is the check
        # that the vectors are quantitatively right, not merely non-zero.
        check("the pan drew one frame per rotation",
              panInfo["drawn"] == panInfo["requested"],
              f"{panInfo['drawn']} frames drawn for {panInfo['requested']} rotations")
        check("water velocity matches the pan rate",
              0.014 < moving["max"] < 0.034,
              f"max {moving['max']:.4f} uv/frame, predicted ~0.022")
        check("reactive mask marks foam",
              still["maxReactive"] > 0.2, f"max reactive {still['maxReactive']:.2f}")

        # ---- stability against sharpness, at several cameras ----------------
        # The preset is set EXPLICITLY at every station.  It used to be None
        # for the quiet ones, meaning "leave whatever the last station set" --
        # and since storm spray runs immediately before underwater, the
        # underwater station was being measured in STORM weather while
        # selftest.py measured it in clearAtlantic.  Two instruments, two
        # different oceans, one shared station name.
        for label, preset, st, reps in STATIONS:
            page.evaluate(f"window.__setPreset('{preset}')")
            page.evaluate("window.__settleScene(90)")
            station(*st)
            # one discarded repetition: the first measurement at a station also
            # pays for whatever has not finished converging there
            rewind(); taa(False); shimmer(page)
            rewind(); taa(True); shimmer(page)

            # Repeated, and judged on the MEDIAN.  A single reading is inside
            # the run-to-run spread: the storm baseline moved 2x between two
            # runs of identical code, which is enough to swing a station either
            # side of an 8% gate.  selftest.py measures the spread within a run;
            # this is what stops a single sample from deciding a pass.
            offs, ons, offd, ond = [], [], [], []
            for _ in range(a.reps or reps):
                rewind(); taa(False)
                offs.append(shimmer(page)); offd.append(detail(shot(page)))
                rewind(); taa(True)
                ons.append(shimmer(page)); ond.append(detail(shot(page)))
            off_shim, on_shim = median(offs), median(ons)
            off_det, on_det = median(offd), median(ond)
            check(f"{label}: shimmer reduced",
                  on_shim < off_shim * 0.92,
                  f"frame-to-frame {off_shim:.3f} -> {on_shim:.3f} "
                  f"({100 * (1 - on_shim / max(off_shim, 1e-6)):.0f}% less)")
            check(f"{label}: stays sharp",
                  on_det > off_det * 0.82,
                  f"detail {off_det:.3f} -> {on_det:.3f} "
                  f"({100 * on_det / max(off_det, 1e-6):.0f}% kept)")

        # ---- ghosting: once a fast pan stops, history must not linger --------
        #
        # Measured with the SIMULATION FROZEN.  The comparison is between the
        # resolved frame and the same frame with no history, and if the sea is
        # allowed to run between the two captures the difference is mostly waves
        # moving: ~2.4 per frame at water level against a limit of 6.0.  Frozen,
        # the only thing that can differ is history that outlived its subject,
        # which is what a trail is.
        page.evaluate("window.__setPreset('clearAtlantic')")
        page.evaluate("window.__settleSea(90)")
        station(0, 2.0, 0, 3, 30)
        taa(True)
        # Stepped, like every other measurement here: a pan timed in
        # milliseconds turns the same number of degrees into a different number
        # of frames on every run, and the history it leaves behind then depends
        # on the frame rate rather than on the filter.
        page.evaluate("window.__lockStep(-1)")     # freeze the sea
        page.evaluate("window.__pauseRender()")
        page.evaluate("window.__advance(12)")
        page.evaluate("window.__panStep(40, 0.05)")
        page.evaluate("window.__advance(6)")       # just after the pan stops
        # Truth = the same renderer with HISTORY disabled, not with the
        # whole filter disabled.  Switching `enabled` off also switches the
        # projection jitter off, so the reference was sampled on a different
        # sub-pixel grid than the image under test and the difference
        # measured sampling as well as trailing: every jittered candidate
        # scored ~8.3 including one with no sharpening whatsoever, while the
        # only low reading belonged to whichever candidate ran first.
        settled = shot(page)
        page.evaluate("window.__taa.setParams({historyMin: 0, historyMax: 0});"
                      "window.__taa.reset();")
        page.evaluate("window.__advance(2)")
        truth = shot(page)
        page.evaluate("window.__resumeRender()")
        page.evaluate("window.__lockStep(1/60)")
        ghost = ImageStat.Stat(ImageChops.difference(settled, truth)).mean[0]
        check("no ghost trail after a fast pan", ghost < 6.0,
              f"mean |resolved - untemporal| {ghost:.2f}/255 once settled")

        check("no page errors", not errs, errs[0][:110] if errs else "")
        br.close()

    if fails:
        print("\nFAILED:", ", ".join(fails))
        sys.exit(1)
    print("\nTAA and motion vectors behave")


if __name__ == "__main__":
    main()
