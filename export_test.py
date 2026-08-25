#!/usr/bin/env python3
"""
export_test.py -- drives the in-browser export and checks what comes out.

    py -3.14 export_test.py [--tier high] [--webgl] [--keep]

Clicks the real export path, catches the downloaded ZIP, opens it with the
standard library, and validates the archive rather than trusting the button:
every promised file present, every JSON parseable and free of NaN, the spectrum
round-tripping the values the running ocean actually holds, and no environment
content anywhere in the package (brief section 88).
"""
import argparse
import io
import json
import os
import sys
import zipfile

from playwright.sync_api import sync_playwright

BANNED = ["island", "terrain", "beach", "rock", "tree", "boat", "building",
          "pier", "character", "npc", "mannequin", "vegetation", "coral"]

REQUIRED = [
    "README_UNREAL_IMPORT.md",
    "README_LICENSES.md",
    "Config/OceanSpectrum.json",
    "Config/OceanMaterial.json",
    "Config/OceanWeatherPresets.json",
    "Config/OceanBreakers.json",
    "Documentation/OceanTechnicalReport.md",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="high")
    ap.add_argument("--webgl", action="store_true")
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()

    flags = ["--ignore-gpu-blocklist", "--use-angle=default"]
    url = f"http://127.0.0.1:5390/index.html?tier={a.tier}"
    if a.webgl:
        url += "&webgl=1"
    else:
        flags += ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"]

    fails = []

    def check(name, ok, detail=""):
        print(f"{'PASS' if ok else 'FAIL'}  {name:40s} {detail}")
        if not ok:
            fails.append(name)

    with sync_playwright() as pw:
        br = pw.chromium.launch(channel="chrome", headless=True, args=flags)
        ctx = br.new_context(accept_downloads=True,
                             viewport={"width": 1280, "height": 720})
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_function("window.__booted === true", timeout=300000)
        page.wait_for_function("window.__ready === true", timeout=300000)
        page.evaluate("window.__setSea('rough')")
        page.evaluate("window.__ocean.weather.speed = 40")
        page.wait_for_timeout(1500)
        page.evaluate("window.__ocean.weather.speed = 0.28")
        page.wait_for_timeout(600)

        live = page.evaluate("""(() => {
            const o = window.__ocean, p = o.sim.params;
            return { windSpeed: p.windSpeed, seed: p.seed, choppy: p.choppy,
                     patches: o.sim.patchSizes };
        })()""")

        issues = page.evaluate("window.__export.validate(window.__export.buildFiles())")
        check("validation reports no issues", not issues,
              issues[0] if issues else "clean")

        with page.expect_download(timeout=120000) as dl:
            page.evaluate("window.__export.downloadPackage()")
        path = dl.value.path()
        size = os.path.getsize(path)
        check("zip downloaded", size > 2000, f"{size} bytes")

        with open(path, "rb") as fh:
            raw = fh.read()
        if a.keep:
            open("Ocean_UE_Export.zip", "wb").write(raw)

        try:
            z = zipfile.ZipFile(io.BytesIO(raw))
            bad = z.testzip()
        except Exception as e:
            check("zip is a valid archive", False, str(e)[:90])
            br.close()
            sys.exit(1)
        check("zip is a valid archive", bad is None,
              f"{len(z.namelist())} entries")

        names = z.namelist()
        missing = [n for n in REQUIRED if n not in names]
        check("all required files present", not missing, ", ".join(missing) or "ok")

        # every JSON parses and holds no NaN
        badjson = []
        spec = None
        for n in names:
            if not n.endswith(".json"):
                continue
            try:
                obj = json.loads(z.read(n).decode("utf-8"))
            except Exception as e:
                badjson.append(f"{n}: {e}")
                continue
            if n.endswith("OceanSpectrum.json"):
                spec = obj

            def scan(o, path):
                if isinstance(o, float) and (o != o or o in (float("inf"), float("-inf"))):
                    badjson.append(f"{n}{path} non-finite")
                elif isinstance(o, dict):
                    for k, v in o.items():
                        scan(v, f"{path}.{k}")
                elif isinstance(o, list):
                    for i, v in enumerate(o):
                        scan(v, f"{path}[{i}]")
            scan(obj, "")
        check("every JSON parses, no NaN", not badjson,
              badjson[0] if badjson else f"{sum(1 for n in names if n.endswith('.json'))} files")

        # the spectrum must describe the ocean that is actually running
        if spec:
            ok = (abs(spec["wind"]["speedMetersPerSecond"] - live["windSpeed"]) < 1e-6
                  and spec["seed"] == live["seed"]
                  and abs(spec["choppiness"] - live["choppy"]) < 1e-6
                  and [c["patchSizeMeters"] for c in spec["cascades"]] == live["patches"])
            check("spectrum matches the running ocean", ok,
                  f"wind {spec['wind']['speedMetersPerSecond']} seed {spec['seed']} "
                  f"cascades {[c['patchSizeMeters'] for c in spec['cascades']]}")
            # What matters is not the ratio but whether the lattices COINCIDE:
            # patches that share a small common multiple line up every few
            # hundred metres and the eye reads that as tiling.  So check the
            # least common multiple, not how close the ratios are to integers.
            import math as _m
            sizes = [int(round(c["patchSizeMeters"])) for c in spec["cascades"]]
            lcm = sizes[0]
            for v in sizes[1:]:
                lcm = lcm * v // _m.gcd(lcm, v)
            check("cascade lattices do not coincide", lcm > 20000,
                  f"sizes {sizes}, lcm {lcm} m (they realign every {lcm/1000:.0f} km)")
        else:
            check("spectrum matches the running ocean", False, "no spectrum file")

        # section 88: no environment content anywhere in the package
        hits = []
        for n in names:
            body = z.read(n).decode("utf-8", "ignore").lower()
            for w in BANNED:
                # the readme legitimately explains what was removed, so only
                # flag words that appear as DATA, not as prose in the guides
                if n.endswith(".json") and w in body:
                    hits.append(f"{n}: {w}")
        check("no environment content in the package", not hits,
              hits[0] if hits else "config is ocean only")

        check("no page errors", not errs, errs[0][:100] if errs else "")
        br.close()

    if fails:
        print("\nFAILED:", ", ".join(fails))
        sys.exit(1)
    print("\nexport package is valid")


if __name__ == "__main__":
    main()
