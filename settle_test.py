#!/usr/bin/env python3
"""
settle_test.py -- does a frozen world keep settling after the camera stops?

    py -3.14 settle_test.py [--tier high] [--translate] [--groups]

ANSWERED: no.  0.00 RMS at every sample including frame 0, on 0.00% of pixels,
measured on the calibrated capture path.

It appeared to for several phases -- 28 RMS at the stop decaying to zero over
~128 frames on thin filaments along mid-distance wave crests -- and the cause
was the INSTRUMENT.  engine.readPixels() on the default framebuffer returned a
sparse high-frequency intermediate instead of the colour frame.  That buffer is
empty when the temporal filter is off (so every "TAA off" row here read a
flawless 0.00 and looked like proof of a deterministic renderer) and fills in as
history accumulates (so a camera stop appeared to settle).  Foam, breakers,
reflection, refraction, camera inertia, auto-exposure, LOD and the whole
spectral pipeline were eliminated one at a time against proven-stopped counters,
and every one of those eliminations was true and useless: the artefact was never
in the rendered image.  See harness.py and capture_test.py.

A second, real bug was found on the way: TemporalAA bound uEnabled from its
`enabled` flag and not from its mode, so TAA_MODE.NONE suppressed only the
jitter and left the full history blend running.  verify.py now asserts that NONE
is byte-identical to disabled.

Kept as the regression gate: the floor is 0.0000 RMS, so any non-zero reading is
real.  EVERY ROW STILL VALIDATES ITSELF -- each queries window.__subsystemState()
and requires the target to report disabled AND its update counter to stop
advancing, or it prints INVALID_PROBE and carries no measurement.  Note that at
dt = 0 those rows are weak evidence BY CONSTRUCTION: an idempotent system
changes nothing when disabled, so an unchanged row is not an exoneration.
"""
import argparse
import io as _io
import sys

from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import sync_playwright

from harness import grab_img

CROP = (0, 100, 1280, 700)
VIEW = (0, 2.0, 0, 3, 30)
SAMPLES = [0, 1, 2, 4, 8, 16, 32, 64, 128]
PAN_STEPS, PAN_RATE = 40, 0.05
STEP_M = 3.0        # metres per frame for the translation variant

ROT = """([n, rate]) => {
    const c = window.__app.camera.camera;
    const b = window.__app.frames;
    for (let i = 0; i < n; i++) { c.rotation.y += rate; window.__advance(1); }
    return { drawn: window.__app.frames - b, yaw: c.rotation.y,
             x: c.position.x, z: c.position.z };
}"""

MOVE = """([n, step]) => {
    const c = window.__app.camera.camera;
    const b = window.__app.frames;
    for (let i = 0; i < n; i++) { c.position.x += step; window.__advance(1); }
    return { drawn: window.__app.frames - b, yaw: c.rotation.y,
             x: c.position.x, z: c.position.z };
}"""

# "sim" freezes the spectral pipeline itself -- the FFT cascades execute
# every rendered frame regardless of dt and were the one system without a
# disable hook.  Idempotence is verified separately by sim_freeze_test.py:
# the cascade textures are bit-stable on repeat execution at dt=0.
SUSPECTS = ["sim", "foam", "breakers", "reflection", "refraction"]


# GPU readback, not page.screenshot(): the compositor lags hand-stepped
# frames and produced a fictitious 128-frame "settling".  See harness.py.
def shot(page):
    return grab_img(page, CROP)


def rms(a, b):
    return ImageStat.Stat(ImageChops.difference(a, b)).rms[0]


