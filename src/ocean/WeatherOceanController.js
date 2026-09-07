// ---------------------------------------------------------------------------
//  WeatherOceanController.js -- one place where "the weather" lives.
//
//  Everything is a target that the live value eases toward, so nothing in the
//  scene can snap: a sea does not go from glass to 6 m in one frame, and the
//  spectrum takes real time to build under a rising wind.
// ---------------------------------------------------------------------------

// Fetch is the honest second lever on wave height: a 3 m/s breeze over 20 km
// of water raises 0.3 m, the same breeze over an ocean would raise far more.
// Measured Hs of these five, integrating the JONSWAP form: 0.30 / 1.75 / 4.2 /
// 8.5 / 13 m, plus the swell column (its own Hs, in metres).
export const SEA_STATES = {
  calm:     { label: "Calm",      windSpeed: 3.0,  fetch: 20000,  choppy: 0.80, swell: 0.55, swellPeriod: 12.0, waveScale: 1.0, foam: 0.55 },
  moderate: { label: "Moderate",  windSpeed: 8.5,  fetch: 90000,  choppy: 1.10, swell: 0.85, swellPeriod: 12.0, waveScale: 1.0, foam: 1.00 },
  rough:    { label: "Rough",     windSpeed: 15.0, fetch: 150000, choppy: 1.25, swell: 1.20, swellPeriod: 11.0, waveScale: 1.0, foam: 1.35 },
  storm:    { label: "Storm",     windSpeed: 23.0, fetch: 250000, choppy: 1.38, swell: 1.60, swellPeriod: 10.0, waveScale: 1.0, foam: 1.75 },
  extreme:  { label: "Extreme",   windSpeed: 31.0, fetch: 350000, choppy: 1.48, swell: 2.20, swellPeriod: 9.5,  waveScale: 1.0, foam: 2.05 },
};

export const WEATHER_PRESETS = {
  calmTropical: {
    label: "Calm Tropical", sea: "calm", water: "tropical",
    cloudCover: 0.22, cloudSharp: 0.55, storm: 0.0, rain: 0.0, turbidity: 2.1, timeOfDay: 13.5,
  },
  clearAtlantic: {
    label: "Clear Atlantic", sea: "moderate", water: "atlantic",
    cloudCover: 0.32, cloudSharp: 0.45, storm: 0.0, rain: 0.0, turbidity: 2.6, timeOfDay: 15.0,
  },
  overcast: {
    label: "Overcast", sea: "moderate", water: "pacific",
    cloudCover: 0.88, cloudSharp: 0.16, storm: 0.12, rain: 0.0, turbidity: 4.2, timeOfDay: 12.0,
  },
  windy: {
    label: "Windy", sea: "rough", water: "atlantic",
    cloudCover: 0.55, cloudSharp: 0.5, storm: 0.15, rain: 0.0, turbidity: 3.0, timeOfDay: 10.5,
  },
  heavyRain: {
    label: "Heavy Rain", sea: "rough", water: "murky",
    cloudCover: 0.95, cloudSharp: 0.12, storm: 0.35, rain: 0.85, turbidity: 5.0, timeOfDay: 11.0,
  },
  storm: {
    label: "Storm", sea: "storm", water: "storm",
    cloudCover: 1.0, cloudSharp: 0.10, storm: 0.75, rain: 0.75, turbidity: 6.0, timeOfDay: 14.0,
  },
  extremeStorm: {
    label: "Extreme Storm", sea: "extreme", water: "storm",
    cloudCover: 1.0, cloudSharp: 0.08, storm: 1.0, rain: 1.0, turbidity: 7.0, timeOfDay: 13.0,
  },
  sunset: {
    label: "Sunset", sea: "moderate", water: "tropical",
    cloudCover: 0.42, cloudSharp: 0.42, storm: 0.0, rain: 0.0, turbidity: 3.4, timeOfDay: 18.35,
  },
  night: {
    label: "Night", sea: "moderate", water: "pacific",
    cloudCover: 0.28, cloudSharp: 0.5, storm: 0.0, rain: 0.0, turbidity: 2.2, timeOfDay: 0.6,
  },
  seaFog: {
    label: "Sea Fog", sea: "calm", water: "pacific",
    cloudCover: 0.78, cloudSharp: 0.12, storm: 0.02, rain: 0, turbidity: 4.8,
    fog: 0.92, timeOfDay: 7.5,
  },
  squall: {
    label: "Squall", sea: "rough", water: "atlantic",
    cloudCover: 0.94, cloudSharp: 0.30, storm: 0.62, rain: 0.80, turbidity: 5.8,
    fog: 0.12, timeOfDay: 15.5,
  },
  clearing: {
    label: "Clearing Skies", sea: "moderate", water: "atlantic",
    cloudCover: 0.52, cloudSharp: 0.68, storm: 0.06, rain: 0.04, turbidity: 3.0,
    fog: 0.06, timeOfDay: 16.5,
  },
};

const KEYS = ["windSpeed", "fetch", "choppy", "swell", "swellPeriod", "waveScale", "foam",
  "cloudCover", "cloudSharp", "storm", "rain", "fog", "turbidity", "windDirDeg"];

export const WEATHER_LIMITS = {
  windSpeed: [0.5, 34], fetch: [5000, 900000], choppy: [0, 2], swell: [0, 6],
  swellPeriod: [5, 20], waveScale: [0.15, 2.2], foam: [0, 3],
  cloudCover: [0, 1], cloudSharp: [0, 1], storm: [0, 1], rain: [0, 1], fog: [0, 1],
  turbidity: [1.2, 9], windDirDeg: [0, 360],
};

