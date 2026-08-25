// ---------------------------------------------------------------------------
//  surf.js -- shoaling, refracting, BREAKING shore waves.
//
//  The deep-water sea stays exactly what it was: three JONSWAP cascades solved
//  by FFT.  This adds the one thing a spectral model cannot produce, because
//  the linear spectrum has no depth in it at all -- a wave train that feels the
//  sea bed, grows, steepens, curls over and turns to whitewater.
//
//  THE PHASE IS PARAMETERISED BY DEPTH, and that single choice is what makes
//  the whole thing behave.  For a wave shoaling up a beach of slope s,
//
//      k     = omega / sqrt(g d)                 (shallow-water dispersion)
//      ds    = dd / s                            (walking up the slope)
//      phase = INT k ds = 2 omega sqrt(d) / (s sqrt(g))
//
//  so the phase of a shoaling wave goes as sqrt(depth).  Writing it that way
//  means the crests are level sets of the DEPTH FIELD, which gives, for free
//  and with no ray tracing anywhere:
//
//    * fronts that bend to follow the bathymetry (refraction) and wrap around
//      headlands, bars and reefs,
//    * a break line that is irregular because the sea bed is,
//    * waves that slow down and bunch together as they come in,
//    * several rows of breakers wherever the bed has several shallow steps.
//
//  Height follows Green's law (H ~ d^-1/4) and is cut off at the McCowan
//  breaking limit H = 0.78 d; the amount by which it wants to exceed that limit
//  IS the breaking intensity, and it drives the crest curl, the whitewater, the
//  spray and the bubbles injected under the surface.
//
//  Everything here is a pure function of world position, depth and time, so the
//  INERT in the ocean-only build: with no depth map bound, seabedAt returns
//  the deep-water value and the band factor is zero everywhere, so this costs a
//  few instructions and contributes nothing.  It is kept because it is the
//  shallow-water module the export documents, ready to reattach with a
//  bathymetry.
// ---------------------------------------------------------------------------

