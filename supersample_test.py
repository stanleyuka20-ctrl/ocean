#!/usr/bin/env python3
"""
supersample_test.py -- is jittered TAA actually reconstructing detail?

    py -3.14 supersample_test.py [--tier high]

taa_test.py scores sharpness as high-frequency energy relative to the SAME
scene rendered without temporal filtering.  That is a fair question to ask of a
reprojection-only filter, which samples the same grid every frame and can only
lose detail.  It is not obviously fair to ask of a jittered one: real
antialiasing removes aliasing energy, and this metric counts aliasing energy as
detail.  A jittered resolve can therefore score WORSE while being objectively
closer to the truth.

So this file does not ask about energy.  It renders a ground truth -- the same
frozen scene at 3x linear resolution, box-downsampled, which is a genuine
supersample -- and asks which candidate is CLOSER TO IT:

    no temporal filtering        (one sample per pixel, aliased)
    reprojection only            (the frozen control)
    jittered TAA                 (sub-pixel accumulation)

If jitter is doing useful supersampling, its error against ground truth falls.
If it is only blurring, the error rises even though the image looks smoother.
Everything is frozen, so the three captures see an identical world.
"""
import argparse
import io as _io
import sys

from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import sync_playwright

from harness import grab_img

# One definition, in the app: window.__freezeWorld().  Every harness used
# to carry its own copy and they drifted -- none of them stopped the legacy
# spray systems, which advance per RENDERED frame regardless of dt and put
# ~9.9 RMS into the no-history floor.
FREEZE = """() => window.__freezeWorld()"""

CROP = (0, 100, 1280, 700)


# GPU readback, not page.screenshot(): the compositor lags hand-stepped
# frames and produced a fictitious 128-frame "settling".  See harness.py.
def shot(page):
    return grab_img(page, CROP)



def rms(a, b):
    d = ImageChops.difference(a, b)
    s = ImageStat.Stat(d)
    return (sum(v ** 2 for v in s.rms) / 3.0) ** 0.5


def hf(img):
    from PIL import ImageFilter
    g = img.convert("L")
    return ImageStat.Stat(ImageChops.difference(
        g, g.filter(ImageFilter.GaussianBlur(1.2)))).mean[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="high")
    a = ap.parse_args()

    flags = ["--ignore-gpu-blocklist", "--use-angle=default",
             "--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"]
    url = f"http://127.0.0.1:5390/index.html?tier={a.tier}"

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
        page.evaluate("window.__taa.enabled = true")
        page.evaluate("window.__setSea('rough')")
        page.evaluate("window.__settleSea(60)")
        page.wait_for_function("window.__ready === true", timeout=180000)
        # water level: the station with the finest crest detail
        page.evaluate("window.__setView(0,1.7,0,2,30)")
        page.wait_for_function("window.__ready === true", timeout=180000)
        page.evaluate(FREEZE)
        page.wait_for_timeout(1200)

        def capture(mode):
            page.evaluate(f"window.__taaMode({mode})")
            page.evaluate("window.__taa.reset()")
            page.wait_for_timeout(250)
            page.evaluate("window.__pauseRender(); window.__advance(120);"
                          "window.__resumeRender();")
            page.wait_for_timeout(200)
            return shot(page).crop(CROP)

        none = capture(0)
        reproj = capture(1)
        jitter = capture(2)

        # ---- ground truth: 3x linear, box-downsampled --------------------
        page.evaluate("window.__taaMode(0)")
        page.evaluate("window.__setOutput(3840)")
        page.wait_for_timeout(1500)
        page.evaluate("window.__pauseRender(); window.__advance(60);"
                      "window.__resumeRender();")
        page.wait_for_timeout(300)
        big = shot(page)
        # The screenshot is the CSS viewport, always 1280x720 -- raising the
        # backbuffer supersamples INTO that, it does not produce a larger image.
        # So the render size has to be read from the engine; measuring the
        # screenshot instead reports 1.00x and calls a working ground truth a
        # failure.
        rw = page.evaluate("window.__engine.getRenderWidth()")
        scale = rw / 1280.0
        truth = big.crop(CROP)
        page.evaluate("window.__setRenderScale(1)")
        page.wait_for_timeout(900)
        check("ground truth was rendered at higher resolution", scale > 1.5,
              f"backbuffer {rw}px wide, {scale:.2f}x the 1280px viewport, "
              f"downsampled by the compositor")

        e_none = rms(none, truth)
        e_rep = rms(reproj, truth)
        e_jit = rms(jitter, truth)
        print(f"      RMS against ground truth: none {e_none:.3f}, "
              f"reproject {e_rep:.3f}, jittered {e_jit:.3f}")
        print(f"      high-frequency energy:    none {hf(none):.3f}, "
              f"reproject {hf(reproj):.3f}, jittered {hf(jitter):.3f}, "
              f"truth {hf(truth):.3f}")

        check("jittered TAA is closer to ground truth than no filtering",
              e_jit < e_none,
              f"{e_none:.3f} -> {e_jit:.3f} "
              f"({100 * (1 - e_jit / max(e_none, 1e-9)):.0f}% less error)")
        check("jittered TAA is closer to ground truth than reprojection alone",
              e_jit < e_rep,
              f"{e_rep:.3f} -> {e_jit:.3f} "
              f"({100 * (1 - e_jit / max(e_rep, 1e-9)):.0f}% less error)")
        # The point of the whole file: if the energy metric ranks the modes
        # differently from the truth, it is not measuring quality here.
        rank_energy = sorted(["none", "reproject", "jittered"],
                             key=lambda k: -{"none": hf(none), "reproject": hf(reproj),
                                             "jittered": hf(jitter)}[k])
        rank_truth = sorted(["none", "reproject", "jittered"],
                            key=lambda k: {"none": e_none, "reproject": e_rep,
                                           "jittered": e_jit}[k])
        print(f"      ranked by energy: {' > '.join(rank_energy)}")
        print(f"      ranked by truth : {' > '.join(rank_truth)}")

        check("no page errors", not errs, errs[0][:110] if errs else "")
        br.close()

    if fails:
        print("\nFAILED: " + ", ".join(fails))
        sys.exit(1)
    print("\njitter reconstructs detail a single sample cannot")


if __name__ == "__main__":
    main()
