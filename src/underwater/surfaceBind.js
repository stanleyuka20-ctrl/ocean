// ---------------------------------------------------------------------------
//  surfaceBind.js -- one uniform upload for every ShaderMaterial that uses
//  SURFACE_FRAG (clipmap bed, rock formations, coral, fish).
// ---------------------------------------------------------------------------

const B = () => window.BABYLON;

export const LIT_UNIFORMS = [
  "world", "viewProjection", "logarithmicDepthConstant",
  "uCamPos", "uSeaLevel", "uClipMode", "uClipTop", "uKind",
  "uRough", "uMetal", "uBaseColor",
  "uAbsorb", "uScatterCol", "uScatterAmt", "uTurbid",
  "uCaustics", "uWetness", "uUnderwaterView",
  "uWetTop", "uWetAmt", "uWetSoak", "uFootRect",
  "uCascadeL", "uWaveScale", "uMaxDepth", "uDune", "uTime",
  "uSunDir", "uSunColor", "uMoonDir", "uMoonColor",
  "uSunI", "uMoonI", "uTurbidity", "uCloudCover", "uCloudSharp",
  "uCloudBright", "uStorm", "uFlash", "uCloudDrift",
  "uCamDepth", "uMaxCausticDepth",
  "uDivePos", "uDiveDir", "uDiveI", "uDiveRange", "uDiveSharp", "uLodInner",
];

export const LIT_SAMPLERS = ["uFootprint", "uDeriv1", "uDeriv2"];

export function makeLitMaterial(scene, id, vertSrc, fragSrc, opts) {
  const BJ = B();
  const vertexColor = !!(opts && opts.vertexColor);
  BJ.Effect.ShadersStore[`${id}VertexShader`] = vertSrc;
  BJ.Effect.ShadersStore[`${id}FragmentShader`] = fragSrc;
  const defines = ["#define LOGARITHMICDEPTH"];
  if (vertexColor) defines.push("#define VERTEXCOLOR");
  const attrs = ["position", "normal", "uv"];
  if (vertexColor) attrs.push("color");
  const mat = new BJ.ShaderMaterial(id, scene,
    { vertex: id, fragment: id },
    {
      attributes: attrs,
      uniforms: LIT_UNIFORMS.slice(),
      samplers: LIT_SAMPLERS.slice(),
      defines,
    });
  mat.backFaceCulling = opts && opts.cull === false ? false : true;
  mat.needAlphaBlending = () => false;
  return mat;
}

export function bindLitSurface(mat, ocean, opts) {
  if (!mat) return;
  const BJ = B();
  const V3 = BJ.Vector3;
  const o = ocean;
  const cam = o.camera.globalPosition;
  const w = o.water;
  const kind = opts && opts.kind !== undefined ? opts.kind : 0;
  const world = o.world;
  const dive = world && world.dive;
  const prof = world && world.profile;

  mat.setFloat("logarithmicDepthConstant",
    2.0 / (Math.log(o.camera.maxZ + 1.0) / Math.LN2));
  mat.setVector3("uCamPos", cam);
  mat.setFloat("uSeaLevel", o.seaLevel);
  mat.setFloat("uKind", kind);
  mat.setFloat("uRough", opts && opts.rough !== undefined ? opts.rough : 0.78);
  mat.setFloat("uMetal", opts && opts.metal !== undefined ? opts.metal : 0);
  const bc = (opts && opts.color) || [0.28, 0.24, 0.18];
  mat.setVector3("uBaseColor", new V3(bc[0], bc[1], bc[2]));
  mat.setVector3("uAbsorb", new V3(w.absorb[0], w.absorb[1], w.absorb[2]));
  mat.setVector3("uScatterCol", new V3(w.scatterCol[0], w.scatterCol[1], w.scatterCol[2]));
  mat.setFloat("uScatterAmt", w.scatterAmt);
  mat.setFloat("uTurbid", w.turbid);
  mat.setFloat("uWetness", 0);
  mat.setFloat("uUnderwaterView", o.underwater && o.underwater.submerged ? 1 : 0);
  mat.setFloat("uWetTop", -1000);
  mat.setFloat("uWetAmt", 0);
  mat.setFloat("uWetSoak", 0);
  mat.setVector4("uFootRect", new BJ.Vector4(0, 0, 1, 0));
  const L = o.sim.patchSizes;
  mat.setVector3("uCascadeL", new V3(L[0], L[1], L[2]));
  mat.setFloat("uWaveScale", o.sim.params.waveScale);
  mat.setFloat("uTime", o.sim.time);
  mat.setFloat("uClipMode", 0);
  mat.setFloat("uClipTop", 0.02);
  mat.setFloat("uMaxDepth", world ? world.maxDepth : 4000);
  mat.setFloat("uDune", world && world.terrain ? world.terrain.dune : 1.45);
  mat.setFloat("uCamDepth", Math.max(0, o.underwater.camDepth));
  mat.setFloat("uMaxCausticDepth", world ? world.causticCut : 70);
  if (dive) {
    mat.setVector3("uDivePos", dive.pos);
    mat.setVector3("uDiveDir", dive.dir);
    mat.setFloat("uDiveI", dive.intensity);
    mat.setFloat("uDiveRange", dive.range);
    mat.setFloat("uDiveSharp", dive.sharp);
  } else {
    mat.setVector3("uDivePos", cam);
    mat.setVector3("uDiveDir", new V3(0, -1, 0));
    mat.setFloat("uDiveI", 0);
    mat.setFloat("uDiveRange", 18);
    mat.setFloat("uDiveSharp", 24);
  }
  mat.setFloat("uLodInner", (opts && opts.lodInner) || 0);
  o.sky.bindTo(mat);
  const dummy = o.sim.displacement[0];
  mat.setTexture("uFootprint", dummy);
  void prof;
}
