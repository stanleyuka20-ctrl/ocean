#!/usr/bin/env python3
"""
stage_test.py -- at which pipeline stage does a stopped camera first differ?

    py -3.14 stage_test.py [--tier high]

HISTORICAL.  The question it was built to answer was malformed: the "settling"
it walks the pipeline looking for was an artefact of the capture path, which
read a sparse high-frequency intermediate instead of the colour frame (see
harness.py).  On a calibrated capture a frozen world panned and stopped is
bit-identical to its settled render at every sample.

Its own result was black-against-black and should not be cited: the row that
appeared to name the boundary -- "no TAA chain: 0.00 at every frame, including
+0" -- reads that way because the buffer being sampled is EMPTY when the
temporal filter is off.  It briefly looked like proof that the TAA chain carried
state in a mode where it holds no history, which was a real bug (TAA_MODE.NONE
gated on the `enabled` flag rather than the mode) but not this one.

Kept because the technique is sound and worth having when a genuine per-stage
question comes up: disable one stage at a time, fresh page per row, and measure
the same curve.  Any future use must first confirm the capture responds in the
configuration being measured -- run capture_test.py.
"""
import argparse
import sys

from PIL import ImageChops, ImageStat
from playwright.sync_api import sync_playwright

from harness import grab_img

CROP = (0, 100, 1280, 700)
VIEW = (0, 2.0, 0, 3, 30)
SAMPLES = [0, 1, 2, 4, 8, 16, 32, 128]
PAN_STEPS, PAN_RATE = 40, 0.05

ROT = """([n, rate]) => {
    const c = window.__app.camera.camera;
    const b = window.__app.frames;
    for (let i = 0; i < n; i++) { c.rotation.y += rate; window.__advance(1); }
    return { drawn: window.__app.frames - b, yaw: c.rotation.y };
}"""

# stage -> JS that removes it from the chain.  Ordered outermost-last so the
# first row that moves names the earliest responsible boundary.
STAGES = [
    ("baseline", ""),
    ("no vignette", "window.__app.pipeline.imageProcessing.vignetteEnabled = false;"),
    ("no bloom", "window.__app.pipeline.bloomEnabled = false;"),
    ("no tonemap", "window.__app.pipeline.imageProcessing.toneMappingEnabled = false;"),
    ("no image processing", "window.__app.pipeline.imageProcessingEnabled = false;"),
    ("no fxaa", "window.__app.pipeline.fxaaEnabled = false;"),
    ("no underwater pp", "window.__ocean.underwater.enabled = false;"),
    ("no TAA chain", "window.__taa.enabled = false;"),
    ("ocean hidden", "window.__ocean.mesh.setEnabled(false);"),
    ("sky hidden", "window.__app.sky.dome.setEnabled(false);"),
]


def rms(a, b):
    return ImageStat.Stat(ImageChops.difference(a, b)).rms[0]


def changed(a, b):
    h = ImageChops.difference(a, b).histogram()
    return sum(h[1:]) / sum(h)


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

        def boot():
            page.goto(url, wait_until="domcontentloaded")
            page.wait_for_function("window.__booted === true", timeout=300000)
            page.wait_for_function("window.__ready === true", timeout=300000)
            page.evaluate("window.__taa.enabled = true; window.__taaMode(0)")
            page.evaluate("window.__setSea('rough')")
            page.evaluate("window.__settleSea(60)")
            page.wait_for_function("window.__ready === true", timeout=180000)
            page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % VIEW)
            page.wait_for_function("window.__ready === true", timeout=180000)
            page.evaluate("window.__freezeWorld()")
            page.wait_for_timeout(600)

        def curve():
            page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % VIEW)
            page.evaluate("window.__pauseRender(); window.__advance(240)")
            page.evaluate(ROT, [PAN_STEPS, PAN_RATE])
            page.evaluate("window.__advance(400)")
            ref = grab_img(page, CROP)
            page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % VIEW)
            page.evaluate("window.__advance(240)")
            info = page.evaluate(ROT, [PAN_STEPS, PAN_RATE])
            out, at = [], 0
            for n in SAMPLES:
                if n > at:
                    page.evaluate(f"window.__advance({n - at})")
                    at = n
                im = grab_img(page, CROP)
                out.append((rms(im, ref), changed(im, ref)))
            page.evaluate("window.__resumeRender()")
            return out, info["drawn"]

        boot()
        print("\n  post-stop RMS, frames " + " ".join(f"{n:>6d}" for n in SAMPLES))
        base = None
        for label, js in STAGES:
            if js:
                # a fresh page per row: post-process toggles are not cleanly
                # reversible and a stale one would contaminate the next row
                boot()
                page.evaluate(js)
                page.wait_for_timeout(400)
            cur, drawn = curve()
            tag = ""
            if base is None:
                base = cur
            else:
                d = abs(cur[1][0] - base[1][0]) / max(base[1][0], 1e-9)
                tag = "  <-- CHANGES THE TAIL" if d > 0.25 else ""
            print(f"    {label:20s} " + " ".join(f"{v[0]:6.2f}" for v in cur)
                  + tag)
            if drawn != PAN_STEPS:
                print(f"    {'':20s} INVALID_PROBE: {drawn} frames drawn")

        check("no page errors", not errs, errs[0][:110] if errs else "")
        br.close()

    if fails:
        print("\nFAILED: " + ", ".join(fails))
        sys.exit(1)
    print("\nstage walk complete -- the first row that changes the tail is the "
          "boundary")


if __name__ == "__main__":
    main()
