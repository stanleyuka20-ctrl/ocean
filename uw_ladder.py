#!/usr/bin/env python3
"""Capture the underwater world at each showcase and depth station."""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:5390/index.html"
OUT = os.path.join(os.path.dirname(__file__), "shots", "UW_WORLD")

STATIONS = [
    ("01_reef", "reef"),
    ("02_arch", "arch"),
    ("03_vents", "vents"),
    ("04_shafts", "shafts"),
    ("05_dropoff", "dropoff"),
    ("06_canyon", "canyon"),
    ("07_d5", "underwater"),
    ("08_d50", "d50"),
    ("09_d100", "d100"),
    ("10_d250", "d250"),
    ("11_d500", "d500"),
    ("12_d1000", "d1000"),
    ("13_d2000", "d2000"),
    ("14_d4000", "d4000"),
]


def main():
    os.makedirs(OUT, exist_ok=True)
    webgpu = "--webgpu" in sys.argv
    size = "1600x900"
    for a in sys.argv:
        if a.startswith("--size="):
            size = a.split("=", 1)[1]
    w, h = (int(x) for x in size.lower().split("x"))
    url = f"{URL}?tier=cinematic"
    if not webgpu:
        url += "&webgl=1"
    flags = ["--ignore-gpu-blocklist", "--enable-gpu-rasterization"]
    if webgpu:
        flags += ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"]

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True, args=flags)
        page = browser.new_page(viewport={"width": w, "height": h})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_function("window.__booted === true", timeout=180000)
        page.wait_for_function("window.__ready === true", timeout=120000)
        rows = []
        for name, key in STATIONS:
            page.evaluate(f"window.__uwGoto({key!r})")
            page.wait_for_timeout(1400)
            st = page.evaluate("window.__uwStats()")
            path = os.path.join(OUT, name + ".png")
            page.screenshot(path=path)
            rows.append({"shot": name, **st})
            print(f"{name:16} depth={st.get('depth', 0):7.1f}  floor={st.get('floor', 0):7.1f}  "
                  f"fps={st.get('fps', 0):5.1f}  zone={st.get('zone')}")
        # short live run
        t0 = time.time()
        n = 0
        fps = []
        while time.time() - t0 < 8:
            page.wait_for_timeout(250)
            st = page.evaluate("window.__uwStats()")
            fps.append(st.get("fps") or 0)
            n += 1
        summary = {
            "backend": rows[-1].get("backend") if rows else "?",
            "live_s": 8, "samples": n,
            "fps_mean": sum(fps) / max(len(fps), 1),
            "fps_min": min(fps) if fps else 0,
            "errors": errors[:12],
            "stations": rows,
        }
        with open(os.path.join(OUT, "report.json"), "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=2)
        print("saved", OUT)
        print(json.dumps({k: summary[k] for k in ("backend", "fps_mean", "fps_min")}, indent=2))
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
