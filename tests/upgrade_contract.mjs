import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const html = read("index.html");
const css = read("styles.css");
const main = read("src/main.js");
const oceanSystem = read("src/ocean/OceanSystem.js");
const particles = read("src/shaders/particles.js");
const refraction = read("src/ocean/RefractionSystem.js");
const underwater = read("src/ocean/UnderwaterSystem.js");

const checks = [];
async function check(name, fn) {
  await fn();
  checks.push(name);
}

await check("semantic and recoverable app shell", () => {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<main\b/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /id="bootRetry"/);
  assert.match(html, /id="bootCompatibility"/);
  assert.match(html, /id="help"[^>]+role="dialog"/);
  assert.match(html, /id="renderCanvas"[^>]+tabindex="0"/);
});

await check("mobile zoom and motion preferences remain available", () => {
  assert.doesNotMatch(html, /user-scalable\s*=\s*no/i);
  assert.doesNotMatch(html, /maximum-scale\s*=\s*1/i);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /env\(safe-area-inset-top/);
  assert.doesNotMatch(css, /calc\([^)]*\*\s*-?\d/);
});

await check("social preview and dependency integrity", () => {
  assert.match(html, /property="og:image"/);
  assert.match(html, /twitter:card" content="summary_large_image"/);
  assert.match(html, /babylonjs@9\.22\.1/);
  assert.match(html, /integrity="sha384-[^"]+"/);
  const pngPath = path.join(root, "assets", "abyssal-og.png");
  const png = fs.readFileSync(pngPath);
  assert.equal(png.toString("ascii", 1, 4), "PNG");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

await check("static DOM references resolve", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "duplicate HTML id");
  const known = new Set(ids);
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  };
  walk(path.join(root, "src"));
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/getElementById\(["']([^"']+)["']\)/g)) {
      assert.ok(known.has(match[1]), `${path.relative(root, file)} references missing #${match[1]}`);
    }
  }
});

await check("quality hot-swap replaces tier-bound resources", () => {
  assert.match(oceanSystem, /this\.effects\.dispose\(\)/);
  assert.match(oceanSystem, /this\.buoyancy\.dispose\(\)/);
  assert.match(oceanSystem, /this\.effects = new OceanEffects/);
  assert.match(oceanSystem, /this\.buoyancy = new BuoyancySystem/);
  assert.match(main, /rebindOceanResources\(\)/);
});

await check("bubble integration and refraction enable hook", () => {
  const bubbleBranch = particles.slice(particles.indexOf("// buoyancy grows"),
    particles.indexOf("vec4 kept"));
  assert.match(bubbleBranch, /p \+= v \* uDt/);
  assert.match(bubbleBranch, /p\.y > surf/);
  assert.doesNotMatch(refraction, /this\.rt\b/);
  assert.match(refraction, /this\.texture\.refreshRate/);
});

await check("WebGPU receives complete dry-frame post-process bindings", async () => {
  assert.doesNotMatch(underwater, /if\s*\(!needPost\)\s*return/);
  assert.match(underwater, /effect\.setTexture\("uUwDeriv",\s*self\.derivTex\)/);

  const previousWindow = globalThis.window;
  const v = {
    x: 0, y: 1, z: 0,
    add() { return this; },
    scale() { return this; },
  };
  globalThis.window = {
    BABYLON: {
      Axis: { X: 0, Y: 1, Z: 2 },
      Vector3: { TransformCoordinates: () => ({ x: 0, y: 0 }) },
    },
  };
  try {
    const { UnderwaterSystem } = await import(
      pathToFileURL(path.join(root, "src/ocean/UnderwaterSystem.js"))
    );
    const camera = {
      globalPosition: v,
      fov: 0.9,
      getDirection: () => v,
      getScene: () => ({ getTransformMatrix: () => ({}) }),
    };
    const system = new UnderwaterSystem({}, { getAspectRatio: () => 1 }, camera, {});
    system.pp = {};
    system.derivTex = { name: "test-derivatives" };
    const sky = {
      sunDir: v, sunColor: {}, sunI: 1, turbidity: 0,
      storm: 0, flash: 0,
    };
    const water = {
      absorb: [0, 0, 0], scatterCol: [0, 0, 0],
      scatterAmt: 0, turbid: 0,
    };
    system.update(1 / 60, 0, sky, water);
    assert.equal(typeof system.pp.onApply, "function",
      "dry frames must still install the attached post-process binder");
    let bound = null;
    const effect = new Proxy({}, {
      get: (_target, prop) => prop === "setTexture"
        ? (_name, texture) => { bound = texture; }
        : () => {},
    });
    system.pp.onApply(effect);
    assert.equal(bound, system.derivTex,
      "the declared WebGPU sampler must always receive a texture");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

await check("boot requires a rendered frame and contains render-loop failures", () => {
  assert.match(main, /this\.frames\s*>\s*0\s*&&\s*this\.allMaterialsReady\(\)/);
  assert.match(main, /this\._renderTick\s*=\s*\(\)\s*=>\s*{/);
  assert.match(main, /this\._handleRenderFailure\(error\)/);
  assert.match(main, /this\.engine\.stopRenderLoop\(this\._renderTick\)/);
  assert.doesNotMatch(main, /setTimeout\(\(\)\s*=>\s*boot\.remove\(\)/);
});

await check("significant wave height sums independent band variance", async () => {
  const mod = await import(pathToFileURL(path.join(root, "src/ocean/OceanDebugTools.js")));
  const layout = [
    { N: 2, offset: 0 },
    { N: 2, offset: 2 * 2 * 6 },
  ];
  const grids = new Float32Array(2 * 2 * 6 * 2);
  for (let i = 0; i < 4; i++) grids[i * 6 + 1] = 1;
  for (let i = 0; i < 4; i++) grids[layout[1].offset + i * 6 + 1] = 2;
  const ocean = { buoyancy: { grids, gridTime: 1, layout } };
  const debug = new mod.OceanDebugTools(ocean);
  assert.ok(Math.abs(debug.significantWaveHeight() - 4 * Math.sqrt(5)) < 1e-9);
  grids[1] = 3;
  ocean.buoyancy.gridTime = 2;
  assert.notEqual(debug.significantWaveHeight(), 4 * Math.sqrt(5));
});

await check("weather selection state stays truthful", async () => {
  const mod = await import(pathToFileURL(path.join(root, "src/ocean/WeatherOceanController.js")));
  const ocean = { sky: { timeOfDay: 0 } };
  const weather = new mod.WeatherOceanController(ocean);
  assert.equal(weather.applyPreset("sunset", { instant: true }), true);
  assert.equal(weather.presetKey, "sunset");
  assert.equal(weather.seaKey, "moderate");
  assert.equal(weather.waterKey, "tropical");
  assert.equal(weather.applySeaState("rough"), true);
  assert.equal(weather.presetKey, null);
  assert.equal(weather.seaKey, "rough");
  assert.equal(weather.set("windSpeed", 12, true), true);
  assert.equal(weather.set("notAControl", 1), false);
});

console.log(`PASS  ${checks.length} upgrade contracts: ${checks.join("; ")}`);
