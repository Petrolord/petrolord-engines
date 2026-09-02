// Matrix identification quicklooks (Petrophysics Studio PS10):
// apparent matrix density and volumetric cross-section, Thomas-Stieber
// shale-distribution diagnostics, and the exact 2-mineral
// density-neutron solve. Shared engine conventions (see vsh.js): pure,
// float64, NaN on invalid input, no I/O. Citations: Doveton (1994),
// "Geologic Log Analysis Using Computer Methods", AAPG Computer
// Applications in Geology 2; Thomas & Stieber (1975), SPE 4271.

/** Apparent matrix density (Doveton 1994):
 *  rho_maa = (rho_b - phi*rho_fl) / (1 - phi), phi = total porosity
 *  (the N-D apparent porosity in quicklook practice). */
export function rhoMaa(rhob, phi, rhoFl) {
  if (!Number.isFinite(rhob) || !Number.isFinite(phi) || phi >= 1) return NaN;
  return (rhob - phi * rhoFl) / (1 - phi);
}

/** Apparent matrix volumetric cross-section (Doveton 1994):
 *  U = Pe * rho_e with the chartbook electron-density conversion
 *  rho_e = (rho_b + 0.1883)/1.0704; U_maa = (U - phi*U_fl)/(1 - phi),
 *  U_fl 0.398 barns/cc for fresh water. */
export function uMaa(pef, rhob, phi, uFl = 0.398) {
  if (!Number.isFinite(pef) || !Number.isFinite(rhob) || !Number.isFinite(phi) || phi >= 1) return NaN;
  const rhoE = (rhob + 0.1883) / 1.0704;
  const u = pef * rhoE;
  return (u - phi * uFl) / (1 - phi);
}

/**
 * Thomas & Stieber (1975, SPE 4271) shale-distribution models: the
 * total porosity each end-member geometry predicts at this Vsh, given
 * the clean-sand porosity and the shale porosity, and which model the
 * measured porosity sits nearest.
 *   laminated:  phi = phiSand*(1 - Vsh) + phiSh*Vsh
 *   dispersed:  phi = phiSand - Vsh*(1 - phiSh)
 *   structural: phi = phiSand + Vsh*phiSh
 * @returns {{laminated: number, dispersed: number, structural: number,
 *            nearest: 'laminated'|'dispersed'|'structural'|null}}
 */
export function thomasStieber(phit, vsh, { phiSand, phiSh }) {
  if (!Number.isFinite(vsh)) {
    return { laminated: NaN, dispersed: NaN, structural: NaN, nearest: null };
  }
  const models = {
    laminated: phiSand * (1 - vsh) + phiSh * vsh,
    dispersed: phiSand - vsh * (1 - phiSh),
    structural: phiSand + vsh * phiSh,
  };
  let nearest = null;
  if (Number.isFinite(phit)) {
    let best = Infinity;
    for (const [name, value] of Object.entries(models)) {
      const d = Math.abs(phit - value);
      if (d < best) { best = d; nearest = name; }
    }
  }
  return { ...models, nearest };
}

/**
 * Exact 2-mineral density-neutron solve: v1 + v2 + phi = 1 with
 *   rhob = v1*rho1 + v2*rho2 + phi*rhoFl
 *   nphi = v1*n1  + v2*n2  + phi*nFl
 * (mineral neutron responses n1/n2 are the tools' apparent readings in
 * 100% mineral, e.g. sandstone ~ -0.02, dolomite ~ 0.02 on a
 * limestone-calibrated tool). Returns UNCLAMPED fractions — a negative
 * volume is information (the model does not fit); NaN when the mineral
 * pair is degenerate.
 * @returns {{v1: number, v2: number, phi: number}}
 */
export function twoMineralSolve(rhob, nphi, {
  m1: { rho: rho1, nphi: n1 },
  m2: { rho: rho2, nphi: n2 },
  fluid: { rho: rhoFl, nphi: nFl },
}) {
  if (!Number.isFinite(rhob) || !Number.isFinite(nphi)) return { v1: NaN, v2: NaN, phi: NaN };
  // substitute phi = 1 - v1 - v2 into both responses:
  const a11 = rho1 - rhoFl;
  const a12 = rho2 - rhoFl;
  const a21 = n1 - nFl;
  const a22 = n2 - nFl;
  const b1 = rhob - rhoFl;
  const b2 = nphi - nFl;
  const det = a11 * a22 - a12 * a21;
  if (Math.abs(det) < 1e-12) return { v1: NaN, v2: NaN, phi: NaN };
  const v1 = (b1 * a22 - b2 * a12) / det;
  const v2 = (a11 * b2 - a21 * b1) / det;
  return { v1, v2, phi: 1 - v1 - v2 };
}
