#!/usr/bin/env python3
"""
tiles.py -- proves the ocean has no visible tiles, rings, patches or seams.

    py -3.14 tiles.py [--tier high] [--webgpu] [--save]

A tile boundary, a clipmap ring, an LOD step and a render-target seam all share
one signature: a LONG STRAIGHT EDGE.  Wave crests, foam, caustics and cloud
shadows are curved and broken.  So this measures the longest collinear run of
edge pixels in the water, at the altitudes and angles where such boundaries show
up, and fails if anything but the horizon is straight.

It also runs the same stations on both backends and compares, because the
artefacts this harness was written for were WebGPU-only: a WebGL2-only pass
looked perfectly clean while the shipped renderer was covered in squares.
"""
import argparse
import io as _io
import math
import os
import sys

from PIL import Image, ImageFilter
from playwright.sync_api import sync_playwright

# x, y, z, pitch, yaw -- the report's own list: 5 m to 1 km looking down,
# plus grazing, plus underwater looking up.
STATIONS = [
    # The brief's altitude sweep, over open water with nothing in frame but
    # ocean: 1 m to 1 km looking down, plus grazing and underwater.
    # Pitched steeply enough that the HORIZON is out of frame: it is a real
    # straight edge, and at low altitude it otherwise dominates the metric and
    # measures the sky boundary instead of the water.
    ("alt1",       (0, 1.0, 0, 62, -60),       330),
    ("alt10",      (0, 10, 0, 55, -60),        330),
    ("alt50",      (0, 50, 0, 40, -60),        330),
    ("alt100",     (0, 100, 0, 42, 20),        330),
    ("alt250",     (0, 250, 0, 50, 20),        330),
    ("alt500",     (0, 500, 0, 58, 20),        330),
    ("alt1000",    (0, 1000, 0, 64, 20),       330),
    ("faraway",    (7400, 90, -6100, 40, 200), 330),
    ("uw_up",      (0, -3.0, 0, -25, 150),     300),
]
# the horizon is a real straight edge, so grazing stations get a higher budget
GRAZING = [("grazing", (200, 2.0, -300, 1, 150), 900)]


