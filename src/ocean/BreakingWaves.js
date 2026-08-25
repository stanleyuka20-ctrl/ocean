// ---------------------------------------------------------------------------
//  BreakingWaves.js -- the surf zone.
//
//  Open-ocean whitecaps.  A wave in deep water breaks because the WIND has
//  driven it past the steepness it can carry, so the criterion is local
//  steepness and crest height against wind speed -- there is no bathymetry
//  anywhere in this project and none is needed.  Breaking crests are turned
//  into what a breaker actually throws: spray off the crest, wind-blown mist,
//  whitewater on the surface and a cloud of air driven under it.
//
//  Only crests within a radius of the camera are sampled -- the surf runs along
//  the whole coast, but nobody can see a bubble from a kilometre away.  The
//  sampling ring moves with the camera continuously and picks its points from a
//  world-space lattice, so nothing pops as it moves and there is no simulation
//  boundary to see.
// ---------------------------------------------------------------------------


function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

const B = () => window.BABYLON;

export class BreakingWaves {
  constructor(ocean) {
    this.ocean = ocean;
    this.enabled = true;

    // --- wave train ---------------------------------------------------------
    this.height = 1.15;        // deep-water height feeding the surf (m)
    this.period = 9.0;         // s
    this.beachSlope = 0.035;   // representative slope, sets the phase constant
    this.refDepth = 9.0;       // depth the height is quoted at (m)
    this.lean = 0.85;          // how far a breaking crest throws forward
    this.decay = 0.35;         // how fast a broken wave gives up its height
    this.variation = 0.45;     // along-shore variation of break intensity
    this.maxDepth = 14.0;      // surf fades out below this depth (m)

    // --- what a breaker throws ---------------------------------------------
    this.whitewater = 1.0;     // surface whitewater density
    this.sprayLight = 1.0;     // spray/mist emission
    this.bubbles = 1.0;        // subsurface air injection
    this.radius = 120;         // sampling radius around the camera (m)

    this._acc = 0;
    this._phase = 0;
    this.stats = { active: 0, spray: 0, bubbles: 0, energy: 0 };
    this._probe = { x: 0, z: 0 };
  }

  /** 2 omega / (slope sqrt(g)) -- phase per sqrt(metre of depth) */
  get phaseK() {
    return (2 * this.omega) / (Math.max(this.beachSlope, 0.004) * Math.sqrt(9.81));
  }
  get omega() { return (2 * Math.PI) / Math.max(this.period, 1.5); }

  /** the uniform block the ocean material reads */
  get uniforms() {
    return {
      enabled: this.enabled,
      height: this.height,
      phaseK: this.phaseK,
      omega: this.omega,
      refDepth: this.refDepth,
      lean: this.lean,
      decay: this.decay,
      variation: this.variation,
      maxDepth: this.maxDepth,
      whitewater: this.whitewater,
      sprayLight: this.sprayLight,
    };
  }

  /**
   * Follow the sea state.  A calm day still has a shore break, a storm has a
   * big irregular one -- what changes is height, period and how ragged the
   * break line is, not whether the surf exists.
   */
  syncToSeaState(windSpeed, hs, storm) {
    const w = Math.max(windSpeed, 0);
    this.height = Math.min(3.2, 0.5 + hs * 0.55 + storm * 0.8);
    this.period = 6.5 + Math.min(6.0, hs * 1.5) + storm * 1.2;
    this.variation = 0.34 + storm * 0.5 + Math.min(0.25, w * 0.012);
    this.lean = 0.72 + storm * 0.35;
    this.maxDepth = 9.0 + this.height * 4.0;
  }

