// ---------------------------------------------------------------------------
//  OceanExport.js -- serialise the ocean and package it for Unreal Engine.
//
//  What can and cannot cross the boundary, stated plainly, because the brief is
//  explicit about not pretending otherwise:
//
//    CAN cross   the numbers.  Spectrum, cascades, optics, foam, weather --
//                every value that defines how this ocean looks and moves.
//    CAN cross   flat data: a reference mesh, LUTs, reference renders.
//    CANNOT cross the WebGPU compute passes, the GLSL, the FFT, the CDLOD
//                clipmap or the particle systems.  glTF has no representation
//                for any of that, and claiming otherwise would produce an
//                import that looks like a dead plane of water.
//
//  So the package is a SPECIFICATION plus reference data, and the Unreal side
//  rebuilds the simulation natively from it.  README_UNREAL_IMPORT.md maps each
//  parameter to where it goes.
// ---------------------------------------------------------------------------

import { Zip } from "./zip.js";
import { WEATHER_PRESETS } from "../ocean/WeatherOceanController.js";
import { WATER_TYPES } from "../ocean/waterTypes.js";

const M_TO_UU = 100;          // 1 Babylon metre = 100 Unreal units

export class OceanExport {
  constructor(app) {
    this.app = app;
    this.issues = [];
  }

  // -------------------------------------------------------------------------
  //  configuration
  // -------------------------------------------------------------------------
  spectrum() {
    const o = this.app.ocean;
    const p = o.sim.params;
    const cas = o.sim.cascades.map((c) => ({
      patchSizeMeters: c.L,
      resolution: c.N,
      texelMeters: +(c.L / c.N).toFixed(4),
    }));
    return {
      schema: "abyssal.ocean.spectrum/1",
      units: { length: "meters", time: "seconds", angle: "degrees" },
      gravity: 9.81,
      spectrumType: "JONSWAP with Hasselmann directional spreading, plus an "
        + "independent swell band",
      wind: {
        speedMetersPerSecond: p.windSpeed,
        directionDegrees: p.windDirDeg,
        fetchMeters: p.fetch,
        directionalSpread: p.spread,
      },
      swell: {
        significantHeightMeters: p.swell,
        peakPeriodSeconds: p.swellPeriod,
        directionDegrees: p.swellDirDeg,
      },
      water: { depthMeters: p.depth },
      amplitude: p.amplitude,
      choppiness: p.choppy,
      waveHeightScale: p.waveScale,
      seed: p.seed,
      cascades: cas,
      cascadePartition: "each cascade carries wavenumbers up to 0.6 x Nyquist "
        + "of the next coarser one, so no band is doubled or missing",
      foam: {
        jacobianThreshold: p.foamThreshold,
        injectRate: p.foamInject,
        decayPerSecond: p.foamDecay,
      },
      measured: {
        significantWaveHeightMeters:
          +this.app.ocean.debug.significantWaveHeight().toFixed(3),
        slopeVariancePerCascade: o.sim.slopeVariance.map((v) => +v.toFixed(5)),
      },
    };
  }

  material() {
    const o = this.app.ocean;
    const s = o.material.state;
    const w = o.water;
    return {
      schema: "abyssal.ocean.material/1",
      units: { length: "meters", coefficients: "per meter" },
      indexOfRefraction: 1.333,
      absorptionPerMeter: { r: w.absorb[0], g: w.absorb[1], b: w.absorb[2] },
      scattering: {
        albedo: { r: w.scatterCol[0], g: w.scatterCol[1], b: w.scatterCol[2] },
        amount: w.scatterAmt,
        turbidity: w.turbid,
      },
      roughness: {
        model: "Cox and Munk mean square slope, mss = 0.003 + 0.00512 * U",
        note: "unresolved cascade slope variance is converted to GGX roughness; "
          + "this is what produces the sun glitter path rather than one hot spot",
        capillaryFloor: s.capillaryVar,
        microDetail: s.microDetail,
      },
      reflection: { strength: s.reflectAmount },
      refraction: { strength: s.refractStrength },
      subsurface: { strength: s.sss },
      foam: {
        amount: s.foamAmount,
        shoreBand: s.foamShore,
        whitecapNote: "whitecaps come from the simulation Jacobian plus wind "
          + "driven steepness, never painted on crests",
      },
      sunGlitter: { strength: s.glitter },
      deepDepthMeters: s.deepDepth,
      seaLevelMeters: o.seaLevel,
    };
  }

