# Abyssal — photorealistic real-time ocean in Babylon.js

A spectral (FFT) ocean rendered in the browser: three JONSWAP cascades solved on
the GPU every frame, a camera-centred geo-clipmap running to 262 km, physically
based water optics, planar reflection + refraction, wind-driven whitecaps with
spray, mist and subsurface bubbles, weather, a full underwater state, and an
export package that serialises the ocean for Unreal Engine.

There is no island, pier, boat, or character. Looking in any direction gives
open ocean to a natural horizon. Dive with **U** or cycle cameras with **C**.

No build step. No npm install. Babylon.js 9 is loaded from a CDN. Every texture
in the scene is generated procedurally at runtime.

## Getting started

### Requirements

- A current Chromium-based browser (Chrome or Edge) with WebGPU preferred.
  WebGL2 is the automatic fallback (`?webgl=1` forces it).
- Python 3.10+ to serve the files locally. Node.js is optional and is only used
  for shader/FFT unit tests (`node tests/fft_test.mjs`).

There is **nothing to install** for the app itself and **nothing to build**.
This is a static ES-module project: `index.html` is the entry file.

### Run locally

From the project root:

```bash
python serve.py
```

Then open <http://127.0.0.1:5390>. Quality can be overridden with
`?tier=cinematic|ultra|high|medium|low`.

If Python’s built-in server is enough:

```bash
python -m http.server 5390 --bind 127.0.0.1 --directory .
```

`serve.py` is preferred: it sends `Cache-Control: no-store` so shader edits
show up without a hard refresh.

### GitHub Pages

This repo is served as a static site from the `main` branch root
(`index.html`). Public URL:

https://stanleyuka20-ctrl.github.io/ocean/

Open that link in Chrome/Edge. The first load compiles the ocean shaders and
can take several seconds (the in-page boot bar tracks this).

### Modify

| Area | Where to edit |
|---|---|
| App shell, render loop, page API | `src/main.js` |
| FFT spectrum / cascades / foam | `src/ocean/` and `src/shaders/oceanSim.js` |
| Surface / sky / underwater GLSL | `src/shaders/` |
| Camera stations and keys | `src/ui/CameraController.js` |
| Quality tiers | `src/core/quality.js` |
| Unreal export mapping | `src/export/` |

Keep relative imports (`./…`, `../…`) as they are. Do not add a bundler unless
you also update every import. Babylon must keep loading from the import map in
`index.html`.

The inverse FFT is **unnormalised**. Do not divide spectrum amplitudes by N².
Never `return` early from a shader `main()` — Babylon’s WebGPU path then skips
the output struct and the canvas goes black.

Future work belongs in **this same GitHub repository**. Pull `main`, keep every
working feature, add the change, test, then push with a clear commit message.

---

## Exporting to Unreal Engine

Open the panel (`H`) and use **Export Unreal Package**, or call
`__export.downloadPackage()`. You get `Ocean_UE_Export.zip`:

```
Config/OceanSpectrum.json        spectrum, cascades, wind, swell, seed
Config/OceanMaterial.json        absorption, scattering, IOR, roughness, foam
Config/OceanWeatherPresets.json  every validated weather state and water type
Config/OceanBreakers.json        whitecap model and emission budgets
README_UNREAL_IMPORT.md          parameter-by-parameter mapping, units, axes
README_LICENSES.md
Documentation/OceanTechnicalReport.md
```

**Nothing in that package is a working ocean — it is the specification for one.**
The simulation is WebGPU fragment passes, a CDLOD clipmap evaluated in a vertex
shader and GPU-resident particle fields; glTF has no representation for any of
it, and importing a mesh from here would give a static plane of water. What
crosses the boundary is every number that defines how this ocean looks and
moves, plus the mapping to rebuild it natively on the Unreal side. The export is
validated before it is written: required files present, every JSON parseable and
free of non-finite values, no unsupported paths, and the spectrum checked
against the ocean actually running.

```bash
py -3.14 export_test.py    # downloads the real ZIP and validates the archive
```


## What is actually simulated

**The sea surface is a spectrum, not a sum of sine waves.** A JONSWAP wind
spectrum with Hasselmann directional spreading, plus an independent swell band,
is sampled on three wave-vector grids and inverse-transformed on the GPU each
frame. The three cascades partition the spectrum at 0.6 × Nyquist of the coarser
one, so no band is doubled or missing:

| cascade | patch | texel | carries |
|---|---|---|---|
| 0 | 513 m | 2.00 m | swell and wind sea, 7 m – 513 m |
| 1 | 127 m | 0.99 m | 1.6 m – 7 m |
| 2 | 29 m | 0.23 m | ripples below 1.6 m |

The patch sizes are deliberately non-harmonic. Sizes in a 2:1 ratio make the
three lattices coincide every few hundred metres and the eye reads that as
tiling.

Wave height follows from physics rather than a slider. Significant wave height
measured in-app against the JONSWAP integral:

| sea state | wind | fetch | Hs (theory) | Hs (measured) |
|---|---|---|---|---|
| Calm | 3.0 m/s | 20 km | 0.63 m | 0.65 m |
| Moderate | 8.5 m/s | 90 km | 1.95 m | 1.89 m |
| Rough | 15 m/s | 150 km | 4.40 m | 3.89 m |
| Storm | 23 m/s | 250 km | ~8.6 m | 6.9 m |

(the measured column comes from the CPU mirror, which is band-limited to the two
coarsest cascades and therefore reads slightly low in the bigger seas.)

**Water colour is an optical calculation.** Per-channel extinction close to
measured sea water (red ≈ 0.42 /m, green ≈ 0.075 /m, blue ≈ 0.020 /m) is
integrated over the real path from the eye through the surface to the sea floor
and back along the sun path. Red therefore vanishes in the first couple of
metres and blue survives a hundred — the depth gradient is a consequence of the
coefficients, never a painted ramp. `scatterCol` is a diffuse water-leaving
*reflectance* of a few per cent, which is what makes the sea a dark body whose
brightness is nearly all reflection.

**Sun glitter comes from unresolved slope variance.** Every cascade the pixel
cannot resolve hands its slope variance (Cox & Munk, mss = 0.003 + 0.00512·U) to
the GGX roughness, plus a floor for capillary ripples the simulation never had.
That single mechanism produces the glitter path, keeps distant water from
aliasing, and needs no distance-fade hacks.

**One atmosphere.** `src/shaders/atmosphere.js` is included by the sky dome, the
ocean surface, the island and the underwater pass. The sky reflected in a wave
and the sky behind the horizon are literally the same integral, so the horizon
cannot seam.

---

## Layout

```
src/
  core/       Engine tiers (quality.js), sun/moon/cloud/exposure (Sky.js), TAA
  ocean/      OceanSystem, WaveSimulation, OceanMaterial, OceanLODManager,
              ReflectionSystem, RefractionSystem, FoamSystem, SeafloorSystem,
              UnderwaterSystem, SpraySystem, BuoyancySystem, CausticsSystem,
              WeatherOceanController, OceanDebugTools, oceanCpu + worker
  interaction/ GpuParticleField, SplashSheets
  export/     Unreal specification ZIP
  ui/         CameraController, DebugPanel
  shaders/    atmosphere / oceanSim / oceanSurface / scene / particles /
              splashSheet / taa GLSL
```

### The simulation, per frame per cascade

```
spectrum(target 0) -> spec0        h(k,t) = h0 e^{iwt} + conj(h0(-k)) e^{-iwt}
spectrum(target 1) -> spec1        packed as two real fields per complex field
fft horizontal  x log2(N)          Cooley-Tukey butterfly, precomputed table
fft vertical    x log2(N)
displacement -> RGBA16F            (Dx, Dy, Dz)
derivatives  -> RGBA16F            (dy/dx, dy/dz, Jacobian, foam)
```

Eight real outputs ride in two RGBA textures because two real fields fit in one
complex transform (A + iB). Everything is a fragment pass, so one GLSL codebase
covers WebGL2 and — transpiled — WebGPU; a compute path would have meant a
second, WGSL-only implementation to keep in sync.

### Geometry

A CDLOD geo-clipmap: 14 nested square rings, each with the same vertex count and
twice the cell size of the one inside it, reaching 262 km. The whole thing is one
mesh in one draw call — every vertex carries `(cellSize, halfExtent)` and the
vertex shader derives that level's camera-snapped origin itself.

Cracks are removed by morphing the outer band of each level onto the coarser
lattice. Matching *positions* is not enough: the cascade weights and mip levels
are driven by an effective cell size that grows with the morph, or the two levels
agree on where a vertex is and disagree on how high the water is there.