  /**
   * Sample the surf around the camera and hand the breaking crests to the
   * spray, foam and bubble systems.
   *
   * The sample points come from a world-space lattice that the camera window
   * slides over, NOT from a grid anchored to the camera: an anchored grid makes
   * every effect march along with the viewer, which is the tell that gives away
   * a camera-local simulation.
   */
  /**
   * Open-ocean whitecaps.  No bathymetry involved: a wave in deep water breaks
   * because the WIND has driven it past the steepness it can carry, so the
   * criterion is local steepness and crest height against wind speed, not
   * depth.  This is what section 12 asks for and it is why the ocean-only
   * project still has breaking waves with no sea bed anywhere.
   *
   * Sampled on a world-space lattice around the camera, exactly like the
   * shoreline surf, so nothing is anchored to the viewer.
   */
  _deepWhitecaps(dt, camPos, ctx) {
    const o = this.ocean;
    const R = this.radius;
    const cell = 7.0;
    const cx = Math.round(camPos.x / cell);
    const cz = Math.round(camPos.z / cell);
    const n = Math.ceil(R / cell);
    const wind = ctx.windDir || [1, 0];
    const ws = ctx.windSpeed || 0;
    const q = ctx.quality || 1;
    const budget = Math.round(30 * q);

    // Whitecaps start around 5 m/s and saturate in a gale.  Below that the sea
    // has crests but no white water on them, which is what a calm day looks
    // like -- painting foam on every crest is the failure this replaces.
    const windAmt = clamp01((ws - 4.5) / 13.0);
    if (windAmt <= 0.001) { this.stats.active = 0; return; }

    let active = 0, energy = 0, spray = 0, bub = 0;
    const probe = {};
    for (let j = -n; j <= n && active < budget; j++) {
      for (let i = -n; i <= n && active < budget; i++) {
        const gx = cx + i, gz = cz + j;
        const h = hash2(gx, gz);
        const x = (gx + (h - 0.5)) * cell;
        const z = (gz + (fract(h * 71.3) - 0.5)) * cell;
        const dx = x - camPos.x, dz = z - camPos.z;
        const r2 = dx * dx + dz * dz;
        if (r2 > R * R) continue;

        const d = o.getSurfaceData({ x, y: 0, z }, probe);
        const nrm = d.normal;
        // steepness of the displaced surface
        const steep = Math.hypot(nrm.x, nrm.z) / Math.max(nrm.y, 0.05);
        const crest = clamp01((d.height - o.seaLevel) / Math.max(ctx.hs * 0.55, 0.2));
        // A crest breaks when it is BOTH steep and high, and the wind is
        // strong enough to push it over.  The thresholds are calibrated
        // against the measured slope distribution of this sea (p90 ~ 0.13
        // rising to ~0.22 in a storm) so that only the top few per cent of
        // crests break -- which is what Monahan's whitecap coverage says:
        // under 1 % at 8 m/s, a few per cent in a gale.  Painting foam on
        // every crest is the failure this is here to avoid.
        const p = clamp01((steep - 0.13) / 0.13) * crest * windAmt;
        if (p < 0.26) continue;

        active++;
        const e = p * Math.max(ctx.hs * 0.6, 0.3);
        energy += e;
        const near = 1 - Math.sqrt(r2) / R;
        const amt = e * near * near;

        // spilling crests run downwind
        const dirx = wind[0], dirz = wind[1];
        const vy = 1.2 + e * 2.2;
        const vx = dirx * (1.8 + ws * 0.16) + d.velocity.x * 0.5;
        const vz = dirz * (1.8 + ws * 0.16) + d.velocity.z * 0.5;

        if (this.sprayLight > 0.01 && o.effects && amt > 0.05) {
          const c = Math.round(amt * 46 * this.sprayLight * q);
          if (c > 0) {
            o.effects.droplets.emit({
              position: [x, d.height + 0.08, z], radius: 0.7 + e * 0.6,
              velocity: [vx, vy, vz], spread: 0.9,
              count: c, size: [0.0025, 0.010],
              life: [0.45, 1.0 + e * 0.7], jitter: 0.95,
            });
            spray += c;
            // wind strips mist off the crest and blows it downwind
            if (windAmt > 0.35 && amt > 0.12) {
              o.effects.mist.emit({
                position: [x, d.height + 0.3, z], radius: 1.4 + e,
                velocity: [dirx * ws * 0.55, vy * 0.35, dirz * ws * 0.55],
                spread: 1.4,
                count: Math.round(amt * 12 * this.sprayLight * windAmt),
                size: [0.05, 0.18], life: [1.0, 2.8], jitter: 1.0,
              });
            }
          }
        }

        if (this.bubbles > 0.01 && o.effects && amt > 0.12) {
          const c = Math.round(amt * 18 * this.bubbles * q);
          if (c > 0) {
            o.effects.bubbles.emit({
              position: [x, d.height - 0.25, z], radius: 0.9 + e * 0.6,
              velocity: [dirx * 0.8, -1.0 - e * 1.2, dirz * 0.8], spread: 1.3,
              count: c, size: [0.002, 0.011],
              life: [1.2, 3.0 + e * 1.6], jitter: 1.0,
            });
            bub += c;
          }
        }

        if (amt > 0.08) {
          o.addDisturbance({
            position: [x + dirx * 0.4, 0, z + dirz * 0.4],
            radius: 1.1 + e * 0.9,
            strength: Math.min(1, 0.35 + e * 0.7) * this.whitewater,
            velocity: [dirx * ws * 0.25, 0, dirz * ws * 0.25],
            lift: 0.003 + e * 0.007,
            type: "OBJECT_IMPACT",
          });
        }
      }
    }
    this.stats.active = active;
    this.stats.spray = spray;
    this.stats.bubbles = bub;
    this.stats.energy = energy;
  }

  update(dt, camPos, ctx) {
    if (this.subsystemEnabled === false) return;
    this.updateCount = (this.updateCount || 0) + 1;
    const o = this.ocean;
    if (!this.enabled) { this.stats.active = 0; return; }
    // No bathymetry -> the shoreline surf cannot exist, so the open-ocean
    // whitecap model takes over.  One or the other, never both.
    if (!o.shoreline) {
      this._acc += dt;
      if (this._acc < 0.05) return;
      this._acc = 0;
      this._deepWhitecaps(dt, camPos, ctx);
      return;
    }
  }

  dispose() {}

  /**
   * Real disable hook.  The update path READS this flag and the counter proves
   * it stopped -- a bisection that merely sets a property nobody reads produces
   * rows identical to the baseline and looks like a diffuse cause, which is
   * exactly what happened here once already.
   */
  setEnabled(v) { this.subsystemEnabled = !!v; return this.subsystemEnabled; }
  subsystemStats() {
    return { enabled: this.subsystemEnabled !== false,
             updates: this.updateCount || 0 };
  }
}

function fract(x) { return x - Math.floor(x); }
function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