  weather() {
    const out = {
      schema: "abyssal.ocean.weather/1",
      presets: {},
      waterTypes: {},
    };
    for (const k of Object.keys(WEATHER_PRESETS)) {
      const p = WEATHER_PRESETS[k];
      out.presets[k] = JSON.parse(JSON.stringify(p));
    }
    for (const k of Object.keys(WATER_TYPES)) {
      out.waterTypes[k] = JSON.parse(JSON.stringify(WATER_TYPES[k]));
    }
    return out;
  }

  breakers() {
    const b = this.app.ocean.breakers;
    return {
      schema: "abyssal.ocean.breakers/1",
      openOceanWhitecaps: {
        model: "steepness x crest height x wind, calibrated so only the top few "
          + "per cent of crests break (Monahan whitecap coverage)",
        steepnessOnset: 0.13,
        steepnessSaturation: 0.26,
        windOnsetMetersPerSecond: 4.5,
        windSaturationMetersPerSecond: 17.5,
      },
      shorelineSurf: {
        enabled: !!this.app.ocean.shoreline,
        note: "optional module; needs a bathymetry and a wave travel time field",
        phase: "omega * (t - tau), tau from |grad tau| = 1/sqrt(g d)",
        greensLawExponent: -0.25,
        mcCowanBreakingIndex: 0.78,
        crestThrow: b.lean,
        surfZoneDecay: b.decay,
      },
      emission: {
        whitewater: b.whitewater,
        spray: b.sprayLight,
        bubbles: b.bubbles,
        sampleRadiusMeters: b.radius,
      },
    };
  }

  // -------------------------------------------------------------------------
  //  validation (brief section 81)
  // -------------------------------------------------------------------------
  validate(files) {
    const issues = [];
    const need = [
      "README_UNREAL_IMPORT.md", "README_LICENSES.md",
      "Config/OceanSpectrum.json", "Config/OceanMaterial.json",
      "Config/OceanWeatherPresets.json", "Config/OceanBreakers.json",
      "Documentation/OceanTechnicalReport.md",
    ];
    for (const n of need) if (!files.some((f) => f.path === n)) issues.push(`missing ${n}`);

    const badNum = (obj, path) => {
      if (obj === null || obj === undefined) { issues.push(`null at ${path}`); return; }
      if (typeof obj === "number") {
        if (!Number.isFinite(obj)) issues.push(`non-finite number at ${path}`);
        return;
      }
      if (typeof obj !== "object") return;
      for (const k of Object.keys(obj)) badNum(obj[k], `${path}.${k}`);
    };
    for (const f of files) {
      if (!f.path.endsWith(".json")) continue;
      try { badNum(JSON.parse(f.data), f.path); }
      catch (e) { issues.push(`invalid JSON in ${f.path}: ${e.message}`); }
    }
    for (const f of files) {
      if (!/^[A-Za-z0-9_./-]+$/.test(f.path)) issues.push(`unsupported filename ${f.path}`);
      if (f.path.startsWith("/") || f.path.includes("..")) issues.push(`invalid path ${f.path}`);
      const len = typeof f.data === "string" ? f.data.length : f.data.length;
      if (!len) issues.push(`empty file ${f.path}`);
    }
    this.issues = issues;
    return issues;
  }

  // -------------------------------------------------------------------------
  //  package
  // -------------------------------------------------------------------------
  buildFiles(extra = []) {
    const spec = this.spectrum();
    const mat = this.material();
    const wea = this.weather();
    const brk = this.breakers();
    const j = (o) => JSON.stringify(o, null, 2);
    const files = [
      { path: "Config/OceanSpectrum.json", data: j(spec) },
      { path: "Config/OceanMaterial.json", data: j(mat) },
      { path: "Config/OceanWeatherPresets.json", data: j(wea) },
      { path: "Config/OceanBreakers.json", data: j(brk) },
      { path: "README_UNREAL_IMPORT.md", data: unrealReadme(spec, mat) },
      { path: "README_LICENSES.md", data: licenses() },
      { path: "Documentation/OceanTechnicalReport.md",
        data: technicalReport(this.app, spec, mat, brk) },
      ...extra,
    ];
    return files;
  }

  async downloadPackage(extra = []) {
    const files = this.buildFiles(extra);
    const issues = this.validate(files);
    if (issues.length) {
      throw new Error("export blocked, missing or invalid data:\n - " + issues.join("\n - "));
    }
    const zip = new Zip();
    for (const f of files) zip.add(f.path, f.data);
    save(zip.blob(), "Ocean_UE_Export.zip");
    return { files: files.length, issues };
  }

