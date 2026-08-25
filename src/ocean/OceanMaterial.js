// ---------------------------------------------------------------------------
//  OceanMaterial.js -- the water ShaderMaterial and every uniform it wants.
//  Kept separate from OceanSystem so the shader can be rebuilt (quality tier
//  change) without tearing down the simulation.
// ---------------------------------------------------------------------------

import { OCEAN_VERT, OCEAN_FRAG } from "../shaders/oceanSurface.js";

const B = () => window.BABYLON;
let SHADER_SERIAL = 0;

export const UNIFORMS = [
  "viewProjection", "logarithmicDepthConstant",
  "uCamPos", "uCamXZ", "uTime", "uSeaLevel",
  "uCascadeL", "uCascadeTexel", "uCascadeOn", "uSlopeVar",
  "uDepthMapRect", "uDepthMapSize", "uHasDepthMap", "uDeepDepth",
  "uChoppy", "uWaveScale", "uMorphStart", "uShoreSteepen", "uWindDir", "uWindSpeed",
  "uSurfOn", "uSurfHeight", "uSurfK", "uSurfOmega", "uSurfRefDepth",
  "uSurfLean", "uSurfDecay", "uSurfVary", "uSurfMaxDepth",
  "uWhitewater", "uSprayLight",
  "uSunDir", "uSunColor", "uMoonDir", "uMoonColor",
  "uSunI", "uMoonI", "uTurbidity", "uCloudCover", "uCloudSharp", "uCloudBright",
  "uStorm", "uFlash", "uCloudDrift",
  "uScreen", "uProjScale", "uAbsorb", "uScatterCol", "uScatterAmt", "uTurbid",
  "uFoamAmount", "uFoamShore", "uReflectAmount", "uRefractStrength", "uSSS",
  "uRainAmount", "uUnderwater", "uDebug", "uMirrorOn", "uRefractOn", "uMicroDetail",
  "uDisturbRect", "uRippleRect", "uCapillaryVar", "uGlitter", "uFloorDepth",
];

export const SAMPLERS = [
  "uDisp0", "uDisp1", "uDisp2", "uDeriv0", "uDeriv1", "uDeriv2",
  "uDepthMap", "uMirror", "uRefract", "uDisturb", "uRipple",
];

export class OceanMaterial {
  constructor(scene, tier) {
    this.scene = scene;
    this.tier = tier;
    this.material = null;
    this.state = {
      seaLevel: 0,
      choppy: 1.15,
      waveScale: 1.0,
      morphStart: 0.72,
      shoreSteepen: 0.85,
      foamAmount: 1.0,
      foamShore: 1.0,
      reflectAmount: 1.0,
      refractStrength: 0.11,
      sss: 0.55,
      rainAmount: 0.0,
      microDetail: tier.microDetail,
      capillaryVar: 0.004,
      glitter: 2.2,
      debug: 0,
      deepDepth: 240,
      floorDepth: 0,
    };
    const BJ = B();
    this._camXZ = new BJ.Vector2();
    this._cascadeL = new BJ.Vector3();
    this._cascadeTx = new BJ.Vector3();
    this._cascadeOn = new BJ.Vector3();
    this._slopeVar = new BJ.Vector3();
    this._windDir = new BJ.Vector2();
    this._screen = new BJ.Vector2();
    this._absorb = new BJ.Vector3();
    this._scatter = new BJ.Vector3();
  }

  build() {
    const BJ = B();
    const id = `ocean${SHADER_SERIAL++}`;
    const defines = [
      `#define SKY_VIEW_STEPS ${this.tier.oceanSkyView}`,
      `#define SKY_LIGHT_STEPS ${this.tier.oceanSkyLight}`,
      `#define CLOUD_STEPS ${this.tier.oceanCloudSteps}`,
      "#define NO_STARS",
      "",
    ].join("\n");

    BJ.Effect.ShadersStore[`${id}VertexShader`] = OCEAN_VERT;
    BJ.Effect.ShadersStore[`${id}FragmentShader`] = defines + OCEAN_FRAG;

    const mat = new BJ.ShaderMaterial(id, this.scene,
      { vertex: id, fragment: id },
      {
        attributes: ["position", "uv"],
        uniforms: UNIFORMS,
        samplers: SAMPLERS,
        defines: ["#define LOGARITHMICDEPTH"],
        needAlphaBlending: false,
        needAlphaTesting: false,
      });
    mat.backFaceCulling = false;      // the surface is seen from below too
    this.material = mat;
    return mat;
  }

