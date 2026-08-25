// ---------------------------------------------------------------------------
//  main.js -- application shell: engine, scene, environment, render loop.
//
//  WebGPU is used whenever the browser offers it; the WebGL2 path is the same
//  code, because every shader in this project is GLSL and Babylon transpiles
//  it to WGSL for the WebGPU backend.  There is no second implementation to
//  keep in sync.
// ---------------------------------------------------------------------------

import { TIERS, TIER_ORDER, autoTier, isMobileDevice } from "./core/quality.js";
import { Sky } from "./core/Sky.js";
import { OceanSystem } from "./ocean/OceanSystem.js";
import { OceanPresentation } from "./core/Presentation.js";
import { OceanExport } from "./export/OceanExport.js";
import { TemporalAA, TAA_MODE } from "./core/TemporalAA.js";
import { CameraController, CAMERA_PRESETS } from "./ui/CameraController.js";
import { DebugPanel } from "./ui/DebugPanel.js";
import { TouchControls } from "./ui/TouchControls.js";
import { WEATHER_PRESETS, SEA_STATES } from "./ocean/WeatherOceanController.js";

const BJ = () => window.BABYLON;

const boot = document.getElementById("boot");
const bootBar = document.getElementById("bootBar");
const bootStatus = document.getElementById("bootStatus");
function progress(p, msg) {
  bootBar.style.width = Math.round(p * 100) + "%";
  if (msg) bootStatus.textContent = msg;
}

class App {
  constructor() {
    this.canvas = document.getElementById("renderCanvas");
    this.dynamicRes = true;
    this._fpsHist = [];
    this._quiet = 0;
    this._resTimer = 0;
    this._hudTimer = 0;
    this.timeLerp = null;
    this._loopOn = false;
    this.showHud = true;
  }

  async init() {
    const B = BJ();
    progress(0.05, "creating renderer...");

    let engine = null;
    const params = new URLSearchParams(location.search);
    const forceGL = params.get("webgl") === "1";
    if (!forceGL && navigator.gpu && B.WebGPUEngine && await B.WebGPUEngine.IsSupportedAsync) {
      try {
        engine = new B.WebGPUEngine(this.canvas, {
          antialias: false, stencil: false, powerPreference: "high-performance",
        });
        await engine.initAsync();
      } catch (e) {
        console.warn("[ocean] WebGPU init failed, falling back to WebGL2:", e);
        engine = null;
      }
    }
    if (!engine) {
      engine = new B.Engine(this.canvas, true, {
        preserveDrawingBuffer: true, stencil: false, alpha: false,
        powerPreference: "high-performance", antialias: false,
      }, false);
      if (engine.webGLVersion === 1) {
        bootStatus.textContent = "WebGL2 is required.";
        throw new Error("WebGL2 required");
      }
    }
    this.engine = engine;
    window.__engine = engine;

    const tierName = params.get("tier") && TIERS[params.get("tier")]
      ? params.get("tier") : autoTier(engine);
    this.tierName = tierName;
    const tier = TIERS[tierName];
    // Presentation owns the backbuffer size from here: the tier's
    // hardwareScale becomes its starting renderScale, so "4K" and "dynamic
    // resolution" are one control rather than two that fight.
    this.present = new OceanPresentation(engine, this.canvas);
    this.present.renderScale = 1 / Math.max(tier.hardwareScale, 0.05)
                             / this.present.devicePixelRatio;
    this.present.maxRenderScale = Math.max(2.0, this.present.renderScale);
    this.present.dynamicResolution = false;
    this.present.targetFrameRate = tier.targetFrameRate || 60;
    this.present.maxPixels = tier.maxPixels
      || (isMobileDevice() ? 1920 * 1080 : 3840 * 2160);
    const lockres = params.get("lockres") === "1";
    const dynParam = params.get("dynres");
    const wide = (this.canvas.clientWidth || 0) > 1680;
    if (dynParam === "1") this.present.dynamicResolution = true;
    else if (dynParam === "0" || lockres) this.present.dynamicResolution = false;
    else if (isMobileDevice() || wide) this.present.dynamicResolution = true;
    this.present.apply();
    this.present.applyNow();
    window.__present = this.present;

    progress(0.15, `scene (${engine.isWebGPU ? "WebGPU" : "WebGL2"}, ${tier.label})...`);
    const scene = new B.Scene(engine);
    scene.clearColor = new B.Color4(0.02, 0.04, 0.06, 1);
    scene.autoClear = true;
    scene.skipPointerMovePicking = true;
    scene.useRightHandedSystem = false;
    this.scene = scene;

    this.camera = new CameraController(scene, engine, this.canvas);

    progress(0.25, "atmosphere...");
    this.sky = new Sky(scene, tier);
    this.sky.build();

    progress(0.35, "spectral ocean...");
    // ocean only: no bathymetry, no shoreline module
    this.ocean = new OceanSystem(engine, scene, this.camera.camera, this.sky, tierName,
      { shoreline: false });
    this.ocean.build();
    window.__ocean = this.ocean;

    // ---------------------------------------------------------------------
    //  OCEAN ONLY.
    //
    //  There is no island, sea floor, pier, boat, prop or character: the scene
    //  is the water, the sky that lights it and the camera looking at it.  The
    //  ocean therefore has to stand on its own -- no bathymetry, nothing in the
    //  reflection or refraction lists -- which is the point of section 3 of the
    //  brief and the reason the shoreline is now an optional module rather
    //  than a dependency.
    // ---------------------------------------------------------------------
    this.ocean.setSceneObjects({ reflect: [], refract: [], surfaceMaterials: [] });

    progress(0.85, "post processing...");
    this._buildPipeline(tier);

    // particles must land after the opaque groups or the water hides them
    for (const p of [...(this.ocean.spray.all || []), this.ocean.underwater.motes]) {
      if (p) p.renderingGroupId = 2;
    }

    // Attached after the default pipeline, so the resolve runs on the
    // tone-mapped image.  That is deliberate: clamping a neighbourhood in HDR
    // lets one specular firefly set the bounds for its whole 3x3, and on a sea
    // full of glitter that is most of the frame.
    this.taa = new TemporalAA(engine, scene, this.camera.camera, this.ocean).build();
    this.taa.attachJitter(this.camera.camera);
    this._applyTaa(tierName);
    window.__taa = this.taa;

    this.exporter = new OceanExport(this);
    window.__export = this.exporter;
    this.panel = new DebugPanel(document.getElementById("panel"), this);
    this.panel.build();

    this.touch = new TouchControls(this);
    const onAct = (act) => {
      if (act === "dive") this._diveToggle();
      if (act === "view") { this.camera.cyclePreset(this._hooks()); this.panel.refresh(); }
      if (act === "panel") this.panel.toggle();
    };
    this.touch.onAction(onAct);
    this.camera.onPadAction = onAct;

    this.ocean.weather.applyPreset("clearAtlantic", { instant: true });
    this.ocean.setWaterType(WEATHER_PRESETS.clearAtlantic.water, true);
    this.camera.mode = "free";
    this.camera.applyPreset(0, this._hooks());

    this._bindKeys();
    window.addEventListener("resize", () => {
      engine.resize();
      this.present.apply();
    });
    document.addEventListener("visibilitychange", () => this._syncLoop());

    progress(0.95, "compiling shaders...");
    // let the first frames build every effect before we show anything
    let warm = 0;
    // A resize destroys the swapchain texture, so skip the frame that does it:
    // WebGPU rejects a submit that touches a texture destroyed mid-frame.
    this._startLoop();
    await new Promise((res) => {
      const t = setInterval(() => {
        warm++;
        progress(Math.min(0.99, 0.95 + warm * 0.0025), "compiling shaders...");
        if (warm > 400 || this.allMaterialsReady()) { clearInterval(t); res(); }
      }, 60);
    });

    this.showHud = params.get("perf") !== "0";
    if (this.showHud) document.getElementById("hud").classList.remove("hidden");
    document.getElementById("hudBackend").textContent =
      `${engine.isWebGPU ? "WebGPU" : "WebGL2"} · ${tier.label}`;
    boot.classList.add("gone");
    setTimeout(() => boot.remove(), 900);
    window.__booted = true;
    if (!lockres && dynParam !== "0"
        && (isMobileDevice() || this.canvas.clientWidth > 1680)) {
      this.present.dynamicResolution = true;
    }
    this.present.apply();
    this._syncLoop();
  }

