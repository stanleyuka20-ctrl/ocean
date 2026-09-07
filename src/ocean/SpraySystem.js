// ---------------------------------------------------------------------------
//  SpraySystem.js -- airborne water: sheet spray torn off crests, the mist
//  that hangs over a rough sea, and rain.
//
//  Rain and the general spray haze are GPU particle systems (tens of thousands
//  of quads, zero CPU per particle).  Crest bursts are CPU particles because
//  they need to START at a real breaking crest, which only the CPU mirror
//  knows -- a GPU emitter shape cannot ask where the water is folding.
// ---------------------------------------------------------------------------

const B = () => window.BABYLON;

function softSprite(scene, name, inner) {
  const BJ = B();
  const dt = new BJ.DynamicTexture(name, { width: 64, height: 64 }, scene, true);
  const c = dt.getContext();
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, `rgba(255,255,255,${inner})`);
  g.addColorStop(0.45, `rgba(240,250,255,${inner * 0.45})`);
  g.addColorStop(1, "rgba(230,245,255,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, 64, 64);
  dt.update();
  return dt;
}
function softStreak(scene, name, len) {
  const BJ = B();
  const dt = new BJ.DynamicTexture(name, { width: 32, height: 128 }, scene, true);
  const c = dt.getContext();
  c.clearRect(0, 0, 32, 128);
  // a soft lozenge: bright core, feathered ends, feathered sides
  for (let y = 0; y < 128; y++) {
    const t = y / 127;
    const along = Math.sin(Math.PI * t) ** (1.0 / Math.max(len, 0.2));
    const g = c.createLinearGradient(0, 0, 32, 0);
    g.addColorStop(0.0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, `rgba(255,255,255,${(0.85 * along).toFixed(3)})`);
    g.addColorStop(1.0, "rgba(255,255,255,0)");
    c.fillStyle = g;
    c.fillRect(0, y, 32, 1);
  }
  dt.update();
  return dt;
}
function streakSprite(scene) {
  const BJ = B();
  const dt = new BJ.DynamicTexture("rainStreak", { width: 16, height: 128 }, scene, true);
  const c = dt.getContext();
  const g = c.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, "rgba(210,235,255,0)");
  g.addColorStop(0.5, "rgba(220,240,255,0.55)");
  g.addColorStop(1, "rgba(210,235,255,0)");
  c.fillStyle = g;
  c.fillRect(5, 0, 6, 128);
  dt.update();
  return dt;
}

export class SpraySystem {
  constructor(scene, camera, tier, buoyancy) {
    this.scene = scene;
    this.camera = camera;
    this.tier = tier;
    this.buoyancy = buoyancy;
    this.seaLevel = 0;
    this.intensity = 0;      // 0..1 from wind + storm
    this.rain = 0;
    this.enabled = true;
    this._probe = {};
    this._acc = 0;
  }

