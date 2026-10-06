// Granular-medium rock physics models (QI programme Q2, Milestone A).
// Forms as published in Mavko, Mukerji & Dvorkin, The Rock Physics Handbook
// (2nd ed., 2009), sections 4.1 (Hashin-Shtrikman), 5.4 (Hertz-Mindlin and
// the soft-sand and stiff-sand models), 5.4 / Dvorkin & Nur (1996) (contact
// cement), Avseth et al. (2000; QSI 2005) (constant cement), and Brie et al.
// (1995) (patchy saturation). Validated against an independent oracle and
// published implementations (tools/validation/rockphysics/oracle_granular.py).
//
// SI throughout: moduli in Pa, pressure in Pa, densities in kg/m3. Porosity
// and fractions in [0, 1]. Unphysical inputs THROW with the reason.

const isPos = (x) => Number.isFinite(x) && x > 0;

function checkMineral(K, G) {
  if (!isPos(K) || !(Number.isFinite(G) && G >= 0)) throw new Error('Mineral moduli must be positive (shear may be zero for a fluid).');
}

/** Poisson's ratio from bulk and shear moduli. */
export function poisson(K, G) {
  return (3 * K - 2 * G) / (2 * (3 * K + G));
}

/** zeta(K, G) of the Hashin-Shtrikman-Walpole shear bound. */
export function hsZeta(K, G) {
  return (G / 6) * ((9 * K + 8 * G) / (K + 2 * G));
}

/**
 * Hashin-Shtrikman-Walpole bounds for any number of isotropic phases
 * (RPH 4.1.12): K+ = Lambda(Gmax), K- = Lambda(Gmin),
 * G+ = Gamma(zeta(Kmax, Gmax)), G- = Gamma(zeta(Kmin, Gmin)).
 * @param {{K:number, G:number, f:number}[]} phases fractions summing to 1
 * @returns {{kUpper:number, kLower:number, gUpper:number, gLower:number}}
 */
export function hashinShtrikman(phases) {
  if (!Array.isArray(phases) || phases.length === 0) throw new Error('Give at least one phase.');
  const sum = phases.reduce((a, p) => a + p.f, 0);
  if (Math.abs(sum - 1) > 1e-9) throw new Error(`Phase fractions must sum to 1 (got ${sum}).`);
  for (const p of phases) {
    if (!(p.f >= 0)) throw new Error('Phase fractions must be non-negative.');
    if (!(p.K >= 0) || !(p.G >= 0)) throw new Error('Phase moduli must be non-negative.');
  }
  const live = phases.filter((p) => p.f > 0);
  const Kmax = Math.max(...live.map((p) => p.K));
  const Kmin = Math.min(...live.map((p) => p.K));
  const Gmax = Math.max(...live.map((p) => p.G));
  const Gmin = Math.min(...live.map((p) => p.G));
  const Lambda = (z) => 1 / live.reduce((a, p) => a + p.f / (p.K + (4 / 3) * z), 0) - (4 / 3) * z;
  const Gamma = (z) => 1 / live.reduce((a, p) => a + p.f / (p.G + z), 0) - z;
  return {
    kUpper: Lambda(Gmax),
    kLower: Lambda(Gmin),
    gUpper: Gamma(hsZeta(Kmax, Gmax)),
    // a fluid phase (G = 0) gives zeta = 0, and 1 / (f / 0) = 0: the lower
    // shear bound is then 0, as it must be
    gLower: Gamma(hsZeta(Kmin, Gmin)),
  };
}

/**
 * Hertz-Mindlin moduli of a dry random pack of identical spheres at
 * critical porosity (RPH 5.4.1-5.4.2). f is the fraction of grain contacts
 * with no slip (1: all no-slip, the classic form; 0: all frictionless).
 * @param {{K:number, G:number, phiC:number, n:number, P:number, f?:number}} p
 */
export function hertzMindlin({ K, G, phiC, n, P, f = 1 }) {
  checkMineral(K, G);
  if (!(phiC > 0 && phiC < 1)) throw new Error('Critical porosity must be in (0, 1).');
  if (!isPos(n)) throw new Error('Coordination number must be positive.');
  if (!(Number.isFinite(P) && P >= 0)) throw new Error('Effective pressure must be zero or positive.');
  if (!(f >= 0 && f <= 1)) throw new Error('The no-slip fraction must be in [0, 1].');
  const nu = poisson(K, G);
  const base = (n * n * (1 - phiC) ** 2 * G * G * P) / (Math.PI * Math.PI * (1 - nu) ** 2);
  const khm = Math.cbrt(base / 18);
  const ghm = ((2 + 3 * f - nu * (1 + 3 * f)) / (5 * (2 - nu))) * Math.cbrt((3 * base) / 2);
  return { K: khm, G: ghm };
}