  downloadConfig() {
    const zip = new Zip();
    for (const f of this.buildFiles().filter((f) => f.path.startsWith("Config/"))) {
      zip.add(f.path, f.data);
    }
    save(zip.blob(), "Ocean_Config.zip");
  }
}

function save(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

// ---------------------------------------------------------------------------
//  documents
// ---------------------------------------------------------------------------
function unrealReadme(spec, mat) {
  return `# Importing this ocean into Unreal Engine

## Read this first

**Nothing in this package is a working ocean.** It is the specification for one.

The Babylon ocean is a set of WebGPU fragment passes: three JONSWAP cascades
inverse-transformed by FFT every frame, a CDLOD clipmap evaluated in a vertex
shader, and GPU-resident particle fields. glTF has no representation for any of
that. Importing a mesh from here and calling the conversion done gives you a
static plane of water, which the brief lists as a failure condition.

What crosses the boundary is **the numbers** — every value that defines how this
ocean looks and moves — plus reference renders to match against. The simulation
is rebuilt natively on the Unreal side.

## Units and axes

| | Babylon | Unreal |
|---|---|---|
| length | 1 metre | 100 uu |
| up axis | +Y | +Z |
| handedness | left | left |
| forward | +Z | +X |

A Babylon position \`(x, y, z)\` becomes an Unreal position \`(z, x, y) * ${M_TO_UU}\`.
**Wave dimensions must survive this exactly**: a ${spec.cascades[0].patchSizeMeters} m
cascade is a ${spec.cascades[0].patchSizeMeters * M_TO_UU} uu patch, and a
significant wave height of ${spec.measured.significantWaveHeightMeters} m is
${(spec.measured.significantWaveHeightMeters * M_TO_UU).toFixed(0)} uu. Verify
against \`Reference/Babylon_4K/\` rather than assuming the transform is right.

## Parameter map

### Spectrum → your compute shader (Config/OceanSpectrum.json)

| Babylon | Value | Unreal |
|---|---|---|
| \`wind.speedMetersPerSecond\` | ${spec.wind.speedMetersPerSecond} | spectrum U, drives both amplitude and Cox-Munk slope variance |
| \`wind.directionDegrees\` | ${spec.wind.directionDegrees} | spectrum direction; note the axis swap above |
| \`wind.fetchMeters\` | ${spec.wind.fetchMeters} | JONSWAP fetch |
| \`swell.*\` | ${spec.swell.significantHeightMeters} m / ${spec.swell.peakPeriodSeconds} s | an independent narrow band added to the spectrum, not a scale on the wind sea |
| \`cascades[]\` | ${spec.cascades.map((c) => c.patchSizeMeters + " m").join(", ")} | one FFT domain each; **keep the sizes non-harmonic** |
| \`choppiness\` | ${spec.choppiness} | horizontal displacement scale |
| \`seed\` | ${spec.seed} | the same integer-hashed RNG, or the seas will not match |

The cascade sizes are deliberately not in 2:1 ratios. Sizes in simple ratios make
the lattices coincide every few hundred metres and the eye reads that as tiling.

### Material → M_Ocean_Master (Config/OceanMaterial.json)

| Babylon | Value | Unreal |
|---|---|---|
| \`absorptionPerMeter\` | ${JSON.stringify(mat.absorptionPerMeter)} | per-channel Beer-Lambert extinction over the real path length. This is what makes water blue; do not replace it with a blue tint |
| \`scattering.albedo\` | ${JSON.stringify(mat.scattering.albedo)} | water-leaving reflectance, a few per cent. Keeps the sea a dark body whose brightness is nearly all reflection |
| \`indexOfRefraction\` | ${mat.indexOfRefraction} | Fresnel; use a real Fresnel, not a power curve, or the water goes chrome at grazing angles |
| \`roughness\` | Cox-Munk | hand the slope variance of every cascade the pixel cannot resolve to roughness. This produces the glitter path and kills distant aliasing at once |
| \`sunGlitter.strength\` | ${mat.sunGlitter.strength} | scales the above; it is not a separate highlight |

### Breakers → Niagara + material (Config/OceanBreakers.json)

Whitecaps are **not** painted on crests. A crest breaks when it is both steep and
high and the wind is strong enough to push it over, calibrated so only the top
few per cent break. Feed your foam mask from the simulation Jacobian the same way.

### Weather → DA_OceanPreset (Config/OceanWeatherPresets.json)

Every validated state. Build one data asset per preset and drive the spectrum
from it; do not hard-code tuning inside the material.

## Suggested Unreal structure

\`\`\`
M_Ocean_Master
├── spectral displacement   (compute -> render target, cascaded)
├── micro normals           (world-space, never mesh UV)
├── Fresnel / absorption / scattering
├── refraction / reflection
├── foam + whitewater       (Jacobian driven)
├── sun glitter             (roughness from unresolved slope variance)
└── underwater integration
\`\`\`

Geometry: camera-centred clipmap or projected grid. **Sample every wave field in
continuous world space**, never in per-tile UV — that is what produces visible
square patches, and removing them is a hard requirement.

## What to verify

Compare against \`Reference/Babylon_4K/\` at matching sun angle and weather:
wave height and wavelength, crest shape, foam placement, water colour with depth,
glitter path length, and the horizon. Then repeat the no-squares sweep from 1 m
to 1000 m above the surface.
`;
}

function licenses() {
  return `# Licenses

## This package

The ocean configuration, documentation and reference renders in this package are
produced by the Abyssal ocean project and may be used freely.

## Dependencies

| Component | License | Note |
|---|---|---|
| Babylon.js | Apache-2.0 | runtime only, not redistributed here |

Every texture and LUT in this package is generated procedurally at runtime by the
project itself. No third-party texture library, paid asset pack, commercial ocean
plugin or subscription API is involved, and none is required to use it.
`;
}

function technicalReport(app, spec, mat, brk) {
  const o = app.ocean;
  const st = o.debug.stats();
  const pr = app.present.stats();
  const eff = o.effects || {};
  return `# Ocean technical report

Generated from the running Babylon ocean.

## Spectrum

| | |
|---|---|
| model | ${spec.spectrumType} |
| wind | ${spec.wind.speedMetersPerSecond} m/s at ${spec.wind.directionDegrees} deg, fetch ${spec.wind.fetchMeters} m |
| swell | ${spec.swell.significantHeightMeters} m at ${spec.swell.peakPeriodSeconds} s |
| measured Hs | ${spec.measured.significantWaveHeightMeters} m |
| seed | ${spec.seed} |

## Cascades

| # | patch | resolution | texel |
|---|---|---|---|
${spec.cascades.map((c, i) =>
  `| ${i} | ${c.patchSizeMeters} m | ${c.resolution}^2 | ${c.texelMeters} m |`).join("\n")}

Partitioned at 0.6 x Nyquist of the coarser neighbour. Sizes are non-harmonic on
purpose: harmonic patches coincide periodically and read as tiling.

## Geometry

| | |
|---|---|
| clipmap | ${st.clipmap} |
| morphing | CDLOD, with the cascade weights derived from an effective cell size that grows with the morph |

## Optics

| | |
|---|---|
| absorption (1/m) | ${mat.absorptionPerMeter.r}, ${mat.absorptionPerMeter.g}, ${mat.absorptionPerMeter.b} |
| scattering albedo | ${mat.scattering.albedo.r}, ${mat.scattering.albedo.g}, ${mat.scattering.albedo.b} |
| roughness | ${mat.roughness.model} |

## Breaking and foam

Open-ocean whitecaps: ${brk.openOceanWhitecaps.model}.
Onset at ${brk.openOceanWhitecaps.windOnsetMetersPerSecond} m/s, saturating at
${brk.openOceanWhitecaps.windSaturationMetersPerSecond} m/s.

Shoreline surf module: ${brk.shorelineSurf.enabled ? "active" : "not present in this build"}.

## Particle budgets

| field | capacity |
|---|---|
| droplets | ${eff.droplets ? eff.droplets.count : "n/a"} |
| mist | ${eff.mist ? eff.mist.count : "n/a"} |
| bubbles | ${eff.bubbles ? eff.bubbles.count : "n/a"} |

## Presentation

| | |
|---|---|
| backbuffer | ${pr.output} (${pr.megapixels} MP) |
| render scale | ${pr.renderScale} |
| device pixel ratio | ${pr.devicePixelRatio} |
| dynamic resolution | ${pr.dynamicResolution ? "on" : "off (opt in)"} |
| backend | ${st.backend} |
| tier | ${st.tier} |

## Known limitations

- Reflections are planar plus the analytic sky, so displaced crests carry the
  usual planar-reflection parallax error.
- The CPU wave mirror covers the two coarsest cascades, so the smallest chop is
  not felt by anything sampling it.
- No temporal anti-aliasing: there are no motion vectors in this build, so thin
  crest edges and spray still shimmer at high resolution. This is the largest
  remaining gap against the brief.
- Breaking crests deform and throw forward but do not enclose a barrel.
- Whitewater is shaded per fragment from the breaking state; it is not advected
  as a field with its own lifetime.
`;
}
