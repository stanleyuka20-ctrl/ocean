// ---------------------------------------------------------------------------
//  DebugPanel.js -- the live developer panel.  Plain DOM, no dependency: the
//  project has to stay free of paid or third-party UI toolkits.
// ---------------------------------------------------------------------------

import { TIER_ORDER, TIERS } from "../core/quality.js";
import { WEATHER_PRESETS, SEA_STATES } from "../ocean/WeatherOceanController.js";
import { WATER_TYPES } from "../ocean/waterTypes.js";
import { DEBUG_CHANNELS } from "../ocean/OceanDebugTools.js";
import { CAMERA_PRESETS } from "./CameraController.js";

export class DebugPanel {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.rows = [];
    this.visible = false;
    this._uid = 0;
    this._returnFocus = null;
  }

  // --- widgets -------------------------------------------------------------
  _id(prefix) {
    this._uid += 1;
    return `abyssal-${prefix}-${this._uid}`;
  }

  _group(title, collapsed) {
    const g = document.createElement("div");
    g.className = "pg" + (collapsed ? " collapsed" : "");
    const h = document.createElement("button");
    h.type = "button";
    h.className = "pg-toggle";
    h.textContent = title;
    const body = document.createElement("div");
    body.className = "pg-body";
    body.id = this._id("group");
    h.setAttribute("aria-controls", body.id);
    h.setAttribute("aria-expanded", String(!collapsed));
    h.onclick = () => {
      const isCollapsed = g.classList.toggle("collapsed");
      h.setAttribute("aria-expanded", String(!isCollapsed));
    };
    g.appendChild(h); g.appendChild(body);
    this.root.appendChild(g);
    return body;
  }

  _subhead(parent, text) {
    const h = document.createElement("h3");
    h.className = "subhead";
    h.textContent = text;
    parent.appendChild(h);
    return h;
  }

  _slider(parent, label, min, max, step, get, set, fmt) {
    const row = document.createElement("div");
    row.className = "row";
    const l = document.createElement("label");
    l.textContent = label;
    const i = document.createElement("input");
    i.type = "range"; i.min = min; i.max = max; i.step = step;
    i.id = this._id("range");
    l.htmlFor = i.id;
    const v = document.createElement("span");
    v.className = "val";
    v.id = this._id("value");
    i.setAttribute("aria-describedby", v.id);
    const show = () => {
      const val = get();
      i.value = val;
      v.textContent = fmt ? fmt(val) : (+val).toFixed(step < 0.1 ? 2 : (step < 1 ? 1 : 0));
      i.setAttribute("aria-valuetext", v.textContent);
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
    s.id = this._id("select");
    l.htmlFor = s.id;
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
    c.id = this._id("check");
    l.htmlFor = c.id;
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
      b.type = "button";
      b.textContent = it.label;
      b.onclick = () => { it.action(); this.refresh(); };
      box.appendChild(b);
      btns.push([b, it]);
    }
    const show = () => {
      if (!activeGet) return;
      const a = activeGet();
      for (const [b, it] of btns) {
        const active = it.key === a;
        b.classList.toggle("on", active);
        b.setAttribute("aria-pressed", String(active));
      }
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
    const activeId = root.contains(document.activeElement) ? document.activeElement.id : "";
    root.innerHTML = "";
    this.rows = [];
    this._uid = 0;

    const header = document.createElement("header");
    header.className = "panel-head";
    const titleWrap = document.createElement("div");
    const eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "Ocean laboratory";
    const h = document.createElement("h2");
    h.textContent = "Controls";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "panel-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close controls");
    close.onclick = () => this.toggle(false);
    titleWrap.appendChild(eyebrow);
    titleWrap.appendChild(h);
    header.appendChild(titleWrap);
    header.appendChild(close);
    root.appendChild(header);

    // ---- presets ----------------------------------------------------------
    {
      const g = this._group("Presets");
      this._subhead(g, "Weather & lighting");
      this._buttons(g, Object.keys(WEATHER_PRESETS).map((k) => ({
        key: k, label: WEATHER_PRESETS[k].label,
        action: () => app.applyEnvironmentPreset(k),
      })), () => o.weather.presetKey);
      this._subhead(g, "Sea state");
      this._buttons(g, Object.keys(SEA_STATES).map((k) => ({
        key: k, label: SEA_STATES[k].label,
        action: () => app.applySeaState(k),
      })), () => o.weather.seaKey);
    }

    // ---- camera and scene views -------------------------------------------
    {
      const g = this._group("Camera & scene views");
      this._buttons(g, CAMERA_PRESETS.map((p, i) => ({
        key: p.key, label: p.label, action: () => app.applyCameraPreset(i),
      })), () => CAMERA_PRESETS[app.camera.presetIndex].key);
      this._note(g, "Camera views change the framing. Storm, sunset, and night views also load the named scene.");
    }

    // ---- sea --------------------------------------------------------------
    {
      const g = this._group("Waves & wind");
      const w = o.weather;
      this._slider(g, "Wind speed", 0.5, 34, 0.1, () => w.target.windSpeed,
        (v) => w.set("windSpeed", v), (v) => (+v).toFixed(1) + " m/s");
      this._slider(g, "Wind direction", 0, 360, 1, () => w.target.windDirDeg,
        (v) => w.set("windDirDeg", v), (v) => (+v).toFixed(0) + "°");
      this._slider(g, "Wave amplitude", 0.15, 2.2, 0.01, () => w.target.waveScale,
        (v) => w.set("waveScale", v));
      this._slider(g, "Wave steepness", 0.0, 2.0, 0.01, () => w.target.choppy,
        (v) => w.set("choppy", v));
      this._slider(g, "Swell height", 0, 6, 0.01, () => w.target.swell,
        (v) => w.set("swell", v), (v) => (+v).toFixed(2) + " m");
      this._slider(g, "Swell period", 5, 20, 0.1, () => w.target.swellPeriod,
        (v) => w.set("swellPeriod", v), (v) => (+v).toFixed(1) + " s");
      this._slider(g, "Wind travel distance", 5, 900, 1, () => w.target.fetch / 1000,
        (v) => w.set("fetch", v * 1000), (v) => (+v).toFixed(0) + " km");
      this._slider(g, "Depth", 4, 2000, 1, () => o.sim.params.depth,
        (v) => { o.sim.setParams({ depth: v }); o.buoyancy.onParamsChanged(); },
        (v) => (+v).toFixed(0) + " m");
      this._slider(g, "Direction spread", 0.25, 3, 0.01, () => o.sim.params.spread,
        (v) => { o.sim.setParams({ spread: v }); o.buoyancy.onParamsChanged(); });
      this._slider(g, "Storm intensity", 0, 1, 0.01, () => w.target.storm, (v) => w.set("storm", v));
      this._slider(g, "Rain intensity", 0, 1, 0.01, () => w.target.rain, (v) => w.set("rain", v));
      this._slider(g, "Preset transition", 0.05, 4, 0.01, () => w.speed, (v) => { w.speed = v; });
    }

    // ---- water ------------------------------------------------------------
    {
      const g = this._group("Water appearance", true);
      this._select(g, "Water type", Object.keys(WATER_TYPES).map((k) => ({ value: k, label: WATER_TYPES[k].label })),
        () => o.waterKey || "tropical", (v) => o.setWaterType(v));
      this._slider(g, "Water clarity", 0.25, 3.0, 0.01, () => o.clarity, (v) => { o.clarity = v; });
      this._slider(g, "Water murkiness", 0, 1.5, 0.01, () => o.water.turbid,
        (v) => { o._waterTarget = Object.assign({}, o._waterTarget, { turbid: v }); });
      this._slider(g, "Light scattering", 0, 2.5, 0.01, () => o.water.scatterAmt,
        (v) => { o._waterTarget = Object.assign({}, o._waterTarget, { scatterAmt: v }); });
      this._slider(g, "Subsurface glow", 0, 2, 0.01, () => o.material.state.sss,
        (v) => { o.material.state.sss = v; });
    }

    // ---- surface ----------------------------------------------------------
    {
      const g = this._group("Surface detail", true);
      const s = o.material.state;
      this._slider(g, "Foam strength", 0, 3, 0.01, () => o.weather.target.foam,
        (v) => o.weather.set("foam", v));
      this._slider(g, "Shore foam", 0, 3, 0.01, () => s.foamShore, (v) => { s.foamShore = v; });
      this._slider(g, "Foam threshold", 0.1, 1.4, 0.01, () => o.sim.params.foamThreshold,
        (v) => { o.sim.params.foamThreshold = v; });
      this._slider(g, "Foam decay", 0.02, 2.0, 0.01, () => o.sim.params.foamDecay,
        (v) => { o.sim.params.foamDecay = v; });
      this._slider(g, "Fine ripples", 0, 2, 0.01, () => s.microDetail, (v) => { s.microDetail = v; });
      this._slider(g, "Sun glitter", 0, 5, 0.01, () => s.glitter, (v) => { s.glitter = v; });
      this._slider(g, "Surface roughness", 0.001, 0.04, 0.0005, () => s.capillaryVar,
        (v) => { s.capillaryVar = v; }, (v) => (+v).toFixed(4));
      this._slider(g, "Shore steepening", 0, 2, 0.01, () => s.shoreSteepen, (v) => { s.shoreSteepen = v; });
      this._slider(g, "Reflection strength", 0, 1, 0.01, () => s.reflectAmount, (v) => { s.reflectAmount = v; });
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
      const g = this._group("Sky & time", true);
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
      this._slider(g, "Cloud sharpness", 0, 1, 0.01, () => o.weather.target.cloudSharp,
        (v) => o.weather.set("cloudSharp", v));
      this._slider(g, "Cloud brightness", 0.2, 2.5, 0.01, () => sky.cloudBright, (v) => { sky.cloudBright = v; });
      this._slider(g, "Atmospheric haze", 1.2, 9, 0.01, () => o.weather.target.turbidity,
        (v) => o.weather.set("turbidity", v));
      this._check(g, "Lightning flashes", () => !!sky.lightningEnabled, (v) => app.setLightning(v));
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
      const g = this._group("Graphics", true);
      this._select(g, "Quality", TIER_ORDER.map((k) => ({ value: k, label: TIERS[k].label })),
        () => o.tierName, (v) => app.setQuality(v));
      this._select(g, "Reflections", ["off", "low", "medium", "high", "ultra"].map((k) => ({ value: k, label: k })),
        () => o.reflection.quality, (v) => o.reflection.setQuality(v));
      this._select(g, "Refraction", ["off", "medium", "high", "ultra"].map((k) => ({ value: k, label: k })),
        () => o.refraction.quality, (v) => o.refraction.setQuality(v));
      this._check(g, "Adaptive reflection quality", () => app.dynamicRes, (v) => { app.dynamicRes = v; });
      this._check(g, "Performance overlay", () => app.showHud, (v) => {
        app.showHud = v;
        const hud = document.getElementById("hud");
        if (hud) hud.classList.toggle("hidden", !v);
      });
      this._check(g, "Bloom", () => app.pipeline && app.pipeline.bloomEnabled,
        (v) => { if (app.pipeline) app.pipeline.bloomEnabled = v; });
      this._check(g, "FXAA", () => app.pipeline && app.pipeline.fxaaEnabled,
        (v) => { if (app.pipeline) app.pipeline.fxaaEnabled = v; });
      this._check(g, "Temporal anti-aliasing", () => !!(app.taa && app.taa.enabled),
        (v) => { if (app.taa) { app.taa.enabled = v; app.taa.reset(); } });
      this._select(g, "TAA mode", [
        { value: "1", label: "Reproject" },
        { value: "2", label: "Jittered" },
      ], () => String(app.taa ? app.taa.mode : 1),
        (v) => { if (app.taa) app.taa.setMode(parseInt(v, 10)); });
      this._check(g, "Underwater effects", () => o.underwater.enabled, (v) => { o.underwater.enabled = v; });
      this._slider(g, "Sunbeams", 0, 2, 0.01, () => o.underwater.godRays,
        (v) => { o.underwater.godRays = v; });
      this._slider(g, "Bubbles", 0, 2.5, 0.01, () => o.underwater.bubbleAmount,
        (v) => { o.underwater.bubbleAmount = v; });
      this._slider(g, "Suspended particles", 0, 2.5, 0.01, () => o.underwater.motesAmount,
        (v) => { o.underwater.motesAmount = v; });
      this._check(g, "Sandy seafloor", () => !!(o.seafloor && o.seafloor.enabled),
        (v) => { if (o.seafloor) o.seafloor.setEnabled(v); });
      this._check(g, "Spray and rain", () => o.spray.enabled, (v) => { o.spray.enabled = v; });
      this._check(g, "Wake foam", () => o.foam.enabled, (v) => { o.foam.enabled = v; });
    }

    // ---- debug -------------------------------------------------------------
    {
      const g = this._group("Diagnostics", true);
      this._select(g, "Visualization", DEBUG_CHANNELS.map((k, i) => ({ value: String(i), label: k })),
        () => String(o.debug.channel), (v) => o.debug.setChannel(parseInt(v, 10)));
      this._check(g, "Wireframe", () => o.debug.showWire, (v) => o.debug.setWireframe(v));
      this._check(g, "Pause wave animation", () => o.sim.paused, (v) => { o.sim.paused = v; });
      this._slider(g, "Wave animation speed", 0, 3, 0.01, () => o.sim.timeScale, (v) => { o.sim.timeScale = v; });
      this._buttons(g, [
        { key: "v", label: "Check buoyancy", action: async () => {
          const r = await o.debug.validateBuoyancy();
          console.log("[ocean] buoyancy validation", r);
          app.announce(r.ok
            ? "Buoyancy check complete — CPU and GPU results are within tolerance."
            : `Buoyancy check failed: ${r.error || "results exceeded tolerance"}`);
        } },
        { key: "s", label: "Log diagnostics", action: () => console.table(o.debug.stats()) },
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
      const g = this._group("Breakers", true);
      const b = o.breakers;
      this._check(g, "Breakers enabled", () => b.enabled, (v) => { b.enabled = v; });
      this._slider(g, "Swell height", 0.1, 5.0, 0.05, () => b.height,
        (v) => { b.height = v; }, (v) => v.toFixed(2) + " m");
      this._slider(g, "Swell period", 4, 18, 0.1, () => b.period,
        (v) => { b.period = v; }, (v) => v.toFixed(1) + " s");
      this._slider(g, "Crest curl", 0.0, 2.0, 0.01, () => b.lean,
        (v) => { b.lean = v; });
      this._slider(g, "Surf foam decay", 0.0, 2.0, 0.01, () => b.decay,
        (v) => { b.decay = v; });
      this._slider(g, "Break-line variation", 0.0, 1.2, 0.01, () => b.variation,
        (v) => { b.variation = v; });
      this._slider(g, "Whitewater", 0.0, 2.0, 0.01, () => b.whitewater,
        (v) => { b.whitewater = v; });
      this._slider(g, "Spray amount", 0.0, 2.5, 0.01, () => b.sprayLight,
        (v) => { b.sprayLight = v; });
      this._slider(g, "Bubble amount", 0.0, 2.5, 0.01, () => b.bubbles,
        (v) => { b.bubbles = v; });
      this._slider(g, "Surf radius", 30, 260, 5, () => b.radius,
        (v) => { b.radius = v; }, (v) => v.toFixed(0) + " m");
      this._slider(g, "Shoaling depth", 4, 40, 0.5, () => b.maxDepth,
        (v) => { b.maxDepth = v; }, (v) => v.toFixed(1) + " m");
    }

    {
      const g = this._group("Display", true);
      const pr = app.present;
      const note = document.createElement("div");
      note.className = "note";
      const refresh = () => {
        const st = pr.stats();
        note.textContent = `Output: ${st.output} · ${st.megapixels} MP · Render scale: ${st.renderScale}×`;
      };
      this._slider(g, "Render scale", 0.5, 3.2, 0.01, () => pr.renderScale,
        (v) => { pr.renderScale = v; pr.apply(); setTimeout(refresh, 60); });
      this._check(g, "Automatic resolution", () => pr.dynamicResolution,
        (v) => { pr.dynamicResolution = v; });
      this._slider(g, "Target frame rate", 24, 144, 1, () => pr.targetFrameRate,
        (v) => { pr.targetFrameRate = v; }, (v) => v.toFixed(0) + " fps");
      this._slider(g, "Resolution adjustment", 0.2, 3.0, 0.05,
        () => pr.resolutionAdaptationSpeed, (v) => { pr.resolutionAdaptationSpeed = v; });
      const row = document.createElement("div");
      row.className = "btnrow";
      for (const [label, px] of [["1080p", 1920], ["1440p", 2560], ["4K", 3840]]) {
        const bt = document.createElement("button");
        bt.type = "button";
        bt.textContent = label;
        bt.onclick = () => { pr.targetWidth(px); setTimeout(refresh, 120); };
        row.appendChild(bt);
      }
      g.appendChild(row);
      g.appendChild(note);
      refresh();
      this.rows.push(refresh);
    }


    {
      const g = this._group("Unreal Engine export", true);
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = "Downloads settings and technical notes for rebuilding this ocean in Unreal Engine. The ZIP is a specification, not a ready-to-run Unreal project.";
      const status = document.createElement("div");
      status.className = "note status-note";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      let busy = false;
      const run = async (fn, label) => {
        if (busy) return;
        busy = true;
        for (const b of row.querySelectorAll("button")) b.disabled = true;
        status.textContent = label + "…";
        try { const r = await fn(); status.textContent = r || (label + " complete."); }
        catch (e) { status.textContent = "Couldn’t export: " + e.message; }
        finally {
          busy = false;
          for (const b of row.querySelectorAll("button")) b.disabled = false;
        }
      };
      const row = document.createElement("div");
      row.className = "btnrow";
      const mk = (label, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.onclick = () => run(fn, label);
        row.appendChild(b);
        return b;
      };
      const primary = mk("Download Unreal package", async () => {
        const r = await app.exporter.downloadPackage();
        return `Downloaded Ocean_UE_Export.zip (${r.files} files).`;
      });
      primary.classList.add("primary");
      mk("Download configuration", async () => {
        app.exporter.downloadConfig();
        return "Download requested for Ocean_Config.zip.";
      });
      mk("Check export", async () => {
        const issues = app.exporter.validate(app.exporter.buildFiles());
        return issues.length === 1 ? `1 issue found: ${issues[0]}`
          : issues.length > 1 ? `${issues.length} issues found. First: ${issues[0]}`
          : "Ready to export.";
      });
      g.appendChild(note);
      g.appendChild(row);
      g.appendChild(status);
    }

    if (activeId) {
      const restore = document.getElementById(activeId);
      if (restore) setTimeout(() => restore.focus(), 0);
    }
  }

  refresh() { for (const r of this.rows) r(); }

  toggle(v) {
    this.visible = v === undefined ? !this.visible : !!v;
    if (this.visible) {
      if (this.app.setHelpOpen) this.app.setHelpOpen(false);
      this._returnFocus = document.activeElement;
      if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
    }
    this.root.classList.toggle("hidden", !this.visible);
    this.root.setAttribute("aria-hidden", String(!this.visible));
    document.querySelectorAll('[aria-controls="panel"]').forEach((button) => {
      button.setAttribute("aria-expanded", String(this.visible));
      if (button.hasAttribute("aria-label")) {
        button.setAttribute("aria-label", this.visible ? "Close controls" : "Open controls");
      }
    });
    if (this.visible) {
      this.refresh();
      const close = this.root.querySelector(".panel-close");
      if (close) setTimeout(() => close.focus(), 0);
    } else if (this._returnFocus && this._returnFocus.focus) {
      const el = this._returnFocus;
      this._returnFocus = null;
      setTimeout(() => el.focus(), 0);
    }
    return this.visible;
  }
}
