// ---------------------------------------------------------------------------
//  VentSystem.js -- world-anchored bubble plumes + a close-up refractive
//  sphere pool.  Far field is the existing GpuParticleField (soft discs, no
//  card edges).  Near field is real icospheres so a hero plume has volume.
// ---------------------------------------------------------------------------

import { UW, bathyY } from "./bathymetry.js";

const B = () => window.BABYLON;
let SERIAL = 0;

const SPHERE_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
uniform mat4 world;
uniform mat4 viewProjection;
#include<logDepthDeclaration>
varying vec3 vWorld;
varying vec3 vNormal;
void main(){
  vec4 wp = world * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(world) * normal);
  gl_Position = viewProjection * wp;
#include<logDepthVertex>
}
`;

const SPHERE_FRAG = /* glsl */ `
precision highp float;
#include<logDepthDeclaration>
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunI;
uniform vec3 uWaterTint;
uniform float uAmbient;
varying vec3 vWorld;
varying vec3 vNormal;
void main(){
#include<logDepthFragment>
  vec3 n = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);
  float ndv = clamp(dot(n, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 col = uWaterTint * uAmbient * (0.18 + 0.82 * F);
  col += uSunColor * uSunI * pow(max(dot(n, normalize(V + uSunDir)), 0.0), 64.0) * 0.12;
  float alpha = clamp(0.10 + 0.78 * F, 0.0, 0.82);
  gl_FragColor = vec4(max(col, 0.0), alpha);
}
`;

export class VentSystem {
  constructor(scene, ocean) {
    this.scene = scene;
    this.ocean = ocean;
    this.intensity = 1;
    this.mesh = null;
    this.mat = null;
    this.pool = [];
    this._acc = 0;
  }

  build() {
    const BJ = B();
    const id = `uwbub${SERIAL++}`;
    BJ.Effect.ShadersStore[`${id}VertexShader`] = SPHERE_VERT;
    BJ.Effect.ShadersStore[`${id}FragmentShader`] = SPHERE_FRAG;
    this.mat = new BJ.ShaderMaterial(id, this.scene, { vertex: id, fragment: id }, {
      attributes: ["position", "normal"],
      uniforms: ["world", "viewProjection", "logarithmicDepthConstant",
        "uCamPos", "uSunDir", "uSunColor", "uSunI", "uWaterTint", "uAmbient"],
      defines: ["#define LOGARITHMICDEPTH"],
      needAlphaBlending: true,
    });
    this.mat.backFaceCulling = true;
    this.mat.needAlphaBlending = () => true;
    this.mat.alphaMode = BJ.Engine.ALPHA_COMBINE;

    const proto = BJ.MeshBuilder.CreateIcoSphere(id, { radius: 1, subdivisions: 2 }, this.scene);
    proto.material = this.mat;
    proto.isPickable = false;
    proto.renderingGroupId = 2;
    proto.setEnabled(false);
    this.mesh = proto;
    this.bubbles = [];
    for (let i = 0; i < 28; i++) {
      const b = proto.clone(id + "c" + i, null, true);
      b.material = this.mat;
      b.isPickable = false;
      b.renderingGroupId = 2;
      b.setEnabled(false);
      this.bubbles.push(b);
      this.pool.push({ life: 0, x: 0, y: 0, z: 0, r: 0.04, vx: 0, vy: 0, vz: 0, mesh: b });
    }
    return this;
  }

  update(dt) {
    const o = this.ocean;
    const f = o.effects && o.effects.bubbles;
    const cam = o.camera.globalPosition;
    const q = this.intensity;
    if (q < 0.01 || !o.underwater || o.underwater.blend < 0.05) {
      for (const b of this.bubbles || []) b.setEnabled(false);
      return;
    }
    this._acc += dt;
    if (this._acc >= 0.05 && f) {
      const step = this._acc; this._acc = 0;
      for (const v of UW.vents) {
        const y = bathyY(v.x, v.z) + 0.25;
        if (Math.hypot(cam.x - v.x, cam.z - v.z) > 140) continue;
        f.emit({
          position: [v.x, y, v.z],
          radius: v.r,
          velocity: [0, 0.55 + q * 0.5, 0],
          spread: 0.45,
          count: Math.max(8, Math.round(step * 160 * q)),
          size: [0.018, 0.085],
          life: [4.0, 13],
          jitter: 0.85,
        });
      }
    }

    const near = UW.vents.some((v) => Math.hypot(cam.x - v.x, cam.y - bathyY(v.x, v.z), cam.z - v.z) < 36);
    if (!near) {
      for (const p of this.pool) if (p.mesh) p.mesh.setEnabled(false);
      return;
    }

    const current = o.world && o.world.current ? o.world.current : [0, 0, 0];
    for (const p of this.pool) {
      if (p.life <= 0 && Math.random() < dt * 8 * q) {
        const v = UW.vents[(Math.random() * UW.vents.length) | 0];
        p.x = v.x + (Math.random() - 0.5) * v.r * 2;
        p.z = v.z + (Math.random() - 0.5) * v.r * 2;
        p.y = bathyY(v.x, v.z) + 0.2;
        p.r = 0.028 + Math.random() * 0.055;
        p.vx = (Math.random() - 0.5) * 0.12;
        p.vy = 0.38 + Math.random() * 0.5;
        p.vz = (Math.random() - 0.5) * 0.12;
        p.life = 3.2 + Math.random() * 5.5;
      }
      if (p.life <= 0) {
        if (p.mesh) p.mesh.setEnabled(false);
        continue;
      }
      p.life -= dt;
      p.vx += current[0] * dt + Math.sin(p.y * 3 + p.x) * 0.08 * dt;
      p.vz += current[2] * dt + Math.cos(p.y * 2.4 + p.z) * 0.08 * dt;
      p.vy += dt * 0.25;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.r = Math.min(0.09, p.r + dt * 0.008);
      if (p.y > o.seaLevel - 0.15) p.life = 0;
      if (p.life <= 0) {
        if (p.mesh) p.mesh.setEnabled(false);
        continue;
      }
      if (p.mesh) {
        p.mesh.setEnabled(true);
        p.mesh.position.set(p.x, p.y, p.z);
        p.mesh.scaling.set(p.r, p.r, p.r);
      }
    }

    const w = o.water;
    const BJ = B();
    this.mat.setFloat("logarithmicDepthConstant",
      2.0 / (Math.log(o.camera.maxZ + 1.0) / Math.LN2));
    this.mat.setVector3("uCamPos", cam);
    this.mat.setVector3("uSunDir", o.sky.sunDir);
    this.mat.setColor3("uSunColor", o.sky.sunColor);
    this.mat.setFloat("uSunI", o.sky.sunI);
    this.mat.setVector3("uWaterTint", new BJ.Vector3(w.scatterCol[0] * 8, w.scatterCol[1] * 8, w.scatterCol[2] * 8));
    this.mat.setFloat("uAmbient", 0.12 + 0.7 * Math.max(0, o.sky.sunDir.y) * o.sky.sunI);
  }

  dispose() {
    for (const b of this.bubbles || []) b.dispose(false, false);
    if (this.mesh) this.mesh.dispose(false, true);
    this.mesh = null; this.mat = null; this.bubbles = [];
  }
}
