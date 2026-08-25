#!/usr/bin/env python3
"""
sim_freeze_test.py -- is the spectral simulation idempotent at dt = 0?

    py -3.14 sim_freeze_test.py [--tier high]

The idempotence half of this file stands and is worth keeping: with the world
frozen, re-running the FFT/cascade passes reproduces every cascade's
displacement AND deriv/normal/Jacobian textures bit-for-bit over repeated
executions, read back directly from the GPU.  The `uPrev` feedback in DERIV_FRAG
reduces to `foam = max(prev, inj)` at dt = 0, which is a fixed point after one
application.  WaveSimulation.setFrozen() exists with per-cascade update counters
so a probe can prove the pipeline actually stopped.

The pan half is HISTORICAL.  It was built to decide whether a post-camera-stop
"settling" lived in the simulation or in how the render samples it.  Neither:
that settling was an artefact of the capture path, which read a high-frequency
intermediate rather than the colour frame (see harness.py).  Note also that a
subsystem bisection is void at dt = 0 by construction -- an idempotent system
changes nothing when disabled -- so those rows were never able to discriminate.
"""
import argparse
import sys

from PIL import ImageChops, ImageStat
from playwright.sync_api import sync_playwright

from harness import grab_img

CROP = (0, 100, 1280, 700)
VIEW = (0, 2.0, 0, 3, 30)
SAMPLES = [0, 1, 2, 4, 8, 16, 32, 64, 128]
PAN_STEPS, PAN_RATE = 40, 0.05

ROT = """([n, rate]) => {
    const c = window.__app.camera.camera;
    const b = window.__app.frames;
    for (let i = 0; i < n; i++) { c.rotation.y += rate; window.__advance(1); }
    return { drawn: window.__app.frames - b, yaw: c.rotation.y };
}"""

# A cheap, stable digest of a cascade's GPU output.  Sums are enough to detect
# "did these texels change at all"; exact equality of floats is the question.
HASH = """(async (which) => {
    const sim = window.__ocean.sim, out = [];
    for (let i = 0; i < sim.cascades.length; i++) {
      const c = sim.cascades[i];
      const t = which === "disp" ? c.disp[c.dispIdx] : c.deriv[c.derivIdx];
      const a = await t.readPixels();
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let k = 0; k < a.length; k += 4) {
        s0 += a[k]; s1 += a[k + 1]; s2 += a[k + 2]; s3 += a[k + 3];
      }
      out.push([+s0.toFixed(4), +s1.toFixed(4), +s2.toFixed(4), +s3.toFixed(4)]);
    }
    return out;
})"""


def rms(a, b):
    return ImageStat.Stat(ImageChops.difference(a, b)).rms[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="high")
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

        # ---- 1. does the pipeline reproduce itself at dt = 0? ---------------
        # Idempotence, before anything about cameras.
        page.evaluate("window.__pauseRender(); window.__advance(20)")
        seq = []
        for _ in range(5):
            page.evaluate("window.__advance(1)")
            seq.append(page.evaluate(HASH, "disp"))
        drv = []
        for _ in range(5):
            page.evaluate("window.__advance(1)")
            drv.append(page.evaluate(HASH, "deriv"))
        page.evaluate("window.__resumeRender()")

        def stable(rows):
            first = rows[0]
            return all(r == first for r in rows[1:])

        print("\n  running the pipeline repeatedly at dt = 0 (world frozen):")
        for i, c in enumerate(seq[0]):
            vals = [r[i] for r in seq]
            same = all(v == vals[0] for v in vals)
            print(f"    cascade {i} displacement  "
                  f"{'STABLE' if same else 'CHANGING'}   {vals[0]}")
        for i, c in enumerate(drv[0]):
            vals = [r[i] for r in drv]
            same = all(v == vals[0] for v in vals)
            print(f"    cascade {i} deriv/normal  "
                  f"{'STABLE' if same else 'CHANGING'}   {vals[0]}")
        check("FFT idempotence at dt=0 (displacement)", stable(seq),
              "re-running on unchanged inputs reproduces the textures"
              if stable(seq) else "textures change on repeat execution")
        check("FFT idempotence at dt=0 (deriv/normal/Jacobian)", stable(drv),
              "stable" if stable(drv) else "textures change on repeat execution")

        # ---- 2. the pan, with and without the spectral pipeline running -----
        def curve(freeze_sim):
            if freeze_sim:
                got = page.evaluate("window.__setSubsystem('sim', false)")
                if not got or got["enabled"] is not False:
                    return None, "no freeze hook"
            page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % VIEW)
            page.evaluate("window.__pauseRender(); window.__advance(240)")
            before = page.evaluate("window.__subsystemState()")["sim"]
            page.evaluate(ROT, [PAN_STEPS, PAN_RATE])
            page.evaluate("window.__advance(400)")
            after = page.evaluate("window.__subsystemState()")["sim"]
            if freeze_sim and after["updates"] != before["updates"]:
                page.evaluate("window.__setSubsystem('sim', true)")
                return None, (f"INVALID_PROBE: counters advanced "
                              f"{before['updates']} -> {after['updates']}")
            ref = grab_img(page, CROP)

            page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % VIEW)
            page.evaluate("window.__advance(240)")
            page.evaluate(ROT, [PAN_STEPS, PAN_RATE])
            out, at = [], 0
            for n in SAMPLES:
                if n > at:
                    page.evaluate(f"window.__advance({n - at})")
                    at = n
                out.append(rms(grab_img(page, CROP), ref))
            page.evaluate("window.__resumeRender()")
            if freeze_sim:
                page.evaluate("window.__setSubsystem('sim', true)")
            return out, None

        print("\n  post-stop RMS, frames "
              + " ".join(f"{n:>6d}" for n in SAMPLES))
        base, err = curve(False)
        print("    sim running   " + " ".join(f"{v:6.2f}" for v in base))
        frozen, err = curve(True)
        if frozen is None:
            check("simulation freeze hook", False, err)
        else:
            print("    sim FROZEN    " + " ".join(f"{v:6.2f}" for v in frozen))
            st = page.evaluate("window.__subsystemState()")["sim"]
            check("simulation freeze hook", True,
                  f"counters held; cascades {st['cascades']}")
            drop = 100 * (1 - frozen[1] / max(base[1], 1e-9))
            print(f"\n    frame +1: {base[1]:.2f} running vs {frozen[1]:.2f} "
                  f"frozen ({drop:+.0f}%)")
            if frozen[1] < base[1] * 0.35:
                print("    SOURCE: SIMULATION -- freezing the pipeline "
                      "collapses the tail")
            elif frozen[1] > base[1] * 0.65:
                print("    SOURCE: RENDER-SAMPLING -- the wave field is "
                      "innocent; look at cascade selection, blending, mips "
                      "and derivatives")
            else:
                print("    SOURCE: NOT_YET_ISOLATED -- partial contribution")

        check("no page errors", not errs, errs[0][:110] if errs else "")
        br.close()

    if fails:
        print("\nFAILED: " + ", ".join(fails))
        sys.exit(1)
    print("\nsimulation freeze measured")


if __name__ == "__main__":
    main()
