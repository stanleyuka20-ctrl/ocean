// ---------------------------------------------------------------------------
//  Sky.js -- sun/moon ephemeris, cloud state, lightning, exposure, and the
//  dome mesh.  Owns every atmosphere uniform; every material that includes
//  the atmosphere GLSL gets them from bindTo().
// ---------------------------------------------------------------------------

import { SKY_VERT, SKY_FRAG } from "../shaders/scene.js";

const B = () => window.BABYLON;
const DEG = Math.PI / 180;

export class Sky {
  constructor(scene, tier) {
    this.scene = scene;
    this.tier = tier;

    this.timeOfDay = 15.4;         // hours
    this.timeSpeed = 0;            // hours per second
    this.latitude = 18;            // degrees
    this.dayOfYear = 172;
    this.northOffset = 0;

    this.turbidity = 2.4;
    this.cloudCover = 0.34;
    this.cloudSharp = 0.45;
    this.cloudBright = 1.0;
    this.storm = 0.0;
    this.rain = 0;
    this.fog = 0;
    this.gust = 1;
    this.flash = 0;
    this.lightningEnabled = false;
    this.lightningDir = new (B().Vector3)(0.65, 0.22, 0.72).normalize();
    this._flashTimer = 4;
    this._flashSeq = 0;
    this.drift = [0, 0];
    this.windDir = [1, 0];
    this.windSpeed = 8;

    this.sunDir = new (B().Vector3)(0.3, 0.7, 0.5);
    this.moonDir = new (B().Vector3)(-0.3, -0.7, -0.5);
    this.sunColor = new (B().Color3)(1.0, 0.972, 0.93);
    this.moonColor = new (B().Color3)(0.72, 0.80, 1.0);
    this.sunI = 1.0;
    this.moonI = 0.0;

    this.exposure = 1.0;
    this._expTarget = 1.0;
    this.autoExposure = true;
    this.exposureBias = 1.0;

    this.dome = null;
    this.material = null;
  }

  build() {
    const BJ = B();
    BJ.Effect.ShadersStore["oceanSkyVertexShader"] = SKY_VERT;
    BJ.Effect.ShadersStore["oceanSkyFragmentShader"] =
      `#define SKY_VIEW_STEPS ${this.tier.skyView}\n` +
      `#define SKY_LIGHT_STEPS ${this.tier.skyLight}\n` +
      `#define CLOUD_STEPS ${this.tier.cloudSteps}\n` + SKY_FRAG;

    const mat = new BJ.ShaderMaterial("skyMat", this.scene,
      { vertex: "oceanSky", fragment: "oceanSky" },
      {
        attributes: ["position"],
        uniforms: ["world", "viewProjection", "uCamPos", "uSunDir", "uSunColor",
          "uMoonDir", "uMoonColor", "uSunI", "uMoonI", "uTurbidity", "uCloudCover",
          "uCloudSharp", "uCloudBright", "uStorm", "uFlash", "uTime", "uCloudDrift",
          "uWeather", "uLightningDir"],
        samplers: [],
      });
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;

    const dome = BJ.MeshBuilder.CreateSphere("skyDome", { diameter: 2, segments: 24 }, this.scene);
    dome.material = mat;
    dome.infiniteDistance = true;
    dome.isPickable = false;
    dome.alwaysSelectAsActiveMesh = true;
    dome.renderingGroupId = 0;
    dome.applyFog = false;

    this.dome = dome;
    this.material = mat;
    this._driftV = new BJ.Vector2(0, 0);
    return dome;
  }

  // -------------------------------------------------------------------------
  //  Solar / lunar position for a latitude and day of year.  Getting this
  //  right is what makes the sunrise azimuth swing over the year and the sun
  //  arc read as a place rather than a slider.
  // -------------------------------------------------------------------------
  _celestial() {
    const lat = this.latitude * DEG;
    const dec = 23.44 * DEG * Math.sin((2 * Math.PI * (this.dayOfYear - 81)) / 365.24);
    const H = ((this.timeOfDay - 12) / 12) * Math.PI;
    const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
    const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
    const cosAz = (Math.sin(dec) - Math.sin(el) * Math.sin(lat)) / Math.max(Math.cos(el) * Math.cos(lat), 1e-4);
    let az = Math.acos(Math.max(-1, Math.min(1, cosAz)));
    if (H > 0) az = 2 * Math.PI - az;
    az += this.northOffset * DEG;
    return { el, az };
  }

