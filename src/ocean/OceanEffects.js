// ---------------------------------------------------------------------------
//  OceanEffects.js -- the GPU-resident droplet, mist and bubble fields, owned
//  by the ocean itself.
//
//  These used to hang off the player-interaction system.  In an ocean-only
//  project there is no player, but a breaking crest still has to throw spray,
//  stream mist downwind and drive air under the surface -- so the fields belong
//  to the water, and anything that disturbs the water borrows them.
//
//  All three are GPU resident: state lives in ping-pong RGBA32F textures
//  integrated by a fragment pass, and the CPU only appends spawn GROUPS to a
//  small table.  A minute of heavy surf allocates nothing.
// ---------------------------------------------------------------------------

import { GpuParticleField } from "../interaction/GpuParticleField.js";

export class OceanEffects {
  constructor(engine, scene, quality = 1) {
    this.engine = engine;
    this.scene = scene;
    this.quality = quality;
    this.enabled = true;
  }

  build(renderer) {
    const q = this.quality;
    this.droplets = new GpuParticleField(this.engine, this.scene, {
      kind: "droplet", count: Math.round(24576 * q) + 2048, stretch: 0.045,
      reactiveBase: 0.65, jumpLimit: 4.0,     // spray re-forms constantly
      minPixel: 1.2, opacity: 0.75,
    }).build(renderer);
    this.mist = new GpuParticleField(this.engine, this.scene, {
      kind: "droplet", count: Math.round(8192 * q) + 512, stretch: 0.0,
      mist: 1.0, sizeScale: 1.0, reactiveBase: 0.55, jumpLimit: 4.0,
      minPixel: 1.2, opacity: 0.15,   // a veil: the water behind it dominates
    }).build(renderer);
    this.bubbles = new GpuParticleField(this.engine, this.scene, {
      kind: "bubble", count: Math.round(480 * q) + 64,
      reactiveBase: 0.45, jumpLimit: 2.5, minPixel: 0, opacity: 0.72,
      stretch: 0,
    }).build(renderer);
    // Suspended matter.  Owned here rather than by a Babylon particle system
    // so its previous position is readable and it can carry a motion vector.
    this.motes = new GpuParticleField(this.engine, this.scene, {
      kind: "neutral", count: Math.round(6144 * q) + 512,
      sizeScale: 1.0, stretch: 0.0, reactiveBase: 0.25, jumpLimit: 1.5,
      minPixel: 1.15, opacity: 0.45,
    }).build(renderer);
    this.fields = [this.droplets, this.mist, this.bubbles, this.motes];
    return this;
  }

  setQuality(q) { this.quality = q; }

  update(dt, ctx) {
    if (!this.fields) return;
    for (const f of this.fields) {
      if (!this.enabled) {
        if (f.mesh) f.mesh.setEnabled(false);
        continue;
      }
      f.update(dt, ctx);
    }
  }

  /** live particle counts, for the debug panel and the harnesses */
  async counts() {
    if (!this.fields) return { droplets: 0, mist: 0, bubbles: 0, motes: 0 };
    return {
      droplets: await this.droplets.liveCount(),
      mist: await this.mist.liveCount(),
      bubbles: await this.bubbles.liveCount(),
      motes: await this.motes.liveCount(),
    };
  }

  dispose() {
    if (!this.fields) return;
    for (const f of this.fields) f.dispose();
    this.fields = null;
  }
}
