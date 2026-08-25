#!/usr/bin/env python3
"""
particle_test.py -- do the motes, bubbles and spray carry REAL motion vectors?

    py -3.14 particle_test.py [--tier high] [--webgl]

The point of this file is that a particle's velocity must come from the
particle's own two positions and nothing else.  So every check here is built to
fail if the vector were inferred from the water underneath, from luminance, or
from the camera alone:

  * a particle field is measured with the OCEAN EXCLUDED from the velocity
    target, so a water vector cannot stand in for a particle one;
  * a still camera over a settled sea still produces particle motion, because
    particles move on their own;
  * a known camera pan must show up in the particle vectors at the same
    magnitude it shows up in the water's;
  * newly born particles must report full reactivity, because they have no
    previous position to reproject from.

The sea is settled by convergence before anything is measured.  A fixed
spin-up is not enough: an undeveloped rough sea reads a quarter of its final
frame-to-frame difference, and an A/B whose halves straddle that ramp measures
the ramp.  That mistake produced a confident, wrong isolation of motes once
already.
"""
import argparse
import sys

from playwright.sync_api import sync_playwright

# Read the velocity target directly.  The isolation switches select which
# sources were allowed to write it, so a claim about particles is made on a
# buffer that contains nothing else.
VELSTAT = """(async () => {
    const t = window.__taa.velocity, a = await t.readPixels();
    let n = 0, cov = 0, sx = 0, sy = 0, mx = 0, react = 0, moving = 0, hot = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (!isFinite(a[i]) || !isFinite(a[i + 1])) continue;
      const c = a[i + 3];
      n++;
      if (c < 0.5) continue;
      cov++;
      const m = Math.hypot(a[i], a[i + 1]);
      sx += Math.abs(a[i]); sy += Math.abs(a[i + 1]);
      mx = Math.max(mx, m); react = Math.max(react, a[i + 2]);
      if (a[i + 2] > 0.95) hot++;
      if (m > 2e-4) moving++;
    }
    return { pixels: n, covered: cov, coverFrac: cov / n,
             meanAbsX: cov ? sx / cov : 0, meanAbsY: cov ? sy / cov : 0,
             max: mx, maxReactive: react, movingFrac: cov ? moving / cov : 0,
             hotFrac: cov ? hot / cov : 0 };
})()"""

DEBUG_MEAN = """(async () => {
    const a = await window.__taa.velocity.readPixels();
    let s = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (!isFinite(a[i])) continue;
      s += Math.abs(a[i]) + Math.abs(a[i + 1]) + Math.abs(a[i + 2]); n++;
    }
    return s / n;
})()"""

# Emit a slab of droplets right in front of the camera, all moving together at
# a known world velocity, and keep emitting so the population holds.  This is
# the deterministic case: stochastic storm spray is bursty and can legitimately
# leave a station with almost no near droplet in frame, which makes an
# assertion about it a coin flip rather than a measurement.
AIMED = """(dir) => {
    const BJ = window.BABYLON, f = window.__ocean.effects.droplets;
    if (window.__aimId) cancelAnimationFrame(window.__aimId);
    window.__aim = () => {
      const cam = window.__app.camera.camera;
      const fwd = cam.getDirection(BJ.Axis.Z), rt = cam.getDirection(BJ.Axis.X);
      const c = cam.position.add(fwd.scale(6.0));
      f.emit({ position: [c.x, c.y, c.z], radius: 2.5,
               velocity: [rt.x * 6 * dir, rt.y * 6 * dir, rt.z * 6 * dir],
               spread: 0.0, count: 900, size: [0.05, 0.09],
               life: [1.2, 1.6], jitter: 0.0 });
      window.__aimId = requestAnimationFrame(window.__aim);
    };
    window.__aim();
}"""

SIGNED = """(async () => {
    const a = await window.__taa.velocity.readPixels();
    let sx = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i + 3] < 0.5 || !isFinite(a[i])) continue;
      sx += a[i]; n++;
    }
    return { meanX: n ? sx / n : 0, covered: n };
})()"""

SPIN = """window.__spin = () => { const c = window.__app.camera.camera;
    c.rotation.y += RATE; window.__spinId = requestAnimationFrame(window.__spin); };
    window.__spin();"""

# Birth lasts exactly ONE frame, so a single burst plus a wait samples six
# frames after the thing under test.  Emit every frame instead: while this is
# running some particle is always newborn, which is the state being asserted.
BURST = """(() => {
    const f = window.__ocean.effects.motes;
    const BJ = window.BABYLON;
    window.__burst = () => {
      // IN FRONT of the camera: a burst placed by guesswork landed behind it,
      // and the reading was then of whatever ambient particles remained.
      const cam = window.__app.camera.camera;
      const fwd = cam.getDirection(BJ.Axis.Z);
      const c = cam.position.add(fwd.scale(3.0));
      f.emit({ position: [c.x, c.y, c.z], radius: 1.6,
               velocity: [0, 0, 0], spread: 1.0, count: 400,
               size: [0.03, 0.06], life: [4, 6], jitter: 1.0 });
      window.__burstId = requestAnimationFrame(window.__burst);
    };
    window.__burst();
})()"""


