#!/usr/bin/env python3
"""
sweep.py -- search the TAA history-confidence parameters, and report a Pareto set.

    py -3.14 sweep.py [--tier high] [--round 1|2] [--reps 1] [--webgl]
    py -3.14 sweep.py --apply "<name>"      # print the winning config as JSON

Eight coupled knobs decide how much history each pixel keeps.  Tuning them one
at a time by eye is how the previous rounds went wrong: every one of them trades
shimmer against detail against ghosting, so a change that improves the number
being watched almost always damages one that is not.  Now that selftest.py
shows the instrument repeats to within a few per cent, the search can be run
instead of guessed.

Structure, and the reason for it:

  * stations are the OUTER loop and candidates the inner one, so each station
    is settled once and the camera-local particle populations stay put;
  * the TAA-OFF baseline is re-measured for EVERY candidate, immediately before
    its TAA-ON reading.  Measuring it once per station looks like an obvious
    saving and is wrong: the foam field keeps accumulating across the inner
    loop, so later candidates were being scored against a stale baseline and
    the whole table drifted with candidate index -- underwater read +66% for
    the first candidate and about -115% for every one after it, regardless of
    what its parameters were;
  * every candidate sees the same anchored wave phase, the same foam, the same
    populations, no lightning, and the same fixed simulated timestep.

Nothing here picks a winner by shimmer alone.  A candidate is REJECTED outright
if it fails detail retention, the ghost limit, or makes any station worse; the
survivors are then printed as a Pareto table for a judgement call across the
whole target, not a single number.
"""
import argparse
import io as _io
import json
import sys

from PIL import Image, ImageChops, ImageFilter, ImageStat
from playwright.sync_api import sync_playwright

from stations import GHOST_STATION, STATIONS

from harness import grab_img

# --- acceptance ------------------------------------------------------------
# The SAME thresholds taa_test.py enforces, so a candidate that passes here is
# predicted to pass there.  "All stations positive" is not the acceptance bar:
# taa_test requires an 8% reduction (on < off * 0.92), and a sweep that only
# asked for positive numbers happily nominated configurations it then failed.
MIN_DETAIL = 0.82
MIN_SHIMMER = 8.0
MAX_GHOST = 6.0

# The stations come from stations.py, which every harness imports.  They must
# not diverge: while this file kept its own copy and used clearAtlantic where
# the acceptance test inherited a post-storm sea, the search was optimising a
# different renderer -- it reported water +19% and underwater detail 88% for a
# configuration the acceptance test then measured at +7% and 81%.
#
# Nothing is inherited any more.  taa_test.py used preset=None for the quiet
# stations, meaning "leave whatever the last station set", so its UNDERWATER
# station was measured in storm weather (storm spray runs immediately before
# it) while selftest.py measured the same station in clearAtlantic.  Every
# station now names its own preset, which changes what underwater measures --
# clear water rather than post-storm -- and makes the three harnesses agree.
INITIAL_SEA = "rough"

BASE = {}

# One-at-a-time variations around the base.  A coordinate sweep, not a grid:
# a grid over thirteen parameters is not bounded by anything.
AXES = {
    "historyMin": [0.10, 0.30, 0.50],
    "historyMax": [0.86, 0.94, 0.97],
    "motionFalloff": [0.008, 0.020, 0.045],
    "edgeFalloff": [0.60, 1.60, 3.20],
    "varHistScale": [2.0, 6.0, 14.0],
    "reactiveScale": [0.55, 0.85, 1.00],
    "ghostRejection": [0.06, 0.16, 0.40],
    "uncoveredConf": [0.20, 0.45, 0.80],
    "varianceGamma": [0.90, 1.25, 1.90],
    "clipSpace": [0, 1],
    "snapTexels": [0.0, 0.5, 1.1],
    "confMotionGate": [0.25, 0.6, 1.5],
    "sharpenAmount": [0.70, 1.00, 1.35],
    "detailMotion": [0.004, 0.010, 0.030],
    "detailReactive": [0.50, 0.80, 1.00],
}