export const SURF_GLSL = /* glsl */ `
uniform float uSurfOn;        // master 0/1
uniform float uSurfHeight;    // deep-water height feeding the surf train (m)
uniform float uSurfK;         // 2 omega / (slope sqrt(g)) -- phase per sqrt(m)
uniform float uSurfOmega;     // rad/s
uniform float uSurfRefDepth;  // depth the height is quoted at (m)
uniform float uSurfLean;      // how far a breaking crest throws forward
uniform float uSurfDecay;     // how fast a broken wave gives up its height
uniform float uSurfVary;      // along-shore variation of break intensity
uniform float uSurfMaxDepth;  // surf fades out below this depth (m)
uniform float uWhitewater;    // surface whitewater density
uniform float uSprayLight;    // spray/mist emission (read by the CPU side)

// Along-shore variation, so neither the height nor the break line is uniform.
// Two scales: long sets (a few hundred metres) and local bathymetric detail.
float surfVariation(vec2 p, float t){
  float a = sin(p.x * 0.0061 + p.y * 0.0043 + t * 0.13);
  float b = sin(p.x * 0.0143 - p.y * 0.0189 - t * 0.081 + 1.7);
  float c = sin(p.x * 0.0374 + p.y * 0.0291 + t * 0.047 + 4.1);
  return 0.52 * a + 0.30 * b + 0.18 * c;
}

// Wave groups: real swell arrives in sets, so the break line pulses in and out
// instead of every wave breaking in the same place.
float surfGroup(float ph, vec2 p, float t){
  float g = sin(ph * 0.19 - t * 0.21 + p.x * 0.0033 + p.y * 0.0027);
  return 0.74 + 0.26 * (g * 0.5 + 0.5);
}

/**
 * eta   surface elevation of the surf train (m, signed)
 * brk   0..1 breaking intensity at this point
 * lean  horizontal throw of the crest, in the shore direction (m)
 * amp   local wave height H (m), after shoaling and the breaking cap
 */
void surfWave(vec2 p, float depth, float travel, vec2 shoreDir, float t,
              out float eta, out float brk, out vec2 lean, out float amp,
              out float crestOut)
{
  eta = 0.0; brk = 0.0; lean = vec2(0.0); amp = 0.0; crestOut = 0.0;

  float d = max(depth, 0.06);
  // fade the train in as the bed comes up, and out again on dry land
  float band = smoothstep(uSurfMaxDepth, uSurfMaxDepth * 0.45, d)
             * smoothstep(0.04, 0.45, d);
  float on = uSurfOn * band;

  // --- phase: omega * (t - travel time) ------------------------------------
  // Fronts are level sets of the baked travel-time field, so wavelength,
  // slowing, bunching and refraction all come out right on any bathymetry --
  // including a flat shelf, where a phase parameterised by depth alone simply
  // stops advancing and the waves disappear.
  float ph = uSurfOmega * (t - travel);

  // --- height: Green's law, then the breaking cap --------------------------
  float vary = 1.0 + uSurfVary * surfVariation(p, t);
  float Ks = pow(clamp(uSurfRefDepth / d, 1.0, 60.0), 0.25);
  float H = uSurfHeight * Ks * max(vary, 0.15) * surfGroup(ph, p, t);
  float Hb = 0.78 * d;                       // McCowan limit

  // How hard the wave is trying to exceed the limit.  This is a property of
  // the DEPTH, so it stays high all the way in once the wave has started to
  // break -- which is correct, and is why a surf zone is a zone.
  float breakability = clamp((H / max(Hb, 1e-3) - 0.50) / 0.42, 0.0, 1.0) * on;

  // Inside the limit the wave keeps only the depth-limited height, which is
  // the observed surf-zone relation H ~ 0.6 d.
  float Hc = min(H, Hb * 1.02);
  Hc *= mix(1.0, 1.0 / (1.0 + uSurfDecay * breakability), breakability);
  amp = Hc * on;

  // --- profile: 2nd-order Stokes, sharpened as it steepens ----------------
  // Crests get peaky and troughs flat -- a sine wave never reads as surf.
  // The cos(2ph) term peaks the crest and flattens the trough (Stokes), but on
  // its own it stays front-back SYMMETRIC, and a shoaling wave is not: its
  // front face steepens while the back stays long.  The sin(2ph) term is what
  // pitches it forward, and it grows with how close the wave is to breaking.
  float steep = 0.22 + 0.55 * breakability;
  float asym = 0.85 * breakability;
  float c1 = cos(ph);
  float c2 = cos(2.0 * ph);
  float s2 = sin(2.0 * ph);
  eta = amp * 0.5 * (c1 + steep * 0.5 * c2 + asym * 0.42 * s2)
      * (1.0 + 0.35 * steep);

  // --- WHERE it breaks ----------------------------------------------------
  // A wave breaks at its CREST, not everywhere it is breakable.  Without this
  // the whole surf zone is one saturated white sheet: the depth test is true
  // over hundreds of metres, so every fragment inside it turns to foam and the
  // individual waves disappear.  Localising to the crest is what produces
  // separate rows of breakers, one per wave, with clear water between them.
  float crest = clamp(c1 * 0.5 + 0.5, 0.0, 1.0);
  brk = breakability * smoothstep(0.38, 0.88, crest);

  // --- the curl -----------------------------------------------------------
  // Only the top of the crest throws forward, and it hooks over as it goes:
  // that is what puts a real silhouette on a breaker instead of a steep hill.
  float lip = crest * crest * crest;
  lean = shoreDir * (breakability * lip * amp * uSurfLean);
  crestOut = crest;
}

/** vertical hook of the lip: the thrown crest falls as it projects forward */
float surfHook(float brk, float crest, float amp){
  float lip = crest * crest * crest;
  return brk * lip * lip * amp * 0.55;
}
`;
