// ---------------------------------------------------------------------------
//  quality.js -- graphics tiers.  Nothing here ever switches the ocean off;
//  the lowest tier still runs a real spectral simulation, just smaller.
// ---------------------------------------------------------------------------

// Cascade patch sizes are deliberately non-harmonic (513 / 127 / 29 m).  Sizes
// in a 2:1 ratio make the three lattices line up every few hundred metres and
// the eye reads that as tiling.
export const CASCADE_L = [513.0, 127.0, 29.0];

// Wave-number band per cascade, cut at 0.6 x Nyquist of the coarser one so the
// three spectra partition the spectrum instead of overlapping (double energy)
// or leaving a hole (a missing wave band reads as "plastic").
export function cascadeCutoffs(sizes) {
  const cuts = [];
  for (let i = 0; i < 3; i++) {
    const nyq = (Math.PI * sizes[i]) / CASCADE_L[i]; // k at N/2
    cuts.push(0.6 * nyq);
  }
  return [
    [0.0, cuts[0]],
    [cuts[0], cuts[1]],
    [cuts[1], 1e9],
  ];
}

const T = (o) => o;

export const TIERS = {
  cinematic: T({
    label: "Cinematic",
    sim: [256, 256, 256],
    clipRes: 64,
    cell0: 0.25,
    levels: 14,
    mirror: 1.0,        // fraction of the backbuffer
    mirrorMax: 1536,
    refract: 0.75,
    refractMax: 1280,
    disturb: 512,
    skyView: 12, skyLight: 5, cloudSteps: 7,
    oceanSkyView: 7, oceanSkyLight: 4, oceanCloudSteps: 5,
    microDetail: 1.0,
    spray: 12000, rain: 30000,
    bloom: true, fxaa: true, taa: true,
    hardwareScale: 1.0,
    targetFrameRate: 60,
    dynamicResolution: true,
    breakerQuality: 1.0,
  }),
  ultra: T({
    label: "Ultra",
    sim: [256, 256, 256],
    clipRes: 48,
    cell0: 0.375,
    levels: 14,
    mirror: 0.7, mirrorMax: 1024,
    refract: 0.6, refractMax: 1024,
    disturb: 512,
    skyView: 10, skyLight: 4, cloudSteps: 6,
    oceanSkyView: 6, oceanSkyLight: 3, oceanCloudSteps: 4,
    microDetail: 1.0,
    spray: 8000, rain: 20000,
    bloom: true, fxaa: true, taa: true,
    hardwareScale: 1.0,
    targetFrameRate: 60,
    dynamicResolution: true,
    breakerQuality: 0.8,
  }),
  high: T({
    label: "High",
    sim: [256, 128, 128],
    clipRes: 32,
    cell0: 0.5,
    levels: 14,
    mirror: 0.5, mirrorMax: 768,
    refract: 0.5, refractMax: 768,
    disturb: 256,
    skyView: 8, skyLight: 4, cloudSteps: 5,
    oceanSkyView: 5, oceanSkyLight: 3, oceanCloudSteps: 3,
    microDetail: 0.85,
    spray: 5000, rain: 12000,
    bloom: true, fxaa: true, taa: false,
    hardwareScale: 1.0,
    targetFrameRate: 60,
    dynamicResolution: true,
    breakerQuality: 0.55,
  }),
  medium: T({
    label: "Medium",
    sim: [128, 128, 64],
    clipRes: 24,
    cell0: 0.75,
    levels: 13,
    mirror: 0.35, mirrorMax: 512,
    refract: 0.4, refractMax: 512,
    disturb: 256,
    skyView: 6, skyLight: 3, cloudSteps: 4,
    oceanSkyView: 4, oceanSkyLight: 2, oceanCloudSteps: 2,
    microDetail: 0.7,
    spray: 2500, rain: 7000,
    bloom: true, fxaa: true, taa: false,
    hardwareScale: 1.0,
    targetFrameRate: 60,
    dynamicResolution: true,
    breakerQuality: 0.35,
  }),
  low: T({
    label: "Low",
    sim: [64, 64, 64],
    clipRes: 16,
    cell0: 1.0,
    levels: 12,
    mirror: 0.0, mirrorMax: 256,     // environment-only reflection
    refract: 0.0, refractMax: 256,
    disturb: 128,
    skyView: 4, skyLight: 2, cloudSteps: 2,
    oceanSkyView: 3, oceanSkyLight: 2, oceanCloudSteps: 2,
    microDetail: 0.5,
    spray: 800, rain: 3000,
    bloom: false, fxaa: true, taa: false,
    hardwareScale: 1.25,
    targetFrameRate: 45,
    dynamicResolution: true,
    breakerQuality: 0.2,
  }),
};

export const TIER_ORDER = ["low", "medium", "high", "ultra", "cinematic"];
export const MOBILE_TIERS = ["low", "medium", "high", "ultra"];

export function isMobileDevice() {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(location.search);
  if (params.get("mobile") === "1") return true;
  if (params.get("mobile") === "0") return false;
  const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  const touch = (navigator.maxTouchPoints || 0) > 0;
  const small = Math.min(screen.width, screen.height) <= 920;
  return !!(coarse || (touch && small));
}

/** Pick a starting tier from what the machine actually reports. */
export function autoTier(engine) {
  const webgpu = !!engine.isWebGPU;
  let renderer = "";
  try {
    const gl = engine._gl;
    if (gl) {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      if (dbg) renderer = (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "") + "";
    }
  } catch (e) { /* not fatal */ }
  const r = renderer.toLowerCase();
  const soft = /swiftshader|llvmpipe|software|basic render/.test(r);
  if (soft) return "low";

  if (isMobileDevice()) {
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    const strongPhone = /adreno (7|8)|mali-g7|mali-g9|immortalis|apple gpu|a1[4-9]|a[2-9][0-9]/.test(r);
    if (webgpu && strongPhone && cores >= 8 && mem >= 6) return "ultra";
    if (webgpu && strongPhone && cores >= 6 && mem >= 4) return "high";
    if (webgpu || (cores >= 6 && mem >= 4)) return "medium";
    return "low";
  }

  const strong = /rtx|radeon rx|rx 6|rx 7|rx 9|arc a|apple m[1-9]|geforce (gtx 1[06-9]|rtx)/.test(r);
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  if (webgpu && strong) return "cinematic";
  if (strong) return "ultra";
  if (webgpu) return "high";
  return dpr > 2 ? "medium" : "high";
}
