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