  _buildPipeline(tier) {
    const B = BJ();
    const p = new B.DefaultRenderingPipeline("oceanPost", true, this.scene, [this.camera.camera]);
    p.imageProcessingEnabled = true;
    p.imageProcessing.toneMappingEnabled = true;
    p.imageProcessing.toneMappingType = B.ImageProcessingConfiguration.TONEMAPPING_ACES;
    p.imageProcessing.exposure = 1.0;
    p.imageProcessing.contrast = 1.06;
    p.imageProcessing.vignetteEnabled = true;
    p.imageProcessing.vignetteWeight = 0.9;
    p.imageProcessing.vignetteStretch = 0.4;
    p.bloomEnabled = tier.bloom;
    p.bloomThreshold = 0.86;
    p.bloomWeight = 0.20;
    p.bloomKernel = 48;
    p.bloomScale = 0.5;
    // TAA is the antialiaser on cinematic/ultra.  FXAA on top of it blurs the
    // resolve, and MSAA fights the jitter sequence, so both stay off there.
    p.fxaaEnabled = tier.fxaa && !tier.taa;
    p.samples = 1;
    this.pipeline = p;
  }

  _hooks() {
    const s = this.sky.sunDir;
    return {
      get: () => null,
      weather: (k) => {
        this.ocean.weather.applyPreset(k);
        this.ocean.setWaterType(WEATHER_PRESETS[k].water);
      },
      sunYaw: Math.atan2(s.x, s.z),
    };
  }

