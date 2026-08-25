#!/usr/bin/env python3
"""
stage_frames.py -- what the image is doing at +0 / +8 / +32 / settled after a
camera stop, as pictures rather than as a number.

    py -3.14 stage_frames.py [--tier high]

Run in TAA_MODE.REPROJECT, because that is where the effect lives: the filter
converging on its new history after a camera move.  In TAA_MODE.NONE the
renderer is bit-exact and all four frames are identical -- which is the whole
point of the fix that made NONE actually mean none, and is worth having on
record next to the mode that does converge.

Writes shots/stage_<mode>_<frame>.png plus x8 difference heatmaps against the
settled frame, so the convergence can be seen and located rather than inferred.
"""
import argparse
import os
import sys

from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import sync_playwright

from harness import grab_img

CROP = (0, 100, 1280, 700)
VIEW = (0, 2.0, 0, 3, 30)
FRAMES = [0, 8, 32]
PAN_STEPS, PAN_RATE = 40, 0.05
OUT = "shots"

ROT = """([n, rate]) => {
    const c = window.__app.camera.camera;
    const b = window.__app.frames;
    for (let i = 0; i < n; i++) { c.rotation.y += rate; window.__advance(1); }
    return window.__app.frames - b;
}"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="high")
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)

    flags = ["--ignore-gpu-blocklist", "--use-angle=default",
             "--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"]
    url = f"http://127.0.0.1:5390/index.html?tier={a.tier}"
    fails = []

    def check(name, ok, why=""):
        print(f"{'PASS' if ok else 'FAIL'}  {name:46s} {why}")
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
        page.evaluate("window.__setSea('rough')")
        page.evaluate("window.__settleSea(60)")
        page.wait_for_function("window.__ready === true", timeout=180000)
        page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % VIEW)
        page.wait_for_function("window.__ready === true", timeout=180000)
        page.evaluate("window.__freezeWorld()")
        page.wait_for_timeout(700)

        for mode, label in ((1, "reproject"), (0, "none")):
            page.evaluate(f"window.__taa.enabled = true; window.__taaMode({mode})")
            page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % VIEW)
            page.evaluate("window.__pauseRender(); window.__advance(240)")
            drawn = page.evaluate(ROT, [PAN_STEPS, PAN_RATE])
            page.evaluate("window.__advance(400)")
            settled = grab_img(page, CROP)
            settled.save(f"{OUT}/stage_{label}_settled.png")
            if drawn != PAN_STEPS:
                check(f"{label}: pan drew {PAN_STEPS} frames", False,
                      f"{drawn} drawn -- INVALID_PROBE")
                continue

            page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % VIEW)
            page.evaluate("window.__advance(240)")
            page.evaluate(ROT, [PAN_STEPS, PAN_RATE])
            print(f"\n  {label}: RMS from the settled frame")
            at, rmss = 0, []
            for n in FRAMES:
                if n > at:
                    page.evaluate(f"window.__advance({n - at})")
                    at = n
                im = grab_img(page, CROP)
                im.save(f"{OUT}/stage_{label}_{n:03d}.png")
                d = ImageChops.difference(im, settled)
                r = ImageStat.Stat(d).rms[0]
                pct = 100 * sum(d.histogram()[1:]) / sum(d.histogram())
                rmss.append(r)
                d.point(lambda v: min(255, v * 8)).save(
                    f"{OUT}/stage_{label}_{n:03d}_diff.png")
                print(f"    +{n:<4d}  {r:7.3f} RMS   {pct:5.2f}% of pixels differ")
            print(f"    settled  {0.0:7.3f} RMS   (reference)")
            page.evaluate("window.__resumeRender()")

            if label == "none":
                check("TAA_MODE.NONE: no convergence at all", max(rmss) < 0.01,
                      f"worst {max(rmss):.4f} RMS -- the renderer is bit-exact")
            else:
                check("TAA_MODE.REPROJECT: the filter converges and settles",
                      rmss[0] > 1.0 and rmss[-1] < rmss[0] * 0.5,
                      f"+0 {rmss[0]:.2f} -> +32 {rmss[-1]:.2f} RMS")

        check("no page errors", not errs, errs[0][:110] if errs else "")
        br.close()

    if fails:
        print("\nFAILED: " + ", ".join(fails))
        sys.exit(1)
    print(f"\nframes written to {OUT}/stage_*.png")


if __name__ == "__main__":
    main()