export class WeatherOceanController {
  constructor(ocean) {
    this.ocean = ocean;
    this.current = {
      windSpeed: 8.5, fetch: 90000, choppy: 1.15, swell: 0.85, swellPeriod: 12.0, waveScale: 1.0,
      foam: 1.0, cloudCover: 0.34, cloudSharp: 0.45, storm: 0.0, rain: 0.0,
      turbidity: 2.4, windDirDeg: 35, fog: 0,
    };
    this.target = Object.assign({}, this.current);
    this.speed = 0.28;                 // 1/e per second
    this.seaKey = "moderate";
    this.waterKey = "atlantic";
    this.presetKey = "clearAtlantic";
    this._h0Timer = 0;
    this._dirty = true;   // force one spectrum push on the first update
  }

  applyPreset(key, opts = {}) {
    const p = WEATHER_PRESETS[key];
    if (!p) return false;
    this.presetKey = key;
    this.seaKey = p.sea;
    const s = SEA_STATES[p.sea];
    Object.assign(this.target, {
      windSpeed: s.windSpeed, fetch: s.fetch, choppy: s.choppy, swell: s.swell,
      swellPeriod: s.swellPeriod, waveScale: s.waveScale, foam: s.foam,
      cloudCover: p.cloudCover, cloudSharp: p.cloudSharp, storm: p.storm,
      rain: p.rain, turbidity: p.turbidity, fog: p.fog || 0,
    });
    this.waterKey = p.water;
    this._dirty = true;
    if (opts.instant) Object.assign(this.current, this.target);
    if (p.timeOfDay !== undefined && opts.time !== false) {
      this.ocean.sky.timeOfDay = p.timeOfDay;
    }
    return true;
  }

  applySeaState(key, opts = {}) {
    const s = SEA_STATES[key];
    if (!s) return false;
    this.presetKey = null;
    this.seaKey = key;
    Object.assign(this.target, {
      windSpeed: s.windSpeed, fetch: s.fetch, choppy: s.choppy, swell: s.swell,
      swellPeriod: s.swellPeriod, waveScale: s.waveScale, foam: s.foam,
    });
    this._dirty = true;
    if (opts.instant) Object.assign(this.current, this.target);
    return true;
  }

  set(key, value, instant) {
    if (!KEYS.includes(key) || !Number.isFinite(value)) return false;
    const [lo, hi] = WEATHER_LIMITS[key];
    value = key === "windDirDeg" ? ((value % 360) + 360) % 360 : Math.min(hi, Math.max(lo, value));
    this.presetKey = null;
    if (Object.hasOwn(SEA_STATES.moderate, key) || key === "windDirDeg") this.seaKey = null;
    this.target[key] = value;
    this._dirty = true;
    if (instant) this.current[key] = value;
    return true;
  }

  update(dt) {
    if (!Number.isFinite(dt) || dt < 0) return;
    const rate = Number.isFinite(this.speed) ? Math.max(0, this.speed) : 0.28;
    const k = -Math.expm1(-dt * rate * 4.0);
    let windMoved = 0;
    for (const key of KEYS) {
      const before = this.current[key];
      const delta = key === "windDirDeg"
        ? ((this.target[key] - before + 540) % 360) - 180 : this.target[key] - before;
      this.current[key] += delta * k;
      if (key === "windDirDeg") this.current[key] = (this.current[key] + 360) % 360;
      if (Math.abs(this.current[key] - this.target[key]) < 1e-4) this.current[key] = this.target[key];
      if (key === "windSpeed" || key === "swell" || key === "swellPeriod" ||
          key === "windDirDeg" || key === "fetch")
        windMoved += Math.abs(this.current[key] - before) * (key === "fetch" ? 1e-4 : 1);
    }

    const c = this.current;
    const o = this.ocean;

    // The spectrum only needs rebuilding when the wind actually moved, and no
    // faster than the eye can tell -- h0 is three full passes.
    this._h0Timer -= dt;
    if ((windMoved > 1e-4 || this._dirty) && this._h0Timer <= 0) {
      this._dirty = false;
      this._h0Timer = 0.12;
      o.sim.setParams({
        windSpeed: c.windSpeed, swell: c.swell, swellPeriod: c.swellPeriod,
        fetch: c.fetch, windDirDeg: c.windDirDeg, swellDirDeg: c.windDirDeg * 0.35 - 5,
      });
      o.buoyancy.onParamsChanged();
    }
    o.sim.params.choppy = c.choppy;
    if (o.sim.params.waveScale !== c.waveScale) {
      o.sim.params.waveScale = c.waveScale;
      o.sim.updateSlopeVariance();
    }
    o.material.state.foamAmount = c.foam;

    o.sky.cloudCover = c.cloudCover;
    o.sky.cloudSharp = c.cloudSharp;
    o.sky.storm = c.storm;
    o.sky.turbidity = c.turbidity;
    o.sky.rain = c.rain;
    o.sky.fog = c.fog;
    o.sky.windDir = o.sim.windVector();
    o.sky.windSpeed = c.windSpeed;
  }

  get rain() { return this.current.rain; }
  get storm() { return this.current.storm; }
  get windSpeed() { return this.current.windSpeed; }
}