  // -------------------------------------------------------------------------
  _bindKeys() {
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      const o = this.ocean;
      switch (e.code) {
        case "Digit1": o.weather.applySeaState("calm"); break;
        case "Digit2": o.weather.applySeaState("moderate"); break;
        case "Digit3": o.weather.applySeaState("rough"); break;
        case "Digit4": o.weather.applySeaState("storm"); break;
        case "Digit5": this._preset("calmTropical"); break;
        case "Digit6": this._preset("overcast"); break;
        case "Digit7": this._preset("heavyRain"); break;
        case "Digit8": this._preset("storm"); break;
        case "Digit9": this._preset("sunset"); break;
        case "Digit0": this._preset("night"); break;
        case "KeyT": {
          const t = [6, 12, 18.35, 0.4];
          const cur = this.sky.timeOfDay;
          let next = t.find((x) => x > cur + 0.05);
          if (next === undefined) next = t[0];
          this.setTime(next);
          break;
        }
        case "KeyY": this.sky.timeSpeed = this.sky.timeSpeed > 0 ? 0 : 0.35; break;
        case "KeyU": this._diveToggle(); break;
        case "KeyF": o.debug.setChannel(o.debug.channel === 4 ? 0 : 4); this.panel.refresh(); break;
        case "KeyL": o.debug.setChannel(o.debug.channel === 6 ? 0 : 6); this.panel.refresh(); break;
        case "KeyG": o.debug.cycle(); this.panel.refresh(); break;
        case "KeyC": this.camera.cyclePreset(this._hooks()); this.panel.refresh(); break;
        case "KeyH": this.panel.toggle(); break;
        case "KeyP": o.sim.paused = !o.sim.paused; this.panel.refresh(); break;
        case "Escape": document.getElementById("help").classList.add("hidden"); break;
        case "Slash":
          if (e.shiftKey) document.getElementById("help").classList.toggle("hidden");
          break;
        default: break;
      }
    });
  }

  _preset(k) {
    this.ocean.spray.flush();
    this.ocean.weather.applyPreset(k);
    this.ocean.setWaterType(WEATHER_PRESETS[k].water);
    this.panel.refresh();
  }

  setTime(t) {
    this.timeLerp = { from: this.sky.timeOfDay, to: t, k: 0 };
  }

  setQuality(name) {
    if (!TIERS[name]) return;
    const o = this.ocean;
    o.setQuality(name);
    this.tierName = name;
    if (this.present) {
      this.present.targetFrameRate = TIERS[name].targetFrameRate || 60;
      if (TIERS[name].maxPixels) this.present.maxPixels = TIERS[name].maxPixels;
      this.present.apply();
    }
    o.setSceneObjects({
      reflect: [], refract: [],
    });
    for (const p of [...(o.spray.all || []), o.underwater.motes]) if (p) p.renderingGroupId = 2;
    if (this.pipeline) { this.pipeline.dispose(); this.pipeline = null; }
    this._buildPipeline(TIERS[name]);
    this._applyTaa(name);
    document.getElementById("hudBackend").textContent =
      `${this.engine.isWebGPU ? "WebGPU" : "WebGL2"} · ${TIERS[name].label}`;
    this.panel.build();
  }

  /**
   * Quality tiers own TAA.  Ultra uses the measured reprojection filter;
   * cinematic adds the jittered supersample.  High and below stay off so
   * every existing harness that boots `?tier=high` still starts with no history.
   */
  _applyTaa(tierName) {
    if (!this.taa) return;
    const want = !!(TIERS[tierName] && TIERS[tierName].taa);
    this.taa.enabled = want;
    if (want) {
      this.taa.setMode(tierName === "cinematic" ? TAA_MODE.JITTERED : TAA_MODE.REPROJECT);
    }
  }

  applyCameraPreset(i) { this.camera.applyPreset(i, this._hooks()); this.panel.refresh(); }

  _diveToggle() {
    const c = this.camera.camera;
    const h = this.ocean.getHeight(c.position.x, c.position.z);
    if (c.position.y > h) c.position.y = h - 3.2;
    else c.position.y = h + 2.2;
    this.camera.followTarget = null;
  }

  // -------------------------------------------------------------------------
  _frame() {
    const engine = this.engine;
    let dt = engine.getDeltaTime() / 1000;
    if (!isFinite(dt) || dt <= 0) dt = 1 / 60;
    dt = Math.min(dt, 0.05);
    // Fixed timestep for measurement.  A harness that waits WALL time between
    // screenshots and diffs them is measuring how far the sea moved, which
    // depends on the frame rate -- so anything that costs GPU time, temporal
    // filtering above all, advances the water less between two captures and
    // scores better for free.  Locked, both configurations see exactly the
    // same motion per frame and the comparison is about filtering only.
    if (this.lockStep > 0) dt = this.lockStep;
    // negative locks the simulation OUTRIGHT: frames still render, nothing
    // advances.  A ghost trail has to be measured against the same scene it was
    // left on, and with the sea running the comparison picks up several frames
    // of ordinary wave motion instead -- at water level that is ~2.4 per frame
    // against a ghost limit of 6.0, so the metric was mostly sea.
    else if (this.lockStep < 0) dt = 0;
    const o = this.ocean;

    if (this.timeLerp) {
      const L = this.timeLerp;
      L.k = Math.min(1, L.k + dt * 0.55);
      let a = L.from, b = L.to;
      if (b < a) b += 24;
      this.sky.timeOfDay = (a + (b - a) * (L.k * L.k * (3 - 2 * L.k))) % 24;
      if (L.k >= 1) this.timeLerp = null;
    }

    this.camera.seaLevel = o.seaLevel;
    this.camera.update(dt, o);
    o.update(dt);
    // after the ocean has bound its uniforms, so the velocity pass sees the
    // identical vertex state
    if (this.taa && o.lastCtx) this.taa.update(o.lastCtx);
    this.sky.bindDome(this.camera.camera);

    // imageProcessing is nulled when imageProcessingEnabled is turned off,
    // which a diagnostic switch does -- guard rather than crash the loop.
    if (this.pipeline && this.pipeline.imageProcessing) {
      const d = Math.max(0, o.underwater.camDepth);
      const reach = Math.exp(-d * 0.008);
      this.pipeline.imageProcessing.exposure = this.sky.exposure * (0.70 + 0.30 * reach);
    }

    this.scene.render();
    this.frames++;

    this._readiness();
    this._adaptive(dt);
    this._hud(dt);
  }

  /**
   * Automation gate.  Every material here compiles a full atmosphere march, and
   * the ocean shader alone takes several seconds on a cold cache -- a fixed
   * sleep in the capture harness photographs a half-built scene and looks
   * exactly like a rendering bug.  Anything that changes state must reset it.
   */
  allMaterialsReady() {
    const o = this.ocean;
    if (!o.material.material.isReady(o.mesh)) return false;
    if (!this.sky.material.isReady(this.sky.dome)) return false;
    if (o.seafloor && o.seafloor.material && o.seafloor.mesh) {
      if (!o.seafloor.material.isReady(o.seafloor.mesh)) return false;
    }
    return o.buoyancy.ready && !!o.buoyancy.grids;
  }

  _readiness() {
    // dynamic resolution runs off the measured frame time
    this.present.update(this.engine.getDeltaTime());

    if (this.allMaterialsReady()) this._quiet++;
    else this._quiet = 0;
    window.__ready = this._quiet > 45;
  }

  /** fixed simulation timestep in seconds, 0 = use real time (see __lockStep) */
  lockStep = 0;
  /** when true the render loop idles and frames are issued by __advance */
  paused = false;
  /** frames actually RENDERED; __advance counts against this, not iterations */
  frames = 0;

  _tick() {
    if (this.paused) return;
    if (this.present.applyNow()) return;
    this._frame();
  }

  _startLoop() {
    if (this._loopOn) return;
    this._loopOn = true;
    this.engine.runRenderLoop(() => this._tick());
  }

  _stopLoop() {
    if (!this._loopOn) return;
    this._loopOn = false;
    this.engine.stopRenderLoop();
  }

  _syncLoop() {
    const want = !this.paused && !(document.hidden && window.__booted);
    if (want) this._startLoop();
    else this._stopLoop();
  }

  invalidateReady() { this._quiet = 0; window.__ready = false; }

  /**
   * Dynamic resolution ladder: give up the expensive ocean buffers before the
   * main render target, because losing reflection resolution is much less
   * visible than losing the whole image.
   */
  _adaptive(dt) {
    if (!this.dynamicRes) return;
    this._resTimer += dt;
    if (this._resTimer < 1.2) return;
    this._resTimer = 0;
    const fps = this.engine.getFps();
    const o = this.ocean;
    const rQ = ["off", "low", "medium", "high", "ultra"];
    const fQ = ["off", "medium", "high", "ultra"];
    if (fps < 42) {
      const ri = rQ.indexOf(o.reflection.quality);
      const fi = fQ.indexOf(o.refraction.quality);
      if (ri > 1) { o.reflection.setQuality(rQ[ri - 1]); return; }
      if (fi > 1) { o.refraction.setQuality(fQ[fi - 1]); return; }
      // Resolution is NOT touched here.  Presentation owns the backbuffer, and
      // a second controller pulling on the same number quietly ratchets it:
      // this block was still raising the hardware scaling underneath an
      // explicit 4K request, so the engine sat at 2594 wide while every
      // setting reported 3840.  This path only drops quality features now.
    } else if (fps > 58) {
      const ri = rQ.indexOf(o.reflection.quality);
      const target = TIERS[this.tierName].mirror > 0.85 ? 4 : TIERS[this.tierName].mirror > 0.6 ? 3 : 2;
      if (ri < target && ri > 0) o.reflection.setQuality(rQ[ri + 1]);
    }
  }

  _hud(dt) {
    this._hudTimer += dt;
    if (this._hudTimer < 0.25) return;
    this._hudTimer = 0;
    const o = this.ocean;
    const c = this.camera.camera.position;
    document.getElementById("hudFps").textContent = this.engine.getFps().toFixed(0);
    document.getElementById("hudMs").textContent =
      ` · ${(1000 / Math.max(this.engine.getFps(), 1)).toFixed(1)} ms`;
    const hh = Math.floor(this.sky.timeOfDay);
    const mm = Math.floor((this.sky.timeOfDay - hh) * 60);
    document.getElementById("hudState").textContent =
      `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")} · ` +
      `wind ${o.weather.windSpeed.toFixed(1)} m/s · Hs ${o.debug.significantWaveHeight().toFixed(2)} m` +
      (o.underwater.submerged ? " · submerged" : "");
    const floor = (o.seafloor && o.seafloor.enabled) ? o.seafloor.depth
      : o.buoyancy.getSurfaceData(c, this._sd || (this._sd = {})).depth;
    const sub = Math.max(0, o.seaLevel - c.y);
    document.getElementById("hudPos").textContent =
      `x ${c.x.toFixed(0)}  y ${c.y.toFixed(1)}  z ${c.z.toFixed(0)}  ·  ` +
      `depth ${sub.toFixed(0)} m  floor ${floor.toFixed(0)} m`;
    const perf = document.getElementById("hudPerf");
    if (perf && this.present) {
      const st = this.present.stats();
      perf.textContent = `${st.output} · ×${st.renderScale} · dpr ${st.devicePixelRatio}`
        + (st.dynamicResolution ? " · dynres" : "");
    }
    const hud = document.getElementById("hud");
    if (hud) hud.classList.toggle("hidden", !this.showHud);
    if (this.panel.visible) this.panel.refresh();
  }
}

