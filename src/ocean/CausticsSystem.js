// ---------------------------------------------------------------------------
//  CausticsSystem.js -- underwater light focusing.
//
//  There is no caustics texture and no separate render pass: the surface
//  shader for the sea floor computes the focusing term directly from the
//  divergence of the REAL wave slopes (see causticsAt in scene.js), sampled at
//  the point where the sun ray entered the water.  That is why the pattern
//  never repeats and always agrees with the waves overhead -- an animated
//  caustics texture tiles, and tiling is the first thing the eye catches.
//
//  This module just owns the strength and keeps the cascade textures bound on
//  every material that renders submerged geometry.
// ---------------------------------------------------------------------------

export class CausticsSystem {
  constructor(sim) {
    this.sim = sim;
    this.strength = 1.0;
    this.materials = [];
  }

  register(mat) { if (mat && this.materials.indexOf(mat) < 0) this.materials.push(mat); }
  unregister(mat) {
    const i = this.materials.indexOf(mat);
    if (i >= 0) this.materials.splice(i, 1);
  }

  update(sunDir) {
    // caustics fade out with the sun: at grazing incidence almost nothing gets
    // through the surface, and below the horizon there is nothing to focus
    const s = Math.max(0, Math.min(1, (sunDir.y - 0.03) / 0.25));
    this.effective = this.strength * s;
    const dr = this.sim.derivatives;
    for (const m of this.materials) {
      m.setTexture("uDeriv1", dr[1]);
      m.setTexture("uDeriv2", dr[2]);
      m.setFloat("uCaustics", this.effective);
    }
  }
}