  /**
   * Per-frame uniform upload.
   * @param target optional material to write to instead of the surface one --
   *        the velocity pass needs the identical vertex state or its motion
   *        vectors describe a differently displaced sea than the one on screen.
   */
  bind(ctx, target) {
    const m = target || this.material;
    if (!m) return;
    const s = this.state;
    const { sim, camera, sky, weather, water, engine } = ctx;

    m.setFloat("logarithmicDepthConstant", 2.0 / (Math.log(camera.maxZ + 1.0) / Math.LN2));
    m.setVector3("uCamPos", camera.globalPosition);
    m.setVector2("uCamXZ", this._camXZ.set(camera.globalPosition.x, camera.globalPosition.z));
    m.setFloat("uTime", sim.time);
    m.setFloat("uSeaLevel", s.seaLevel);

    const L = sim.patchSizes, TX = sim.texelSizes;
    m.setVector3("uCascadeL", this._cascadeL.set(L[0], L[1], L[2]));
    m.setVector3("uCascadeTexel", this._cascadeTx.set(TX[0], TX[1], TX[2]));
    m.setVector3("uCascadeOn", this._cascadeOn.set(sim.enabled[0], sim.enabled[1], sim.enabled[2]));
    const sv = sim.slopeVariance;
    m.setVector3("uSlopeVar", this._slopeVar.set(sv[0], sv[1], sv[2]));

    const d = sim.displacement, dr = sim.derivatives;
    m.setTexture("uDisp0", d[0]); m.setTexture("uDisp1", d[1]); m.setTexture("uDisp2", d[2]);
    m.setTexture("uDeriv0", dr[0]); m.setTexture("uDeriv1", dr[1]); m.setTexture("uDeriv2", dr[2]);

    m.setFloat("uChoppy", sim.params.choppy);
    m.setFloat("uWaveScale", sim.params.waveScale);
    m.setFloat("uMorphStart", s.morphStart);
    m.setFloat("uShoreSteepen", s.shoreSteepen);
    const sf = ctx.surf;
    m.setFloat("uSurfOn", sf.enabled ? 1 : 0);
    m.setFloat("uSurfHeight", sf.height);
    m.setFloat("uSurfK", sf.phaseK);
    m.setFloat("uSurfOmega", sf.omega);
    m.setFloat("uSurfRefDepth", sf.refDepth);
    m.setFloat("uSurfLean", sf.lean);
    m.setFloat("uSurfDecay", sf.decay);
    m.setFloat("uSurfVary", sf.variation);
    m.setFloat("uSurfMaxDepth", sf.maxDepth);
    m.setFloat("uWhitewater", sf.whitewater);
    m.setFloat("uSprayLight", sf.sprayLight);
    const wv = sim.windVector();
    m.setVector2("uWindDir", this._windDir.set(wv[0], wv[1]));
    m.setFloat("uWindSpeed", sim.params.windSpeed);

    sky.bindTo(m);

    m.setVector2("uScreen", this._screen.set(engine.getRenderWidth(), engine.getRenderHeight()));
    // UV per metre, at one metre of distance, along the vertical axis.  The
    // screen-space refraction/reflection offsets are a WORLD length and have
    // to be converted with the real projection -- see the note in the shader.
    const cam = ctx.camera;
    const fovY = cam && cam.fov ? cam.fov : 0.9;
    m.setFloat("uProjScale", 0.5 / Math.tan(fovY * 0.5));
    m.setVector3("uAbsorb", this._absorb.set(water.absorb[0], water.absorb[1], water.absorb[2]));
    m.setVector3("uScatterCol", this._scatter.set(water.scatterCol[0], water.scatterCol[1], water.scatterCol[2]));
    m.setFloat("uScatterAmt", water.scatterAmt);
    m.setFloat("uTurbid", water.turbid);

    m.setFloat("uFoamAmount", s.foamAmount);
    m.setFloat("uFoamShore", s.foamShore);
    m.setFloat("uReflectAmount", s.reflectAmount);
    m.setFloat("uRefractStrength", s.refractStrength);
    m.setFloat("uSSS", s.sss);
    m.setFloat("uRainAmount", weather.rain);
    m.setFloat("uUnderwater", camera.globalPosition.y < s.seaLevel ? 1 : 0);
    m.setFloat("uDebug", s.debug);
    m.setFloat("uMicroDetail", s.microDetail);
    m.setFloat("uDeepDepth", s.deepDepth);
    m.setFloat("uFloorDepth", s.floorDepth);
    m.setFloat("uCapillaryVar", s.capillaryVar);
    m.setFloat("uGlitter", s.glitter);
  }

  dispose() {
    if (this.material) { this.material.dispose(true, true); this.material = null; }
  }
}
