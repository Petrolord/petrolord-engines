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
 * older ones). PT11a, closes audit item B5.
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
 * an NaCl-solution chart, so it inherits the chart's limits:
 *  - denominator B - 0.5*Rwe must be positive; at or below zero (roughly
 *    Rwe above 2 ohm.m at formation temperatures) the fit is meaningless
 *    and the function returns NaN rather than extrapolating;
 *  - T must exceed 50.8 degF, where the second log goes to zero;
 *  - T must sit inside the temperature range printed on the chart. The
 *    upper bound is recorded in RWE_TO_RW_DOMAIN when the chart is read
 *    for the golden points (chart_points.json); until then no upper
 *    bound is enforced, and the header says so rather than guessing one;
 *  - NaCl waters only, as the chart assumes.
 * Where the fit is small: within a few percent between Rwe 0.1 and 0.3
 * at formation temperature; upward for saline waters; growing again
 * toward very fresh water. Check point: T = 150, Rwe = 0.050 gives
 * A = 0.0181, B = 1.232, Rw = 0.0564.
 */
export const RWE_TO_RW_DOMAIN = Object.freeze({
  tempFMin: 50.8,   // exclusive: log10(T/50.8) -> 0
  tempFMax: null,   // the chart's printed upper temperature, once read
  rweMin: 0,        // exclusive
});

const bkAB = (tempF) => ({
  a: 0.131 * 10 ** (1 / Math.log10(tempF / 19.9) - 2),
  b: 10 ** (0.0426 / Math.log10(tempF / 50.8)),
});

const tempInDomain = (tempF) => Number.isFinite(tempF) && tempF > RWE_TO_RW_DOMAIN.tempFMin
  && (RWE_TO_RW_DOMAIN.tempFMax == null || tempF <= RWE_TO_RW_DOMAIN.tempFMax);

/** Rw from the equivalent Rwe at formation temperature (degF). NaN outside the fit. */
export function rweToRw(rweOhmm, tempF) {
  if (!(rweOhmm > 0) || !tempInDomain(tempF)) return NaN;
  const { a, b } = bkAB(tempF);
  const den = b - 0.5 * rweOhmm;
  return den > 0 ? (rweOhmm + a) / den : NaN;
}

/** The inverse: Rwe from Rw at formation temperature (degF). NaN outside the fit. */
export function rwToRwe(rwOhmm, tempF) {
  if (!(rwOhmm > 0) || !tempInDomain(tempF)) return NaN;
  const { a, b } = bkAB(tempF);
  const rwe = (rwOhmm * b - a) / (1 + 0.5 * rwOhmm);
  return rwe > 0 ? rwe : NaN;
}

/** Why rweToRw refuses, as a sentence for the UI, or null when it does not. */
export function rweToRwProblem(rweOhmm, tempF) {
  if (!Number.isFinite(tempF)) return 'Formation temperature is needed.';
  if (!(tempF > RWE_TO_RW_DOMAIN.tempFMin)) return `The Bateman-Konen fit is undefined at or below ${RWE_TO_RW_DOMAIN.tempFMin} °F (10.4 °C).`;
  if (RWE_TO_RW_DOMAIN.tempFMax != null && tempF > RWE_TO_RW_DOMAIN.tempFMax) return `The chart stops at ${RWE_TO_RW_DOMAIN.tempFMax} °F.`;
  if (!(rweOhmm > 0)) return 'Rwe must be positive.';
  const { b } = bkAB(tempF);
  if (!(b - 0.5 * rweOhmm > 0)) return `Rwe of ${rweOhmm} ohm·m is beyond the chart at this temperature (the fit fails above ${(2 * b).toFixed(2)} ohm·m); the water is too fresh for the SP route.`;
  return null;
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
