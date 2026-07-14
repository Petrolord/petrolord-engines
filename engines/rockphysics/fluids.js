// Batzle-Wang 1992 pore-fluid properties (Rock Physics Studio G6.1).
// Validated against tools/validation/rockphysics goldens; constants
// cross-checked against bruges + equinor/open_petro_elastic (see
// test-data/rockphysics/README.md — note the brine-velocity S^2
// coefficient is -820, a commonly misquoted constant).
//
// Public API is SI (kg/m3, m/s, Pa). Internally the correlations run
// in the paper's native units: T degC, P MPa, rho g/cc, salinity as
// WEIGHT FRACTION NaCl, GOR in L/L. Domain errors throw (petrophysics
// NaN-not-silent-defaults discipline: bad PHYSICS throws, missing
// samples are the caller's NaN concern).

const GCC = 1000; // g/cc -> kg/m3

// Water velocity coefficients w[i][j] (BW eq 28, Table 1): sum over
// T^i * P^j.
const W = [
  [1402.85, 1.524, 3.437e-3, -1.197e-5],
  [4.871, -1.11e-2, 1.739e-4, -1.628e-6],
  [-4.783e-2, 2.747e-4, -2.135e-6, 1.237e-8],
  [1.487e-4, -6.503e-7, -1.455e-8, 1.327e-10],
  [-2.197e-7, 7.987e-10, 5.23e-11, -4.614e-13],
];

function checkTP(tC, pMPa) {
  if (!Number.isFinite(tC) || !Number.isFinite(pMPa) || pMPa <= 0) {
    throw new Error('Temperature (degC) and positive pressure (MPa) required.');
  }
}

/** Pure water density, g/cc (BW eq 27a). */
export function waterDensity(tC, pMPa) {
  const t = tC, p = pMPa;
  const x = -80 * t - 3.3 * t * t + 0.00175 * t ** 3 + 489 * p - 2 * t * p
    + 0.016 * t * t * p - 1.3e-5 * t ** 3 * p - 0.333 * p * p
    - 0.002 * t * p * p;
  return 1 + 1e-6 * x;
}

/** Pure water P velocity, m/s (BW eq 28). */
export function waterVelocity(tC, pMPa) {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 4; j++) v += W[i][j] * tC ** i * pMPa ** j;
  }
  return v;
}

/** Brine {rho, vp, k} SI (BW eqs 27b, 29). salinity = weight fraction NaCl. */
export function brine(tC, pMPa, salinity) {
  checkTP(tC, pMPa);
  if (!(salinity >= 0 && salinity < 0.5)) {
    throw new Error('Salinity must be a weight fraction in [0, 0.5).');
  }
  const t = tC, p = pMPa, s = salinity;
  const xr = 300 * p - 2400 * p * s + t * (80 + 3 * t - 3300 * s - 13 * p + 47 * p * s);
  const rho = (waterDensity(t, p) + s * (0.668 + 0.44 * s + 1e-6 * xr)) * GCC;
  const s1 = 1170 - 9.6 * t + 0.055 * t * t - 8.5e-5 * t ** 3 + 2.6 * p
    - 0.0029 * t * p - 0.0476 * p * p;
  const s15 = 780 - 10 * p + 0.16 * p * p;
  const vp = waterVelocity(t, p) + s * s1 + s ** 1.5 * s15 - 820 * s * s;
  return { rho, vp, k: rho * vp * vp };
}

