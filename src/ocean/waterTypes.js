// ---------------------------------------------------------------------------
//  waterTypes.js -- optical properties per water body.
//
//  absorb is the per-channel extinction in 1/m and is roughly the measured
//  absorption of sea water (red ~0.34, green ~0.064, blue ~0.015 at 1 m),
//  pushed a little for readability.  It is what makes red vanish in the first
//  couple of metres while blue survives a hundred -- the depth gradient is a
//  consequence of these numbers, never a hand-painted ramp.
//
//  scatterCol is the diffuse water-leaving REFLECTANCE, a few per cent and
//  blue biased, which is what remote sensing actually measures.  Treating it
//  as an emissive colour instead is how water ends up looking like poster
//  paint: the sea is a dark body, and nearly all of its apparent brightness
//  comes from what it reflects.  A small neutral floor is added to every
//  type for particulate backscatter -- pure water reflectance is 10:1 blue to
//  red and renders as electric blue without it.
// ---------------------------------------------------------------------------

export const WATER_TYPES = {
  tropical: {
    label: "Tropical",
    absorb: [0.42, 0.075, 0.020],
    scatterCol: [0.026, 0.094, 0.102],
    scatterAmt: 1.00,
    turbid: 0.05,
  },
  atlantic: {
    label: "Atlantic",
    absorb: [0.48, 0.105, 0.048],
    scatterCol: [0.016, 0.040, 0.068],
    scatterAmt: 1.00,
    turbid: 0.13,
  },
  pacific: {
    label: "Pacific",
    absorb: [0.40, 0.070, 0.018],
    scatterCol: [0.013, 0.033, 0.071],
    scatterAmt: 1.00,
    turbid: 0.07,
  },
  mediterranean: {
    label: "Mediterranean",
    absorb: [0.44, 0.086, 0.028],
    scatterCol: [0.018, 0.057, 0.091],
    scatterAmt: 1.00,
    turbid: 0.07,
  },
  arctic: {
    label: "Arctic",
    absorb: [0.52, 0.135, 0.078],
    scatterCol: [0.024, 0.050, 0.059],
    scatterAmt: 1.00,
    turbid: 0.20,
  },
  murky: {
    label: "Murky coastal",
    absorb: [0.78, 0.44, 0.36],
    scatterCol: [0.058, 0.062, 0.038],
    scatterAmt: 1.00,
    turbid: 0.62,
  },
  storm: {
    label: "Storm ocean",
    absorb: [0.56, 0.17, 0.095],
    scatterCol: [0.020, 0.031, 0.037],
    scatterAmt: 1.00,
    turbid: 0.34,
  },
};

export const WATER_TYPE_KEYS = Object.keys(WATER_TYPES);

export function lerpWaterType(a, b, t) {
  const L = (x, y) => x + (y - x) * t;
  return {
    absorb: a.absorb.map((v, i) => L(v, b.absorb[i])),
    scatterCol: a.scatterCol.map((v, i) => L(v, b.scatterCol[i])),
    scatterAmt: L(a.scatterAmt, b.scatterAmt),
    turbid: L(a.turbid, b.turbid),
  };
}