// ---------------------------------------------------------------------------
//  headless / automation hooks
// ---------------------------------------------------------------------------
function exposeApi(app) {
  const o = app.ocean;
  window.__app = app;
  window.__setView = (x, y, z, pitchDeg, yawDeg) => {
    app.invalidateReady();
    // An explicit camera placement detaches from the character -- otherwise
    // and every scripted viewpoint silently becomes the same shot.
    app.camera.player = null;
    app.camera.mode = "free";
    app.camera.followTarget = null;
    app.camera.camera.position.set(x, y, z);
    app.camera.camera.rotation.set((pitchDeg || 0) * Math.PI / 180, (yawDeg || 0) * Math.PI / 180, 0);
  };
  window.__setPreset = (k) => { app.invalidateReady(); app._preset(k); };
  window.__setSea = (k) => { app.invalidateReady(); o.spray.flush(); o.weather.applySeaState(k, { instant: true }); };
  window.__setTime = (t) => { app.invalidateReady(); app.sky.timeOfDay = t; app.timeLerp = null; };
  window.__setWater = (k) => { app.invalidateReady(); o.setWaterType(k, true); };
  window.__setDebug = (i) => { app.invalidateReady(); o.debug.setChannel(i); };
  window.__setQuality = (q) => { app.invalidateReady(); app.setQuality(q); };
  /**
   * Fast-forward until the sea has actually finished developing, and resolve
   * only then.
   *
   * Two quantities, because two things develop at different rates and BOTH
   * move what a harness measures:
   *
   *   Hs      the spectrum reaches its target within a second of an instant
   *           sea-state change, so this converges almost immediately;
   *   foam    the whitecap field is an ACCUMULATOR.  It keeps filling for
   *           roughly a minute of rough seas, and the bright patches it lays
   *           on the surface -- particularly seen from underneath -- are the
   *           largest moving feature in the frame.  Anchoring sim.time does
   *           not anchor it, because foam is integrated state, not a phase.
   *
   * That second one is not cosmetic.  Untracked, it raised the measured
   * frame-to-frame difference 4x partway through an A/B, and the halves either
   * side of the step read as a -288% and a +7% for identical code.  It also
   * produced a confident, wrong isolation of underwater motes as the cause of
   * a TAA regression: reversing the A/B order reproduced the step exactly.
   * So this gates on the QUANTITIES, not on a clock.
   */
  // Has this quantity stopped TRENDING?
  //
  // Compare the first half of a window against the second half and ask whether
  // the value MOVED by more than it SCATTERS.  The obvious alternative -- "n
  // consecutive polls within x%" -- is wrong in both directions: it never
  // certifies a stochastic quantity that fluctuates wider than x around a
  // perfectly stable mean (storm spray), and it instantly certifies a slow
  // monotonic fill whose per-poll steps are smaller than x (the foam
  // accumulator, which kept climbing from 0.0077 to 0.0107 long after
  // __settleSea had declared it settled, so the storm station was measured on a
  // scene that was still filling).
  const _trendSettled = (hist, tol) => {
    const W = hist.length;
    if (W < 8) return { ok: false, drift: -1, scatter: -1 };
    const h = W >> 1;
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const m0 = mean(hist.slice(0, h)), m1 = mean(hist.slice(h)), all = mean(hist);
    const scatter = Math.sqrt(mean(hist.map((v) => (v - all) * (v - all))));
    const drift = Math.abs(m1 - m0);
    return { ok: drift < Math.max(scatter, Math.abs(all) * tol), drift, scatter };
  };

  window.__settleSea = (maxSeconds) => new Promise((resolve) => {
    const budget = (maxSeconds || 90) * 1000;
    const t0 = performance.now();
    const hsH = [], fmH = [];
    o.weather.speed = 40;
    const foamMean = async () => {
      const f = o.foam;
      if (!f || !f.rt) return 0;
      const a = await f.rt[f.idx].readPixels();
      let s2 = 0;
      for (let i = 0; i < a.length; i += 4) s2 += a[i];
      return s2 / (a.length / 4);
    };
    const tick = async () => {
      const hs = o.debug.significantWaveHeight();
      const foam = await foamMean();
      hsH.push(hs); fmH.push(foam);
      if (hsH.length > 10) { hsH.shift(); fmH.shift(); }
      const h = _trendSettled(hsH, 0.015);
      const f = _trendSettled(fmH, 0.02);
      const done = h.ok && f.ok;
      if (done || performance.now() - t0 > budget) {
        o.weather.speed = 0.28;
        app.invalidateReady();
        resolve({ hs, foam, seconds: (performance.now() - t0) / 1000,
                  hsDrift: h.drift, foamDrift: f.drift, foamScatter: f.scatter,
                  converged: done });
        return;
      }
      setTimeout(tick, 320);
    };
    setTimeout(tick, 320);
  });
  /**
   * Settle everything a measurement at a STATION depends on: the sea, and then
   * the camera-local particle populations.
   *
   * Spray, mist, bubbles and motes are emitted relative to the camera, so they
   * start from nothing at every new viewpoint and take seconds to reach their
   * steady population -- and once they carry motion vectors they are a large
   * part of what a temporal filter is being judged on.  Measured without this,
   * two consecutive runs of identical code scored +39% and -72% in storm spray
   * and -363% and +44% underwater, because their TAA-off baselines were taken
   * at populations that differed several-fold.
   *
   * Call it after __setView, not before.
   */
  window.__settleScene = async (maxSeconds) => {
    // Sea and particles are COUPLED: spray is emitted off breaking crests, so
    // settling the particles lets the foam accumulator keep filling, which then
    // raises the spray population.  Settling one and then the other once leaves
    // the first one stale -- the storm station converged at 1624 particles and
    // foam 0.0077 while its true steady state was ~4500 and 0.0107, and the
    // shimmer it reported moved by 10 points between the two.  Alternate until
    // BOTH hold at the same time.
    const budget = (maxSeconds || 90);
    const t0 = performance.now();
    let sea = null, p = null, rounds = 0;
    for (; rounds < 4; rounds++) {
      const left = budget - (performance.now() - t0) / 1000;
      if (left <= 2) break;
      sea = await window.__settleSea(Math.min(left, budget));
      const left2 = budget - (performance.now() - t0) / 1000;
      if (left2 <= 2) break;
      p = await window.__settleParticles(Math.min(left2, budget));
      // did settling the particles disturb the sea again?
      const left3 = budget - (performance.now() - t0) / 1000;
      if (left3 <= 2) break;
      const recheck = await window.__settleSea(Math.min(left3, 8));
      if (recheck.converged && p.converged) { sea = recheck; break; }
      sea = recheck;
    }
    return { sea, counts: p && p.counts, particles: p && p.particles,
             drift: p && p.drift, scatter: p && p.scatter,
             foamDrift: sea && sea.foamDrift, rounds: rounds + 1,
             seconds: (performance.now() - t0) / 1000,
             converged: !!(p && p.converged && sea && sea.converged) };
  };

  /**
   * Wait for the camera-local particle populations alone.
   *
   * Needed on its own after any discontinuity in the wave field: rewinding
   * sim.time teleports every crest, the breaker set jumps, and the spray
   * emitted by it spikes and decays over several seconds.  A measurement taken
   * at an arbitrary point in that transient is what made storm spray read
   * -3%, -94% and +30% on three repetitions of the same configuration.
   */
  // Settled means NOT TRENDING, not "two readings happened to be close".
  //
  // The old test wanted three consecutive samples within 8%.  A storm's spray
  // population is genuinely stochastic -- droplets burst off breaking crests --
  // and swings wider than that around a perfectly stable mean, so the storm
  // station could never converge and burned its whole 90 s budget while the
  // scene had in fact been settled for a minute.  Meanwhile a slow monotonic
  // fill CAN produce three close consecutive samples and pass.  The criterion
  // was wrong in both directions.
  //
  // So compare the first half of a window against the second half and ask
  // whether the population has MOVED by more than it SCATTERS.
  window.__settleParticles = async (maxSeconds) => {
    const budget = (maxSeconds || 45) * 1000;
    const t0 = performance.now();
    const W = 8;                       // samples per window, 400 ms apart
    const hist = [];
    let counts = null, converged = false, drift = 0, scatter = 0;
    for (;;) {
      counts = await o.effects.counts();
      hist.push(counts.droplets + counts.mist + counts.bubbles + counts.motes);
      if (hist.length > W) hist.shift();
      if (hist.length === W) {
        const h = W / 2;
        const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
        const m0 = mean(hist.slice(0, h)), m1 = mean(hist.slice(h));
        const all = mean(hist);
        scatter = Math.sqrt(mean(hist.map((v) => (v - all) * (v - all))));
        drift = Math.abs(m1 - m0);
        // moved by less than it scatters (and less than 6% of the level):
        // fluctuating around a stable mean rather than still filling
        converged = drift < Math.max(scatter, Math.max(all, 50) * 0.06);
      }
      if (converged || performance.now() - t0 > budget) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    app.invalidateReady();
    return { counts, particles: hist[hist.length - 1],
             drift: Math.round(drift), scatter: Math.round(scatter),
             seconds: (performance.now() - t0) / 1000, converged };
  };

  // kept for older harnesses; prefer __settleSea / __settleScene
  window.__settle = () => window.__settleSea(90);
  /** freeze the simulation timestep; 0 restores real time. See App.update. */
  window.__lockStep = (dt) => { app.lockStep = dt || 0; return app.lockStep; };
  /** 0 none, 1 reprojection only (the frozen control), 2 jittered */
  window.__taaMode = (m) => app.taa.setMode(m);
  window.__jitterState = () => app.taa.jitterState();
  /** 'A_PRE_STABLE' or 'B_STABLE_SOURCE'; see JITTER_PROFILES */
  window.__taaProfile = (n) => app.taa.setProfile(n);

  /**
   * Deterministic stepping, for harnesses that diff consecutive frames.
   *
   * Waiting wall-clock milliseconds between two screenshots and calling the
   * difference "shimmer" measures two things at once: how unstable the image
   * is, and how many frames went by.  The second one moves with GPU load, so
   * enabling a temporal filter -- which costs GPU time -- lowers the score
   * whether or not it filters anything.  Combined with __lockStep, this makes
   * a capture N frames after the last one, always, at a fixed simulated dt.
   */
  /** stop lightning (and clear any flash in progress) for measurement */
  window.__setLightning = (on) => {
    app.sky.lightningEnabled = !!on;
    if (!on) { app.sky.flash = 0; app.sky._flashSeq = 0; }
    return app.sky.lightningEnabled;
  };
  /**
   * Put the foam accumulator back to empty and re-fill it deterministically.
   *
   * Pair it with an anchored sim.time: together they make the whole visible
   * scene a function of the frame count.  Without it, storm and underwater
   * baselines drifted 282% and 127% across a single sweep.
   */
  window.__resetFoam = (frames) => {
    o.foam.clear();
    const n = frames === undefined ? 90 : frames;
    window.__pauseRender();
    window.__advance(n);
    window.__resumeRender();
    return n;
  };
  /**
   * THE authoritative freeze.  One definition, in the app, so no harness can
   * hold a divergent copy of what "frozen" means -- every previous version of
   * this lived in the test files and they drifted.
   *
   * Stopping the simulation clock is NOT enough.  Babylon ParticleSystems
   * advance by their own updateSpeed once per RENDERED frame, with no
   * reference to dt at all, so the legacy spray/mist/rain/burst systems kept
   * moving (and kept spawning at Math.random() positions) while the world was
   * supposedly stationary.  That is per-frame state, not time-driven state,
   * and it is invisible to any audit that only greps for clocks.
   */
  window.__freezeWorld = () => {
    window.__lockStep(-1);
    window.__setLightning(false);
    app.sky.autoExposure = false;
    app.present.dynamicResolution = false;
    o.underwater.moteDensity = 0;
    if (o.effects) for (const f of o.effects.fields) f.enabled = false;
    // legacy spray: per-frame ParticleSystems, must be STOPPED not idled
    const stopped = [];
    if (o.spray && o.spray.all) {
      for (const ps of o.spray.all) {
        if (ps && ps.isStarted && ps.isStarted()) { ps.stop(); stopped.push(ps.name); }
        if (ps && ps.reset) ps.reset();
      }
      o.spray.enabled = false;
    }
    return { stopped, lockStep: app.lockStep };
  };

  /**
   * A compact record of everything that is supposed to be stationary while the
   * world is frozen.  Comparing two of these says WHICH subsystem moved,
   * instead of leaving a visual difference to be diagnosed by eye.
   */
  window.__stateFingerprint = () => {
    const cam = app.camera.camera;
    const m = cam.getWorldMatrix().m;
    let camHash = 0;
    for (let i = 0; i < 16; i++) camHash = (camHash * 31 + Math.round(m[i] * 1e6)) | 0;
    const ps = (o.spray && o.spray.all) ? o.spray.all.map(
      (p) => (p && p.getActiveCount) ? p.getActiveCount() : -1) : [];
    return {
      renderFrame: app.frames,
      simTime: o.sim ? o.sim.time : null,
      lockStep: app.lockStep,
      cameraMatrixHash: camHash,
      foamIndex: o.foam ? o.foam.idx : null,
      dispIndex: o.sim && o.sim.dispIdx !== undefined ? o.sim.dispIdx : null,
      breakerActive: o.breakers && o.breakers.stats ? o.breakers.stats.active : null,
      breakerEnergy: o.breakers && o.breakers.stats
        ? +o.breakers.stats.energy.toFixed(6) : null,
      sprayActive: ps,
      sprayIntensity: o.spray ? +(o.spray.intensity || 0).toFixed(6) : null,
      particleFieldIdx: o.effects && o.effects.fields
        ? o.effects.fields.map((f) => f.idx) : [],
      particleCursor: o.effects && o.effects.fields
        ? o.effects.fields.map((f) => f._cursor) : [],
      skyTime: +(app.sky.clock || 0).toFixed(6),
      underwaterTime: +(o.underwater.clock || 0).toFixed(6),
      sprayTime: o.spray ? +(o.spray.clock || 0).toFixed(6) : null,
      skyFlash: +(app.sky.flash || 0).toFixed(6),
      exposure: +(app.engine.getRenderWidth()).toFixed(0),
      taaHistIdx: app.taa ? app.taa.histIdx : null,
    };
  };

  /**
   * What each suspect subsystem reports about itself.
   *
   * A bisection row is only a measurement if the subsystem it claims to have
   * disabled actually stopped.  Setting a property nobody reads produced seven
   * identical rows once and read as "the cause is diffuse" when in fact the
   * probe had done nothing; `updates` here is an update counter (or a render
   * target's refresh rate) so a caller can prove the change took effect.
   */
  window.__subsystemState = () => {
    const g = (x) => (x && x.subsystemStats) ? x.subsystemStats()
                                             : { enabled: null, updates: -1 };
    return {
      foam: g(o.foam),
      breakers: g(o.breakers),
      reflection: g(o.reflection),
      refraction: g(o.refraction),
      lod: { enabled: !!o.lod, updates: -1 },   // no per-frame update: shader-side
      sim: (o.sim && o.sim.simStats) ? o.sim.simStats()
                                     : { enabled: null, updates: -1 },
      frames: app.frames,
    };
  };
  window.__setSubsystem = (name, on) => {
    const t = o[name];
    if (name === "sim" && t && t.setFrozen) {
      t.setFrozen(!on);
      return window.__subsystemState().sim;
    }
    if (!t || !t.setEnabled) return null;
    t.setEnabled(on);
    return window.__subsystemState()[name];
  };

  /**
   * THE authoritative capture path.  One implementation, in the app, consumed
   * by every quantitative harness.
   *
   * page.screenshot() goes through the browser compositor, and with the render
   * loop paused and frames issued synchronously inside one evaluate() it
   * returns stale composited content that catches up over successive captures.
   * Measured side by side after a camera stop: this path read 0.0000 against
   * the settled reference at every frame including +0, and the TAA velocity
   * target was exactly 0.000000 from +1 -- the renderer was bit-stable -- while
   * screenshots decayed 2.914 -> 0.002 over 128 frames.  That artefact was the
   * whole "camera-motion settling", the ~12 RMS persistence floor, and the
   * reason six validated subsystem eliminations all came back negative.
   *
   * Returns a lossless PNG data URL of the real backbuffer plus the state that
   * identifies WHICH frame it is, so a harness can assert it captured what it
   * asked for rather than inferring it from timing.  Screenshots remain fine
   * for human-visible evidence; they are not valid for measurement.
   */
  // Candidate capture path B: the canvas itself, after the frame is presented.
  // Kept alongside __grabFrame so the two can be calibrated against a known
  // answer rather than against each other -- comparing two readers proves only
  // that they disagree, never which one is right.
  window.__grabCanvas = () => {
    const cv = app.canvas;
    try { return { png: cv.toDataURL("image/png"), width: cv.width,
                   height: cv.height, renderedFrameId: app.frames }; }
    catch (e) { return { error: e.message, renderedFrameId: app.frames }; }
  };

  // A deliberately known frame: everything hidden, a flat clear colour.  A
  // reader that cannot return THIS cannot be trusted to return an ocean.
  window.__calibrate = (r, g, b) => {
    const B = window.BABYLON, sc = app.scene;
    if (r === null) {                       // restore
      sc.clearColor = app._clearWas || new B.Color4(0, 0, 0, 1);
      if (app._hidWas) app._hidWas.forEach((m) => m.setEnabled(true));
      app._hidWas = null;
      return "restored";
    }
    if (!app._clearWas) app._clearWas = sc.clearColor.clone();
    if (!app._hidWas) {
      app._hidWas = sc.meshes.filter((m) => m.isEnabled());
      app._hidWas.forEach((m) => m.setEnabled(false));
    }
    sc.clearColor = new B.Color4(r, g, b, 1);
    return { r, g, b, hidden: app._hidWas.length };
  };

  // Frame IDENTITY only.  The PIXELS come from the caller's own screenshot --
  // see harness.py.
  //
  // Reading pixels back from the GPU here was tried twice and is wrong twice
  // over: engine.readPixels() on the default framebuffer, and a trailing
  // PassPostProcess tap copied with CopyTextureToTexture, BOTH returned a
  // sparse high-frequency intermediate -- black almost everywhere with thin
  // bright filaments along the wave crests and the horizon -- and not the
  // colour frame at all.  That buffer is empty when the temporal filter is off,
  // so "TAA off" read a flawless 0.00 RMS and looked like proof of a
  // deterministic renderer; and it fills in as history accumulates, which is
  // the whole of the "camera-motion settling on mid-distance wave crests" that
  // was chased through a simulation freeze hook, a subsystem bisection and a
  // render-stage walk.  Saving one frame from each path and LOOKING at them
  // ended it in a minute: 676 KB of ocean against 2.7 KB of pure black.
  //
  // A reader must be calibrated against a known answer, never against another
  // reader.  The tell was available and ignored: debug channel 1 outputs the
  // resolve's own INPUT, which cannot depend on the TAA mode, and it read
  // 20.362 in REPROJECT against 0.000 in NONE.
  window.__frameId = () => {
    const cam = app.camera.camera;
    const m = cam.getWorldMatrix().m;
    let camHash = 0;
    for (let i = 0; i < 16; i++) camHash = (camHash * 31 + Math.round(m[i] * 1e6)) | 0;
    return {
      renderedFrameId: app.frames,
      simTime: app.ocean.sim ? app.ocean.sim.time : null,
      simDt: app.lockStep,
      cameraHash: camHash,
      width: app.engine.getRenderWidth(),
      height: app.engine.getRenderHeight(),
    };
  };
  window.__grabFrame = async () => ({
    error: "REMOVED: GPU readback read a high-frequency intermediate, not the "
         + "colour frame. Use the page screenshot; call __frameId() for identity.",
  });

  window.__pauseRender = () => { app.paused = true; app._syncLoop(); };
  window.__resumeRender = () => { app.paused = false; app._syncLoop(); };
  window.__advance = (n) => {
    const k = Math.max(1, n || 1);
    // Counted by the app's own frame counter, not by loop iterations.
    //
    // A frame can be consumed without rendering anything -- a backbuffer resize
    // is one way, and _frame() has its own reasons to bail -- and a caller that
    // rotates the camera once per requested step then rotates twice between two
    // rendered frames.  The pan-rate check caught it as exactly double the
    // predicted 0.022 uv/frame, twice, on runs either side of a fix that only
    // handled the resize case.  Asking the renderer what it actually drew is
    // the only version of this that cannot drift.
    const target = app.frames + k;
    let guard = 0;
    while (app.frames < target && guard++ < k * 16) {
      if (app.present.applyNow()) continue;
      app._frame();
    }
    return app.frames - (target - k);
  };
  window.__stats = () => Object.assign({ fps: app.engine.getFps() },
    o.debug.stats(), { present: app.present.stats(), surf: o.breakers.stats });
  /** aim the backbuffer at a width in real pixels, e.g. __setOutput(3840) */
  window.__setOutput = (px) => { app.invalidateReady(); return app.present.targetWidth(px); };
  window.__setRenderScale = (s) => {
    app.invalidateReady(); app.present.renderScale = s; app.present.apply();
    return app.present.stats();
  };
  window.__dynamicResolution = (v) => { app.present.dynamicResolution = !!v; };
  window.__surf = () => o.breakers;
  window.__camera = () => {
    const c = app.camera.camera;
    return { x: c.position.x, y: c.position.y, z: c.position.z,
             pitch: c.rotation.x * 180 / Math.PI, yaw: c.rotation.y * 180 / Math.PI };
  };
  window.__uwGoto = (key) => {
    const i = CAMERA_PRESETS.findIndex((p) => p.key === key);
    if (i < 0) return null;
    app.invalidateReady();
    return app.camera.applyPreset(i, app._hooks());
  };
  window.__uwStats = () => {
    const c = app.camera.camera.position;
    return {
      backend: app.engine.isWebGPU ? "webgpu" : "webgl2",
      fps: app.engine.getFps(),
      ms: 1000 / Math.max(app.engine.getFps(), 1),
      x: c.x, y: c.y, z: c.z,
      depth: Math.max(0, o.seaLevel - c.y),
      floor: o.seafloor && o.seafloor.enabled ? o.seafloor.depth : 0,
    };
  };
}

const app = new App();
app.init().then(() => exposeApi(app)).catch((e) => {
  console.error(e);
  bootStatus.textContent = "failed: " + (e && e.message ? e.message : e);
  bootStatus.style.color = "#ff8080";
});