### Buoyancy

`ocean.getSurfaceData(worldPosition)` returns `{height, normal, velocity, foam,
depth}` from a CPU mirror of the same spectrum, running in a worker at 30 Hz.
It uses the *same* integer-hashed random amplitudes as the GPU (a PCG hash keyed
on the wave-number index, not the texel), so the 128² CPU field is the GPU field
low-pass filtered rather than a different sea. Measured agreement: **1–2 % of
Hs**. Floating objects are integrated as rigid bodies sampled at 9–15 probes, so
they pitch and roll with the wave they are sitting on.

### Interaction API

```js
ocean.getSurfaceData(position)          // { height, normal, velocity, foam, depth }
ocean.addDisturbance({ position, radius, strength, velocity })
ocean.setQuality("cinematic"|"ultra"|"high"|"medium"|"low")
ocean.setWaterType("tropical"|"atlantic"|"pacific"|"mediterranean"|"arctic"|"murky"|"storm")
ocean.weather.applyPreset("storm")      // eases, never snaps
ocean.weather.applySeaState("rough")
```

---

## Controls

`WASD` move the character · mouse look (click to lock) · `Shift` run
`Space` jump (rise in free cam) · `Ctrl` dive (descend in free cam)
`V` camera: third / first / free · `C` camera preset
`1..4` sea state · `5..0` weather presets · `T` time of day · `Y` animate time
`U` dive/surface · `B` spawn floating object · `N` boat impulse
`F` foam debug · `L` LOD debug · `G` cycle debug channel · `J` interaction debug
`H` settings panel · `P` pause waves · `?` help

---

## Verification

```bash
node tests/fft_test.mjs       # butterfly table vs a direct DFT
node tests/shader_hygiene.mjs # early returns / backticks in GLSL comments
py -3.14 verify.py            # 14 functional checks (add --webgpu)
py -3.14 tiles.py             # no tiles/rings/seams, BOTH backends compared
py -3.14 resolution_test.py   # real 4K backbuffer, dynamic resolution
py -3.14 export_test.py       # the Unreal package, validated from the ZIP
py -3.14 ladder.py L1         # 24 open-ocean stations, one browser session
py -3.14 screenshot.py out.png --preset storm --view 520,9,700 --pitch 3 --yaw -158
```

`tiles.py` is the guard against the failure this system is most prone to: a
tile, clipmap ring, LOD step or render-target seam all show up as a LONG
STRAIGHT EDGE, where waves, foam and cloud shadows are curved and broken. It
measures the longest collinear run of edge pixels at 5 m, 25 m, 100 m, 250 m,
500 m and 1 km looking down, plus grazing and underwater, **and runs the same
stations on both backends and compares them** — every artefact it was written
for was WebGPU-only, and a WebGL2-only pass looked spotless while the shipped
renderer was covered in squares.

`verify.py` covers the spectrum against theory, CPU/GPU agreement, buoyancy,
wakes, debug channels, quality switching and the resources it frees, the runtime
API contract, and the underwater transition. Both backends pass 16/16.

Page API for automation: `__setView`, `__setPreset`, `__setSea`, `__setTime`,
`__setWater`, `__setDebug`, `__setQuality`, `__stats`, `__validate`, `__panel`,
and `__ready` — which gates on every material being compiled plus 45 quiet
frames. A fixed sleep is not enough: the ocean shader alone takes several
seconds to compile on a cold cache, and capturing early looks exactly like a
rendering bug.

---

## Player interaction

A procedural character (no imported assets) with a real bone hierarchy, so the
water is driven by actual **foot, hand, elbow and hair transforms** rather than
by an effect parented to the body. Every event is assembled from the same
physically related pieces, scaled continuously by the quantity that caused it:

```
foot crosses the moving surface
  -> sheet of water torn up along the wave normal and the foot direction
  -> large droplets separate      (3 size classes, most of them tiny)
  -> micro spray
  -> sub-surface bubble burst
  -> ripple impulse into the fine field  -> rings propagate away
  -> foam patch left in the WATER, not on the character
```

Inputs the response actually reads: per-foot velocity and entry depth, gait
phase, submersion, body mass, entry angle, wave normal and wave velocity, wind,
current, water depth and the quality tier.

