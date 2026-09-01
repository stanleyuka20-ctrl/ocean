# Abyssal

**A living spectral ocean in your browser.**

Abyssal is an interactive, real-time open-ocean observatory built with
Babylon.js. Three GPU FFT wave cascades drive a camera-centred ocean surface,
physical water optics, weather, open-water whitecaps, spray, bubbles, an
underwater state, a procedural sea floor, and temporal anti-aliasing on the top
quality tiers.

[Open Abyssal](https://stanleyuka20-ctrl.github.io/ocean/)

There is no build step, package manager, account, tracking script, or asset
pipeline. The app is a static ES-module site; Babylon.js is the only runtime
dependency and is loaded from jsDelivr with Subresource Integrity.

## Highlights

- Three non-harmonic JONSWAP + swell FFT cascades, evolved on the GPU.
- A single-draw geo-clipmap extending the ocean to the horizon.
- Physically based absorption, scattering, Fresnel reflection, refraction,
  foam, sun glitter, and underwater attenuation.
- Calm, moderate, rough, storm, and extreme sea states plus time-of-day and
  weather environments.
- Wind-driven whitecaps with GPU-resident spray, mist, bubbles, and suspended
  particles.
- Camera views designed for the waterline, aerial observation, storms, sunsets,
  and diving.
- Responsive keyboard, mouse, gamepad, and touch controls.
- Accessible dialogs, labelled controls, visible focus, reduced-motion support,
  safe-area-aware mobile layouts, and recoverable renderer errors.
- WebGPU when available, with an automatic WebGL 2 fallback.
- An Unreal export package containing validated spectrum, material, weather,
  and breaker configuration plus an implementation map.

## Run locally

Requirements:

- A current browser with WebGPU or WebGL 2.
- Python 3 to run the included no-cache development server.
- Node.js only if you want to run the JavaScript tests.

From the repository root:

```bash
python serve.py
```

Then open [http://127.0.0.1:5390](http://127.0.0.1:5390).

Useful query parameters:

```text
?tier=cinematic|ultra|high|medium|low
?webgl=1          Force WebGL 2 compatibility mode
?mobile=1         Force the mobile tier and touch UI
?perf=0           Hide the performance HUD
?lightning=1      Allow full-frame storm lightning
```

Lightning is deliberately opt-in and is always disabled when the operating
system requests reduced motion.

## Explore

Click the ocean to capture the mouse, then use:

| Input | Action |
|---|---|
| `W A S D` | Move |
| Mouse | Look around |
| `Shift` | Move faster |
| `Space` / `Ctrl` | Ascend / descend |
| `U` | Dive or return to the surface |
| `C` | Cycle curated camera views |
| `1`–`4` | Calm / Moderate / Rough / Storm |
| `5`–`0` | Weather and lighting environments |
| `T` | Cycle time of day |
| `Y` | Start or pause the day cycle |
| `P` | Pause or resume wave evolution |
| `H` | Open Controls |
| `?` | Open Help |
| `F` / `L` / `G` | Foam / LOD / diagnostic views |

On touch devices, the left stick moves, dragging open water looks around, and
the labelled right-side controls handle depth, speed, camera views, and the
controls drawer. All held inputs are released on blur, orientation change,
visibility change, and cancelled pointer capture.

## How it works

### Spectral waves

Each frame, every enabled cascade performs:

```text
JONSWAP + swell spectrum
        ↓
time evolution h(k,t)
        ↓
horizontal inverse FFT
        ↓
vertical inverse FFT
        ↓
displacement + derivatives + Jacobian foam
```

The patch sizes are deliberately non-harmonic (`513 m`, `127 m`, `29 m`) so the
lattices do not repeatedly line up and reveal a tile. Their wave-number bands
partition the spectrum instead of overlapping it. A CPU mirror of the two
coarsest bands runs in a worker and provides height, normal, velocity, and foam
queries for the camera and effects.

### Surface and horizon

`OceanLODManager` builds nested square clipmap rings as one mesh. The ocean
vertex shader snaps the rings around the camera, morphs adjacent levels onto a
shared lattice, and samples the appropriate wave bands. The analytic atmosphere
is shared by the sky and ocean shader, keeping reflected lighting and the
horizon consistent.

### Water and diving

Water types provide per-channel absorption, scattering colour, scattering
amount, and turbidity. Clarity scales physical extinction instead of tinting a
flat colour. Crossing the moving surface enables the underwater post-process,
particles, shafts, and a camera-following procedural sea floor that receives
caustics derived from the live wave slopes.

### Whitecaps and particles

Open-water crests break from local steepness, crest height, and wind rather
than coastline depth. Droplets, mist, bubbles, and motes keep their state in
GPU textures. Each field also has a velocity material so Ultra and Cinematic
TAA reproject the particle that is actually visible, not the water behind it.

### Quality and resizing

Quality tiers own simulation resolution, clipmap density, atmospheric samples,
particle budgets, offscreen target sizes, anti-aliasing, and output pixel
budgets. Switching quality rebuilds the tier-bound GPU graph while preserving
the live sea, weather, material controls, diagnostics, and camera state.
Reflection and refraction buffers track the actual backbuffer aspect ratio and
resize with it.

## Project layout

```text
index.html                 Semantic app shell and renderer recovery UI
styles.css                 Responsive visual system and control layouts
serve.py                   No-cache local static server
assets/                    Social preview artwork
src/
  core/                    Quality, presentation, sky, temporal AA
  ocean/                   FFT simulation and ocean subsystems
  interaction/             GPU particle fields and splash geometry
  shaders/                 Ocean, atmosphere, particles, scene, TAA GLSL
  ui/                      Camera, controls drawer, touch controls
  export/                  Validated Unreal specification package
tests/                     Fast deterministic Node tests
```

Important entry points:

| Area | File |
|---|---|
| App lifecycle and automation API | `src/main.js` |
| Wave spectrum and FFT | `src/ocean/WaveSimulation.js` |
| System composition and quality switching | `src/ocean/OceanSystem.js` |
| Surface material bindings | `src/ocean/OceanMaterial.js` |
| Ocean surface GLSL | `src/shaders/oceanSurface.js` |
| Spectrum / FFT GLSL | `src/shaders/oceanSim.js` |
| Weather and sea states | `src/ocean/WeatherOceanController.js` |
| Camera views | `src/ui/CameraController.js` |
| Controls drawer | `src/ui/DebugPanel.js` |

## Public runtime API

The running page exposes a small automation and inspection surface:

```js
await __setSea("rough");
await __setPreset("sunset");
await __setQuality("ultra");
await __setView(2);
await __panel(true);

__setWater("atlantic");
__setTime(18.35);
__setLightning(false);
__dynamicResolution(true);

const state = __stats();
const validation = await __validate();
```

`__ready` becomes true only after materials are compiled, the CPU wave mirror
has produced data, and the renderer has completed a quiet settling window.
`__booted` indicates that the interactive shell has been handed to the user.

The ocean object itself provides:

```js
ocean.getSurfaceData(position); // height, normal, velocity, foam, depth
ocean.getHeight(x, z);
ocean.addDisturbance({ position, radius, strength, velocity, type });
ocean.setWaterType("pacific");
ocean.setQuality("cinematic");
ocean.weather.applyPreset("storm");
ocean.weather.applySeaState("moderate");
```

## Verification

Run the deterministic, dependency-free checks:

```bash
node tests/fft_test.mjs
node tests/shader_hygiene.mjs
node tests/upgrade_contract.mjs
```

- `fft_test.mjs` compares the butterfly implementation against a direct inverse
  DFT.
- `shader_hygiene.mjs` catches shader constructs known to break Babylon's
  WebGPU translation path.
- `upgrade_contract.mjs` verifies the app shell, accessibility safeguards,
  social asset, DOM wiring, hot quality swap, bubble integration, wave-height
  aggregation, and weather-selection state.

The repository also includes deeper Python harnesses for spectrum, rendering,
output resolution, TAA, particles, exports, and seam detection. These harnesses
drive the page through the public API and require a compatible local browser:

```bash
python verify.py
python tiles.py
python resolution_test.py
python taa_test.py
python export_test.py
```

The inverse FFT is intentionally unnormalised; do not divide its amplitudes by
`N²`. Avoid early `return` statements in shader `main()` because Babylon's
WebGPU translation can omit the output struct and produce a black frame.

## Unreal export

Open **Controls → Export & verification → Export Unreal package**, or run:

```js
await __export.downloadPackage();
```

The ZIP includes:

```text
Config/OceanSpectrum.json
Config/OceanMaterial.json
Config/OceanWeatherPresets.json
Config/OceanBreakers.json
README_UNREAL_IMPORT.md
README_LICENSES.md
Documentation/OceanTechnicalReport.md
```

This is an honest implementation specification, not a static mesh disguised as
a portable ocean. WebGPU fragment passes, a shader-evaluated clipmap, and
GPU-resident particles do not have a glTF equivalent. The package carries the
validated numbers and a parameter-by-parameter Unreal mapping so the system can
be rebuilt natively.

## Browser support and privacy

- WebGPU is preferred; WebGL 2 is the compatibility path.
- The renderer error screen can retry or add `?webgl=1` without losing the page.
- The entire simulation runs locally in the browser.
- The project includes no analytics, cookies, sign-in, advertising, or remote
  storage.
- The only network request made by the app itself is the integrity-pinned
  Babylon.js runtime unless you serve that file locally.

## License note

Babylon.js is licensed under Apache-2.0 and is loaded at runtime rather than
redistributed here. All visual textures used by the scene are generated
procedurally. Review the repository's license status before redistributing the
project itself.
