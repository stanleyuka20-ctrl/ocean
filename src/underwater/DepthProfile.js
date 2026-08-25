// ---------------------------------------------------------------------------
//  DepthProfile.js -- data-driven optical zones and water-body presets.
//  Zones blend continuously; nothing here draws a fog wall.
// ---------------------------------------------------------------------------

export const DEPTH_ZONES = [
  { name: "shallows",     to: 20,   caustic: 1.00, vis: 1.00, snow: 0.55, bubbles: 1.00, bio: 0.00, dive: 0.15 },
  { name: "reefShelf",    to: 60,   caustic: 0.55, vis: 0.82, snow: 0.80, bubbles: 0.70, bio: 0.00, dive: 0.35 },
  { name: "dropOff",      to: 200,  caustic: 0.08, vis: 0.55, snow: 1.10, bubbles: 0.35, bio: 0.05, dive: 0.70 },
  { name: "twilight",     to: 1000, caustic: 0.00, vis: 0.28, snow: 1.45, bubbles: 0.12, bio: 0.45, dive: 1.00 },
  { name: "abyss",        to: 4000, caustic: 0.00, vis: 0.10, snow: 1.20, bubbles: 0.04, bio: 0.85, dive: 1.20 },
];

export const UW_PRESETS = {
  tropicalClear: {
    label: "Clear tropical",
    water: "tropical",
    clarity: 1.35,
    turbid: 0.04,
    scatterAmt: 0.92,
    particle: 0.70,
    snow: 0.65,
    bubbles: 1.00,
    coral: 1.15,
    fish: 1.10,
    shafts: 1.20,
    dive: 10,
    bio: 0.15,
    maxDepth: 4000,
    causticCut: 72,
  },
  openOcean: {
    label: "Open ocean",
    water: "atlantic",
    clarity: 1.00,
    turbid: 0.13,
    scatterAmt: 1.00,
    particle: 0.90,
    snow: 0.90,
    bubbles: 0.80,
    coral: 0.55,
    fish: 0.70,
    shafts: 0.85,
    dive: 16,
    bio: 0.35,
    maxDepth: 4000,
    causticCut: 58,
  },
  stormWater: {
    label: "Storm water",
    water: "storm",
    clarity: 0.55,
    turbid: 0.38,
    scatterAmt: 1.15,
    particle: 1.40,
    snow: 1.25,
    bubbles: 1.20,
    coral: 0.70,
    fish: 0.50,
    shafts: 0.45,
    dive: 22,
    bio: 0.20,
    maxDepth: 4000,
    causticCut: 36,
  },
  deepCanyon: {
    label: "Deep canyon",
    water: "pacific",
    clarity: 0.85,
    turbid: 0.16,
    scatterAmt: 0.88,
    particle: 1.05,
    snow: 1.35,
    bubbles: 0.55,
    coral: 0.35,
    fish: 0.40,
    shafts: 0.70,
    dive: 28,
    bio: 0.55,
    maxDepth: 2500,
    causticCut: 50,
  },
  abyssalTrench: {
    label: "Abyssal trench",
    water: "atlantic",
    clarity: 0.70,
    turbid: 0.22,
    scatterAmt: 0.70,
    particle: 1.10,
    snow: 1.50,
    bubbles: 0.25,
    coral: 0.15,
    fish: 0.20,
    shafts: 0.20,
    dive: 42,
    bio: 1.00,
    maxDepth: 4000,
    causticCut: 40,
  },
};

function lerp(a, b, t) { return a + (b - a) * t; }

/** Smooth optical multipliers at a camera depth in metres. */
export function profileAt(depth) {
  const d = Math.max(0, depth);
  let prev = { to: 0, caustic: 1, vis: 1, snow: 0.45, bubbles: 1, bio: 0, dive: 0.1 };
  for (let i = 0; i < DEPTH_ZONES.length; i++) {
    const z = DEPTH_ZONES[i];
    if (d <= z.to) {
      const span = z.to - prev.to;
      const t = span < 1e-3 ? 1 : (d - prev.to) / span;
      const s = t * t * (3 - 2 * t);
      return {
        name: z.name,
        depth: d,
        caustic: lerp(prev.caustic, z.caustic, s),
        vis: lerp(prev.vis, z.vis, s),
        snow: lerp(prev.snow, z.snow, s),
        bubbles: lerp(prev.bubbles, z.bubbles, s),
        bio: lerp(prev.bio, z.bio, s),
        dive: lerp(prev.dive, z.dive, s),
        sunReach: Math.exp(-d * 0.011),
      };
    }
    prev = z;
  }
  const z = DEPTH_ZONES[DEPTH_ZONES.length - 1];
  return {
    name: z.name, depth: d, caustic: z.caustic, vis: z.vis, snow: z.snow,
    bubbles: z.bubbles, bio: z.bio, dive: z.dive, sunReach: Math.exp(-d * 0.011),
  };
}