  update(dt) {
    this.clock = (this.clock || 0) + (dt || 0);
    const BJ = B();
    if (this.timeSpeed !== 0) {
      this.timeOfDay = (this.timeOfDay + this.timeSpeed * dt) % 24;
      if (this.timeOfDay < 0) this.timeOfDay += 24;
    }

    const s = this._celestial();
    this.sunDir.set(Math.cos(s.el) * Math.sin(s.az), Math.sin(s.el), Math.cos(s.el) * Math.cos(s.az));
    this.sunDir.normalize();

    // moon trails the sun by ~12.4 h and rides a slightly tilted path
    const save = this.timeOfDay;
    this.timeOfDay = (this.timeOfDay + 12.4) % 24;
    const m = this._celestial();
    this.timeOfDay = save;
    this.moonDir.set(Math.cos(m.el) * Math.sin(m.az + 0.18), Math.sin(m.el) * 0.96 + 0.05,
                     Math.cos(m.el) * Math.cos(m.az + 0.18));
    this.moonDir.normalize();

    const sunUp = Math.max(0, this.sunDir.y);
    // a soft civil-twilight ramp; a hard cutoff pops the whole scene
    this.sunI = Math.pow(Math.min(1, Math.max(0, (this.sunDir.y + 0.09) / 0.20)), 1.4);
    const moonUp = Math.max(0, this.moonDir.y);
    this.moonI = 0.050 * Math.pow(moonUp, 0.6) * (1 - this.sunI * 0.92);

    // --- lightning ---------------------------------------------------------
    // lightningEnabled is a harness switch, not a quality setting: a flash
    // rewrites the exposure of the entire frame, so any measurement that diffs
    // consecutive frames sees a single stroke as a 40x outlier.  Left on, one
    // repetition in three of a storm reading came back at 22.06 against a
    // steady 0.50.
    this.flash = 0;
    if (this.storm > 0.35 && this.lightningEnabled) {
      this._flashTimer -= dt * (0.4 + this.storm * 2.6);
      if (this._flashTimer <= 0) {
        const az = Math.random() * Math.PI * 2;
        this.lightningDir.set(Math.cos(az), 0.12 + Math.random() * 0.25, Math.sin(az)).normalize();
        this._flashSeq = 0.55;
        this._flashTimer = 1.4 + Math.random() * 7.5 * (1.3 - this.storm);
      }
    }
    if (this._flashSeq > 0) {
      this._flashSeq = Math.max(0, this._flashSeq - dt);
      const t = this._flashSeq;
      // double pulse: a leader, then the return stroke
      this.flash = (Math.exp(-Math.pow((t - 0.46) * 40, 2)) * 0.55 +
                    Math.exp(-Math.pow((t - 0.30) * 16, 2))) * (0.5 + 0.9 * this.storm);
    }

    // --- cloud drift -------------------------------------------------------
    this.gust = 1 + this.storm * (0.20 * Math.sin(this.clock * 0.37)
      + 0.12 * Math.sin(this.clock * 0.83 + 1.7));
    const ws = this.windSpeed * 1.35 * this.gust;
    this.drift[0] -= this.windDir[0] * ws * dt;
    this.drift[1] -= this.windDir[1] * ws * dt;

    // --- exposure: analytic, from the sky itself ---------------------------
    // A readback-based auto exposure stalls the pipeline; sky luminance is a
    // closed-form function of the sun here, so use it directly.
    // Night is meant to READ as night: the floor and the moon term stop auto
    // exposure from opening five stops and turning a moonlit sea into daylight.
    const lum = 0.035 + 1.25 * Math.pow(sunUp, 0.52) * (1 - 0.45 * this.storm)
              + 0.30 * moonUp * (1 - this.sunI) + 0.010 * this.cloudCover * sunUp;
    this._expTarget = (0.62 / lum) * this.exposureBias;
    this._expTarget = Math.min(Math.max(this._expTarget, 0.15), 12);
    if (this.autoExposure) {
      const k = 1 - Math.exp(-dt * (this._expTarget < this.exposure ? 2.2 : 0.8));
      this.exposure += (this._expTarget - this.exposure) * k;
    }
  }

  /** Push every atmosphere uniform onto a material that includes atmosphere.js */
  bindTo(mat) {
    mat.setVector3("uSunDir", this.sunDir);
    mat.setVector3("uMoonDir", this.moonDir);
    mat.setColor3("uSunColor", this.sunColor);
    mat.setColor3("uMoonColor", this.moonColor);
    mat.setFloat("uSunI", this.sunI);
    mat.setFloat("uMoonI", this.moonI);
    mat.setFloat("uTurbidity", this.turbidity);
    mat.setFloat("uCloudCover", this.cloudCover);
    mat.setFloat("uCloudSharp", this.cloudSharp);
    mat.setFloat("uCloudBright", this.cloudBright);
    mat.setFloat("uStorm", this.storm);
    mat.setFloat("uFlash", this.flash);
    if (!this._weatherV) this._weatherV = new (B().Vector4)(0, 0, 0, 1);
    this._weatherV.set(this.rain, this.fog, this.clock || 0, this.gust);
    mat.setVector4("uWeather", this._weatherV);
    mat.setVector3("uLightningDir", this.lightningDir);
    if (this._driftV) this._driftV.set(this.drift[0], this.drift[1]);
    else this._driftV = new (B().Vector2)(this.drift[0], this.drift[1]);
    mat.setVector2("uCloudDrift", this._driftV);
  }

  bindDome(camera) {
    if (this.material) {
      this.material.setVector3("uCamPos", camera.globalPosition);
      this.bindTo(this.material);
    // SIM clock, not the wall clock.  performance.now() keeps advancing
    // when the simulation is stopped, so a shader driven by it animates in
    // a scene that is supposed to be frozen -- which defeats every
    // frozen-scene measurement.  It put ~10 RMS of drift into the
    // persistence floor and collapsed the whole matrix below it.  At
    // normal playback the two are equivalent; under __lockStep they are
    // not, and only this one is honest.
      this.material.setFloat("uTime", this.clock || 0);
    }
  }

  /** Recompile the atmosphere constants when the user changes quality. */
  setTier(tier) {
    if (!tier || tier === this.tier) return this.dome;
    const wasEnabled = this.dome ? this.dome.isEnabled() : true;
    this.dispose();
    this.tier = tier;
    this.build();
    if (this.dome) this.dome.setEnabled(wasEnabled);
    return this.dome;
  }

  dispose() {
    if (this.dome) {
      this.dome.material = null;
      this.dome.dispose(false, false);
    }
    if (this.material) this.material.dispose(true, false);
    this.dome = null;
    this.material = null;
  }
}
