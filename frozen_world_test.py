#!/usr/bin/env python3
"""
frozen_world_test.py -- the fundamental determinism gate.

    py -3.14 frozen_world_test.py [--tier high] [--frames 24] [--bisect]

With TAA_NONE, dt = 0, a fixed camera, fixed resolution, fixed exposure and no
history anywhere, consecutive rendered frames must be the same picture.  Every
frozen-scene measurement in this project -- convergence, persistence, fidelity --
is built on that assumption, and none of them mean anything until it holds.

It did not hold: the no-history persistence floor measured ~9.9 RMS, larger than
the persistence of every mode including a deliberately broken one, which
collapsed the whole matrix below the floor.

This file does not tune anything.  It measures consecutive frames, reports RMS,
maximum difference, changed-pixel percentage and a heatmap, and prints a
renderer-state fingerprint diff so a moving subsystem names itself instead of
being diagnosed by eye.  With --bisect it disables subsystems one at a time and
reports which removal collapses the floor.
"""
import argparse
import io as _io
import sys

from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import sync_playwright

from harness import grab_img

CROP = (0, 100, 1280, 700)
VIEW = (0, 2.0, 0, 3, 30)

# label -> JS that disables that subsystem.  Deliberately disable-and-measure
# only; nothing here tunes anything.
SUBSYSTEMS = {
    "legacy spray": "if (window.__ocean.spray && window.__ocean.spray.all)"
                    " for (const p of window.__ocean.spray.all)"
                    " { if (p.isStarted && p.isStarted()) p.stop(); }",
    "particle fields": "if (window.__ocean.effects)"
                       " for (const f of window.__ocean.effects.fields)"
                       " { f.enabled = false; if (f.mesh) f.mesh.setEnabled(false); }",
    "foam field": "window.__ocean.foam.clear();",
    "planar reflection": "if (window.__ocean.reflection &&"
                         " window.__ocean.reflection.rt)"
                         " window.__ocean.reflection.rt.refreshRate = 0;",
    "breakers": "if (window.__ocean.breakers) window.__ocean.breakers.enabled = false;",
    "underwater post": "window.__ocean.underwater.enabled = false;",
}


# GPU readback, not page.screenshot(): the compositor lags hand-stepped
# frames and produced a fictitious 128-frame "settling".  See harness.py.
def shot(page):
    return grab_img(page, CROP)



