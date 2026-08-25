#!/usr/bin/env python3
"""
detail_stages.py -- where in the pipeline does the sharpness actually go?

    py -3.14 detail_stages.py [--tier high]

The jittered resolve is measurably softer than a supersampled reference, and
there are five places that could be responsible:

    current jittered sample
      -> TAA blend
      -> history write
      -> history REPROJECTION (a resampling filter, applied every frame)
      -> final sharpen

Tuning parameters around the wrong one is how the last several rounds were
spent, so this measures high-frequency energy at every stage instead, using the
resolve's own debug channels -- the same shader, the same frame, so the numbers
are comparable.

It runs the whole ladder twice:

    FROZEN, camera still   -- motion vectors are zero, so the history lookup
                              lands exactly on a texel centre and the
                              reprojection filter does nothing.
    MOVING sea             -- the lookup lands at fractional offsets, so the
                              reprojection filter runs every frame.

If detail survives the frozen pass and dies in the moving one, the blur is
repeated resampling, not temporal averaging -- and the fix belongs in the
fetch, not in the accumulation.
"""
import argparse
import io as _io
import json as _json
import sys

from PIL import Image, ImageChops, ImageFilter, ImageStat
from playwright.sync_api import sync_playwright

from harness import grab_img

CROP = (0, 100, 1280, 700)

# One definition, in the app: window.__freezeWorld().  Every harness used
# to carry its own copy and they drifted -- none of them stopped the legacy
# spray systems, which advance per RENDERED frame regardless of dt and put
# ~9.9 RMS into the no-history floor.
FREEZE = """() => window.__freezeWorld()"""

# ch, label, needs-sharpen-on
STAGES = [
    (1, "current jittered sample", False),
    (2, "stored history (at vUV)", False),
    (4, "reprojected history (at hUV)", False),
    (0, "resolve output", False),
    (0, "final, after sharpen", True),
]


# GPU readback, not page.screenshot(): the compositor lags hand-stepped
# frames and produced a fictitious 128-frame "settling".  See harness.py.
def shot(page):
    return grab_img(page, CROP)



def hf(img):
    return ImageStat.Stat(ImageChops.difference(
        img, img.filter(ImageFilter.GaussianBlur(1.2)))).mean[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="high")
    a = ap.parse_args()

    flags = ["--ignore-gpu-blocklist", "--use-angle=default",
             "--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"]
    url = f"http://127.0.0.1:5390/index.html?tier={a.tier}"

    with sync_playwright() as pw:
        br = pw.chromium.launch(channel="chrome", headless=True, args=flags)
        page = br.new_page(viewport={"width": 1280, "height": 720})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_function("window.__booted === true", timeout=300000)
        page.wait_for_function("window.__ready === true", timeout=300000)
        page.evaluate("window.__taa.enabled = true")
        page.evaluate("window.__setSea('rough')")
        page.evaluate("window.__settleSea(60)")
        page.wait_for_function("window.__ready === true", timeout=180000)
        page.evaluate("window.__setView(0,1.7,0,2,30)")
        page.wait_for_function("window.__ready === true", timeout=180000)
        page.wait_for_timeout(800)

        def ladder(mode, label):
            page.evaluate(f"window.__taaMode({mode})")
            saved = page.evaluate("window.__taa.params()")
            print(f"\n  {label}")
            base = None
            for ch, name, sharp in STAGES:
                page.evaluate("window.__taa.setParams(%s)"
                              % _json.dumps(saved if sharp
                                            else dict(saved, sharpenAmount=0)))
                # Converge with the debug channel OFF, then switch it on for a
                # couple of frames and look.  A channel replaces the resolve's
                # output, so leaving it on while accumulating measures the
                # visualisation feeding back into itself.
                page.evaluate("window.__taa.debug = 0")
                page.evaluate("window.__taa.reset()")
                page.wait_for_timeout(200)
                page.evaluate("window.__pauseRender(); window.__advance(120);"
                              "window.__resumeRender();")
                page.evaluate(f"window.__taa.debug = {ch}")
                page.wait_for_timeout(120)
                page.evaluate("window.__pauseRender(); window.__advance(2);"
                              "window.__resumeRender();")
                page.wait_for_timeout(120)
                e = hf(shot(page))
                if base is None:
                    base = e
                print(f"    {name:32s} HF {e:6.3f}   "
                      f"{100 * e / max(base, 1e-9):5.1f}% of the input sample")
            # how far the history lookup sits from a texel centre
            page.evaluate("window.__taa.debug = 18")
            page.wait_for_timeout(200)
            page.evaluate("window.__pauseRender(); window.__advance(2);"
                          "window.__resumeRender();")
            off = ImageStat.Stat(shot(page)).mean[0] / 255.0 * 0.5
            print(f"    {'history offset from texel centre':32s} "
                  f"{off:.3f} texels (0 = aligned, 0.5 = worst)")
            page.evaluate("window.__taa.debug = 0")
            page.evaluate("window.__taa.setParams(%s)" % _json.dumps(saved))

        print("FROZEN scene, camera still -- the lookup is texel-aligned")
        page.evaluate(FREEZE)
        page.wait_for_timeout(900)
        ladder(2, "jittered")
        ladder(1, "reprojection only")

        print("\nMOVING sea -- the lookup lands at fractional offsets")
        page.evaluate("window.__lockStep(1/60)")
        page.wait_for_timeout(1200)
        ladder(2, "jittered")
        ladder(1, "reprojection only")

        if errs:
            print("\nPAGE ERRORS:", errs[0][:140])
        br.close()
    print("\nRead the two passes against each other: a stage that only loses "
          "energy in the MOVING pass is a resampling problem, not a temporal one.")


if __name__ == "__main__":
    main()