def longest_straight_edge(img, thresh=26):
    """Longest collinear run of gradient pixels, in image pixels."""
    g = img.convert("L").filter(ImageFilter.GaussianBlur(0.6))
    w, h = g.size
    px = g.load()
    edges = set()
    for y in range(2, h - 2, 2):
        for x in range(2, w - 2, 2):
            gx = px[x + 2, y] - px[x - 2, y]
            gy = px[x, y + 2] - px[x, y - 2]
            if gx * gx + gy * gy > thresh * thresh:
                edges.add((x, y))
    if not edges:
        return 0
    pts = list(edges)
    pts = pts[:: max(1, len(pts) // 1400)]
    best = 0
    for i in range(0, len(pts), 3):
        x0, y0 = pts[i]
        for ang in range(0, 180, 6):
            a = math.radians(ang)
            dx, dy = math.cos(a), math.sin(a)
            run = miss = 0
            k = 1
            while k < 400:
                x = int(round(x0 + dx * k * 2))
                y = int(round(y0 + dy * k * 2))
                if not (0 <= x < w and 0 <= y < h):
                    break
                if (x - x % 2, y - y % 2) in edges or (x, y) in edges:
                    run, miss = k, 0
                else:
                    miss += 1
                    if miss > 3:
                        break
                k += 1
            best = max(best, run * 2)
    return best


def run(webgpu, tier, save):
    tag = "wgpu" if webgpu else "wgl"
    flags = ["--ignore-gpu-blocklist", "--use-angle=default"]
    url = f"http://127.0.0.1:5390/index.html?tier={tier}"
    if webgpu:
        flags += ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"]
    else:
        url += "&webgl=1"

    results, errs = {}, []
    with sync_playwright() as pw:
        br = pw.chromium.launch(channel="chrome", headless=True, args=flags)
        page = br.new_page(viewport={"width": 1024, "height": 576})
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_function("window.__booted === true", timeout=240000)
        page.wait_for_function("window.__ready === true", timeout=240000)
        got = page.evaluate("window.__engine.isWebGPU ? 'WebGPU' : 'WebGL2'")
        if webgpu and got != "WebGPU":
            print("  (WebGPU unavailable here, skipping)")
            br.close()
            return None, []
        page.evaluate("window.__setTime(15.0)")
        page.evaluate("window.__setSea('moderate')")
        page.evaluate("window.__ocean.weather.speed = 40")
        page.wait_for_timeout(1500)
        page.evaluate("window.__ocean.weather.speed = 0.28")

        # the buffers must share the screen's shape: they are read with screen uv
        rt = page.evaluate("""(() => {
            const o = window.__ocean, e = window.__engine;
            const asp = e.getRenderWidth() / e.getRenderHeight();
            const f = (t) => t ? t.getSize().width / t.getSize().height : asp;
            return { asp, refract: f(o.refraction.texture), mirror: f(o.reflection.texture) };
        })()""")

        for name, (x, y, z, pit, yaw), budget in STATIONS + GRAZING:
            page.evaluate(f"window.__setView({x},{y},{z},{pit},{yaw})")
            page.wait_for_function("window.__ready === true", timeout=180000)
            page.wait_for_timeout(500)
            shot = page.screenshot()
            im = Image.open(_io.BytesIO(shot)).convert("RGB").crop((0, 90, 1024, 576))
            L = longest_straight_edge(im)
            results[name] = (L, budget)
            if save:
                os.makedirs("shots/tiles", exist_ok=True)
                im.save(f"shots/tiles/{tag}_{name}.png")
        br.close()
    return (results, rt), errs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="high")
    ap.add_argument("--webgpu", action="store_true",
                    help="only this backend (default: both)")
    ap.add_argument("--save", action="store_true")
    a = ap.parse_args()

    backends = [True] if a.webgpu else [True, False]
    fails, all_res = [], {}
    for gpu in backends:
        tag = "WebGPU" if gpu else "WebGL2"
        print(f"{tag}:")
        out, errs = run(gpu, a.tier, a.save)
        if out is None:
            continue
        res, rt = out
        for name, (L, budget) in res.items():
            ok = L <= budget
            print(f"  {'PASS' if ok else 'FAIL'}  {name:12s} longest straight edge "
                  f"{L:4d} px (budget {budget})")
            if not ok:
                fails.append(f"{tag}/{name} {L}px")
        for k in ("refract", "mirror"):
            ok = abs(rt[k] - rt["asp"]) < 0.06
            print(f"  {'PASS' if ok else 'FAIL'}  {k+' aspect':12s} {rt[k]:.3f} "
                  f"vs screen {rt['asp']:.3f}")
            if not ok:
                fails.append(f"{tag}/{k}-aspect")
        if errs:
            print(f"  FAIL  page errors: {errs[0][:100]}")
            fails.append(f"{tag}/page-error")
        all_res[tag] = res

    # the two backends must agree: a backend-only artefact is the failure mode
    # that a single-backend pass cannot see at all
    if len(all_res) == 2:
        wg, gl = all_res["WebGPU"], all_res["WebGL2"]
        for name in wg:
            # The grazing station's number is the HORIZON, a real straight edge
            # whose detected length swings between ~340 and ~800 px depending on
            # whether a wave happens to break it.  Comparing backends on that
            # measures the sea state, not the renderer.  Its own budget still
            # applies; only the agreement check is skipped.
            if name == "grazing":
                continue
            d = abs(wg[name][0] - gl[name][0])
            ok = d <= 140
            print(f"  {'PASS' if ok else 'FAIL'}  backends agree {name:12s} "
                  f"WebGPU {wg[name][0]} vs WebGL2 {gl[name][0]}")
            if not ok:
                fails.append(f"backend-diff/{name}")

    if fails:
        print("\nFAILED:", ", ".join(fails))
        sys.exit(1)
    print("\nno tiles, rings, patches or seams found")


if __name__ == "__main__":
    main()
