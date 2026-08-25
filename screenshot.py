#!/usr/bin/env python3
"""
Headless capture for the ocean project.

    py -3.14 screenshot.py out.png [--view X,Y,Z] [--pitch D] [--yaw D]
                                   [--preset k] [--sea k] [--time h] [--water k]
                                   [--debug i] [--tier t] [--size WxH]
                                   [--settle S] [--js "code"] [--webgpu]

Requires the server on 5390 (python serve.py).  Uses the installed Chrome, not
the bundled Chromium, so the real GPU stack is exercised where available.
"""
import argparse
import sys
import time

from playwright.sync_api import sync_playwright

DEFAULT_URL = "http://127.0.0.1:5390/index.html"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--view")
    ap.add_argument("--pitch", type=float, default=0.0)
    ap.add_argument("--yaw", type=float, default=0.0)
    ap.add_argument("--preset")
    ap.add_argument("--sea")
    ap.add_argument("--time", type=float)
    ap.add_argument("--water")
    ap.add_argument("--debug", type=int)
    ap.add_argument("--tier", default="high")
    ap.add_argument("--size", default="1280x720")
    ap.add_argument("--settle", type=float, default=2.6)
    ap.add_argument("--js")
    ap.add_argument("--js2")
    ap.add_argument("--webgpu", action="store_true")
    ap.add_argument("--headed", action="store_true")
    a = ap.parse_args()

    w, h = (int(x) for x in a.size.lower().split("x"))
    url = a.url
    sep = "&" if "?" in url else "?"
    url = f"{url}{sep}tier={a.tier}"
    if not a.webgpu:
        url += "&webgl=1"

    flags = [
        "--ignore-gpu-blocklist",
        "--enable-gpu-rasterization",
        "--enable-webgl-draft-extensions",
        "--use-angle=default",
    ]
    if a.webgpu:
        flags += ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"]

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=not a.headed, args=flags)
        page = browser.new_page(viewport={"width": w, "height": h})
        errors = []
        page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}")
                if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
        page.goto(url, wait_until="domcontentloaded")

        try:
            page.wait_for_function("window.__booted === true", timeout=180000)
        except Exception:
            print("!! never booted", file=sys.stderr)
            for e in errors[:40]:
                print("   ", e, file=sys.stderr)
            page.screenshot(path=a.out)
            browser.close()
            sys.exit(2)

        if a.preset:
            page.evaluate(f"window.__setPreset({a.preset!r})")
        if a.sea:
            page.evaluate(f"window.__setSea({a.sea!r})")
        if a.water:
            page.evaluate(f"window.__setWater({a.water!r})")
        if a.time is not None:
            page.evaluate(f"window.__setTime({a.time})")
        if a.debug is not None:
            page.evaluate(f"window.__setDebug({a.debug})")
        if a.view:
            x, y, z = (float(v) for v in a.view.split(","))
            page.evaluate(f"window.__setView({x},{y},{z},{a.pitch},{a.yaw})")
        if a.js:
            page.evaluate(a.js)

        # __ready gates on every material being compiled AND 45 quiet frames;
        # a fixed sleep here captures a half-built scene
        try:
            page.wait_for_function("window.__ready === true", timeout=120000)
        except Exception:
            print("!! __ready never set", file=sys.stderr)
        # then let the spectrum, weather easing and foam history settle
        page.wait_for_timeout(int(a.settle * 1000))
        if a.js2:
            page.evaluate(a.js2)
            page.wait_for_timeout(500)

        stats = page.evaluate("window.__stats ? window.__stats() : {}")
        page.screenshot(path=a.out)
        browser.close()

    print(f"saved {a.out}")
    for k, v in stats.items():
        print(f"   {k}: {v}")
    hard = [e for e in errors if "[pageerror]" in e or "[error]" in e]
    if hard:
        print("--- console ---")
        for e in hard[:25]:
            print("   ", e)


if __name__ == "__main__":
    main()