  build() {
    const BJ = B();
    const gpu = BJ.GPUParticleSystem && BJ.GPUParticleSystem.IsSupported;
    const mk = (name, cap) => (gpu
      ? new BJ.GPUParticleSystem(name, { capacity: cap }, this.scene)
      : new BJ.ParticleSystem(name, cap, this.scene));

    const mist = softSprite(this.scene, "mistTex", 0.35);

    // --- wind-driven spray haze -------------------------------------------
    const spray = mk("spray", this.tier.spray);
    spray.particleTexture = softStreak(this.scene, "sprayStreak", 0.75);
    spray.emitter = new BJ.Vector3(0, 0, 0);
    // Annulus, not a box: a box emitter puts particles ON the camera, where a
    // half-metre droplet subtends 30 degrees and reads as a white balloon.
    spray.createCylinderEmitter(70, 3.0, 0.82, 0.4);
    spray.color1 = new BJ.Color4(1, 1, 1, 0.16);
    spray.color2 = new BJ.Color4(0.85, 0.93, 1.0, 0.09);
    spray.colorDead = new BJ.Color4(0.8, 0.9, 1.0, 0);
    spray.minSize = 0.020; spray.maxSize = 0.075;
    spray.minLifeTime = 0.5; spray.maxLifeTime = 2.2;
    spray.emitRate = 0;
    spray.blendMode = BJ.ParticleSystem.BLENDMODE_STANDARD;
    // Wind-torn spray is a SMEAR, not a bead.  A round billboard the size of a
    // real droplet reads as bokeh -- a snowstorm of white discs at any range
    // where the droplet is still resolvable.  The streak comes from the SPRITE
    // plus a screen-space rotation onto the wind (see _alignToWind), never from
    // BILLBOARDMODE_STRETCHED: see the note on that mode below.
    spray.isBillboardBased = true;
    spray.minScaleY = 2.4; spray.maxScaleY = 6.0;
    spray.gravity = new BJ.Vector3(0, -6.5, 0);
    spray.minEmitPower = 1.5; spray.maxEmitPower = 6.0;
    spray.updateSpeed = 0.016;
    if (spray.useLogarithmicDepth !== undefined) spray.useLogarithmicDepth = true;
    this.spray = spray;

    // --- low mist over the surface ----------------------------------------
    const mistPs = mk("crestMist", Math.round(this.tier.spray * 0.5));
    mistPs.particleTexture = mist;
    mistPs.emitter = new BJ.Vector3(0, 0, 0);
    mistPs.createCylinderEmitter(95, 5.0, 0.86, 0.3);
    mistPs.color1 = new BJ.Color4(0.92, 0.96, 1.0, 0.07);
    mistPs.color2 = new BJ.Color4(0.80, 0.88, 0.96, 0.04);
    mistPs.colorDead = new BJ.Color4(0.8, 0.9, 1.0, 0);
    mistPs.minSize = 0.9; mistPs.maxSize = 3.0;
    mistPs.minLifeTime = 1.8; mistPs.maxLifeTime = 4.5;
    mistPs.emitRate = 0;
    mistPs.blendMode = BJ.ParticleSystem.BLENDMODE_STANDARD;
    mistPs.gravity = new BJ.Vector3(0, 0.3, 0);
    mistPs.minEmitPower = 0.4; mistPs.maxEmitPower = 2.0;
    mistPs.updateSpeed = 0.02;
    if (mistPs.useLogarithmicDepth !== undefined) mistPs.useLogarithmicDepth = true;
    this.mist = mistPs;

    // --- rain --------------------------------------------------------------
    const rain = mk("rain", Math.min(this.tier.rain, 1800));
    rain.particleTexture = streakSprite(this.scene);
    rain.emitter = new BJ.Vector3(0, 0, 0);
    // Tight box: rain only has to sell the near field.  A 110 m box with the
    // camera inside stacks a dozen translucent streaks over every pixel and
    // composites to solid white long before it looks like weather.
    rain.minEmitBox = new BJ.Vector3(-20, 10, -20);
    rain.maxEmitBox = new BJ.Vector3(20, 22, 20);
    rain.color1 = new BJ.Color4(0.78, 0.86, 0.95, 0.42);
    rain.color2 = new BJ.Color4(0.70, 0.80, 0.92, 0.26);
    rain.colorDead = new BJ.Color4(0.7, 0.8, 0.9, 0.1);
    rain.minSize = 0.018; rain.maxSize = 0.045;
    rain.minScaleY = 7; rain.maxScaleY = 16;
    rain.minLifeTime = 1.6; rain.maxLifeTime = 2.8;
    rain.emitRate = 0;
    rain.blendMode = BJ.ParticleSystem.BLENDMODE_STANDARD;
    rain.isBillboardBased = true;
    rain.gravity = new BJ.Vector3(0, 0, 0);
    rain.minEmitPower = 0.85; rain.maxEmitPower = 1.15;
    rain.direction1 = new BJ.Vector3(0, -1, 0);
    rain.direction2 = new BJ.Vector3(0, -1, 0);
    rain.updateSpeed = 0.016;
    rain.isLocal = false;
    if (rain.useLogarithmicDepth !== undefined) rain.useLogarithmicDepth = true;
    this.rainPs = rain;

    // --- CPU crest bursts ---------------------------------------------------
    const burst = new BJ.ParticleSystem("crestBurst", 900, this.scene);
    burst.particleTexture = softStreak(this.scene, "burstStreak", 0.55);
    burst.emitter = new BJ.Vector3(0, 0, 0);
    burst.color1 = new BJ.Color4(1, 1, 1, 0.85);
    burst.color2 = new BJ.Color4(0.90, 0.95, 1.0, 0.55);
    burst.colorDead = new BJ.Color4(0.85, 0.92, 1.0, 0);
    burst.minSize = 0.07; burst.maxSize = 0.32;
    burst.minLifeTime = 0.6; burst.maxLifeTime = 1.7;
    burst.emitRate = 0;
    burst.blendMode = BJ.ParticleSystem.BLENDMODE_STANDARD;
    burst.isBillboardBased = true;
    burst.minScaleY = 1.5; burst.maxScaleY = 3.4;
    burst.gravity = new BJ.Vector3(0, -9.0, 0);
    burst.minEmitPower = 2.5; burst.maxEmitPower = 8.0;
    burst.updateSpeed = 0.016;
    burst.useLogarithmicDepth = true;
    this.burst = burst;
    this._crests = [];
    burst.startPositionFunction = (worldMatrix, positionToUpdate) => {
      const c = this._crests.length
        ? this._crests[(Math.random() * this._crests.length) | 0]
        : [this.camera.globalPosition.x, this.seaLevel, this.camera.globalPosition.z];
      positionToUpdate.set(c[0] + (Math.random() - 0.5) * 2.2,
                           c[1] + Math.random() * 0.5,
                           c[2] + (Math.random() - 0.5) * 2.2);
    };

    this.all = [spray, mistPs, rain, burst];
    // deliberately NOT started -- see _gate
  }

