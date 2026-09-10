// Formation-water resistivity utilities (Petrophysics Studio G2.1).
// Shared engine conventions in vsh.js. Temperatures are degF INSIDE
// these formulas only (they are defined in degF) — everything else in
// the app is SI; the UI converts at the boundary and says so.

/** Arps temperature conversion (NaCl solutions), degF:
 *  Rw2 = Rw1*(T1+6.77)/(T2+6.77). */
export function rwArps(rw1, t1F, t2F) {
  return Number.isFinite(rw1) ? (rw1 * (t1F + 6.77)) / (t2F + 6.77) : NaN;
}

/** SP temperature coefficient K = 61 + 0.133*T(degF). */
export const spK = (tempF) => 61 + 0.133 * tempF;

/** SP temperature coefficient K = 61 + 0.133*T(degF); SSP = -K*log10(Rmfe/Rwe)
 *  => Rwe = Rmfe*10^(SSP/K). Rwe is the EQUIVALENT water resistivity; the
 *  chart step to Rw is rweToRw below (PT11a), and the filtrate step from
 *  Rmf to Rmfe is rmfeFromRmf. The one-call chain is rwFromSsp. */
export function rweFromSsp(sspMv, rmfe, tempF) {
  return Number.isFinite(sspMv) && rmfe > 0 ? rmfe * 10 ** (sspMv / spK(tempF)) : NaN;
}

/**
 * Bateman & Konen (1977) fit to the Schlumberger Rw versus Rweq chart
 * (SP-2 in current editions of the Log Interpretation Charts, Gen-9 in
 * older ones). PT11a, closes audit item B5; band narrowed 2026-09-10
 * when the chart was read (chart_points.json).
 *
 * Sources: Bateman, R. M. and Konen, C. E., 1977, "The log analyst and
 * the programmable pocket calculator," The Log Analyst, v. 18, no. 5,
 * p. 3-11 (primary). Reproduced in Asquith, G. and Krygowski, D., 2004,
 * Basic Well Log Analysis, 2nd ed., AAPG Methods in Exploration 16, the
 * spontaneous potential chapter (secondary). Equation supplied by the
 * owner 2026-09-10; the equation's own page is recorded in the Studio
 * audit once verified against the copy in hand.
 *
 *   A   = 0.131 * 10^(1/log10(T/19.9) - 2)
 *   B   = 10^(0.0426 / log10(T/50.8))
 *   Rw  = (Rwe + A) / (B - 0.5*Rwe)          forward
 *   Rwe = (Rw*B - A) / (1 + 0.5*Rw)          inverse (the filtrate side)
 *
 * T in degF, resistivities in ohm.m, logs base 10. An EMPIRICAL FIT to
 * an NaCl-solution chart. WHAT THE CHART SAYS ABOUT IT (31 readings off
 * chart SP-2, 2026-09-10, test-data/petrophysics/chart_points.json):
 *  - the chart's printed temperature range is 75 to 500 degF;
 *  - every reading has Rw ABOVE Rweq: the chart's correction is upward
 *    everywhere on its printed range, and it grows toward fresh water
 *    and with temperature (Rw = 1.0 ohm.m is Rweq 0.744 at 75 degF and
 *    0.229 at 500 degF);
 *  - the fit does NOT reproduce that: at Rw of 1 ohm.m and above it is
 *    36 to 92 percent LOW at all seven temperatures (it even turns the
 *    correction downward between Rwe 0.1 and about 1.4 ohm.m below
 *    250 degF), and near NaCl saturation at 75 degF (Rweq 0.015 and
 *    below) it is 13 to 24 percent HIGH; its only confirmed anchors are
 *    the 75 degF saturation asymptote (A/B = 0.040 against the chart's
 *    0.035) and the owner's 150 degF check point;
 *  - no reading yet sits between Rweq 0.02 and Rw 1.0 (the owner flagged
 *    75 degF between 0.02 and 0.06 for a human check), so the band the
 *    fit is trusted in below is bounded by where it is KNOWN wrong, not
 *    proven right; the gate says PENDING for that band until it is read.
 * Accepted band (RWE_TO_RW_DOMAIN, refused with a reason outside it):
 *    T inside 75..500 degF (and above 50.8 degF, where the second log
 *    goes to zero); Rwe at formation temperature at most rweMax = 0.1
 *    ohm.m (the same 0.1 ohm.m "fresh" boundary the Rmfe rule uses);
 *    Rwe carried to 75 degF by Arps at least rweMin75F = 0.02 ohm.m
 *    (the near-saturation bend the fit misses). NaCl waters only. The
 *    denominator B - 0.5*Rwe is also checked, though inside the band it
 *    is always positive. No extrapolation, no clamping.
 * Inside the band the correction is upward and modest: +13 percent at
 * 150 degF and Rwe 0.05 (the check point, Rw = 0.0564), within 2 percent
 * of Rwe at the 0.1 edge (slightly below it at 75 degF). Check point: T = 150, Rwe = 0.050 gives A = 0.0181,
 * B = 1.232, Rw = 0.0564.
 */
