// AVO reflectivity (Rock Physics Studio G6.1) — exact Zoeppritz PP
// (Dvorkin et al. 2014 expression form, complex past critical),
// Aki & Richards (1980) 3-term, Shuey (1985) 2-/3-term, and
// Rutherford & Williams (1989) + class IV classification. Validated
// against the rockphysics oracle goldens. SI units; angles in degrees.

// Minimal complex helpers (JS has no complex type). Only what
// Zoeppritz needs; sqrt of a real uses the Im >= 0 branch so
// evanescent transmitted waves decay (cmath.sqrt convention).
const C = (re, im = 0) => ({ re, im });
const add = (a, b) => C(a.re + b.re, a.im + b.im);
const sub = (a, b) => C(a.re - b.re, a.im - b.im);
const mul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const div = (a, b) => {
  const d = b.re * b.re + b.im * b.im;
  return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};
const scale = (a, s) => C(a.re * s, a.im * s);
const sqrtReal = (x) => (x >= 0 ? C(Math.sqrt(x)) : C(0, Math.sqrt(-x)));

function checkHalfspace(vp, vs, rho, side) {
  if (!(vp > 0) || !(vs > 0) || !(rho > 0)) {
    throw new Error(`${side} halfspace needs positive vp, vs and rho.`);
  }
  if (vs >= vp) throw new Error(`${side} halfspace has vs >= vp.`);
}

/** Exact Zoeppritz PP reflectivity, complex {re, im}. */
export function zoeppritzRpp(vp1, vs1, rho1, vp2, vs2, rho2, thetaDeg) {
  checkHalfspace(vp1, vs1, rho1, 'Upper');
  checkHalfspace(vp2, vs2, rho2, 'Lower');
  const th1 = (thetaDeg * Math.PI) / 180;
  const p = Math.sin(th1) / vp1;

  const sinPhi1 = p * vs1;
  const sinPhi2 = p * vs2;
  const cosTh1 = C(Math.cos(th1));
  const cosTh2 = sqrtReal(1 - (p * vp2) ** 2);
  const cosPhi1 = sqrtReal(1 - sinPhi1 * sinPhi1);
  const cosPhi2 = sqrtReal(1 - sinPhi2 * sinPhi2);

  const a = rho2 * (1 - 2 * sinPhi2 * sinPhi2) - rho1 * (1 - 2 * sinPhi1 * sinPhi1);
  const b = rho2 * (1 - 2 * sinPhi2 * sinPhi2) + 2 * rho1 * sinPhi1 * sinPhi1;
  const c = rho1 * (1 - 2 * sinPhi1 * sinPhi1) + 2 * rho2 * sinPhi2 * sinPhi2;
  const d = 2 * (rho2 * vs2 * vs2 - rho1 * vs1 * vs1);

  const ct1vp1 = scale(cosTh1, 1 / vp1);
  const ct2vp2 = scale(cosTh2, 1 / vp2);
  const cp1vs1 = scale(cosPhi1, 1 / vs1);
  const cp2vs2 = scale(cosPhi2, 1 / vs2);

  const e = add(scale(ct1vp1, b), scale(ct2vp2, c));
  const f = add(scale(cp1vs1, b), scale(cp2vs2, c));
  const g = sub(C(a), scale(mul(ct1vp1, cp2vs2), d));
  const h = sub(C(a), scale(mul(ct2vp2, cp1vs1), d));

  const den = add(mul(e, f), scale(mul(g, h), p * p));
  const num = sub(
    mul(f, sub(scale(ct1vp1, b), scale(ct2vp2, c))),
    scale(mul(h, add(C(a), scale(mul(ct1vp1, cp2vs2), d))), p * p),
  );
  return div(num, den);
}

/** Aki-Richards 3-term linearization (real). */
export function akiRichards(vp1, vs1, rho1, vp2, vs2, rho2, thetaDeg) {
  const th = (thetaDeg * Math.PI) / 180;
  const vp = 0.5 * (vp1 + vp2);
  const vs = 0.5 * (vs1 + vs2);
  const rho = 0.5 * (rho1 + rho2);
  const s = Math.sin(th) * (vp2 / vp1);
  if (s >= 1) throw new Error('Aki-Richards is undefined past the critical angle.');
  const thMean = 0.5 * (th + Math.asin(s));
  const sin2 = Math.sin(th) ** 2;
  const w = (vs / vp1) ** 2;
  return 0.5 * ((rho2 - rho1) / rho)
    - 2 * w * ((rho2 - rho1) / rho) * sin2
    + (0.5 * ((vp2 - vp1) / vp)) / Math.cos(thMean) ** 2
    - 4 * w * ((vs2 - vs1) / vs) * sin2;
}

/** Shuey (1985): returns {a, b, c, r} — intercept, gradient, curvature
 *  and R(theta) (3-term unless threeTerm=false). */
export function shuey(vp1, vs1, rho1, vp2, vs2, rho2, thetaDeg, { threeTerm = true } = {}) {
  const th = (thetaDeg * Math.PI) / 180;
  const vp = 0.5 * (vp1 + vp2);
  const vs = 0.5 * (vs1 + vs2);
  const rho = 0.5 * (rho1 + rho2);
  const dvp = vp2 - vp1;
  const dvs = vs2 - vs1;
  const drho = rho2 - rho1;
  const a = 0.5 * (dvp / vp + drho / rho);
  const b = 0.5 * (dvp / vp) - 2 * (vs / vp) ** 2 * (drho / rho + (2 * dvs) / vs);
  const c = 0.5 * (dvp / vp);
  let r = a + b * Math.sin(th) ** 2;
  if (threeTerm) r += c * (Math.tan(th) ** 2 - Math.sin(th) ** 2);
  return { a, b, c, r };
}

/**
 * The AVO class of a reflector top from Shuey's intercept A and gradient B:
 * the classes of Rutherford and Williams (1989), I to III, with class IV of
 * Castagna and Swan (1997). The one classifier for Rock Physics Studio and
 * QI Studio (engines/qi/avo.js re-exports it; owner decision 2026-10-12).
 *
 *   I    A above +t
 *   II   |A| at or below t (the near-zero intercept band, both edges included)
 *   III  A below -t and B at or below zero
 *   IV   A below -t and B above zero
 *
 * t is the class II band, 0.02 by default. Neither paper places a value lying
 * exactly on a border, so the convention is stated here: t is the largest |A|
 * still read as near zero, and class IV needs a gradient that is positive
 * (Castagna and Swan 1997: negative A with positive B, the amplitude falling
 * in magnitude with angle). A flat B = 0 below the band stays class III.
 * The third argument is the band, as a number or as { band }. Returns null
 * when A or B is not a finite number.
 */
export function avoClass(a, b, opts = 0.02) {
  const t = typeof opts === 'number' ? opts : (opts?.band ?? 0.02);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a > t) return 'I';
  if (a >= -t) return 'II';
  return b > 0 ? 'IV' : 'III';
}