def compare(a, b):
    d = ImageChops.difference(a, b)
    st = ImageStat.Stat(d)
    hist = d.histogram()
    n = sum(hist)
    changed = sum(hist[1:]) / n
    return dict(rms=st.rms[0], mean=st.mean[0], mx=d.getextrema()[1],
                changed=changed, img=d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="high")
    ap.add_argument("--frames", type=int, default=24)
    ap.add_argument("--bisect", action="store_true")
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
        page.evaluate("window.__taa.enabled = true; window.__taaMode(0)")
        page.evaluate("window.__setSea('rough')")
        page.evaluate("window.__settleSea(60)")
        page.wait_for_function("window.__ready === true", timeout=180000)
        page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % VIEW)
        page.wait_for_function("window.__ready === true", timeout=180000)

        def freeze():
            return page.evaluate("window.__freezeWorld()")

        def run(label, extra_js=None):
            """Consecutive-frame differences with the world frozen."""
            freeze()
            if extra_js:
                page.evaluate(extra_js)
            page.wait_for_timeout(500)
            page.evaluate("window.__pauseRender(); window.__advance(40)")
            f0 = page.evaluate("window.__stateFingerprint()")
            prev = shot(page)
            worst, acc, chg, mxd = None, 0.0, 0.0, 0
            for _ in range(a.frames):
                page.evaluate("window.__advance(1)")
                cur = shot(page)
                c = compare(prev, cur)
                acc += c["rms"]; chg = max(chg, c["changed"]); mxd = max(mxd, c["mx"])
                if worst is None or c["rms"] > worst["rms"]:
                    worst = c
                prev = cur
            f1 = page.evaluate("window.__stateFingerprint()")
            page.evaluate("window.__resumeRender()")
            moved = {k: (f0[k], f1[k]) for k in f0
                     if k not in ("renderFrame",) and f0[k] != f1[k]}
            return dict(rms=acc / a.frames, changed=chg, mx=mxd,
                        worst=worst["img"], moved=moved, stopped=f0)

        base = run("baseline")
        print(f"\n  frozen world, TAA_NONE, {a.frames} consecutive frames:")
        print(f"    mean frame-to-frame RMS   {base['rms']:.4f}")
        print(f"    worst single-pixel delta  {base['mx']} / 255")
        print(f"    changed pixels (worst)    {100 * base['changed']:.2f}%")
        if base["moved"]:
            print("    STATE THAT MOVED WHILE FROZEN:")
            for k, (v0, v1) in base["moved"].items():
                print(f"      {k}: {v0}  ->  {v1}")
        else:
            print("    no tracked state changed")
        base["worst"].point(lambda v: min(255, v * 12)).save(
            "shots/frozen_world_diff.png")
        print("    heatmap -> shots/frozen_world_diff.png (x12)")

        if a.bisect and base["rms"] > 0.05:
            print("\n  bisection -- disable one subsystem, re-measure:")
            for label, js in SUBSYSTEMS.items():
                r = run(label, js)
                drop = 100 * (1 - r["rms"] / max(base["rms"], 1e-9))
                print(f"    without {label:20s} RMS {r['rms']:7.4f}  "
                      f"({drop:+5.0f}%)  changed {100*r['changed']:5.2f}%")
                # reload to undo the disable cleanly
                page.goto(url, wait_until="domcontentloaded")
                page.wait_for_function("window.__booted === true", timeout=300000)
                page.wait_for_function("window.__ready === true", timeout=300000)
                page.evaluate("window.__taa.enabled = true; window.__taaMode(0)")
                page.evaluate("window.__setSea('rough')")
                page.evaluate("window.__settleSea(60)")
                page.wait_for_function("window.__ready === true", timeout=180000)
                page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % VIEW)
                page.wait_for_function("window.__ready === true", timeout=180000)

        # ---- long horizon --------------------------------------------------
        # Consecutive frames are not enough.  The drift here is SLOW and
        # SYSTEMATIC -- about 0.022 RMS per rendered frame -- so a
        # frame-to-frame gate passes it while two renders separated by a few
        # hundred frames sit several RMS apart.  That is what keeps the
        # persistence floor at ~12 RMS: within one measurement the settled
        # reference and the decay samples are inherently ~520 frames apart.
        page.evaluate("window.__freezeWorld()")
        page.wait_for_timeout(400)
        page.evaluate("window.__pauseRender(); window.__advance(40)")
        anchor = shot(page)
        horizon = {}
        seen = 0
        for n in (60, 240, 520):
            page.evaluate(f"window.__advance({n - seen})")
            seen = n
            horizon[n] = compare(anchor, shot(page))["rms"]
        page.evaluate("window.__resumeRender()")
        print()
        print("  drift against absolute frame count (frozen, TAA_NONE):")
        for n, v in horizon.items():
            print(f"    +{n:4d} frames   {v:7.3f} RMS   "
                  f"({v / n:.4f} per frame)")

        print()
        check("frozen world is path independent over 520 frames",
              horizon[520] < 1.0,
              f"{horizon[520]:.3f} RMS after 520 frames "
              f"({horizon[520] / 520:.4f}/frame) -- any comparison of two "
              f"renders separated in time inherits this")
        check("a frozen world renders the same picture twice",
              base["rms"] < 0.5,
              f"{base['rms']:.4f} RMS, max delta {base['mx']}, "
              f"{100*base['changed']:.2f}% of pixels changed")
        check("no tracked state advances while frozen", not base["moved"],
              ", ".join(base["moved"]) if base["moved"] else "all stationary")
        check("no page errors", not errs, errs[0][:110] if errs else "")
        br.close()

    if fails:
        print("\nFAILED: " + ", ".join(fails))
        print("Frozen-world determinism is the prerequisite for persistence "
              "analysis; do not resume TAA work until it passes.")
        sys.exit(1)
    print("\nFROZEN-WORLD DETERMINISM: PASS")


if __name__ == "__main__":
    main()
