// ---------------------------------------------------------------------------
//  DebugPanel.js -- the live developer panel.  Plain DOM, no dependency: the
//  project has to stay free of paid or third-party UI toolkits.
// ---------------------------------------------------------------------------

import { TIER_ORDER, TIERS } from "../core/quality.js";
import { WEATHER_PRESETS, SEA_STATES } from "../ocean/WeatherOceanController.js";
import { WATER_TYPES } from "../ocean/waterTypes.js";
import { DEBUG_CHANNELS } from "../ocean/OceanDebugTools.js";
import { CAMERA_PRESETS } from "./CameraController.js";
import { UW_PRESETS } from "../underwater/DepthProfile.js";

export class DebugPanel {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.rows = [];
    this.visible = false;
  }

  // --- widgets -------------------------------------------------------------
  _group(title, collapsed) {
    const g = document.createElement("div");
    g.className = "pg" + (collapsed ? " collapsed" : "");
    const h = document.createElement("h4");
    h.textContent = title;
    h.onclick = () => g.classList.toggle("collapsed");
    const body = document.createElement("div");
    body.className = "pg-body";
    g.appendChild(h); g.appendChild(body);
    this.root.appendChild(g);
    return body;
  }

  _slider(parent, label, min, max, step, get, set, fmt) {
    const row = document.createElement("div");
    row.className = "row";
    const l = document.createElement("label");
    l.textContent = label;
    const i = document.createElement("input");
    i.type = "range"; i.min = min; i.max = max; i.step = step;
    const v = document.createElement("span");
    v.className = "val";
    const show = () => {
      const val = get();
      i.value = val;
      v.textContent = fmt ? fmt(val) : (+val).toFixed(step < 0.1 ? 2 : (step < 1 ? 1 : 0));
    };
    i.oninput = () => { set(parseFloat(i.value)); show(); };
    row.appendChild(l); row.appendChild(i); row.appendChild(v);
    parent.appendChild(row);
    this.rows.push(show);
    show();
    return row;
  }

  _select(parent, label, options, get, set) {
    const row = document.createElement("div");
    row.className = "row";
    const l = document.createElement("label");
    l.textContent = label;
    const s = document.createElement("select");
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = o.value; opt.textContent = o.label;
      s.appendChild(opt);
    }
    const show = () => { s.value = get(); };
    s.onchange = () => set(s.value);
    row.appendChild(l); row.appendChild(s);
    parent.appendChild(row);
    this.rows.push(show);
    show();
    return row;
  }

  _check(parent, label, get, set) {
    const row = document.createElement("div");
    row.className = "row chk";
    const l = document.createElement("label");
    l.textContent = label;
    const c = document.createElement("input");
    c.type = "checkbox";
    const show = () => { c.checked = !!get(); };
    c.onchange = () => set(c.checked);
    row.appendChild(l); row.appendChild(c);
    parent.appendChild(row);
    this.rows.push(show);
    show();
    return row;
  }

  _buttons(parent, items, activeGet) {
    const box = document.createElement("div");
    box.className = "btns";
    const btns = [];
    for (const it of items) {
      const b = document.createElement("button");
      b.textContent = it.label;
      b.onclick = () => { it.action(); this.refresh(); };
      box.appendChild(b);
      btns.push([b, it]);
    }
    const show = () => {
      if (!activeGet) return;
      const a = activeGet();
      for (const [b, it] of btns) b.classList.toggle("on", it.key === a);
    };
    parent.appendChild(box);
    this.rows.push(show);
    show();
    return box;
  }

  _note(parent, text) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = text;
    parent.appendChild(p);
    return p;
  }

  // --- build ---------------------------------------------------------------
  build() {
    const app = this.app;
    const o = app.ocean;
    const root = this.root;
    root.innerHTML = "";
    this.rows = [];

    const h = document.createElement("h2");
    h.textContent = "Ocean Controls";
    root.appendChild(h);

    // ---- presets ----------------------------------------------------------
    {
      const g = this._group("Weather presets");
      this._buttons(g, Object.keys(WEATHER_PRESETS).map((k) => ({
        key: k, label: WEATHER_PRESETS[k].label,
        action: () => { o.weather.applyPreset(k); o.setWaterType(WEATHER_PRESETS[k].water); },
      })), () => o.weather.presetKey);
      this._buttons(g, Object.keys(SEA_STATES).map((k) => ({
        key: k, label: SEA_STATES[k].label,
        action: () => o.weather.applySeaState(k),
      })), () => o.weather.seaKey);
    }

    // ---- sea --------------------------------------------------------------
    {
      const g = this._group("Sea");
      const w = o.weather;
      this._slider(g, "Wind speed", 0.5, 34, 0.1, () => w.target.windSpeed,
        (v) => w.set("windSpeed", v), (v) => (+v).toFixed(1) + " m/s");
      this._slider(g, "Wind direction", 0, 360, 1, () => w.target.windDirDeg,
        (v) => w.set("windDirDeg", v), (v) => (+v).toFixed(0) + "°");
      this._slider(g, "Wave height", 0.15, 2.2, 0.01, () => w.target.waveScale,
        (v) => w.set("waveScale", v));
      this._slider(g, "Wave steepness", 0.0, 2.0, 0.01, () => w.target.choppy,
        (v) => w.set("choppy", v));
      this._slider(g, "Swell height", 0, 6, 0.01, () => w.target.swell,
        (v) => w.set("swell", v), (v) => (+v).toFixed(2) + " m");
      this._slider(g, "Swell period", 5, 20, 0.1, () => w.target.swellPeriod,
        (v) => w.set("swellPeriod", v), (v) => (+v).toFixed(1) + " s");
      this._slider(g, "Fetch", 5, 900, 1, () => w.target.fetch / 1000,
        (v) => w.set("fetch", v * 1000), (v) => (+v).toFixed(0) + " km");
      this._slider(g, "Depth", 4, 2000, 1, () => o.sim.params.depth,
        (v) => { o.sim.setParams({ depth: v }); o.buoyancy.onParamsChanged(); },
        (v) => (+v).toFixed(0) + " m");
      this._slider(g, "Spread", 0.25, 3, 0.01, () => o.sim.params.spread,
        (v) => { o.sim.setParams({ spread: v }); o.buoyancy.onParamsChanged(); });
      this._slider(g, "Storm", 0, 1, 0.01, () => w.target.storm, (v) => w.set("storm", v));
      this._slider(g, "Rain", 0, 1, 0.01, () => w.target.rain, (v) => w.set("rain", v));
      this._slider(g, "Transition speed", 0.05, 4, 0.01, () => w.speed, (v) => { w.speed = v; });
    }

    // ---- water ------------------------------------------------------------
    {
      const g = this._group("Water body");
      this._select(g, "Type", Object.keys(WATER_TYPES).map((k) => ({ value: k, label: WATER_TYPES[k].label })),
        () => o.waterKey || "tropical", (v) => o.setWaterType(v));
      this._slider(g, "Clarity", 0.25, 3.0, 0.01, () => o.clarity, (v) => { o.clarity = v; });
      this._slider(g, "Turbidity", 0, 1.5, 0.01, () => o.water.turbid,
        (v) => { o._waterTarget = Object.assign({}, o._waterTarget, { turbid: v }); });
      this._slider(g, "Scattering", 0, 2.5, 0.01, () => o.water.scatterAmt,
        (v) => { o._waterTarget = Object.assign({}, o._waterTarget, { scatterAmt: v }); });
      this._slider(g, "Subsurface", 0, 2, 0.01, () => o.material.state.sss,
        (v) => { o.material.state.sss = v; });
    }

    // ---- surface ----------------------------------------------------------
    {
      const g = this._group("Surface");
      const s = o.material.state;
      this._slider(g, "Foam strength", 0, 3, 0.01, () => o.weather.target.foam,
        (v) => o.weather.set("foam", v));
      this._slider(g, "Shore foam", 0, 3, 0.01, () => s.foamShore, (v) => { s.foamShore = v; });
      this._slider(g, "Foam threshold", 0.1, 1.4, 0.01, () => o.sim.params.foamThreshold,
        (v) => { o.sim.params.foamThreshold = v; });
      this._slider(g, "Foam decay", 0.02, 2.0, 0.01, () => o.sim.params.foamDecay,
        (v) => { o.sim.params.foamDecay = v; });
      this._slider(g, "Micro detail", 0, 2, 0.01, () => s.microDetail, (v) => { s.microDetail = v; });
      this._slider(g, "Sun glitter", 0, 5, 0.01, () => s.glitter, (v) => { s.glitter = v; });
      this._slider(g, "Capillary roughness", 0.001, 0.04, 0.0005, () => s.capillaryVar,
        (v) => { s.capillaryVar = v; }, (v) => (+v).toFixed(4));
      this._slider(g, "Shore steepening", 0, 2, 0.01, () => s.shoreSteepen, (v) => { s.shoreSteepen = v; });
      this._slider(g, "Reflection amount", 0, 1, 0.01, () => s.reflectAmount, (v) => { s.reflectAmount = v; });
      this._slider(g, "Refraction strength", 0, 0.5, 0.005, () => s.refractStrength, (v) => { s.refractStrength = v; });
      this._slider(g, "Caustics", 0, 3, 0.01, () => o.caustics.strength, (v) => { o.caustics.strength = v; });
      this._slider(g, "LOD morph start", 0.35, 0.95, 0.01, () => s.morphStart, (v) => { s.morphStart = v; });
      for (let c = 0; c < 3; c++) {
        this._check(g, `Cascade ${c} (${o.sim.patchSizes[c].toFixed(0)} m)`,
          () => o.sim.enabled[c], (v) => { o.sim.enabled[c] = v ? 1 : 0; o.sim.updateSlopeVariance(); });
      }
    }

    // ---- sky / time --------------------------------------------------------
    {
      const g = this._group("Sky and time");
      const sky = o.sky;
      this._slider(g, "Time of day", 0, 24, 0.01, () => sky.timeOfDay, (v) => { sky.timeOfDay = v; },
        (v) => {
          const hh = Math.floor(v), mm = Math.floor((v - hh) * 60);
          return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
        });
      this._slider(g, "Time speed", 0, 3, 0.01, () => sky.timeSpeed, (v) => { sky.timeSpeed = v; },
        (v) => (+v).toFixed(2) + "h/s");
      this._slider(g, "Latitude", -60, 60, 1, () => sky.latitude, (v) => { sky.latitude = v; });
      this._slider(g, "Cloud cover", 0, 1, 0.01, () => o.weather.target.cloudCover,
        (v) => o.weather.set("cloudCover", v));
      this._slider(g, "Cloud definition", 0, 1, 0.01, () => o.weather.target.cloudSharp,
        (v) => o.weather.set("cloudSharp", v));
      this._slider(g, "Cloud brightness", 0.2, 2.5, 0.01, () => sky.cloudBright, (v) => { sky.cloudBright = v; });
      this._slider(g, "Turbidity", 1.2, 9, 0.01, () => o.weather.target.turbidity,
        (v) => o.weather.set("turbidity", v));
      this._check(g, "Auto exposure", () => sky.autoExposure, (v) => { sky.autoExposure = v; });
      this._slider(g, "Exposure bias", 0.2, 3, 0.01, () => sky.exposureBias, (v) => { sky.exposureBias = v; });
      this._slider(g, "Exposure", 0.05, 8, 0.01, () => sky.exposure,
        (v) => { sky.autoExposure = false; sky.exposure = v; });
      this._buttons(g, [
        { key: "06", label: "06:00", action: () => app.setTime(6) },
        { key: "12", label: "12:00", action: () => app.setTime(12) },
        { key: "18", label: "18:20", action: () => app.setTime(18.35) },
        { key: "00", label: "00:00", action: () => app.setTime(0.4) },
      ]);
    }

    // ---- rendering ---------------------------------------------------------
    {
      const g = this._group("Rendering");
      this._select(g, "Quality", TIER_ORDER.map((k) => ({ value: k, label: TIERS[k].label })),
        () => o.tierName, (v) => app.setQuality(v));
      this._select(g, "Reflections", ["off", "low", "medium", "high", "ultra"].map((k) => ({ value: k, label: k })),
        () => o.reflection.quality, (v) => o.reflection.setQuality(v));
      this._select(g, "Refraction", ["off", "medium", "high", "ultra"].map((k) => ({ value: k, label: k })),
        () => o.refraction.quality, (v) => o.refraction.setQuality(v));
      this._slider(g, "Render scale", 0.5, 2.0, 0.05, () => 1 / app.engine.getHardwareScalingLevel(),
        (v) => { app.present.renderScale = v; app.present.apply(); });
      this._check(g, "Dynamic resolution", () => app.dynamicRes, (v) => { app.dynamicRes = v; });
      this._check(g, "Bloom", () => app.pipeline && app.pipeline.bloomEnabled,
        (v) => { if (app.pipeline) app.pipeline.bloomEnabled = v; });
      this._check(g, "FXAA", () => app.pipeline && app.pipeline.fxaaEnabled,
        (v) => { if (app.pipeline) app.pipeline.fxaaEnabled = v; });
      this._check(g, "Temporal AA", () => !!(app.taa && app.taa.enabled),
        (v) => { if (app.taa) { app.taa.enabled = v; app.taa.reset(); } });
      this._select(g, "TAA mode", [
        { value: "1", label: "Reproject" },
        { value: "2", label: "Jittered" },
      ], () => String(app.taa ? app.taa.mode : 1),
        (v) => { if (app.taa) app.taa.setMode(parseInt(v, 10)); });
      this._check(g, "Underwater FX", () => o.underwater.enabled, (v) => { o.underwater.enabled = v; });
      this._slider(g, "God rays", 0, 2, 0.01, () => o.underwater.godRays,
        (v) => { o.underwater.godRays = v; });
      this._slider(g, "Bubbles", 0, 2.5, 0.01, () => o.underwater.bubbleAmount,
        (v) => { o.underwater.bubbleAmount = v; });
      this._slider(g, "Marine snow", 0, 2.5, 0.01, () => o.underwater.motesAmount,
        (v) => { o.underwater.motesAmount = v; });
      this._check(g, "Sandy seafloor", () => !!(o.seafloor && o.seafloor.enabled),
        (v) => { if (o.seafloor) o.seafloor.setEnabled(v); });
      this._check(g, "Spray / rain", () => o.spray.enabled, (v) => { o.spray.enabled = v; });
      this._check(g, "Wakes", () => o.foam.enabled, (v) => { o.foam.enabled = v; });
    }

    if (o.world) {
      const g = this._group("Underwater world");
      const w = o.world;
      this._buttons(g, Object.keys(UW_PRESETS).map((k) => ({
        key: k, label: UW_PRESETS[k].label,
        action: () => w.applyPreset(k, true),
      })), () => w.presetKey);
      this._slider(g, "Max depth", 80, 4000, 10, () => w.maxDepth,
        (v) => { w.maxDepth = v; }, (v) => (+v).toFixed(0) + " m");
      this._slider(g, "Visibility", 0.2, 2.0, 0.01, () => w.visibility,
        (v) => { w.visibility = v; o.clarity = v; });
      this._slider(g, "Absorption R", 0.05, 1.2, 0.01, () => o.water.absorb[0],
        (v) => { o.water.absorb[0] = v; o._waterTarget.absorb[0] = v; });
      this._slider(g, "Absorption G", 0.01, 0.6, 0.005, () => o.water.absorb[1],
        (v) => { o.water.absorb[1] = v; o._waterTarget.absorb[1] = v; });
      this._slider(g, "Absorption B", 0.005, 0.3, 0.005, () => o.water.absorb[2],
        (v) => { o.water.absorb[2] = v; o._waterTarget.absorb[2] = v; });
      this._slider(g, "Scattering", 0.2, 2.0, 0.01, () => o.water.scatterAmt,
        (v) => { o.water.scatterAmt = v; o._waterTarget.scatterAmt = v; });
      this._slider(g, "Turbidity", 0, 1.2, 0.01, () => o.water.turbid,
        (v) => { o.water.turbid = v; o._waterTarget.turbid = v; });
      this._slider(g, "Volumetric shafts", 0, 1.5, 0.01, () => w.shaftQuality,
        (v) => { w.shaftQuality = v; });
      this._slider(g, "Caustic depth cut", 8, 120, 1, () => w.causticCut,
        (v) => { w.causticCut = v; }, (v) => (+v).toFixed(0) + " m");
      this._slider(g, "Particle density", 0, 2.5, 0.01, () => w.particleMul,
        (v) => { w.particleMul = v; });
      this._slider(g, "Marine snow", 0, 2.5, 0.01, () => w.snowMul,
        (v) => { w.snowMul = v; });
      this._slider(g, "Bubble plumes", 0, 2.5, 0.01, () => w.bubbleMul,
        (v) => { w.bubbleMul = v; });
      this._slider(g, "Coral density", 0, 2, 0.01, () => w.coralMul,
        (v) => { w.coralMul = v; });
      this._slider(g, "Fish density", 0, 2, 0.01, () => w.fishMul,
        (v) => { w.fishMul = v; });
      this._slider(g, "Bioluminescence", 0, 2, 0.01, () => w.bioMul,
        (v) => { w.bioMul = v; });
      this._slider(g, "Dive light", 0, 80, 0.5, () => (w.diveManual < 0 ? w.dive.intensity : w.diveManual),
        (v) => { w.diveManual = v; }, (v) => (+v).toFixed(0));
      this._slider(g, "Dive range", 6, 120, 0.5, () => w.diveRange,
        (v) => { w.diveRange = v; }, (v) => (+v).toFixed(0) + " m");
      this._slider(g, "Terrain LOD", 0.4, 2.0, 0.01, () => w.terrain.lodDist,
        (v) => { w.terrain.lodDist = v; });
      this._slider(g, "Current X", -0.4, 0.4, 0.005, () => w.current[0],
        (v) => { w.current[0] = v; });
      this._slider(g, "Current Z", -0.4, 0.4, 0.005, () => w.current[2],
        (v) => { w.current[2] = v; });
      this._slider(g, "Dunes", 0, 3, 0.01, () => w.terrain.dune,
        (v) => { w.terrain.dune = v; });
      this._note(g, "C cycles reef, arch, vents, cavern, drop-off, canyon, then depth stations. Dive light is automatic below the photic zone unless you move this slider.");
    }

    // ---- debug -------------------------------------------------------------
    {
      const g = this._group("Debug", true);
      this._select(g, "Channel", DEBUG_CHANNELS.map((k, i) => ({ value: String(i), label: k })),
        () => String(o.debug.channel), (v) => o.debug.setChannel(parseInt(v, 10)));
      this._check(g, "Wireframe", () => o.debug.showWire, (v) => o.debug.setWireframe(v));
      this._check(g, "Pause waves", () => o.sim.paused, (v) => { o.sim.paused = v; });
      this._slider(g, "Time scale", 0, 3, 0.01, () => o.sim.timeScale, (v) => { o.sim.timeScale = v; });
      this._buttons(g, [
        { key: "v", label: "Validate CPU/GPU", action: async () => {
          const r = await o.debug.validateBuoyancy();
          console.log("[ocean] buoyancy validation", r);
          alert("Buoyancy validation\n" + JSON.stringify(r, null, 2));
        } },
        { key: "s", label: "Log stats", action: () => console.table(o.debug.stats()) },
      ]);
      const info = document.createElement("p");
      info.className = "note";
      g.appendChild(info);
      this._info = info;
      this.rows.push(() => {
        const s = o.debug.stats();
        info.textContent = Object.keys(s).map((k) => `${k}: ${s[k]}`).join("\n");
        info.style.whiteSpace = "pre-line";
      });
    }

    {
      const g = this._group("Surf and breakers", true);
      const b = o.breakers;
      this._check(g, "Breakers enabled", () => b.enabled, (v) => { b.enabled = v; });
      this._slider(g, "Swell height", 0.1, 5.0, 0.05, () => b.height,
        (v) => { b.height = v; }, (v) => v.toFixed(2) + " m");
      this._slider(g, "Swell period", 4, 18, 0.1, () => b.period,
        (v) => { b.period = v; }, (v) => v.toFixed(1) + " s");
      this._slider(g, "Crest throw", 0.0, 2.0, 0.01, () => b.lean,
        (v) => { b.lean = v; });
      this._slider(g, "Surf-zone decay", 0.0, 2.0, 0.01, () => b.decay,
        (v) => { b.decay = v; });
      this._slider(g, "Break-line variation", 0.0, 1.2, 0.01, () => b.variation,
        (v) => { b.variation = v; });
      this._slider(g, "Whitewater", 0.0, 2.0, 0.01, () => b.whitewater,
        (v) => { b.whitewater = v; });
      this._slider(g, "Spray density", 0.0, 2.5, 0.01, () => b.sprayLight,
        (v) => { b.sprayLight = v; });
      this._slider(g, "Bubble density", 0.0, 2.5, 0.01, () => b.bubbles,
        (v) => { b.bubbles = v; });
      this._slider(g, "Surf radius", 30, 260, 5, () => b.radius,
        (v) => { b.radius = v; }, (v) => v.toFixed(0) + " m");
      this._slider(g, "Shoaling depth", 4, 40, 0.5, () => b.maxDepth,
        (v) => { b.maxDepth = v; }, (v) => v.toFixed(1) + " m");
    }

    {
      const g = this._group("Presentation", true);
      const pr = app.present;
      const note = document.createElement("div");
      note.className = "note";
      const refresh = () => {
        const st = pr.stats();
        note.textContent = `${st.output}  ${st.megapixels} MP  x${st.renderScale}`;
      };
      this._slider(g, "Render scale", 0.5, 3.2, 0.01, () => pr.renderScale,
        (v) => { pr.renderScale = v; pr.apply(); setTimeout(refresh, 60); });
      this._check(g, "Dynamic resolution", () => pr.dynamicResolution,
        (v) => { pr.dynamicResolution = v; });
      this._slider(g, "Target frame rate", 24, 144, 1, () => pr.targetFrameRate,
        (v) => { pr.targetFrameRate = v; }, (v) => v.toFixed(0) + " fps");
      this._slider(g, "Adaptation speed", 0.2, 3.0, 0.05,
        () => pr.resolutionAdaptationSpeed, (v) => { pr.resolutionAdaptationSpeed = v; });
      const row = document.createElement("div");
      row.className = "btnrow";
      for (const [label, px] of [["1080p", 1920], ["1440p", 2560], ["4K", 3840]]) {
        const bt = document.createElement("button");
        bt.textContent = label;
        bt.onclick = () => { pr.targetWidth(px); setTimeout(refresh, 120); };
        row.appendChild(bt);
      }
      g.appendChild(row);
      g.appendChild(note);
      refresh();
      setInterval(refresh, 1000);
    }


    {
      const g = this._group("Export");
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = "Serialises the ocean and packages it for Unreal. "
        + "Nothing here is a runnable ocean -- it is the specification for one, "
        + "plus reference renders to match against.";
      const status = document.createElement("div");
      status.className = "note";
      const run = async (fn, label) => {
        status.textContent = label + "...";
        try { const r = await fn(); status.textContent = r || (label + " done"); }
        catch (e) { status.textContent = "BLOCKED: " + e.message; }
      };
      const row = document.createElement("div");
      row.className = "btnrow";
      const mk = (label, fn) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.onclick = () => run(fn, label);
        row.appendChild(b);
        return b;
      };
      const primary = mk("Export Unreal Package", async () => {
        const r = await app.exporter.downloadPackage();
        return `Ocean_UE_Export.zip written, ${r.files} files`;
      });
      primary.classList.add("primary");
      mk("Export Configuration", async () => {
        app.exporter.downloadConfig();
        return "Ocean_Config.zip written";
      });
      mk("Validate", async () => {
        const issues = app.exporter.validate(app.exporter.buildFiles());
        return issues.length ? `${issues.length} issue(s): ${issues[0]}`
                             : "validation passed";
      });
      g.appendChild(note);
      g.appendChild(row);
      g.appendChild(status);
    }

    {
      const g = this._group("Cameras");
      this._buttons(g, CAMERA_PRESETS.map((p, i) => ({
        key: p.key, label: p.label, action: () => app.applyCameraPreset(i),
      })), () => CAMERA_PRESETS[app.camera.presetIndex].key);
      this._note(g, "Click the canvas to capture the mouse. WASD to move, Shift to boost.");
    }
  }

  refresh() { for (const r of this.rows) r(); }

  toggle(v) {
    this.visible = v === undefined ? !this.visible : v;
    this.root.classList.toggle("hidden", !this.visible);
    if (this.visible) this.refresh();
    return this.visible;
  }
}