export const RWE_TO_RW_DOMAIN = Object.freeze({
  tempFMin: 50.8,     // exclusive: log10(T/50.8) -> 0
  chartTempFMin: 75,  // inclusive: the chart's printed range, read 2026-09-10
  tempFMax: 500,      // inclusive: the chart's printed upper temperature
  rweMin: 0,          // exclusive
  rweMax: 0.1,        // inclusive, at formation temperature: fresher is refused (chart refutes the fit)
  rweMin75F: 0.02,    // inclusive, Rwe carried to 75 degF by Arps: nearer saturation is refused
});

const bkAB = (tempF) => ({
  a: 0.131 * 10 ** (1 / Math.log10(tempF / 19.9) - 2),
  b: 10 ** (0.0426 / Math.log10(tempF / 50.8)),
});

const D = RWE_TO_RW_DOMAIN;
const tempInDomain = (tempF) => Number.isFinite(tempF) && tempF > D.tempFMin
  && tempF >= D.chartTempFMin && tempF <= D.tempFMax;

/** The accepted Rwe band at formation temperature `tempF`: { lo, hi } in
 *  ohm.m (lo = rweMin75F carried to tempF by Arps, hi = rweMax), or null
 *  when the temperature is outside the chart. */
export function rweBand(tempF) {
  if (!tempInDomain(tempF)) return null;
  return { lo: rwArps(D.rweMin75F, 75, tempF), hi: D.rweMax };
}

const rweInBand = (rweOhmm, tempF) => {
  const band = rweBand(tempF);
  // 1e-9 relative slack so a round trip that lands on the band edge stays inside it
  return band != null && rweOhmm >= band.lo * (1 - 1e-9) && rweOhmm <= band.hi * (1 + 1e-9);
};

/** Rw from the equivalent Rwe at formation temperature (degF). NaN outside the accepted band. */
export function rweToRw(rweOhmm, tempF) {
  if (!(rweOhmm > 0) || !rweInBand(rweOhmm, tempF)) return NaN;
  const { a, b } = bkAB(tempF);
  const den = b - 0.5 * rweOhmm;
  return den > 0 ? (rweOhmm + a) / den : NaN;
}

/** The inverse: Rwe from Rw at formation temperature (degF). NaN when the
 *  Rwe it lands on is outside the accepted band. */
export function rwToRwe(rwOhmm, tempF) {
  if (!(rwOhmm > 0) || !tempInDomain(tempF)) return NaN;
  const { a, b } = bkAB(tempF);
  const rwe = (rwOhmm * b - a) / (1 + 0.5 * rwOhmm);
  return rwe > 0 && rweInBand(rwe, tempF) ? rwe : NaN;
}

const tempProblem = (tempF) => {
  if (!Number.isFinite(tempF)) return 'Formation temperature is needed.';
  if (!(tempF > D.tempFMin)) return `The Bateman-Konen fit is undefined at or below ${D.tempFMin} °F (10.4 °C).`;
  if (tempF < D.chartTempFMin) return `Chart SP-2 starts at ${D.chartTempFMin} °F (${((D.chartTempFMin - 32) * 5 / 9).toFixed(1)} °C).`;
  if (tempF > D.tempFMax) return `Chart SP-2 stops at ${D.tempFMax} °F (${((D.tempFMax - 32) * 5 / 9).toFixed(0)} °C).`;
  return null;
};

const bandProblem = (rweOhmm, tempF, what) => {
  const { lo, hi } = rweBand(tempF);
  if (rweOhmm > hi) return `${what} of ${rweOhmm.toPrecision(3)} ohm·m is beyond the chart band the fit reproduces (up to ${hi} ohm·m at formation temperature; chart SP-2 readings put the fit 36 to 92 percent low for fresher waters); the water is too fresh for the SP route.`;
  if (rweOhmm < lo) return `${what} of ${rweOhmm.toPrecision(3)} ohm·m is nearer NaCl saturation than the fit follows (the chart bends toward saturation below ${lo.toPrecision(3)} ohm·m at this temperature, ${D.rweMin75F} ohm·m at 75 °F).`;
  return null;
};

/** Why rweToRw refuses, as a sentence for the UI, or null when it does not. */
export function rweToRwProblem(rweOhmm, tempF) {
  const tp = tempProblem(tempF);
  if (tp) return tp;
  if (!(rweOhmm > 0)) return 'Rwe must be positive.';
  const bp = bandProblem(rweOhmm, tempF, 'Rwe');
  if (bp) return bp;
  const { b } = bkAB(tempF);
  if (!(b - 0.5 * rweOhmm > 0)) return `Rwe of ${rweOhmm} ohm·m is beyond the chart at this temperature (the fit fails above ${(2 * b).toFixed(2)} ohm·m); the water is too fresh for the SP route.`;
  return null;
}