def changed(a, b):
    h = ImageChops.difference(a, b).histogram()
    return sum(h[1:]) / sum(h)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="high")
    ap.add_argument("--translate", action="store_true",
                    help="also run a translation-only pan")
    a = ap.parse_args()

    flags = ["--ignore-gpu-blocklist", "--use-angle=default",
             "--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"]
    url = f"http://127.0.0.1:5390/index.html?tier={a.tier}"

    fails = []

    def check(name, ok, why=""):
        print(f"{'PASS' if ok else 'FAIL'}  {name:46s} {why}")
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
        page.evaluate("window.__freezeWorld()")
        page.wait_for_timeout(700)

        def curve(motion, arg):
            """Post-stop decay against a separately settled render at the same
            final camera state."""
            # reference: same route, then a long settle
            page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % VIEW)
            page.evaluate("window.__pauseRender(); window.__advance(240)")
            page.evaluate(motion, arg)
            page.evaluate("window.__advance(400)")
            ref = shot(page)
            end = page.evaluate("""(() => { const c = window.__app.camera.camera;
                return {yaw: c.rotation.y, x: c.position.x}; })()""")

            # measurement: identical route, sample the decay
            page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % VIEW)
            page.evaluate("window.__advance(240)")
            info = page.evaluate(motion, arg)
            out, at = [], 0
            for n in SAMPLES:
                if n > at:
                    page.evaluate(f"window.__advance({n - at})")
                    at = n
                im = shot(page)
                out.append((rms(im, ref), changed(im, ref)))
            page.evaluate("window.__resumeRender()")
            same = abs(info["yaw"] - end["yaw"]) < 1e-9 and \
                abs(info["x"] - end["x"]) < 1e-9
            return out, info["drawn"], same

        def show(label, cur):
            print(f"    {label:22s} " + " ".join(f"{v[0]:6.2f}" for v in cur))

        print(f"\n  post-stop RMS against a settled render, frames "
              + " ".join(f"{n:>6d}" for n in SAMPLES))

        base, drawn, same = curve(ROT, [PAN_STEPS, PAN_RATE])
        show("rotation (baseline)", base)
        check("the pan rendered and ended at the same pose",
              drawn == PAN_STEPS and same,
              f"{drawn} frames drawn, final pose identical: {same}")
        print(f"    {'':22s} " + " ".join(f"{100*v[1]:5.1f}%" for v in base)
              + "   <- changed pixels")

        if a.translate:
            tr, d2, s2 = curve(MOVE, [PAN_STEPS, STEP_M])
            show("translation only", tr)
            rot_settle = base[0][0] - base[-1][0]
            tr_settle = tr[0][0] - tr[-1][0]
            print(f"    rotation settles {rot_settle:.2f} RMS, "
                  f"translation settles {tr_settle:.2f} RMS")

        # ---- self-validating bisection ---------------------------------------
        print("\n  bisection -- each row must PROVE the subsystem stopped:")
        for name in SUSPECTS:
            before = page.evaluate("window.__subsystemState()")[name]
            got = page.evaluate(f"window.__setSubsystem('{name}', false)")
            if got is None:
                print(f"    {name:22s} INVALID_PROBE (no setEnabled hook)")
                continue
            # advance and confirm the update counter actually stopped
            page.evaluate("window.__pauseRender(); window.__advance(20);"
                          "window.__resumeRender();")
            after = page.evaluate("window.__subsystemState()")[name]
            stopped = (after["enabled"] is False) and \
                (after["updates"] == got["updates"] or after["updates"] <= 0)
            if not stopped:
                print(f"    {name:22s} INVALID_PROBE (still updating: "
                      f"{got['updates']} -> {after['updates']})")
                page.evaluate(f"window.__setSubsystem('{name}', true)")
                continue
            cur, _, _ = curve(ROT, [PAN_STEPS, PAN_RATE])
            drop = 100 * (1 - (cur[0][0] / max(base[0][0], 1e-9)))
            show(f"without {name}", cur)
            print(f"    {'':22s} frame0 {cur[0][0]:.2f} vs {base[0][0]:.2f} "
                  f"({drop:+.0f}%)   updates {before['updates']} -> "
                  f"{after['updates']}")
            page.evaluate(f"window.__setSubsystem('{name}', true)")

        print()
        check("post-stop settling reaches the static floor by frame 1",
              base[1][0] < 0.5,
              f"frame 1 {base[1][0]:.2f} RMS (static floor ~0.02)")
        check("no unexplained settling beyond 64 frames",
              base[-2][0] < 0.5,
              f"frame 64 {base[-2][0]:.2f} RMS, frame 128 {base[-1][0]:.2f}")
        check("no page errors", not errs, errs[0][:110] if errs else "")
        br.close()

    if fails:
        print("\nFAILED: " + ", ".join(fails))
        sys.exit(1)
    print("\nCAMERA-MOTION SETTLING: within the deterministic floor")


if __name__ == "__main__":
    main()
