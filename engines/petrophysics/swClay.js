// Shaly-sand water saturation (Petrophysics Studio PS5): Waxman-Smits,
// dual-water and modified Simandoux, plus the B(T) and Qv helpers.
// Shared engine conventions (see vsh.js): pure scalars, float64,
// UNCLAMPED (Sw > 1 is information), NaN on invalid input, no I/O.
//
// The implicit models solve by Newton iteration with a bisection
// fallback; the validation oracle uses PURE BISECTION so the two
// implementations share no numerics (independence rule). Convergence
// tolerance 1e-14 relative, so the 1e-12 golden gate holds.
//
// NOTE for consumers: Waxman-Smits m*/n* are the SHALY-ROCK exponents
// measured on shaly samples — they are NOT Archie's clean-rock m/n,
// and the UI labels them distinctly.

/** Juhasz (1981, SPWLA 22nd Annual Logging Symposium, paper Z):
 *  B = -1.28 + 0.225*T - 0.0004059*T^2 (T degC, B in (S/m)/(meq/cm3)). */
export function bJuhasz(tC) {
  if (!Number.isFinite(tC)) return NaN;
  return -1.28 + 0.225 * tC - 0.0004059 * tC * tC;
}

/** Waxman & Smits (1968): Qv = CEC*(1-phit)*rho_grain/(100*phit),
 *  CEC in meq/100 g, rho_grain g/cc -> Qv in meq/cm3. */
export function qvFromCec(cecMeq100g, phit, rhoGrain) {
  if (!Number.isFinite(phit) || phit <= 0 || phit >= 1) return NaN;
  return (cecMeq100g * (1 - phit) * rhoGrain) / (100 * phit);
}

const SW_LO = 1e-9;
const SW_HI = 10;
const TOL = 1e-14;

/** Solve f(sw) = 0 for monotonic-through-the-root f on [SW_LO, SW_HI]:
 *  Newton from a mid start, falling back to bisection whenever a step
 *  leaves the bracket or stalls. */
function solveSw(f, df) {
  let lo = SW_LO;
  let hi = SW_HI;
  let flo = f(lo);
  const fhi = f(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return NaN;
  let x = 0.5;
  for (let i = 0; i < 200; i++) {
    const fx = f(x);
    if (fx === 0) return x;
    if (flo * fx < 0) hi = x;
    else { lo = x; flo = fx; }
    const d = df(x);
    let next = x - fx / d;
    if (!Number.isFinite(next) || next <= lo || next >= hi) next = 0.5 * (lo + hi);
    if (Math.abs(next - x) <= TOL * Math.max(1, Math.abs(next))) return next;
    x = next;
  }
  return x;
}

/**
 * Waxman & Smits (1968, SPE Journal 8(2), "Electrical Conductivities
 * in Oil-Bearing Shaly Sands"):
 *   1/Rt = (phi^m* * Sw^n* / a) * (1/Rw + B*Qv/Sw)
 * Reduces exactly to Archie at Qv = 0.
 */
export function swWaxmanSmits(rt, phi, rw, qv, b, a = 1, mStar = 2, nStar = 2) {
  if (!Number.isFinite(rt) || !Number.isFinite(phi) || rt <= 0 || phi <= 0) return NaN;
  const target = 1 / rt;
  const k = phi ** mStar / a;
  const f = (sw) => k * sw ** nStar * (1 / rw + (b * qv) / sw) - target;
  const df = (sw) => k * (nStar * sw ** (nStar - 1) / rw + (nStar - 1) * b * qv * sw ** (nStar - 2));
  return solveSw(f, df);
}

/**
 * Clavier, Coates & Dumanoir (1984, SPE Journal 24(2), "Theoretical
 * and Experimental Bases for the Dual-Water Model"):
 *   1/Rt = (phit^m0 * Swt^n0 / a) * (1/Rwf + (Swb/Swt)*(1/Rwb - 1/Rwf))
 * Returns TOTAL water saturation Swt. Reduces exactly to Archie
 * (Rw = Rwf) at Swb = 0.
 */
export function swDualWater(rt, phit, rwf, rwb, swb, a = 1, m0 = 2, n0 = 2) {
  if (!Number.isFinite(rt) || !Number.isFinite(phit) || rt <= 0 || phit <= 0) return NaN;
  const target = 1 / rt;
  const k = phit ** m0 / a;
  const dc = 1 / rwb - 1 / rwf;
  const f = (swt) => k * swt ** n0 * (1 / rwf + (swb * dc) / swt) - target;
  const df = (swt) => k * (n0 * swt ** (n0 - 1) / rwf + (n0 - 1) * swb * dc * swt ** (n0 - 2));
  return solveSw(f, df);
}

/**
 * Bardon & Pied (1969) modified Simandoux:
 *   1/Rt = phi^m*Sw^n/(a*Rw*(1-Vsh)) + Vsh*Sw/Rsh
 * Implicit for general n. Reduces exactly to Archie at Vsh = 0;
 * Vsh >= 1 leaves no clean term and returns NaN.
 */
export function swModSimandoux(rt, phi, rw, vsh, rsh, a = 1, m = 2, n = 2) {
  if (!Number.isFinite(rt) || !Number.isFinite(phi) || !Number.isFinite(vsh)) return NaN;
  if (rt <= 0 || phi <= 0 || vsh >= 1) return NaN;
  const target = 1 / rt;
  const c = phi ** m / (a * rw * (1 - vsh));
  const d = vsh / rsh;
  const f = (sw) => c * sw ** n + d * sw - target;
  const df = (sw) => c * n * sw ** (n - 1) + d;
  return solveSw(f, df);
}
