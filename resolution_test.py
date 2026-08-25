#!/usr/bin/env python3
"""
resolution_test.py -- the 4K output and dynamic-resolution checks (brief 1, 2, 77).

    py -3.14 resolution_test.py [--tier cinematic] [--webgl]

The claim being tested is the one the brief calls out as a failure condition:
"the output is merely upscaled from low resolution".  So this reads the actual
BACKBUFFER size out of the engine, not a setting, and confirms that asking for
3840 wide really renders 3840 wide -- and that the image gets measurably
sharper when it does, by comparing high-frequency detail between scales.

It then drives the dynamic-resolution controller and asserts that it moves the
scale when the frame time target is impossible, stops at the floor, and does
not oscillate.
"""
import argparse
import io as _io
import sys

from PIL import Image, ImageFilter
from playwright.sync_api import sync_playwright


def detail(shot):
    """High-frequency energy: a real resolution increase raises this."""
    im = Image.open(_io.BytesIO(shot)).convert("L").crop((0, 120, 1280, 700))
    hi = im.filter(ImageFilter.GaussianBlur(1.2))
    px, qx = im.load(), hi.load()
    w, h = im.size
    acc = n = 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            d = px[x, y] - qx[x, y]
            acc += d * d
            n += 1
    return (acc / max(n, 1)) ** 0.5


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="cinematic")
    ap.add_argument("--webgl", action="store_true")
    a = ap.parse_args()

    flags = ["--ignore-gpu-blocklist", "--use-angle=default"]
    url = f"http://127.0.0.1:5390/index.html?tier={a.tier}"
    if a.webgl:
        url += "&webgl=1"
    else:
        flags += ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"]

    fails = []

    def check(name, ok, detail=""):
        print(f"{'PASS' if ok else 'FAIL'}  {name:38s} {detail}")
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
        page.evaluate("window.__setSea('moderate')")
        page.evaluate("window.__ocean.weather.speed = 40")
        page.wait_for_timeout(1500)
        page.evaluate("window.__ocean.weather.speed = 0")
        page.evaluate("window.__setView(120,3.0,300,3,150)")
        page.wait_for_function("window.__ready === true", timeout=180000)
        page.evaluate("window.__app.sky.autoExposure = false")
        page.wait_for_timeout(600)

        base = page.evaluate("window.__present.stats()")
        check("reports the real backbuffer size",
              base["output"] == f"{page.evaluate('window.__engine.getRenderWidth()')} x "
                                f"{page.evaluate('window.__engine.getRenderHeight()')}",
              base["output"])

        # ---- half scale, then 4K, measuring the image each time -------------
        page.evaluate("window.__setRenderScale(0.62)")
        page.wait_for_function("window.__ready === true", timeout=180000)
        page.wait_for_timeout(700)
        low = page.evaluate("window.__present.stats()")
        dLow = detail(page.screenshot())

        got = page.evaluate("window.__setOutput(3840)")
        page.wait_for_function("window.__ready === true", timeout=240000)
        page.wait_for_timeout(1200)
        hi = page.evaluate("window.__present.stats()")
        dHi = detail(page.screenshot())

        # the scale is solved iteratively, so it converges to within a pixel
        gotW = int(hi["output"].split(" x ")[0])
        check("asking for 3840 renders 3840",
              abs(gotW - 3840) <= 2, f"{low['output']} -> {hi['output']}")
        check("4K is 8.3 megapixels", hi["megapixels"] > 8.0, f"{hi['megapixels']} MP")
        check("4K is genuinely sharper, not upscaled",
              dHi > dLow * 1.12, f"detail {dLow:.2f} at {low['output']} "
                                 f"-> {dHi:.2f} at {hi['output']}")

        # ---- dynamic resolution ---------------------------------------------
        page.evaluate("window.__setRenderScale(1.0)")
        page.wait_for_timeout(500)
        page.evaluate("""(() => {
            const p = window.__present;
            p.targetFrameRate = 1000;      // impossible: force it to back off
            p.resolutionAdaptationSpeed = 3;
            p.dynamicResolution = true;
        })()""")
        seq = []
        for _ in range(16):
            page.wait_for_timeout(260)
            seq.append(page.evaluate("window.__present.applied.scale"))
        check("dynamic resolution backs off under load",
              seq[-1] < seq[0] - 0.02, f"scale {seq[0]:.2f} -> {seq[-1]:.2f}")
        check("it stops at the floor",
              seq[-1] >= page.evaluate("window.__present.minRenderScale") - 1e-3,
              f"floor {page.evaluate('window.__present.minRenderScale')}")
        # monotone descent, no pumping
        ups = sum(1 for i in range(1, len(seq)) if seq[i] > seq[i - 1] + 1e-3)
        check("it does not oscillate", ups <= 1, f"{ups} upward steps while overloaded")

        page.evaluate("window.__present.dynamicResolution = false")
        check("no page errors", not errs, errs[0][:110] if errs else "")
        br.close()

    if fails:
        print("\nFAILED:", ", ".join(fails))
        sys.exit(1)
    print("\n4K output and dynamic resolution behave")


if __name__ == "__main__":
    main()
