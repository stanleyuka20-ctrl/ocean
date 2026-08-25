#!/usr/bin/env python3
"""
selftest.py -- is the temporal harness an instrument, or is it noise?

    py -3.14 selftest.py [--tier high] [--reps 4] [--webgl]

taa_test.py compares one configuration against another by measuring the
frame-to-frame difference of the rendered image.  That comparison is only worth
anything if the SAME configuration measures the same twice.  It did not, for a
long time, and the failures were not subtle:

  * without anchoring sim.time, one build scored +56% and -362% on consecutive
    runs;
  * with sim.time anchored but the foam field free to keep filling, the
    measured difference stepped 4x partway through an A/B and the halves read
    as -288% and +7% -- and that step was briefly, and wrongly, attributed to
    underwater motes;
  * with both anchored but the camera-local particle populations free, storm
    spray scored +39% and -72% on consecutive runs of near-identical code.

So this file measures the instrument, not the renderer.  It repeats the exact
measurement taa_test.py makes, several times, at each station, and reports the
spread.  A spread wider than the effects being chased means no number from
taa_test.py may be quoted -- fix the harness first.

Nothing here asserts that TAA is good.  It asserts only that the scale is
repeatable.
"""
import argparse
import io as _io
import sys
from statistics import median

from stations import STATIONS

from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import sync_playwright

from harness import grab_img

# The tightest spread that is honest to ask for.  Particle populations are
# stochastic by construction, so this can never be zero; it has to be well
# inside the size of the effect being measured.
TOLERANCE = 0.15


# GPU readback, not page.screenshot(): the compositor lags hand-stepped
# frames and produced a fictitious 128-frame "settling".  See harness.py.
def shot(page):
    return grab_img(page)