function checkPhi(phi, phiEnd, label) {
  if (!(phi >= 0 && phi <= phiEnd)) throw new Error(`Porosity must be between 0 and the ${label} (${phiEnd}).`);
}

/**
 * Soft-sand (friable sand, unconsolidated) dry moduli: the modified lower
 * Hashin-Shtrikman bound between the Hertz-Mindlin pack at critical porosity
 * and the mineral point (RPH 5.4.5; Dvorkin & Nur 1996).
 */
export function softSand({ K, G, phi, phiC, n, P, f = 1 }) {
  const hm = hertzMindlin({ K, G, phiC, n, P, f });
  checkPhi(phi, phiC, 'critical porosity');
  const a = phi / phiC;
  const kdry = 1 / (a / (hm.K + (4 / 3) * hm.G) + (1 - a) / (K + (4 / 3) * hm.G)) - (4 / 3) * hm.G;
  const z = hsZeta(hm.K, hm.G);
  const gdry = 1 / (a / (hm.G + z) + (1 - a) / (G + z)) - z;
  return { K: kdry, G: gdry };
}

/**
 * Stiff-sand dry moduli: the modified upper Hashin-Shtrikman bound between the
 * same two end points (RPH 5.4.6).
 */
export function stiffSand({ K, G, phi, phiC, n, P, f = 1 }) {
  const hm = hertzMindlin({ K, G, phiC, n, P, f });
  checkPhi(phi, phiC, 'critical porosity');
  const a = phi / phiC;
  const kdry = 1 / (a / (hm.K + (4 / 3) * G) + (1 - a) / (K + (4 / 3) * G)) - (4 / 3) * G;
  const z = hsZeta(K, G);
  const gdry = 1 / (a / (hm.G + z) + (1 - a) / (G + z)) - z;
  return { K: kdry, G: gdry };
}

/**
 * Dvorkin-Nur (1996) contact-cement dry moduli: cement added to a pack at
 * initial porosity phi0 reduces porosity to phi. scheme 'contact' puts the
 * cement at the grain contacts; 'surface' coats the grains evenly
 * (RPH 5.4.7-5.4.10).
 * @param {{K:number, G:number, Kc:number, Gc:number, phi:number, phi0:number, n:number, scheme?:'contact'|'surface'}} p
 */
export function contactCement({ K, G, Kc, Gc, phi, phi0, n, scheme = 'surface' }) {
  checkMineral(K, G);
  if (!isPos(Kc) || !isPos(Gc)) throw new Error('Cement moduli must be positive.');
  if (!(phi0 > 0 && phi0 < 1)) throw new Error('Initial (pack) porosity must be in (0, 1).');
  checkPhi(phi, phi0, 'initial pack porosity');
  if (!isPos(n)) throw new Error('Coordination number must be positive.');
  const nu = poisson(K, G);
  const nuc = poisson(Kc, Gc);
  const d = phi0 - phi;
  let alpha;
  if (scheme === 'contact') alpha = 2 * ((d / (3 * n * (1 - phi0))) ** 0.25);
  else if (scheme === 'surface') alpha = Math.sqrt((2 * d) / (3 * (1 - phi0)));
  else throw new Error("scheme must be 'contact' or 'surface'.");
  const lamN = (2 * Gc * (1 - nu) * (1 - nuc)) / (Math.PI * G * (1 - 2 * nuc));
  const lamT = Gc / (Math.PI * G);
  const An = -0.024153 * lamN ** -1.3646;
  const Bn = 0.20405 * lamN ** -0.89008;
  const Cn = 0.00024649 * lamN ** -1.9864;
  const At = -1e-2 * (2.26 * nu * nu + 2.07 * nu + 2.3) * lamT ** (0.079 * nu * nu + 0.1754 * nu - 1.342);
  const Bt = (0.0573 * nu * nu + 0.0937 * nu + 0.202) * lamT ** (0.0274 * nu * nu + 0.0529 * nu - 0.8765);
  const Ct = 1e-4 * (9.654 * nu * nu + 4.945 * nu + 3.1) * lamT ** (0.01867 * nu * nu + 0.4011 * nu - 1.8186);
  const Sn = An * alpha * alpha + Bn * alpha + Cn;
  const St = At * alpha * alpha + Bt * alpha + Ct;
  const Mc = Kc + (4 / 3) * Gc;
  const kdry = (n * (1 - phi0) * Mc * Sn) / 6;
  const gdry = (3 / 5) * kdry + (3 / 20) * n * (1 - phi0) * Gc * St;
  return { K: kdry, G: gdry };
}