# GPU readback, not page.screenshot(): the compositor lags hand-stepped
# frames and produced a fictitious 128-frame "settling".  See harness.py.
def shot(page):
    return grab_img(page, (0, 100, 1280, 700))


def detail(img):
    return ImageStat.Stat(ImageChops.difference(img, img.filter(
        ImageFilter.GaussianBlur(1.2)))).mean[0]


def measure(page, frames=6):
    """One deterministic reading: mean frame-to-frame difference, and the
    high-frequency energy of the last frame."""
    page.evaluate("window.__pauseRender()")
    try:
        page.evaluate("window.__advance(4)")
        prev = shot(page)
        acc = 0.0
        for _ in range(frames):
            page.evaluate("window.__advance(1)")
            cur = shot(page)
            acc += ImageStat.Stat(ImageChops.difference(cur, prev)).mean[0]
            prev = cur
        return acc / frames, detail(prev)
    finally:
        page.evaluate("window.__resumeRender()")


def candidates(base):
    out = [("base", dict(base))]
    seen = {json.dumps(base, sort_keys=True)}
    for key, vals in AXES.items():
        for v in vals:
            c = dict(base)
            if key not in c:
                continue          # a knob this build does not have
            c[key] = v
            sig = json.dumps(c, sort_keys=True)
            if sig in seen:
                continue
            seen.add(sig)
            out.append((f"{key}={v}", c))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="high")
    ap.add_argument("--round", type=int, default=1)
    ap.add_argument("--mode", default="reproject",
                    choices=["reproject", "jittered"])
    ap.add_argument("--webgl", action="store_true")
    ap.add_argument("--only-extra", action="store_true",
                    help="evaluate only the --extra candidates, not the axes")
    ap.add_argument("--extra", default=None,
                    help="JSON file of additional {name: params} to evaluate")
    ap.add_argument("--out", default="sweep_results.json")
    a = ap.parse_args()

    flags = ["--ignore-gpu-blocklist", "--use-angle=default"]
    url = f"http://127.0.0.1:5390/index.html?tier={a.tier}"
    if a.webgl:
        url += "&webgl=1"
    else:
        flags += ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"]

    results = {}
    with sync_playwright() as pw:
        br = pw.chromium.launch(channel="chrome", headless=True, args=flags)
        page = br.new_page(viewport={"width": 1280, "height": 720})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_function("window.__booted === true", timeout=300000)
        page.wait_for_function("window.__ready === true", timeout=300000)
        page.evaluate("window.__lockStep(1/60)")
        page.evaluate("window.__setLightning(false)")

        page.evaluate("window.__setSea('%s')" % INITIAL_SEA)
        page.evaluate("window.__settleSea(90)")
        page.wait_for_function("window.__ready === true", timeout=180000)

        page.evaluate("window.__taaMode(%d)"
                      % {"reproject": 1, "jittered": 2}[a.mode])
        print(f"mode: {a.mode}")

        base = page.evaluate("window.__taa.params()")
        cands = [] if a.only_extra else candidates(base)
        if a.extra:
            with open(a.extra) as fh:
                for name, prm in json.load(fh).items():
                    c = dict(base)
                    c.update(prm)
                    cands.append((name, c))
        print(f"{len(cands)} candidates x {len(STATIONS)} stations + ghost")
        print(f"base (read from the running build): {json.dumps(base)}\n")
        results.update({n: {"params": p, "stations": {}} for n, p in cands})
        page.evaluate("""window.__panStep = (n, rate) => {
            const c = window.__app.camera.camera;
            for (let i = 0; i < n; i++) { c.rotation.y += rate; window.__advance(1); }
        };""")

        def rewind():
            page.evaluate("window.__ocean.sim.time = 137.0")
            page.evaluate("window.__resetFoam(90)")
            page.wait_for_timeout(250)

        def taa(on):
            page.evaluate("window.__taa.enabled = %s; window.__taa.reset();"
                          % ("true" if on else "false"))
            page.wait_for_timeout(300)
            # an accumulation buffer converges in FRAMES, not milliseconds
            page.evaluate("window.__pauseRender(); window.__advance(48);"
                          "window.__resumeRender();")

        def goto(preset, st):
            if preset:
                page.evaluate("window.__setPreset('%s')" % preset)
            page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % st)
            page.wait_for_function("window.__ready === true", timeout=180000)
            page.evaluate("window.__app.sky.autoExposure = false")
            page.evaluate("window.__settleScene(90)")
            page.wait_for_function("window.__ready === true", timeout=180000)

        # ---- stations outer, candidates inner ------------------------------
        for label, preset, st, _reps in STATIONS:
            goto(preset, st)
            # One discarded measurement per station.  The first candidate
            # measured after arriving pays for whatever has not finished
            # converging there, and it showed: the first row of every table came
            # back with an impossible number (underwater -609%) while the same
            # parameters measured normally anywhere else in the run.
            page.evaluate("window.__taa.setParams(%s)" % json.dumps(cands[0][1]))
            rewind(); taa(False); measure(page)
            rewind(); taa(True); measure(page)
            base_sh = None
            for name, prm in cands:
                page.evaluate("window.__taa.setParams(%s)" % json.dumps(prm))
                rewind(); taa(False)
                off_sh, off_det = measure(page)
                rewind(); taa(True)
                on_sh, on_det = measure(page)
                if base_sh is None:
                    base_sh = off_sh
                    print(f"{label:14s} baseline  shimmer {off_sh:7.3f}  "
                          f"detail {off_det:6.3f}")
                results[name]["stations"][label] = {
                    "shimmer": 100.0 * (1 - on_sh / max(off_sh, 1e-9)),
                    "detail": on_det / max(off_det, 1e-9),
                    "off": off_sh,
                }
            drift = max(r["stations"][label]["off"] for r in results.values()) / \
                max(min(r["stations"][label]["off"] for r in results.values()), 1e-9)
            print(f"{'':14s} {len(cands)} candidates measured, "
                  f"baseline drifted {100 * (drift - 1):.0f}% across the run")

        # ---- ghost ---------------------------------------------------------
        preset, st = GHOST_STATION.preset, GHOST_STATION.view
        goto(preset, st)
        # Measured with the SIMULATION FROZEN, and against a reference taken
        # from the same frozen state.  Two earlier versions of this measured
        # something else entirely: a shared reference captured in its own run
        # was 48 frames out of phase, and even a per-candidate one taken 8
        # frames later was mostly ordinary wave motion -- which is why the whole
        # table read ~13.7 no matter what the history parameters were.
        for name, prm in cands:
            page.evaluate("window.__taa.setParams(%s)" % json.dumps(prm))
            rewind()
            page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % st)
            taa(True)
            page.evaluate("window.__lockStep(-1)")
            page.evaluate("window.__pauseRender()")
            page.evaluate("window.__advance(12)")
            page.evaluate("window.__panStep(40, 0.05)")
            page.evaluate("window.__advance(6)")
            settled = shot(page)
            # Truth = the same renderer with HISTORY disabled, not with the
            # whole filter disabled.  Switching `enabled` off also switches the
            # projection jitter off, so the reference was sampled on a different
            # sub-pixel grid than the image under test, and the difference
            # measured sampling as well as trailing: every jittered candidate
            # scored ~8.3 including one with no sharpening whatsoever.
            page.evaluate("window.__taa.setParams({historyMin: 0, historyMax: 0});"
                          "window.__taa.reset();")
            page.evaluate("window.__advance(2)")
            truth = shot(page)
            page.evaluate("window.__resumeRender()")
            page.evaluate("window.__lockStep(1/60)")
            results[name]["ghost"] = ImageStat.Stat(
                ImageChops.difference(settled, truth)).mean[0]
            # A trail is a LOW-frequency ghost of content that moved; a
            # difference in display sharpening is high-frequency.  The raw
            # number cannot tell them apart -- it charged a stable-source
            # sharpen 8.6 against 2.4 for a current-frame one at similar
            # trailing -- so the same difference is also measured with both
            # images blurred, where sharpening cancels and a trail does not.
            b = ImageFilter.GaussianBlur(1.6)
            results[name]["ghostLF"] = ImageStat.Stat(ImageChops.difference(
                settled.filter(b), truth.filter(b))).mean[0]
        print(f"{'ghost':14s} {len(cands)} candidates measured\n")

        if errs:
            print("PAGE ERRORS:", errs[0][:140])
        br.close()

    # ---- verdict -----------------------------------------------------------
    for name, r in results.items():
        dets = [v["detail"] for v in r["stations"].values()]
        shs = [v["shimmer"] for v in r["stations"].values()]
        r["minDetail"] = min(dets)
        r["minShimmer"] = min(shs)
        r["meanShimmer"] = sum(shs) / len(shs)
        why = []
        if r["minDetail"] < MIN_DETAIL:
            why.append(f"detail {100 * r['minDetail']:.0f}%")
        if r["ghost"] > MAX_GHOST:
            why.append(f"ghost {r['ghost']:.2f}")
        if r["minShimmer"] < MIN_SHIMMER:
            why.append(f"shimmer {r['minShimmer']:+.0f}%")
        r["rejected"] = why

    with open(a.out, "w") as fh:
        json.dump(results, fh, indent=1)

    survivors = {n: r for n, r in results.items() if not r["rejected"]}
    order = sorted(results.items(), key=lambda kv: -kv[1]["meanShimmer"])

    hdr = f"{'candidate':26s} {'detail':>7s} {'ghost':>6s} {'ghstLF':>5s} " + \
          " ".join(f"{lbl.split()[0]:>7s}" for lbl, _, _, _ in STATIONS) + "   verdict"
    print(hdr)
    print("-" * len(hdr))
    for name, r in order:
        cells = " ".join(f"{r['stations'][lbl]['shimmer']:+6.0f}%"
                         for lbl, _, _, _ in STATIONS)
        verdict = "PASS" if not r["rejected"] else "reject: " + ", ".join(r["rejected"])
        print(f"{name:26s} {100 * r['minDetail']:6.0f}% {r['ghost']:6.2f} "
              f"{r.get('ghostLF', 0):5.2f} {cells}   {verdict}")

    print(f"\n{len(survivors)}/{len(results)} candidates satisfy "
          f"detail >= {100 * MIN_DETAIL:.0f}%, ghost <= {MAX_GHOST}, "
          f"every station >= {MIN_SHIMMER:.0f}%")
    if survivors:
        print("\nPareto set (no other survivor beats these on every axis):")
        for name, r in sorted(survivors.items(), key=lambda kv: -kv[1]["meanShimmer"]):
            dominated = any(
                o is not r and o["minDetail"] >= r["minDetail"]
                and o["ghost"] <= r["ghost"] and o["meanShimmer"] >= r["meanShimmer"]
                and (o["minDetail"], -o["ghost"], o["meanShimmer"])
                != (r["minDetail"], -r["ghost"], r["meanShimmer"])
                for o in survivors.values())
            if not dominated:
                print(f"  {name:24s} detail {100 * r['minDetail']:.0f}%  "
                      f"ghost {r['ghost']:.2f}  mean shimmer {r['meanShimmer']:+.0f}%")
                print(f"    {json.dumps(r['params'])}")
    else:
        print("\nNo candidate passes yet. The per-axis table above says which "
              "direction each knob wants; compose a candidate from the best of "
              "each and re-run with --extra.")
        sys.exit(1)


if __name__ == "__main__":
    main()