| system | where | notes |
|---|---|---|
| droplets / mist | `GpuParticleField` | state lives in two RGBA32F textures, integrated by a fragment pass; the CPU only appends spawn *groups* to a 64×4 table, so a minute of running allocates nothing |
| splash sheets | `SplashSheets` | pool of GPU-deformed crown patches: ballistic rise, ragged rim, leans into the motion, tears into holes |
| bubbles | `GpuParticleField` (bubble) | buoyancy by radius, drag, wobble; rendered as an air/water interface — bright Fresnel ring, transparent middle — and burst at the real wave surface |
| ripples | `FoamSystem` fine field | 26 m / 512 px (5 cm texels) following the player, wave equation, impulses into the **velocity** channel so energy radiates instead of piling up |
| wetness | `WetnessSystem` | a world-space *line* (highest point that has been submerged) plus an amount that dries with wind and sun; per-material soak (cotton ≫ skin ≫ rubber) |
| footprints | `FoamSystem` stamp field | wet prints on dry sand, weaker each step, evaporating |
| audio | `InteractionAudio` | event hooks plus a procedural WebAudio voice (no assets); pitch and envelope ride the impact energy |

Movement resists with depth — 100 % dry, 95 % ankle, 80 % knee, 55 % waist,
30 % chest — and the walk → wade → float → swim transition is a blend driven by
whether the feet can still reach the bottom, measured against the live wave.

### Interaction API

```js
oceanInteraction.registerCharacter(player);
const s = oceanInteraction.getCharacterWaterState(player);
// { submerged, depth, submergedPercent, surfaceHeight, surfaceNormal,
//   waterVelocity, waterDepth, state, leftFootSubmerged, rightFootSubmerged,
//   leftFootDepth, rightFootDepth, swimAmount }

ocean.addDisturbance({ position, velocity, radius, strength, lift,
                       type: "FOOTSTEP" });   // RUN_STEP | BODY_ENTRY |
                                              // SWIM_STROKE | KICK |
                                              // OBJECT_IMPACT | BOAT
```

Character-scale types route to the fine field, vessel and object impacts to the
coarse one; the ocean shader adds both.

### Interaction verification

```bash
py -3.14 walkin.py W1              # dry sand -> ankle -> knee -> waist -> chest -> swim -> dive -> back
py -3.14 verify_interaction.py     # 12 checks aimed at the brief's failure conditions
```

`verify_interaction.py` asserts the specific things that are supposed to be
wrong: no splash on dry land, every event originating at the surface, splash
energy varying with and tracking impact speed, live droplets and bubbles,
bubbles wandering rather than rising in lines, a swim transition that blends,
foam left behind in the water rather than carried, effects that scale with the
quality tier without ever switching off, and no frame-time spike while
splashing.

---

## Surf zone: shoaling, refraction and breaking waves

The deep-water sea is still three JONSWAP cascades solved by FFT. That model has
no depth in it at all, so it can never shoal, refract or break. The surf zone is
a second, explicit wave train that does, and it hangs on one field:

**Wave travel time**, solved once on the bathymetry by fast sweeping:

```
|grad tau| = 1 / c(d),     c = sqrt(g d)
```

A wave front is a level set of `tau`, so a phase of `omega (t - tau)` gives, at
the right wavelength and with no ray tracing anywhere:

- fronts that slow and bunch up as the bed rises,
- fronts that bend to wrap around headlands, bars and reefs — refraction,
- a break line that is irregular because the sea bed is,
- several rows of breakers wherever the bed has several shallow steps.

The obvious cheaper trick — parameterising the phase directly by `sqrt(depth)`,
which is the closed form for a plane beach — is what this started as, and it
fails wherever the bed is flat: the phase stops advancing and the waves simply
vanish over a shelf or inside a lagoon. That is most of a real coastline.

Height follows Green's law (`H ~ d^-1/4`) and is cut off at the McCowan limit
`H = 0.78 d`. **How hard the wave is trying to exceed that limit is the breaking
intensity**, and it drives everything downstream: the forward throw of the crest,
the whitewater on the surface, the spray off the lip, the wind-blown mist and the
air injected under the collapsing face. Breaking is localised to the crest, which
is what produces separate rows of breakers with clear water between them rather
than one saturated white sheet over the whole surf zone.

`src/shaders/surf.js` is the wave, `src/ocean/surfCpu.js` is its CPU mirror, and
`src/ocean/BreakingWaves.js` samples the breaking crests near the camera on a
world-space lattice and hands them to the same GPU particle fields the player's
splashes use — a breaker and a footstep are one system.

