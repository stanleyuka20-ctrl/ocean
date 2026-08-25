#!/usr/bin/env python3
"""
ghost_test.py -- history PERSISTENCE after motion stops, and the certification
of the estimator that measures it.

    py -3.14 ghost_test.py [--tier high] [--reps 5] [--window 64]

WHAT A TRAIL IS
---------------
Content that should have gone, still lingering.  It is a temporal property, so
it is measured temporally: freeze the world, converge, pan deterministically,
stop dead, and watch the image decay toward where that renderer itself settles.
The old ghost number compared against a single-sample image and therefore scored
antialiasing as though it were trailing; it is retired.

WHY THE ESTIMATOR CHANGED
-------------------------
The first version subtracted each mode's OWN settled tail:

    excess(t) = E(t) - candidateTail

For a mode that converges quickly those two quantities are nearly equal, so the
result was a difference of near-equal numbers.  Measured over three repetitions
of identical code the production jittered mode's area moved 128x while the
deliberately broken control moved 1.3x -- the estimator was reporting noise.

Now the floor is measured SEPARATELY, from the no-history control under the
identical scenario, and never from the candidate itself:

    F      = median of NO_HISTORY's stationary tail, pooled over repetitions
    sigma  = MAD of that same pool          (robust noise scale)
    P(t)   = max(E(t) - F, 0)
    Pnorm  = P(t) / max(P(0), k * sigma)

If P(0) does not clear the noise scale the answer is BELOW_MEASUREMENT_FLOOR --
the instrument cannot resolve persistence above the non-history baseline.  That
is a success condition, not missing data, and no half-life is manufactured for
it.
"""
import argparse
import io as _io
import json as _json
import sys
from statistics import median

from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import sync_playwright

from harness import grab_img

CROP = (0, 100, 1280, 700)
SAMPLES = [0, 1, 2, 4, 8, 16, 32]
FLOOR_FRAMES = [16, 24, 32, 48, 64]      # stationary tail, no-history control
NOISE_K = 3.0                            # epsilon = NOISE_K * robust sigma

# One definition, in the app: window.__freezeWorld().  Every harness used
# to carry its own copy and they drifted -- none of them stopped the legacy
# spray systems, which advance per RENDERED frame regardless of dt and put
# ~9.9 RMS into the no-history floor.
FREEZE = """() => window.__freezeWorld()"""

# ONE argument: page.evaluate passes a single value, so a two-parameter arrow
# receives the whole list as its first parameter and undefined as its second.
PAN = """([n, rate]) => {
    const c = window.__app.camera.camera;
    const before = window.__app.frames;
    for (let i = 0; i < n; i++) { c.rotation.y += rate; window.__advance(1); }
    return { drawn: window.__app.frames - before, yaw: c.rotation.y };
}"""

# keepCeil MUST be raised too.  The resolve clamps keep to a ceiling, and
# while that ceiling was hard-coded at 0.97 this "0.995 history" control
# was silently clamped straight back to production's own maximum -- so the
# deliberately broken build was really production at full history, and the
# certification correctly reported that it was not the worst persistence in
# the matrix.  A control that cannot reach the failure mode it represents
# certifies nothing.
BROKEN = {"historyMin": 0.995, "historyMax": 0.995, "keepCeil": 0.998,
          "reactiveScale": 0.0,
          "ghostRejection": 0.0, "uncoveredConf": 1.0, "motionFalloff": 0.0,
          "edgeFalloff": 0.0, "varHistScale": 0.0, "varianceGamma": 40.0}

START = (0, 2.0, 0, 3, 30)
PAN_STEPS, PAN_RATE = 40, 0.05


# GPU readback, not page.screenshot(): the compositor lags hand-stepped
# frames and produced a fictitious 128-frame "settling".  See harness.py.
def shot(page):
    return grab_img(page, CROP)


def rms(a, b):
    return ImageStat.Stat(ImageChops.difference(a, b)).rms[0]


