#!/usr/bin/env python3
"""
capture_test.py -- the capture path must return the frame, proved against a
KNOWN ANSWER.

    py -3.14 capture_test.py [--tier high]

This file exists because of the most expensive mistake in this project.

Two GPU readback paths were built and trusted -- engine.readPixels() on the
default framebuffer, and a trailing PassPostProcess tap copied with
CopyTextureToTexture.  Both returned a sparse high-frequency intermediate
instead of the colour frame: black almost everywhere, thin bright filaments
along the wave crests and the horizon.  It was empty when the temporal filter
was off, so every "TAA off" control measured a perfect 0.0000 RMS and read as a
bit-exact renderer; and it filled in as history accumulated, so a camera stop
appeared to "settle" over ~128 frames on ~2% of pixels along mid-distance wave
crests.  That phantom was pursued through an ocean-simulation freeze hook, a
self-validating subsystem bisection and a render-stage walk before anyone saved
the two candidate frames and looked at them.

So the gate here is NOT "the readers agree".  Two readers agreeing on the wrong
buffer is exactly what happened.  The gate is that the capture tracks changes
whose answers are known in advance:

  1. a frame the renderer is told to make darker must read darker, and brighter
     brighter, by roughly the amount asked for;
  2. the capture must contain the SCENE -- an ocean frame is highly structured,
     so a capture whose mean and stddev collapse is reading something else;
  3. the capture must reflect a hand-stepped change immediately rather than one
     capture later, because latency is the compositor's real failure mode;
  4. no quantitative harness may bypass harness.grab, which owns settling and
     frame identity.
"""
import argparse
import io as _io
import os
import re
import sys

from PIL import ImageChops, ImageStat
from playwright.sync_api import sync_playwright

from harness import grab, grab_img

CROP = (0, 100, 1280, 700)
VIEW = (0, 2.0, 0, 3, 30)

#: harnesses whose numbers are acceptance criteria
QUANTITATIVE = ["taa_test.py", "selftest.py", "fidelity_test.py", "ghost_test.py",
                "detail_stages.py", "frozen_world_test.py", "jitter_test.py",
                "settle_test.py", "sweep.py", "supersample_test.py",
                "stage_test.py", "sim_freeze_test.py", "stage_frames.py"]


def rms(a, b):
    return ImageStat.Stat(ImageChops.difference(a, b)).rms[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="high")
    a = ap.parse_args()

    fails = []

    def check(name, ok, why=""):
        print("%s  %-48s %s" % ("PASS" if ok else "FAIL", name, why))
        if not ok:
            fails.append(name)

    # ---- static audit: everyone goes through harness.grab -------------------
    here = os.path.dirname(os.path.abspath(__file__))
    offenders = []
    for f in QUANTITATIVE:
        p = os.path.join(here, f)
        if not os.path.exists(p):
            continue
        src = _io.open(p, encoding="utf-8").read()
        for m in re.finditer(r"^(?!\s*#).*page\.screenshot\(\)", src, re.M):
            offenders.append("%s:%d" % (f, src[:m.start()].count("\n") + 1))
        if "__grabFrame" in src:
            offenders.append("%s: uses the removed __grabFrame" % f)
    check("every quantitative harness captures via harness.grab",
          not offenders, ", ".join(offenders) if offenders
          else "%d harnesses" % len(QUANTITATIVE))

    flags = ["--ignore-gpu-blocklist", "--use-angle=default",
             "--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"]
    url = "http://127.0.0.1:5390/index.html?tier=%s" % a.tier

    with sync_playwright() as pw:
        br = pw.chromium.launch(channel="chrome", headless=True, args=flags)
        page = br.new_page(viewport={"width": 1280, "height": 720})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_function("window.__booted === true", timeout=300000)
        page.wait_for_function("window.__ready === true", timeout=300000)
        page.evaluate("window.__setSea('rough')")
        page.evaluate("window.__settleSea(60)")
        page.wait_for_function("window.__ready === true", timeout=180000)
        page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % VIEW)
        page.wait_for_function("window.__ready === true", timeout=180000)
        page.wait_for_timeout(900)

        # ---- 1. known answer: night is darker than noon ---------------------
        # Not a comparison against another reader.  The sun is put below the
        # horizon and then overhead, and the capture has to say which is which.
        # (Exposure was tried first and is too soft a control here: ACES plus a
        # bright sky compresses a 6x exposure change into nine grey levels, and
        # a weak monotonic response is exactly what a wrong buffer can also
        # produce.  A known answer has to be unmistakable.)
        means = {}
        print()
        for tag, t in (("midnight", 0.0), ("noon", 12.0), ("evening", 18.5)):
            page.evaluate("window.__setTime(%s)" % t)
            page.wait_for_function("window.__ready === true", timeout=180000)
            page.wait_for_timeout(700)
            means[tag] = ImageStat.Stat(grab_img(page, CROP)).mean[0]
            print("    time %-9s -> mean %7.3f" % (t, means[tag]))
        # 2.0x, set from the measurement rather than guessed: noon reads ~2.9x
        # midnight here, and the point of the gate is to catch a reader that is
        # not looking at the frame at all (the discarded one read a FLAT 0.000
        # in three configurations out of four).  It is not a rendering-quality
        # threshold and must never be treated as one.
        check("capture tracks a known lighting change",
              means["noon"] > means["midnight"] * 2.0,
              "noon %.1f vs midnight %.1f (%.1fx)"
              % (means["noon"], means["midnight"],
                 means["noon"] / max(means["midnight"], 1e-6)))
        page.evaluate("window.__setTime(15.0)")
        page.wait_for_function("window.__ready === true", timeout=180000)
        page.wait_for_timeout(600)

        # ---- 2. the capture contains the scene ------------------------------
        st = ImageStat.Stat(grab_img(page, CROP))
        check("capture contains a rendered scene, not a sparse buffer",
              st.mean[0] > 20 and st.stddev[0] > 10,
              "mean %.1f, stddev %.1f" % (st.mean[0], st.stddev[0]))

        # ---- 3. no latency under hand-stepping ------------------------------
        page.evaluate("window.__pauseRender(); window.__advance(30)")
        before = grab_img(page, CROP)
        page.evaluate("(() => { const c = window.__app.camera.camera;"
                      " c.rotation.y += 0.9; window.__advance(3); })()")
        after = grab_img(page, CROP)
        again = grab_img(page, CROP)
        moved = rms(after, before)
        late = rms(again, after)
        page.evaluate("window.__resumeRender()")
        print("\n    after a 0.9 rad turn: changed %.2f RMS, then a further "
              "%.2f on the next read" % (moved, late))
        check("capture is current, not one frame behind",
              moved > 5.0 and late < moved * 0.05,
              "%.2f RMS on the turn, %.2f residual" % (moved, late))

        # ---- 4. identity ----------------------------------------------------
        # Paused: with the loop running the counter advances between the
        # capture and the assertion, and the check fails by exactly one for a
        # reason that has nothing to do with the capture.
        page.evaluate("window.__pauseRender(); window.__advance(2)")
        _, meta = grab(page)
        live = page.evaluate("window.__app.frames")
        page.evaluate("window.__resumeRender()")
        check("capture reports the frame it captured",
              meta["renderedFrameId"] == live,
              "grab says %s, app says %s" % (meta["renderedFrameId"], live))

        check("no page errors", not errs, errs[0][:110] if errs else "")
        br.close()

    if fails:
        print("\nFAILED: " + ", ".join(fails))
        sys.exit(1)
    print("\nAUTHORITATIVE_SOURCE = PAGE_SCREENSHOT (calibrated)")


if __name__ == "__main__":
    main()