def shimmer(page, frames=6, step=1):
    """Frame-to-frame difference, measured deterministically.

    The render loop is stopped and frames are issued one at a time at a fixed
    simulated timestep, so both configurations see exactly the same motion per
    frame.  Timed with wall-clock waits instead, this measures how many frames
    went by as much as how unstable they were -- and a temporal filter, which
    costs GPU time, then improves its own score by slowing the frame rate.
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


def spread(vals):
    lo, hi = min(vals), max(vals)
    # Both ends at zero is a renderer that produced identical frames, not an
    # infinite spread -- report it as perfect rather than as a failure.
    if hi <= 1e-9:
        return 0.0
    return (hi / lo - 1.0) if lo > 1e-9 else float("inf")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="high")
    ap.add_argument("--reps", type=int, default=3,
                    help="how many MEDIANS to compare")
    ap.add_argument("--group", type=int, default=0,
                    help="readings per median; must match taa_test --reps")
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
        print(f"{'PASS' if ok else 'FAIL'}  {name:44s} {why}")
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
        # 60 Hz of simulated time per rendered frame, independent of how fast
        # the machine actually renders
        page.evaluate("window.__lockStep(1/60)")
        # a lightning stroke rewrites the whole frame; see Sky.lightningEnabled
        page.evaluate("window.__setLightning(false)")

        def rewind():
            # sim.time is the wave PHASE; foam is a separate ACCUMULATOR that
            # keeps filling independently of it.  Both have to be put back or
            # successive measurements are of different scenes.
            page.evaluate("window.__ocean.sim.time = 137.0")
            page.evaluate("window.__resetFoam(90)")
            page.wait_for_timeout(250)

        def taa(on):
            page.evaluate("window.__taa.enabled = %s; window.__taa.reset();"
                          % ("true" if on else "false"))
            page.wait_for_timeout(400)
            # An accumulation buffer needs frames, not milliseconds, to reach
            # its steady state -- reset() throws the history away.  Measured
            # from four frames in, a single repetition read 22.05 against a
            # 0.36 steady value, purely because it caught the convergence.
            page.evaluate("window.__pauseRender(); window.__advance(48);"
                          "window.__resumeRender();")

        for label, preset, st, reps in STATIONS:
            page.evaluate("window.__setPreset('%s')" % preset)
            page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % st)
            page.wait_for_function("window.__ready === true", timeout=180000)
            page.evaluate("window.__app.sky.autoExposure = false")
            info = page.evaluate("window.__settleScene(90)")
            page.wait_for_function("window.__ready === true", timeout=180000)
            check("%s: scene settled" % label, info["converged"],
                  "Hs %.2f m, foam %.4f, %d particles (drift %s vs scatter %s), "
                  "%s rounds, %.0f s"
                  % (info["sea"]["hs"], info["sea"]["foam"], info["particles"],
                     info.get("drift"), info.get("scatter"),
                     info.get("rounds"), info["seconds"]))

            # one discarded repetition: the first measurement at a station also
            # pays for whatever has not finished converging there
            rewind(); taa(False); shimmer(page)
            rewind(); taa(True); shimmer(page)

            # Reproduce the STATISTIC taa_test.py reports, which is the MEDIAN
            # of --reps readings, not a single reading.  Checking single-shot
            # spread asks a question the acceptance test never asks, and at the
            # storm station it is the wrong question: the spray population is
            # genuinely stochastic (measured drift 205 against scatter 283, so
            # ~17% scatter at a settled steady state) and single readings spread
            # ~20% no matter how long the scene settles.  A median of three is
            # what decides a pass, so a median of three is what has to repeat.
            offs, ons, raw_o, raw_n = [], [], [], []
            for _ in range(a.reps):
                go, gn = [], []
                for _ in range(a.group or reps):
                    rewind(); taa(False); go.append(shimmer(page))
                    rewind(); taa(True); gn.append(shimmer(page))
                raw_o += go; raw_n += gn
                offs.append(median(go)); ons.append(median(gn))
            so, sn = spread(offs), spread(ons)
            check("%s: TAA-off baseline repeats" % label, so <= TOLERANCE,
                  "medians %s  spread %.0f%%  (singles spread %.0f%%)"
                  % (" ".join("%.2f" % v for v in offs), 100 * so,
                     100 * spread(raw_o)))
            check("%s: TAA-on measurement repeats" % label, sn <= TOLERANCE,
                  "medians %s  spread %.0f%%  (singles spread %.0f%%)"
                  % (" ".join("%.2f" % v for v in ons), 100 * sn,
                     100 * spread(raw_n)))
            # what taa_test.py would have reported, per repetition
            deltas = [100 * (1 - n / o) if o > 1e-9 else float('nan')
                      for o, n in zip(offs, ons)]
            print("      would report: "
                  + ", ".join("%+.0f%%" % d for d in deltas))

        # ---- debug views must be observational only -------------------------
        # A diagnostic that becomes part of the algorithm it measures produced a
        # confident false diagnosis once (a 92% history detail loss that never
        # happened).  This asserts the production image is bit-comparable with a
        # channel enabled and then disabled again -- i.e. that displaying one
        # left no trace in the temporal history.
        page.evaluate("window.__setPreset('clearAtlantic')")
        page.evaluate("window.__setView(0,1.7,0,2,30)")
        page.wait_for_function("window.__ready === true", timeout=180000)
        page.evaluate("window.__settleScene(60)")
        page.wait_for_function("window.__ready === true", timeout=180000)
        rewind(); taa(True)
        # The SIMULATION has to stop too.  Advancing frames at 1/60 s each moves
        # the sea, and the resulting difference is scene motion, not debug
        # contamination -- it read as 14.8/255 of "drift" with the guard working
        # perfectly.  Frozen, the only thing that can change the image is
        # whether displaying a channel left a trace.
        page.evaluate("window.__lockStep(-1)")
        page.evaluate("window.__pauseRender(); window.__advance(64)")
        before = shot(page)
        page.evaluate("window.__taa.debug = 7")
        page.evaluate("window.__advance(12)")
        held = page.evaluate("window.__taa._historyHeld === true")
        page.evaluate("window.__taa.debug = 0")
        page.evaluate("window.__advance(1)")
        after = shot(page)
        page.evaluate("window.__resumeRender()")
        page.evaluate("window.__lockStep(1/60)")
        drift = ImageStat.Stat(ImageChops.difference(after, before)).mean[0]
        check("debug views do not contaminate temporal history",
              held and drift < 1.0,
              f"history write held: {held}; production image drifted "
              f"{drift:.3f}/255 across 12 frames of debug display")

        check("no page errors", not errs, errs[0][:110] if errs else "")
        br.close()

    if fails:
        print("\nFAILED: " + ", ".join(fails))
        print("Do not quote a number from taa_test.py until this passes.")
        sys.exit(1)
    print("\nthe harness repeats itself; taa_test.py numbers are meaningful")


if __name__ == "__main__":
    main()
