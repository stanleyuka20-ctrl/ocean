#!/usr/bin/env python3
"""
ladder.py -- one browser session, every station the ocean has to hold up in.

    py -3.14 ladder.py [tag] [--only a,b] [--tier high] [--size WxH]

Shots land in shots/<tag>/.  Each station reports its own stats so a
regression shows up as a number, not only as a picture.
"""
import argparse, json, os, sys
from playwright.sync_api import sync_playwright

STATIONS = [
    # Ocean only: every station is open water.  Positions are far from the
    # origin on purpose -- a wave field that only looks right near (0,0) is
    # hiding a precision problem.
    ("01_waterline",    (0, 1.7, 0),           2,   30, "__setPreset('clearAtlantic')"),
    ("02_eyelevel",     (2400, 2.4, -1800),    3,  -152, "__setPreset('clearAtlantic')"),
    ("03_lowaerial",    (-900, 24, 1200),     22,   64, "__setPreset('clearAtlantic')"),
    ("04_midaerial",    (140, 120, -260),     34,  -120, "__setPreset('clearAtlantic')"),
    ("05_highaerial",   (300, 640, 900),      46,  -178, "__setPreset('clearAtlantic')"),
    ("06_kilometre",    (0, 1000, 0),         52,   20, "__setPreset('clearAtlantic')"),
    ("07_horizon",      (0, 3.0, 0),           1,   96, "__setPreset('clearAtlantic')"),
    ("08_downwind",     (-500, 2.0, 400),      2, -100, "__setPreset('clearAtlantic')"),
    ("09_calm",         (0, 1.7, 0),           2,   30, "__setSea('calm')"),
    ("10_moderate",     (0, 1.7, 0),           2,   30, "__setSea('moderate')"),
    ("11_rough",        (0, 2.2, 0),           3,   30, "__setSea('rough')"),
    ("12_storm",        (0, 3.0, 0),           4,   30, "__setPreset('storm')"),
    ("13_extreme",      (0, 4.0, 0),           5,   30, "__setPreset('extremeStorm')"),
    ("14_rain",         (0, 2.4, 0),           3,   30, "__setPreset('heavyRain')"),
    ("15_overcast",     (0, 2.0, 0),           2,   30, "__setPreset('overcast')"),
    ("16_sunrise",      (0, 1.7, 0),           2,  110, "__setTime(6.4)"),
    ("17_midday",       (0, 1.7, 0),           2,   30, "__setTime(12.5)"),
    ("18_sunset",       (0, 1.7, 0),           2, -100, "__setTime(18.35)"),
    ("19_night",        (0, 1.7, 0),           2,   30, "__setTime(0.6)"),
    ("20_uw_1m",        (0, -1.0, 0),        -22,   30, "__setSea('moderate')"),
    ("21_uw_5m",        (0, -5.0, 0),         12,   30, "__setSea('moderate')"),
    ("22_uw_25m",       (0, -25.0, 0),        30,   30, "__setSea('rough')"),
    ("23_murky",        (0, 1.7, 0),           2,   30, "__setWater('murky')"),
    ("24_arctic",       (0, 2.0, 0),           3,   30, "__setWater('arctic');__setSea('rough')"),
]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tag", nargs="?", default="ladder")
    ap.add_argument("--only")
    ap.add_argument("--tier", default="high")
    ap.add_argument("--size", default="1280x720")
    ap.add_argument("--settle", type=float, default=3.2)
    ap.add_argument("--webgpu", action="store_true")
    a = ap.parse_args()

    w, h = (int(x) for x in a.size.lower().split("x"))
    out = os.path.join("shots", a.tag)
    os.makedirs(out, exist_ok=True)
    keep = set(a.only.split(",")) if a.only else None

    url = f"http://127.0.0.1:5390/index.html?tier={a.tier}"
    if not a.webgpu:
        url += "&webgl=1"
    flags = ["--ignore-gpu-blocklist", "--use-angle=default"]
    if a.webgpu:
        flags += ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"]

    report = []
    with sync_playwright() as pw:
        br = pw.chromium.launch(channel="chrome", headless=True, args=flags)
        page = br.new_page(viewport={"width": w, "height": h})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_function("window.__booted === true", timeout=240000)
        page.evaluate("window.__panel(false)")

        for name, pos, pitch, yaw, setup in STATIONS:
            if keep and not any(k in name for k in keep):
                continue
            page.evaluate(f"(()=>{{{setup};window.__ocean.weather.speed=40;}})()")
            page.wait_for_timeout(400)
            page.evaluate(f"window.__setView({pos[0]},{pos[1]},{pos[2]},{pitch},{yaw})")
            page.evaluate("window.__ocean.weather.speed=0.28")
            try:
                page.wait_for_function("window.__ready === true", timeout=90000)
            except Exception:
                print(f"   {name}: __ready timed out")
            page.wait_for_timeout(int(a.settle * 1000))
            st = page.evaluate("window.__stats()")
            page.screenshot(path=os.path.join(out, name + ".png"))
            report.append({"station": name, **st})
            print(f"{name:20s} fps {st['fps']:5.0f}  Hs {st['hs']:>7}  exp {st['exposure']}")
        br.close()

    with open(os.path.join(out, "report.json"), "w") as f:
        json.dump(report, f, indent=1)
    if errs:
        print("--- page errors ---")
        for e in errs[:10]:
            print("  ", e)

if __name__ == "__main__":
    main()
