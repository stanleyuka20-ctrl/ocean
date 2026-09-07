import assert from "node:assert/strict";
import { WeatherOceanController, WEATHER_PRESETS, WEATHER_LIMITS, SEA_STATES } from "../src/ocean/WeatherOceanController.js";
import { Sky } from "../src/core/Sky.js";

function fixture() {
  const calls = [];
  const ocean = {
    sky: { timeOfDay: 12 }, material: { state: {} },
    sim: { params: { waveScale: 1 }, setParams: p => calls.push(p),
      windVector: () => [1, 0], updateSlopeVariance() {} },
    buoyancy: { onParamsChanged() {} },
  };
  return { weather: new WeatherOceanController(ocean), ocean, calls };
}

for (const [key, preset] of Object.entries(WEATHER_PRESETS)) {
  const { weather, ocean } = fixture();
  assert.ok(SEA_STATES[preset.sea]);
  assert.ok(weather.applyPreset(key, { instant: true, time: false }));
  weather.update(0);
  assert.equal(ocean.sky.timeOfDay, 12);
  assert.equal(ocean.sky.rain, preset.rain);
  assert.equal(ocean.sky.fog, preset.fog || 0);
  for (const [name, value] of Object.entries(weather.current)) {
    const [lo, hi] = WEATHER_LIMITS[name];
    assert.ok(Number.isFinite(value) && value >= lo && value <= hi, `${key}: ${name}`);
  }
}

const a = fixture(), b = fixture();
a.weather.applyPreset("seaFog"); b.weather.applyPreset("seaFog");
a.weather.update(0.1);
for (let i = 0; i < 10; i++) b.weather.update(0.01);
assert.ok(Math.abs(a.weather.current.fog - b.weather.current.fog) < 1e-10);
assert.ok(a.weather.current.fog > 0 && a.weather.current.fog < a.weather.target.fog);
const mid = a.weather.current.fog;
a.weather.applyPreset("clearAtlantic");
assert.equal(a.weather.current.fog, mid);
a.weather.update(0.1);
assert.ok(a.weather.current.fog < mid);

const { weather, ocean } = fixture();
weather.set("windDirDeg", 359, true);
weather.set("windDirDeg", 1);
weather.update(0.1);
assert.ok(weather.current.windDirDeg > 359 || weather.current.windDirDeg < 1);
weather.set("rain", Number.MAX_VALUE, true);
weather.set("fog", -100, true);
assert.equal(weather.current.rain, 1);
assert.equal(weather.current.fog, 0);
assert.equal(weather.set("rain", NaN), false);
const snapshot = JSON.stringify(weather.current);
weather.update(NaN); weather.update(Infinity); weather.update(-1);
assert.equal(JSON.stringify(weather.current), snapshot);
weather.applyPreset("storm", { instant: true });
weather.set("windSpeed", 12);
assert.equal(weather.seaKey, null);
assert.equal(weather.presetKey, null);
weather.applyPreset("seaFog", { instant: true });
weather.update(0);
assert.equal(ocean.sky.fog, 0.92);
weather.applyPreset("clearAtlantic", { instant: true });
weather.update(0);
assert.equal(ocean.sky.fog, 0);

// Exercise the actual shared binder: dry and wet frames must upload the pack.
class V {
  constructor(x = 0, y = 0, z = 0, w = 0) { this.set(x, y, z, w); }
  set(x, y, z = 0, w = 0) { Object.assign(this, { x, y, z, w }); return this; }
  normalize() { const l = Math.hypot(this.x, this.y, this.z) || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
}
globalThis.window = { BABYLON: { Vector2: V, Vector3: V, Vector4: V, Color3: V } };
try {
  const sky = new Sky({}, {});
  assert.equal(sky.lightningEnabled, false);
  const uniforms = new Map();
  const material = new Proxy({}, { get: () => (name, value) => uniforms.set(name,
    typeof value === "object" ? { ...value } : value) });
  for (const rain of [0, 1]) {
    sky.rain = rain; sky.fog = 0.6; sky.storm = 1;
    sky.update(1 / 60); sky.bindTo(material);
    assert.equal(uniforms.get("uWeather").x, rain);
    assert.equal(uniforms.get("uWeather").y, 0.6);
    assert.ok(Number.isFinite(uniforms.get("uWeather").z));
    assert.ok(Number.isFinite(uniforms.get("uLightningDir").x));
    assert.equal(sky.flash, 0);
  }
  const frozen = sky.drift.slice(); sky.update(0);
  assert.deepEqual(sky.drift, frozen);
} finally { delete globalThis.window; }

console.log(`PASS  weather: ${Object.keys(WEATHER_PRESETS).length} presets, shared bindings, reset, continuity, bounds, angular wrap, default-off lightning`);