  /** Drop every live particle (used when the weather is switched outright). */
  flush() {
    if (!this.all) return;
    for (const p of this.all) { if (p.reset) p.reset(); }
  }

  /** Find breaking crests near the camera from the CPU mirror. */
  _findCrests(windDir) {
    const list = [];
    if (!this.buoyancy || !this.buoyancy.grids) { this._crests = list; return; }
    const cam = this.camera.globalPosition;
    const R = 55;
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * R;
      const x = cam.x + Math.cos(a) * r;
      const z = cam.z + Math.sin(a) * r;
      const d = this.buoyancy.getSurfaceData({ x, z }, this._probe);
      if (d.foam > 0.30 && d.height > this.seaLevel + 0.35) list.push([x, d.height, z]);
    }
    this._crests = list;
  }

  /**
   * Particles live in the same HDR buffer as everything else, so their colour
   * IS a radiance.  Leaving it at 1.0 makes spray self-luminous: invisible by
   * day and a field of glowing white discs the moment night exposure opens up.
   */
  _relight(sky) {
    // Clouds have to be in this: under a full overcast the sun still stands at
    // the same elevation, and lighting spray by unobstructed sunlight fills a
    // storm with glowing white discs.
    const cloudT = 1 - 0.85 * sky.cloudCover * (0.45 + 0.55 * sky.storm);
    const sunE = Math.max(0, sky.sunDir.y) * sky.sunI * 22.0 * cloudT;
    const moonE = Math.max(0, sky.moonDir.y) * sky.moonI * 22.0;
    const skyE = 2.2 * (sky.sunI * 0.8 + 0.05);
    const L = Math.min(9.0, (0.82 * (sunE + moonE + skyE)) / Math.PI);
    const set = (ps, r, g, b, a1, a2) => {
      ps.color1.set(r * L, g * L, b * L, a1);
      ps.color2.set(r * L * 0.86, g * L * 0.86, b * L * 0.86, a2);
      ps.colorDead.set(r * L * 0.7, g * L * 0.7, b * L * 0.7, 0);
    };
    set(this.spray, 1.0, 1.0, 1.0, 0.16, 0.09);
    set(this.mist, 0.94, 0.97, 1.0, 0.030, 0.016);
    set(this.burst, 1.0, 1.0, 1.0, 0.62, 0.38);
    set(this.rainPs, 0.80, 0.87, 0.96, 0.24, 0.12);
  }

  /**
   * Point each streak along its own travel direction, in SCREEN space.
   *
   * This exists instead of BILLBOARDMODE_STRETCHED, which is the obvious way to
   * do it and is a trap on a GPUParticleSystem: that class draws its WHOLE
   * capacity every frame and relies on the shader to collapse dead particles to
   * zero size.  A dead particle has no direction, so the stretched path takes
   * normalize(cross(toCamera, direction)) of a zero vector.  WebGL2 degenerates
   * the quad and nothing shows; WebGPU expands it, and the sea fills with huge
   * overlapping translucent polygons that read as broken ocean tiles -- with
   * the particle count reading zero the whole time.
   *
   * Rotating a streak sprite has no such failure mode and looks the same.
   */
  _alignToWind() {
    const cam = this.camera;
    const right = cam.getDirection(B().Axis.X);
    const up = cam.getDirection(B().Axis.Y);
    const set = (ps, d) => {
      const l = Math.hypot(d.x, d.y, d.z);
      if (l < 1e-4) return;
      const sx = (d.x * right.x + d.y * right.y + d.z * right.z) / l;
      const sy = (d.x * up.x + d.y * up.y + d.z * up.z) / l;
      if (Math.abs(sx) + Math.abs(sy) < 1e-4) return;   // dead-on, any angle
      const a = Math.atan2(-sx, sy);
      ps.minInitialRotation = a - 0.14;
      ps.maxInitialRotation = a + 0.14;
      // CPU systems can also turn the particles already in flight
      if (ps.particles) for (const q of ps.particles) q.angle = a;
    };
    const mid = (ps) => ({
      x: (ps.direction1.x + ps.direction2.x) * 0.5,
      y: (ps.direction1.y + ps.direction2.y) * 0.5,
      z: (ps.direction1.z + ps.direction2.z) * 0.5,
    });
    set(this.spray, mid(this.spray));
    set(this.rainPs, mid(this.rainPs));
    set(this.burst, mid(this.burst));
  }

  /**
   * Emission rate, and whether the system runs at all.
   *
   * A GPUParticleSystem draws its ENTIRE capacity every frame and leaves it to
   * its own shader to collapse the dead ones.  A buffer that has never emitted
   * is all zeros, so age/life is 0/0: NaN size, NaN corners.  WebGL2 quietly
   * degenerates those quads and nothing shows; WebGPU rasterises them, and a
   * system sitting at zero emission fills the screen with a starburst of huge
   * translucent streaks -- while every particle count reads zero.
   *
   * So an idle system must be STOPPED, not merely set to rate 0.  The idle
   * timer covers the longest particle lifetime so a stop never cuts a live
   * tail short.
   */
  _gate(ps, rate, dt) {
    ps.emitRate = rate;
    if (rate > 0) {
      ps._idleFor = 0;
      if (!ps.isStarted()) ps.start();
    } else {
      ps._idleFor = (ps._idleFor || 0) + dt;
      if (ps._idleFor > 5.0 && ps.isStarted()) {
        ps.stop();
        if (ps.reset) ps.reset();
      }
    }
  }

  update(dt, wind, storm, rainAmount, windDir, sky) {
    this.clock = (this.clock || 0) + (dt || 0);
    if (sky) this._relight(sky);
    if (!this.spray) return;
    const cam = this.camera.globalPosition;
    for (const p of this.all) if (p.emitter && p.emitter.copyFrom) p.emitter.copyFrom(cam);
    this.spray.emitter.y = this.seaLevel;
    this.mist.emitter.y = this.seaLevel;
    this.rainPs.emitter.y = cam.y;

    const BJ = B();
    const w = Math.min(1, Math.max(0, (wind - 9) / 18));
    const inten = this.enabled ? Math.min(1, w + storm * 0.85) : 0;
    this.intensity = inten;

    // wind carries the spray downwind
    // SIM clock, not the wall clock.  performance.now() keeps advancing
    // when the simulation is stopped, so a shader driven by it animates in
    // a scene that is supposed to be frozen -- which defeats every
    // frozen-scene measurement.  It put ~10 RMS of drift into the
    // persistence floor and collapsed the whole matrix below it.  At
    // normal playback the two are equivalent; under __lockStep they are
    // not, and only this one is honest.
    const gust = sky ? sky.gust : 1;
    const wx = windDir[0] * wind * 0.55 * gust, wz = windDir[1] * wind * 0.55 * gust;
    this.spray.direction1 = new BJ.Vector3(wx * 0.6 - 1, 2.0, wz * 0.6 - 1);
    this.spray.direction2 = new BJ.Vector3(wx * 1.1 + 1, 5.5, wz * 1.1 + 1);
    this.mist.direction1 = new BJ.Vector3(wx * 0.3 - 0.5, 0.1, wz * 0.3 - 0.5);
    this.mist.direction2 = new BJ.Vector3(wx * 0.6 + 0.5, 0.7, wz * 0.6 + 0.5);
    this.burst.direction1 = new BJ.Vector3(wx * 0.5 - 1.5, 2.5, wz * 0.5 - 1.5);
    this.burst.direction2 = new BJ.Vector3(wx * 1.0 + 1.5, 7.0, wz * 1.0 + 1.5);
    this.rainPs.direction1.set(windDir[0] * wind * 0.45 * gust - 0.4, -8.5,
      windDir[1] * wind * 0.45 * gust - 0.4);
    this.rainPs.direction2.set(windDir[0] * wind * 0.45 * gust + 0.4, -7.2,
      windDir[1] * wind * 0.45 * gust + 0.4);

    const under = cam.y < this.seaLevel - 0.2;
    // Whitecaps now place spray at the crests that are actually breaking
    // (see BreakingWaves), so this uniform emitter is no longer the source of
    // droplets -- left at its old rate the two stack and the sea fills with an
    // even field of white tick marks, which is exactly the "spray looks like
    // white dots" failure.  What is left here is faint wind haze.
    this._gate(this.spray, under ? 0 : this.tier.spray * 0.05 * Math.pow(inten, 2.0), dt);
    // Mist overlaps: a few hundred soft quads read as haze, a few thousand read
    // as a white sheet no matter how low each one's alpha is.
    this._gate(this.mist, under ? 0 : Math.min(140, this.tier.spray * 0.02) * Math.pow(inten, 2.0), dt);
    this.rain = rainAmount;
    // Heavy rain must reduce visibility, not paint the frame white: the veil
    // that does the visibility work lives in the water and sky shaders, and
    // the particles only need to sell the near field.
    this._gate(this.rainPs, (under || !this.enabled) ? 0 : Math.min(520, this.tier.rain * 0.05) * rainAmount, dt);

    this._acc += dt;
    if (this._acc > 0.1) {
      this._acc = 0;
      if (inten > 0.12 && !under) this._findCrests(windDir);
      else this._crests = [];
    }
    this._gate(this.burst, (under || !this._crests.length) ? 0 : 420 * Math.pow(inten, 1.2), dt);
    this._alignToWind();
  }

  dispose() { if (this.all) this.all.forEach((p) => p.dispose()); this.all = null; }
}