def mad(vals):
    m = median(vals)
    return median([abs(v - m) for v in vals]) * 1.4826 or 1e-6


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="high")
    ap.add_argument("--reps", type=int, default=5)
    ap.add_argument("--window", type=int, default=64)
    a = ap.parse_args()

    flags = ["--ignore-gpu-blocklist", "--use-angle=default",
             "--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"]
    url = f"http://127.0.0.1:5390/index.html?tier={a.tier}"

    fails = []

    def check(name, ok, why=""):
        print(f"{'PASS' if ok else 'FAIL'}  {name:48s} {why}")
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
        page.evaluate("window.__taa.enabled = true")
        page.evaluate("window.__setSea('rough')")
        page.evaluate("window.__settleSea(60)")
        page.wait_for_function("window.__ready === true", timeout=180000)
        page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % START)
        page.wait_for_function("window.__ready === true", timeout=180000)
        page.evaluate(FREEZE)
        page.wait_for_timeout(1000)

        # ---- assertion: nothing but the camera may move ---------------------
        page.evaluate("window.__taaMode(0)")
        page.evaluate("window.__pauseRender(); window.__advance(30)")
        _a = shot(page)
        page.evaluate("window.__advance(120)")
        drift = rms(_a, shot(page))
        page.evaluate("window.__resumeRender()")
        # ~5% of the ~40 RMS pan-induced change this decay is measured against.
        check("world frozen after stop", drift < 2.0,
              f"{drift:.3f} RMS over 120 frames, no history")

        def configure(mode, params=None, profile=None):
            page.evaluate(f"window.__taaMode({mode})")
            if profile:
                page.evaluate(f"window.__taaProfile('{profile}')")
            if params:
                page.evaluate("window.__taa.setParams(%s)" % _json.dumps(params))

        def settled_reference():
            """Where this renderer settles at the final pose, from a CLEAN
            history, reached by the same route as the measurement.

            The reference must sit at the same total frame count as the decay
            run.  Jumping the camera to the end pose instead cost 240 frames of
            the world's slow residual drift, and that difference landed in the
            no-history floor: F measured 4.99 RMS, larger than the persistence
            of every mode including the deliberately broken one, so the whole
            matrix read BELOW_MEASUREMENT_FLOOR.  Panning there and THEN
            clearing the history gives a clean accumulation at the same world
            state."""
            page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % START)
            page.evaluate("window.__pauseRender(); window.__advance(240)")
            page.evaluate(PAN, [PAN_STEPS, PAN_RATE])
            page.evaluate("window.__taa.reset()")
            page.evaluate("window.__advance(240); window.__resumeRender();")
            page.wait_for_timeout(100)
            return shot(page)

        def decay(mode, params=None, profile=None, frames=None):
            """E(t) against this mode's own settled reference."""
            configure(mode, params, profile)
            ref = settled_reference()

            # 480, not 240: the reference path runs 240 + pan + 240 frames, so
            # the measurement must reach its frame 0 at the SAME total frame
            # count.  There is a slow per-frame drift in the renderer -- about
            # 0.02 RMS a frame, invisible to a consecutive-frame test and
            # unaffected by disabling reflection, refraction, foam, breakers,
            # underwater or LOD -- and over a 240-frame path difference it
            # accumulated to ~4.8 RMS, which became the persistence floor and
            # sank every mode below it.  Equal path lengths cancel it.
            page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % START)
            page.evaluate("window.__taa.reset()")
            page.wait_for_timeout(120)
            page.evaluate("window.__pauseRender(); window.__advance(480)")
            info = page.evaluate(PAN, [PAN_STEPS, PAN_RATE])
            want = frames if frames is not None else SAMPLES
            out, at = [], 0
            for n in want:
                if n > at:
                    page.evaluate(f"window.__advance({n - at})")
                    at = n
                out.append(rms(shot(page), ref))
            page.evaluate("window.__resumeRender()")
            return out, info["drawn"]

        CANDIDATES = [
            ("NO_HISTORY", 0, None, None),
            ("REPROJECT", 1, None, None),
            ("JITTER_PROFILE_A", 2, None, "A_PRE_STABLE"),
            ("JITTER_PROFILE_B", 2, None, "B_STABLE_SOURCE"),
            ("BROKEN_0.995", 2, BROKEN, None),
        ]

        floor_pool, drawn_ok = [], True
        raw = {c[0]: [] for c in CANDIDATES}
        for i in range(a.reps):
            print(f"  repetition {i + 1}/{a.reps}")
            f, d = decay(0, frames=FLOOR_FRAMES)
            floor_pool.extend(f)
            drawn_ok = drawn_ok and d == PAN_STEPS
            for label, mode, params, prof in CANDIDATES:
                e, d = decay(mode, params, prof)
                raw[label].append(e)
                drawn_ok = drawn_ok and d == PAN_STEPS

        F = median(floor_pool)
        sigma = mad(floor_pool)
        eps = NOISE_K * sigma
        print(f"\n  no-history floor F = {F:.3f} RMS, robust sigma = "
              f"{sigma:.3f}, epsilon = {eps:.3f}\n")

        results = {}
        for label, _, _, _ in CANDIDATES:
            per_rep = []
            for e in raw[label]:
                P = [max(v - F, 0.0) for v in e]
                if P[0] <= eps:
                    per_rep.append(None)          # below measurement floor
                    continue
                pn = [v / P[0] for v in P]
                auc = sum(0.5 * (pn[i] + pn[i - 1]) * (SAMPLES[i] - SAMPLES[i - 1])
                          for i in range(1, len(SAMPLES)))

                def first(t, pn=pn):
                    for n, v in zip(SAMPLES, pn):
                        if v <= t:
                            return n
                    return None
                per_rep.append(dict(auc=auc, half=first(0.5), r90=first(0.10),
                                    r95=first(0.05), residual=pn[-1], p0=P[0]))
            ok = [r for r in per_rep if r]
            if not ok:
                results[label] = dict(floored=True, n=len(per_rep))
                print(f"  {label:18s} BELOW_MEASUREMENT_FLOOR "
                      f"({len(per_rep)}/{len(per_rep)} repetitions)")
                continue
            aucs = [r["auc"] for r in ok]
            spread = max(aucs) / max(min(aucs), 1e-6)
            results[label] = dict(
                floored=False, auc=median(aucs), spread=spread,
                half=median([r["half"] or 99 for r in ok]),
                r90=median([r["r90"] or 99 for r in ok]),
                r95=median([r["r95"] or 99 for r in ok]),
                residual=median([r["residual"] for r in ok]),
                p0=median([r["p0"] for r in ok]),
                floored_reps=len(per_rep) - len(ok), n=len(per_rep))
            r = results[label]
            print(f"  {label:18s} AUC {r['auc']:6.2f} (spread {spread:4.1f}x)  "
                  f"half-life {r['half']:>2}  90% {r['r90']:>2}  "
                  f"95% {r['r95']:>2}  residual@32 {r['residual']:.3f}"
                  + (f"  [{r['floored_reps']} reps at floor]"
                     if r["floored_reps"] else ""))

        # ---- certify the instrument -----------------------------------------
        print()
        check("pan actually rendered", drawn_ok,
              f"{PAN_STEPS} frames per pan, every mode, every repetition")
        nh, brk = results["NO_HISTORY"], results["BROKEN_0.995"]
        check("no-history floor stability",
              sigma < 0.5 * max(F, 1e-6) or sigma < 0.5,
              f"F {F:.3f} +/- {sigma:.3f} RMS over {len(floor_pool)} tail samples")
        check("broken control separates from the floor",
              (not brk["floored"])
              and (nh["floored"] or brk["auc"] > nh["auc"] * 3.0),
              f"broken AUC {brk.get('auc', float('nan')):.2f} vs no-history "
              + ("BELOW_FLOOR" if nh["floored"] else f"{nh['auc']:.2f}"))
        prod = [results[k] for k in ("JITTER_PROFILE_A", "JITTER_PROFILE_B")]
        check("production repeatability",
              all(p["floored"] or p["spread"] < 2.0 for p in prod),
              ", ".join(f"{k} " + ("floored" if results[k]["floored"]
                                   else f"{results[k]['spread']:.1f}x")
                        for k in ("JITTER_PROFILE_A", "JITTER_PROFILE_B")))
        check("broken control is the worst measurable persistence",
              (not brk["floored"]) and all(
                  p["floored"] or brk["auc"] > p["auc"] for p in prod),
              f"broken {brk.get('auc', 0):.2f} vs A "
              + ("floored" if prod[0]["floored"] else f"{prod[0]['auc']:.2f}")
              + ", B "
              + ("floored" if prod[1]["floored"] else f"{prod[1]['auc']:.2f}"))
        check("no page errors", not errs, errs[0][:110] if errs else "")
        br.close()

    if fails:
        print("\nFAILED: " + ", ".join(fails))
        print("The persistence instrument is NOT certified; do not quote it.")
        sys.exit(1)
    print("\nPERSISTENCE INSTRUMENT: CERTIFIED")


if __name__ == "__main__":
    main()