def _frames(page, n):
    """yield n times, letting a few frames pass between each"""
    for i in range(n):
        if i:
            page.wait_for_timeout(180)
        yield i


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="high")
    ap.add_argument("--webgl", action="store_true")
    a = ap.parse_args()

    flags = ["--ignore-gpu-blocklist", "--use-angle=default"]
    url = f"http://127.0.0.1:5390/index.html?tier={a.tier}"
    if a.webgl:
        url += "&webgl=1"
    else:
        flags += ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"]

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

        def only(ocean, particles):
            page.evaluate(
                "window.__taa.oceanVelocity = %s;"
                "window.__taa.particleVelocity = %s"
                % ("true" if ocean else "false", "true" if particles else "false"))
            page.wait_for_timeout(320)

        def station(x, y, z, pit, yaw):
            page.evaluate("window.__setView(%s,%s,%s,%s,%s)" % (x, y, z, pit, yaw))
            page.wait_for_function("window.__ready === true", timeout=180000)
            page.evaluate("window.__app.sky.autoExposure = false")
            page.wait_for_timeout(700)

        page.evaluate("window.__setSea('rough')")
        settled = page.evaluate("window.__settleSea(30)")
        check("sea development converged before measuring",
              settled["converged"],
              "Hs %.2f m, foam %.4f, after %.1f s of spin-up"
              % (settled["hs"], settled["foam"], settled["seconds"]))
        page.wait_for_function("window.__ready === true", timeout=180000)

        # ---- 1. motes: underwater, particles only ---------------------------
        station(0, -4.0, 0, -28, 30)
        page.wait_for_timeout(2500)
        counts = page.evaluate("window.__ocean.effects.counts()")
        check("motes are live under the surface", counts["motes"] > 200,
              "%d motes, %d bubbles" % (counts["motes"], counts["bubbles"]))

        # 3D bubble spheres own a lot of pixels.  These checks are about motes
        # (coverage that responds to a burst, motion on a still camera), so
        # the bubble field has to be out of the velocity target or it drowns
        # them.
        page.evaluate("""() => {
          window.__ocean.underwater.bubbleAmount = 0;
          window.__ocean.effects.bubbles.setEnabled(false);
        }""")
        page.wait_for_timeout(800)

        only(False, True)
        page.wait_for_timeout(400)
        p_still = page.evaluate(VELSTAT)
        # An absolute floor here would just be a number I chose, and the live
        # mote count varies by ~10% between runs.  The floor is only "clearly
        # not zero"; the assertion with teeth is the relational one at the
        # burst below -- coverage must RESPOND to how many particles exist.
        check("particles alone cover the velocity target",
              p_still["coverFrac"] > 0.0005,
              "%.2f%% of pixels (%d), ocean excluded"
              % (100 * p_still["coverFrac"], p_still["covered"]))
        # The check that cannot pass by copying the water: the ocean is not in
        # the target at all, and the camera is stationary.
        check("particles move with a still camera",
              p_still["movingFrac"] > 0.25 and p_still["max"] > 1e-4,
              "%.0f%% of particle pixels moving, max %.2e uv/frame"
              % (100 * p_still["movingFrac"], p_still["max"]))
        check("particle reactive mask is raised",
              p_still["maxReactive"] > 0.2,
              "max reactive %.2f" % p_still["maxReactive"])

        # ---- 2. a known pan must reach the particles ------------------------
        page.evaluate(SPIN.replace("RATE", "0.02"))
        page.wait_for_timeout(700)
        p_pan = page.evaluate(VELSTAT)
        only(True, False)
        o_pan = page.evaluate(VELSTAT)
        page.evaluate("cancelAnimationFrame(window.__spinId)")
        page.wait_for_timeout(400)
        # 0.02 rad/frame over a ~0.9 rad fov is ~0.022 uv, for anything on screen
        check("particle vectors track the camera pan",
              0.012 < p_pan["max"] < 0.040,
              "particles max %.4f uv/frame, predicted ~0.022" % p_pan["max"])
        check("particles and water agree on camera motion",
              abs(p_pan["max"] - o_pan["max"]) < 0.010,
              "particles %.4f vs water %.4f" % (p_pan["max"], o_pan["max"]))

        # ---- 3. birth: a fresh burst has no history -------------------------
        only(False, True)
        quiet = page.evaluate(VELSTAT)
        page.evaluate(BURST)
        page.wait_for_timeout(500)
        born = page.evaluate(VELSTAT)
        page.evaluate("cancelAnimationFrame(window.__burstId)")
        page.wait_for_timeout(600)
        # Asserted on the FRACTION of fully-reactive pixels, not the maximum.
        # The mote emitter runs continuously, so there is no quiet period in
        # which nothing is newborn -- the maximum reads 1.00 either way, and a
        # check written against it fails while the behaviour it describes is
        # working.  What a burst actually changes is how MANY pixels are newly
        # born, and that is what the resolve consumes.
        check("newborn particles are marked fully reactive",
              born["maxReactive"] > 0.95
              and born["hotFrac"] > max(quiet["hotFrac"] * 3.0, 0.05),
              "%.1f%% of particle pixels fully reactive during a burst vs %.1f%% ambient"
              % (100 * born["hotFrac"], 100 * quiet["hotFrac"]))
        check("particle coverage responds to particle count",
              born["covered"] > quiet["covered"] * 2.0,
              "%d covered pixels ambient -> %d during a burst in view"
              % (quiet["covered"], born["covered"]))

        page.evaluate("window.__ocean.underwater.bubbleAmount = 1")

        # ---- 4. spray above water ------------------------------------------
        page.evaluate("window.__setPreset('storm')")
        page.evaluate("window.__settleSea(30)")
        page.wait_for_function("window.__ready === true", timeout=180000)
        station(0, 3.0, 0, 4, 30)
        # The spray POPULATION is not part of what __settleSea gates, and the
        # harness runs the clock at 0.28x, so a droplet field emptied by the
        # 40x spin-up needs real time to refill.  Polled from here at 1 Hz
        # rather than with wait_for_function: that polls every animation frame,
        # and each poll is four GPU readbacks, which starves the very simulation
        # being waited on.
        sc = {"droplets": 0}
        for _ in range(60):
            sc = page.evaluate("window.__ocean.effects.counts()")
            if sc["droplets"] > 1500:
                break
            page.wait_for_timeout(1000)
        only(False, True)
        page.wait_for_timeout(400)
        check("storm spray is live", sc["droplets"] > 1500,
              "%d droplets, %d mist" % (sc["droplets"], sc["mist"]))

        # Deterministic: the same droplets driven right, then left.  Nothing
        # inferred from the water, the luminance or the camera can flip sign
        # with the emitted velocity -- only the particles' own two positions can.
        signed = {}
        for label, d in (("rightward", 1), ("leftward", -1)):
            page.evaluate(AIMED, d)
            page.wait_for_timeout(900)
            best = max((page.evaluate(SIGNED) for _ in _frames(page, 6)),
                       key=lambda r: r["covered"])
            signed[label] = best
        page.evaluate("cancelAnimationFrame(window.__aimId)")
        r, l = signed["rightward"], signed["leftward"]
        check("aimed droplets are on screen with vectors",
              r["covered"] > 2000 and l["covered"] > 2000,
              "%d and %d covered pixels" % (r["covered"], l["covered"]))
        check("droplet vectors follow the emitted direction",
              r["meanX"] * l["meanX"] < 0
              and min(abs(r["meanX"]), abs(l["meanX"])) > 1e-5,
              "mean vx %+.5f rightward vs %+.5f leftward"
              % (r["meanX"], l["meanX"]))
        page.wait_for_timeout(1500)

        # ---- 5. debug views actually render ---------------------------------
        only(True, True)
        views = {}
        for n, label in ((1, "current position"), (2, "previous position"),
                         (3, "birth/reuse/alive"), (4, "coverage"),
                         (5, "velocity magnitude")):
            page.evaluate("window.__taa.particleDebug = %d; window.__taa.debug = 13" % n)
            page.wait_for_timeout(260)
            views[label] = page.evaluate(DEBUG_MEAN)
        page.evaluate("window.__taa.particleDebug = 0; window.__taa.debug = 0")
        distinct = len({round(v, 4) for v in views.values()})
        check("particle debug views are wired and distinct", distinct >= 4,
              ", ".join("%s %.3f" % (k, v) for k, v in views.items()))

        # ---- 6. cost --------------------------------------------------------
        page.wait_for_timeout(2000)
        fps_on = page.evaluate("window.__engine.getFps()")
        page.evaluate("window.__taa.particleVelocity = false")
        page.wait_for_timeout(2000)
        fps_off = page.evaluate("window.__engine.getFps()")
        page.evaluate("window.__taa.particleVelocity = true")
        check("particle velocity pass costs under 12% of frame rate",
              fps_on > fps_off * 0.88,
              "%.0f fps without -> %.0f fps with" % (fps_off, fps_on))

        check("no page errors", not errs, errs[0][:110] if errs else "")
        br.close()

    if fails:
        print("\nFAILED: " + ", ".join(fails))
        sys.exit(1)
    print("\nparticles carry their own motion vectors")


if __name__ == "__main__":
    main()