/** Why rwToRwe (the filtrate side) refuses, as a sentence, or null. */
export function rwToRweProblem(rwOhmm, tempF) {
  const tp = tempProblem(tempF);
  if (tp) return tp;
  if (!(rwOhmm > 0)) return 'Rmf must be positive.';
  const { a, b } = bkAB(tempF);
  const rwe = (rwOhmm * b - a) / (1 + 0.5 * rwOhmm);
  if (!(rwe > 0)) return `Rmf of ${rwOhmm.toPrecision(3)} ohm·m at formation temperature is below the fit's floor (${(a / b).toPrecision(3)} ohm·m, its NaCl-saturation asymptote).`;
  return bandProblem(rwe, tempF, 'Rmfe');
}

/**
 * Mud-filtrate side: Rmfe from Rmf. `rmf` was measured at `rmfTempF`;
 * Arps carries it to formation temperature `tempF` for the value and to
 * 75 degF for the rule: when Rmf at 75 degF EXCEEDS 0.1 ohm.m the
 * standard convention Rmfe = 0.85*Rmf is used (at exactly 0.1 the chart
 * inverse is used), otherwise the Bateman-Konen inverse.
 * @returns {{ rmfe: number, rule: 'x0.85'|'chart-inverse', rmfAtT: number }}
 */
export function rmfeFromRmf(rmf, rmfTempF, tempF) {
  if (!(rmf > 0) || !Number.isFinite(rmfTempF) || !Number.isFinite(tempF)) return { rmfe: NaN, rule: null, rmfAtT: NaN };
  const rmfAtT = rwArps(rmf, rmfTempF, tempF);
  const rmf75 = rwArps(rmf, rmfTempF, 75);
  if (rmf75 > 0.1) return { rmfe: 0.85 * rmfAtT, rule: 'x0.85', rmfAtT };
  return { rmfe: rwToRwe(rmfAtT, tempF), rule: 'chart-inverse', rmfAtT };
}

/**
 * The whole SP chain at formation temperature: Rmf (measured at
 * rmfTempF) -> Rmfe -> Rwe (from SSP and K) -> Rw. Every intermediate is
 * returned so the UI shows the chain rather than one number.
 */
export function rwFromSsp(sspMv, rmf, rmfTempF, tempF) {
  const k = spK(tempF);
  const { rmfe, rule, rmfAtT } = rmfeFromRmf(rmf, rmfTempF, tempF);
  const rwe = rweFromSsp(sspMv, rmfe, tempF);
  return { k, rmfAtT, rmfe, rmfeRule: rule, rwe, rw: rweToRw(rwe, tempF) };
}

/**
 * Pickett (1966/1973) water-line fit: least squares on
 * log10(Rt) = log10(a*Rw) - m*log10(phi) over presumed Sw=1 points.
 * @param {Array<[number, number]>} points [phi, rt] pairs (phi, rt > 0)
 * @returns {{m: number, aRw: number}} m reported positive
 */
export function pickettFit(points) {
  const pts = points.filter(([p, r]) => p > 0 && r > 0 && Number.isFinite(p) && Number.isFinite(r));
  if (pts.length < 2) throw new Error('Pickett fit needs at least two valid (phi, Rt) points.');
  const n = pts.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const [p, r] of pts) {
    const x = Math.log10(p);
    const y = Math.log10(r);
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) throw new Error('Pickett fit is degenerate — points share one porosity.');
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { m: -slope, aRw: 10 ** intercept };
}

/**
 * Rw of an NaCl solution from its salinity and temperature — the
 * Bateman & Konen (1977, The Log Analyst 18(5)) fit to the Schlumberger
 * Gen-9 chart: Rw(75 degF) = 0.0123 + 3647.5 / ppm^0.955, then Arps to
 * the formation temperature. A CHART FIT: within about 10 percent of
 * the chart over 1,000 to 300,000 ppm; the UI says so. Non-NaCl waters
 * need an NaCl-equivalent salinity first (Gen-8 multipliers, not
 * implemented).
 * @param {number} ppmNaCl salinity, ppm NaCl (mg/L)
 * @param {number} tF formation temperature, degF
 * @returns {number} ohm.m at tF; NaN outside the fit's domain
 */
export function rwFromSalinity(ppmNaCl, tF) {
  if (!(ppmNaCl > 0) || !Number.isFinite(tF)) return NaN;
  const rw75 = 0.0123 + 3647.5 / ppmNaCl ** 0.955;
  return rwArps(rw75, 75, tF);
}

/** The inverse: NaCl salinity (ppm) implied by an Rw at tF, through the
 *  same fit. NaN when Rw at 75 degF is at or below the fit's floor. */
export function salinityFromRw(rw, tF) {
  if (!(rw > 0) || !Number.isFinite(tF)) return NaN;
  const rw75 = rwArps(rw, tF, 75);
  if (!(rw75 > 0.0123)) return NaN;
  return (3647.5 / (rw75 - 0.0123)) ** (1 / 0.955);
}