```bash
py -3.14 breaker_test.py     # nine physics assertions + six camera angles
```

It asserts the behaviour rather than photographing it: waves shoal (measured
1.33 m at 12.9 m depth growing to 2.46 m at 5.2 m), nothing breaks while it is
small for the depth, the surf zone does break, height stays under the depth
limit, waves die at the waterline, and the break line varies by tens of metres
along the shore.

## Output resolution

`src/core/Presentation.js` owns the backbuffer:

```
backbuffer = cssSize * devicePixelRatio * renderScale
```

so a 4K target means the backbuffer is 3840 wide — on a 1080p display that is
2x supersampling and genuinely sharper, on a 4K display it is native. Dynamic
resolution moves `renderScale` toward a frame-time target in small steps after a
sustained trend, because a resolution that visibly pumps is worse than one that
is simply lower. It is **off by default** and opted into with
`__dynamicResolution(true)` or the panel: a resolution that changes under a
measurement makes every image comparison non-reproducible, and this project's
verification is image based.

```bash
py -3.14 resolution_test.py  # reads the real backbuffer, not the setting
```

The failure condition the brief names is "the output is merely upscaled from low
resolution", so the test measures high-frequency image energy at each scale:
3.90 at 793x446 against 12.88 at 3841x2160. That ratio is what makes it real
resolution rather than a stretched image.

---

## Motion vectors and TAA — partially landed

`src/core/TemporalAA.js` + `src/shaders/taa.js`. **Motion vectors work and are
verified; the temporal resolve does not and is off by default.**

The vectors come from the previous frame's displacement textures, which the
simulation now ping-pongs. That matters: the water's motion is not the camera's,
and the choppy horizontal displacement slides a crest sideways as well as up, so
integrating a single velocity number would smear every crest into the trough
behind it. Sampling the same lattice point one frame apart is exact for height
and choppiness together. Both clip positions are built from **unjittered**
matrices — jitter is a sampling offset, not motion, and leaving it in gives every
pixel a permanent sub-pixel velocity that crawls in place.

Measured (`py -3.14 taa_test.py`):

| | |
|---|---|
| still camera | max 1.3e-3 uv/frame — the water's own orbital motion |
| 0.02 rad/frame pan | max 0.0220 uv/frame, against 0.02/fov ≈ 0.022 predicted |
| reactive mask | reaches 0.77 on foam |

The resolve converges but is **roughly neutral**, and `taa_test.py` reports
**7/14**. Two findings from this round matter more than the score.

### The harness was the problem first

An earlier version of this file claimed a 77% storm improvement. **That was
instrument noise.** The sea evolved between the TAA-off and TAA-on halves of
each comparison, so the two halves measured different oceans: TAA-off baselines
wandered 3x between runs (storm 24.7 against 8.2) and the *same build* scored
+56% and -362% on consecutive runs. `taa_test.py` now anchors `sim.time` before
every measurement. With a controlled sea the real numbers are small and stable:

| case | TAA off | TAA on | |
|---|---|---|---|
| water level | 29.094 | 28.141 | +3% |
| aerial | 2.137 | 2.155 | -1% |
| storm spray | 22.175 | 21.473 | +3% |
| underwater | 4.292 | 4.594 | -7% |

Without jitter there is little for reprojection to remove: the sea's shimmer is
largely view-dependent specular glitter, which changes at a *fixed* surface
point and cannot be predicted by any motion vector. The value of TAA on this
content comes from the supersampling, and that needs velocity coverage for sky,
spray and bubbles which does not exist yet.

### Underwater caustics were screen-space, and it showed

The caustic shimmer was `sin(uv.x*40 + t) * sin(uv.y*31 - t)` -- a full-screen
sinusoid multiplying every pixel by +/-14% on a clock, with nothing tying it to
the world. Isolated on a frozen sea with every emitter silenced, it was the
**sole** screen-space contributor to underwater instability:

| configuration | frame-to-frame |
|---|---|
| base / +rays / +motes / +rays+motes | 0.232 - 0.242 |
| anything **+caustics** | 2.021 - 2.044 |

God rays and the motes shader term contributed nothing measurable; caustics
alone raised instability **8.5x**. The phase now comes from the cascade
Jacobian sampled at a world point along the view ray, so it moves with the
waves and the camera. After the change every configuration reads 0.028-0.032 --
the caustics cost nothing at all.