/** Gas {rho, k} SI (BW eqs 9a, 10, 11). gravity = molar mass / air. */
export function gas(tC, pMPa, gravity) {
  checkTP(tC, pMPa);
  if (!(gravity > 0.5 && gravity < 2.5)) {
    throw new Error('Gas gravity must be in (0.5, 2.5).');
  }
  const ta = tC + 273.15;
  const tpr = ta / (94.72 + 170.75 * gravity);
  const ppr = pMPa / (4.892 - 0.4048 * gravity);
  const m = 0.45 + 8 * (0.56 - 1 / tpr) ** 2;
  const e = 0.109 * (3.85 - tpr) ** 2 * Math.exp(-m * ppr ** 1.2 / tpr);
  const c = 0.03 + 0.00527 * (3.5 - tpr) ** 3;
  const z = c * ppr + (0.642 * tpr - 0.007 * tpr ** 4 - 0.52) + e;
  const dzDppr = c - (e * m * 1.2 * ppr ** 0.2) / tpr;
  const rho = (28.8 * gravity * pMPa) / (z * 8.31441 * ta) * GCC;
  const gamma0 = 0.85 + 5.6 / (ppr + 2) + 27.1 / (ppr + 3.5) ** 2
    - 8.7 * Math.exp(-0.65 * (ppr + 1));
  const k = (gamma0 * pMPa) / (1 - (ppr * dzDppr) / z) * 1e6;
  return { rho, k };
}

/** API gravity -> reference density g/cc at 15.6 degC / atmospheric. */
export function apiToRho0(api) {
  if (!(api > 0 && api < 100)) throw new Error('API gravity must be in (0, 100).');
  return 141.5 / (api + 131.5);
}

function deadOilDensityGcc(t, p, rho0) {
  const rhoP = rho0 + (0.00277 * p - 1.71e-7 * p ** 3) * (rho0 - 1.15) ** 2
    + 3.49e-4 * p;
  return rhoP / (0.972 + 3.81e-4 * (t + 17.78) ** 1.175);
}

function deadOilVelocityMs(t, p, rho0) {
  return 2096 * Math.sqrt(rho0 / (2.6 - rho0)) - 3.7 * t + 4.64 * p
    + 0.0115 * (4.12 * Math.sqrt(1.08 / rho0 - 1) - 1) * t * p;
}

function checkRho0(rho0) {
  if (!(rho0 > 0.5 && rho0 < 1.15)) {
    throw new Error('Oil reference density must be in (0.5, 1.15) g/cc.');
  }
}

/** Dead (gas-free) oil {rho, vp, k} SI (BW eqs 18, 19, 20a). rho0 g/cc. */
export function deadOil(tC, pMPa, rho0) {
  checkTP(tC, pMPa);
  checkRho0(rho0);
  const rho = deadOilDensityGcc(tC, pMPa, rho0) * GCC;
  const vp = deadOilVelocityMs(tC, pMPa, rho0);
  return { rho, vp, k: rho * vp * vp };
}

/** Live (gas-saturated) oil {rho, vp, k} SI (BW eqs 22-24).
 *  gorLL = GOR in L/L; density is eq 24 as written (B0 carries the
 *  temperature dependence — the open_petro_elastic reading; see the
 *  goldens README), velocity is eq 20a on the eq-22 pseudo-density. */
export function liveOil(tC, pMPa, rho0, gorLL, gasGravity) {
  checkTP(tC, pMPa);
  checkRho0(rho0);
  if (!(gorLL >= 0)) throw new Error('GOR must be >= 0 L/L.');
  const b0 = 0.972 + 0.00038
    * (2.4 * gorLL * Math.sqrt(gasGravity / rho0) + tC + 17.8) ** 1.175;
  const rho = ((rho0 + 0.0012 * gasGravity * gorLL) / b0) * GCC;
  const rhoPseudo = rho0 / b0 / (1 + 0.001 * gorLL);
  const vp = deadOilVelocityMs(tC, pMPa, rhoPseudo);
  return { rho, vp, k: rho * vp * vp };
}

/** Reuss/Wood mixed fluid from {k, rho} phases and saturations. */
export function woodMix(phases) {
  const total = phases.reduce((s, ph) => s + ph.sat, 0);
  if (Math.abs(total - 1) > 1e-9) throw new Error('Saturations must sum to 1.');
  let inv = 0;
  let rho = 0;
  for (const ph of phases) {
    if (ph.sat < 0) throw new Error('Saturations must be >= 0.');
    if (ph.sat > 0) {
      if (!(ph.k > 0)) throw new Error('Phase moduli must be positive.');
      inv += ph.sat / ph.k;
    }
    rho += ph.sat * ph.rho;
  }
  return { k: 1 / inv, rho };
}