/**
 * Constant-cement dry moduli (Avseth et al. 2000): sands of different
 * sorting that share one cement fraction. The contact-cement rock at the
 * well-sorted end porosity phiB is joined to the mineral point by the
 * modified lower Hashin-Shtrikman bound.
 */
export function constantCement({ K, G, Kc, Gc, phi, phiB, phi0, n, scheme = 'surface' }) {
  if (!(phiB > 0 && phiB <= phi0)) throw new Error('The cemented end porosity must be in (0, initial pack porosity].');
  checkPhi(phi, phiB, 'cemented end porosity');
  const b = contactCement({ K, G, Kc, Gc, phi: phiB, phi0, n, scheme });
  const a = phi / phiB;
  const kdry = 1 / (a / (b.K + (4 / 3) * b.G) + (1 - a) / (K + (4 / 3) * b.G)) - (4 / 3) * b.G;
  const z = hsZeta(b.K, b.G);
  const gdry = 1 / (a / (b.G + z) + (1 - a) / (G + z)) - z;
  return { K: kdry, G: gdry };
}

/**
 * Brie et al. (1995) effective fluid bulk modulus for patchy saturation:
 * K = (Kliquid - Kgas) * Sw^e + Kgas. e = 1 is the Voigt (patchy) limit;
 * large e approaches the Wood (uniform) limit.
 */
export function brieFluid({ kLiquid, kGas, sw, e = 3 }) {
  if (!isPos(kLiquid) || !isPos(kGas)) throw new Error('Fluid moduli must be positive.');
  if (!(sw >= 0 && sw <= 1)) throw new Error('Water saturation must be in [0, 1].');
  if (!(e >= 1)) throw new Error('The Brie exponent must be 1 or more.');
  return (kLiquid - kGas) * sw ** e + kGas;
}

/** Dry moduli to saturated velocities (Gassmann with the given fluid). */
export function dryToVelocities({ kdry, gdry, kmin, kfl, phi, rhoMin, rhoFl }) {
  if (!(phi > 0 && phi < 1)) throw new Error('Porosity must be in (0, 1).');
  const num = (1 - kdry / kmin) ** 2;
  const den = phi / kfl + (1 - phi) / kmin - kdry / (kmin * kmin);
  const ks = kdry + num / den;
  const rho = (1 - phi) * rhoMin + phi * rhoFl;
  return { vp: Math.sqrt((ks + (4 / 3) * gdry) / rho), vs: Math.sqrt(gdry / rho), rho, ksat: ks };
}

const MODELS = { soft: softSand, stiff: stiffSand };

/**
 * Calibrate the soft- or stiff-sand model to well data: grid-search the
 * coordination number that minimises the RMS misfit of predicted against
 * measured brine-saturated Vp and Vs (the dry model is Gassmann-saturated
 * with the given fluid). Returns the best n and the residual RMS in m/s.
 * atEdge is true when the best n sits on the end of the grid, so the true
 * optimum may lie outside it; the search never extrapolates.
 * @param {Object} p
 * @param {'soft'|'stiff'} p.model
 * @param {{phi:number, vp:number, vs:number}[]} p.samples measured, brine saturated
 * @param {{K:number, G:number, rho:number}} p.mineral
 * @param {{K:number, rho:number}} p.fluid
 * @param {number} p.phiC
 * @param {number} p.P
 * @param {number[]} [p.nGrid]
 */
export function calibrateGranular({ model, samples, mineral, fluid, phiC, P, nGrid = [4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20] }) {
  const fn = MODELS[model];
  if (!fn) throw new Error("model must be 'soft' or 'stiff'.");
  const usable = samples.filter((s) => s.phi > 0 && s.phi < phiC && isPos(s.vp) && isPos(s.vs));
  if (usable.length < 3) throw new Error('Need at least 3 samples with porosity below critical and both velocities.');
  let best = null;
  for (const n of nGrid) {
    let ss = 0;
    for (const s of usable) {
      const d = fn({ K: mineral.K, G: mineral.G, phi: s.phi, phiC, n, P });
      const v = dryToVelocities({ kdry: d.K, gdry: d.G, kmin: mineral.K, kfl: fluid.K, phi: s.phi, rhoMin: mineral.rho, rhoFl: fluid.rho });
      ss += (v.vp - s.vp) ** 2 + (v.vs - s.vs) ** 2;
    }
    const rms = Math.sqrt(ss / (2 * usable.length));
    if (!best || rms < best.rmsMs) best = { n, rmsMs: rms };
  }
  return { model, phiC, P, ...best, samples: usable.length, atEdge: best.n === nGrid[0] || best.n === nGrid[nGrid.length - 1] };
}
