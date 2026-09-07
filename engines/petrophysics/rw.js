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

/** QUICKLOOK SP chain (documented approximation — plan Q4): treats
 *  Rmfe ~= Rmf and Rw ~= Rwe. SSP = -K*log10(Rmfe/Rwe) =>
 *  Rwe = Rmfe*10^(SSP/K). The full Bateman & Konen (1977) conversions
 *  are deliberately NOT implemented until a page-referenced source is
 *  in hand — no guessed coefficients. */
export function rweFromSsp(sspMv, rmfe, tempF) {
  return Number.isFinite(sspMv) && rmfe > 0 ? rmfe * 10 ** (sspMv / spK(tempF)) : NaN;
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