### What still blocks underwater

The motes *particle system* (not the shader term). Controlled, three runs
agreeing: with motes running TAA is negative; with them stopped it is +56%,
+70%, +69%. They are camera-local particles that write no motion vector, so the
velocity under them is the water's and reprojecting by it is wrong.

A luminance-disagreement rejection was tried as a way to catch particles without
plumbing vectors through every emitter. It does not work and was reverted: a
moving sea disagrees with its history a little everywhere, so any response
strong enough to catch a mote also collapses the history weight across the whole
frame (-32% to -40% underwater against +13% without it). Particles need real
vectors, not an inference.

Sky, spray, bubbles and suspended matter now all carry real motion vectors, and
the filter has three explicit modes: `TAA_MODE.NONE`, `REPROJECT` and
`JITTERED`.

### The instrument that read the wrong buffer

For several phases a "renderer defect" was chased here: with the world frozen at
`dt = 0`, a camera pan followed by a dead stop appeared to leave the image ~28
RMS from its own settled render, decaying to zero over about 128 frames along
thin filaments on mid-distance wave crests. It was pursued through a
spectral-simulation freeze hook (which proved the FFT bit-idempotent at
`dt = 0`), a self-validating subsystem bisection against update counters, a
migration of every quantitative harness onto GPU backbuffer readback, and a walk
of the render pipeline disabling one stage at a time.

None of it was real. `engine.readPixels()` on the default framebuffer — and a
second attempt using a trailing `PassPostProcess` tap copied with
`CopyTextureToTexture` — both returned a sparse high-frequency intermediate
rather than the colour frame: black almost everywhere, thin bright filaments
along the crests and the horizon. Two properties of that buffer made it look
like a superb instrument. It is **empty when the temporal filter is off**, so
every "TAA off" control measured a flawless `0.0000 RMS` and read as a bit-exact
renderer. And it **fills in as history accumulates**, so a camera stop appeared
to settle over ~128 frames on ~2% of pixels.

It was settled by saving one frame from each candidate path and looking at them:
676 KB of correct ocean from the compositor against 2.7 KB of pure black. The
tell had been available for a long time and went unread — TAA debug channel 1
outputs `cur`, the resolve's own *input*, a plain `texture2D` of
`textureSampler` that cannot depend on the TAA mode, and it read 20.362 in
REPROJECT against 0.000 in NONE. A reader that reports two values for a quantity
that cannot differ is measuring something else.

Re-measured on a calibrated capture, a frozen world panned and stopped is
bit-identical to its settled render at every sample in `TAA_MODE.NONE` (0.000
RMS, 0.00% of pixels), and in `REPROJECT` it shows only the filter converging:

| frame | RMS | pixels differing |
|---|---|---|
| +0 | 1.949 | 16.22% |
| +8 | 0.637 | 4.15% |
| +32 | 0.221 | 1.24% |
| settled | 0.000 | — |

A faint, broad change concentrated on whitecaps and the horizon — 13× smaller
than the phantom, across five times as many pixels, and the opposite shape.

`capture_test.py` now gates the capture against **known answers** rather than
against another reader: the frame must track a commanded lighting change, must
contain a scene (mean and stddev, because "perfectly stable" and "empty" are the
same reading), must reflect a hand-stepped change immediately, and must report
which frame it captured.

### A control that did not control anything

A second, real bug surfaced on the way. The resolve bound its shader gate from
the subsystem's `enabled` flag rather than from the mode:

```js
e.setFloat("uEnabled", this.enabled ? 1 : 0);   // ignores this.mode
```

`TAA_MODE.NONE` had only ever suppressed the jitter, so every harness using
`__taaMode(0)` as its "no TAA" control was measuring the reprojection filter
against itself. `verify.py` now permanently asserts the invariant that made it
possible: **`TAA_MODE.NONE` must be byte-identical to `enabled = false`**.

The split of what the bad control reached: `taa_test.py`, `selftest.py` and
`sweep.py` baseline from `enabled = false`, so the bad control never touched
them; `ghost_test.py`, `fidelity_test.py`, `jitter_test.py`,
`supersample_test.py` and `frozen_world_test.py` used the mode. All of them are
being re-run on the calibrated capture regardless, because the capture fault
reached every harness.
