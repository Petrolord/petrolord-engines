// Water saturation models (Petrophysics Studio G2.1). Shared engine
// conventions in vsh.js: UNCLAMPED cores (Sw > 1 is information —
// wrong parameters, bad hole; the UI flags it), NaN on invalid input
// (the legacy library's silent Sw=1 default is deliberately gone).
// Every parameter explicit; a/m/n defaults are the classic carbonate
// set (a=1, m=n=2) and the UI always displays what's applied.

/** Archie (1942): Sw = ((a*Rw)/(phi^m*Rt))^(1/n). */
export function swArchie(rt, phi, rw, a = 1, m = 2, n = 2) {
  if (!(rt > 0) || !(phi > 0) || !(rw > 0)) return NaN;
  return ((a * rw) / (phi ** m * rt)) ** (1 / n);
}

/** Simandoux (1963), classic form (n=2 inherent in the quadratic):
 *  1/Rt = phi^m*Sw^2/(a*Rw) + Vsh*Sw/Rsh — positive root. Degenerates
 *  exactly to Archie (n=2) at Vsh=0. */
export function swSimandoux(rt, phi, rw, vsh, rsh, a = 1, m = 2) {
  if (!(rt > 0) || !(phi > 0) || !(rw > 0) || !(rsh > 0) || !Number.isFinite(vsh)) return NaN;
  const c = phi ** m / (a * rw);
  const d = vsh / rsh;
  return (-d + Math.sqrt(d * d + (4 * c) / rt)) / (2 * c);
}

/** Poupon & Leveaux (1971) 'Indonesia':
 *  1/sqrt(Rt) = (Vsh^(1-Vsh/2)/sqrt(Rsh) + phi^(m/2)/sqrt(a*Rw))*Sw^(n/2).
 *  Degenerates exactly to Archie at Vsh=0. */
export function swIndonesia(rt, phi, rw, vsh, rsh, a = 1, m = 2, n = 2) {
  if (!(rt > 0) || !(phi > 0) || !(rw > 0) || !(rsh > 0) || !Number.isFinite(vsh)) return NaN;
  const termSh = vsh > 0 ? vsh ** (1 - 0.5 * vsh) / Math.sqrt(rsh) : 0;
  const termPhi = phi ** (m / 2) / Math.sqrt(a * rw);
  return ((1 / Math.sqrt(rt)) / (termSh + termPhi)) ** (2 / n);
}

export const SW_METHODS = { archie: swArchie, simandoux: swSimandoux, indonesia: swIndonesia };

/**
 * Curve-level Sw. vsh may be omitted for archie.
 * @param {{rt: ArrayLike<number>, phi: ArrayLike<number>, vsh?: ArrayLike<number>}} curves
 * @param {{method: 'archie'|'simandoux'|'indonesia', rw: number, rsh?: number,
 *          a?: number, m?: number, n?: number}} p
 * @returns {Float64Array}
 */
export function swCurve({ rt, phi, vsh }, { method, rw, rsh, a = 1, m = 2, n = 2 }) {
  if (!SW_METHODS[method]) throw new Error(`Unknown Sw method "${method}".`);
  if (method !== 'archie' && !vsh) throw new Error(`${method} needs a Vsh curve.`);
  const out = new Float64Array(rt.length);
  for (let k = 0; k < rt.length; k++) {
    if (method === 'archie') out[k] = swArchie(rt[k], phi[k], rw, a, m, n);
    else if (method === 'simandoux') out[k] = swSimandoux(rt[k], phi[k], rw, vsh[k], rsh, a, m);
    else out[k] = swIndonesia(rt[k], phi[k], rw, vsh[k], rsh, a, m, n);
  }
  return out;
}
