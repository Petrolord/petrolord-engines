// Multi-mineral solver, stage one (Petrophysics Studio PT11d, 2026-09-10).
// Density, neutron and photoelectric factor solved SIMULTANEOUSLY for
// three mineral fractions plus porosity with a fixed fluid, as a linear
// system per sample. Shared engine conventions (see vsh.js): pure,
// float64, no I/O, no silent defaults; the endpoint table is explicit
// and the caller (the Studio) shows every value in play.
//
// Formulation (Doveton 1994, "Geologic Log Analysis Using Computer
// Methods", AAPG Computer Applications in Geology 2, ch. 3, the
// determined-system case): unknowns v1, v2, v3, phi with
//   rhob = sum(vi rho_i) + phi rho_f
//   nphi = sum(vi n_i)   + phi n_f
//   U    = sum(vi U_i)   + phi U_f        U = Pe * rho_e, the volumetric
//                                         photoelectric absorption index,
//                                         rho_e = (rho_b + 0.1883)/1.0704
//                                         (matrix.js uMaa, chart-book)
//   1    = v1 + v2 + v3 + phi
// U is used rather than Pe because U mixes linearly by volume and Pe
// does not. Neutron endpoints are apparent limestone-porosity readings
// in 100 percent mineral (the density-neutron chart assumption; the
// three main minerals come from crossplot.js ND_LITHOLOGY_LINES so one
// constant owns them). Photoelectric endpoints from the Schlumberger Log
// Interpretation Charts mineral table (quartz 1.81, calcite 5.08,
// dolomite 3.14, anhydrite 5.05, halite 4.65 b/e); clay is a user row
// because clay endpoints vary by clay type.
//
// A determined system has zero fit residual, so the stage-one RESIDUAL
// is the excursion: the largest amount by which any fraction leaves the
// zero to one range (0 for an accepted sample). The tool-space misfit
// arrives with stage two (weighted least squares over the same table).
// Refusals (per sample, structured): flag 1 singular (pivot below 1e-12,
// the twoMineralSolve guard), flag 2 a fraction or phi outside zero to
// one beyond 1e-9, flag 3 a missing input. Refused samples carry NaN
// fractions; `unclamped` keeps the raw solution because a negative
// volume is information the UI can chart (matrix.js). Not suited to:
// clay-rich rock (no bound water; clay endpoints vary), gas-bearing
// intervals (the fluid is fixed), heavy minerals, pyrite and barite mud
// (Pe dominated), coal, washed-out hole, more than three minerals.
//
// Stage two (planned, PT11e): the table schema carries optional `sigma`
// per tool and optional `dt` / `gr` columns, unused here, so a weighted
// least-squares fit is additive.

import { solveDense } from '../../lib/linalg/solveDense';
import { phiDensity } from './porosity';
import { twoMineralSolve } from './matrix';
import { ND_LITHOLOGY_LINES } from './crossplot';

/** Chart-book electron density from bulk density (matrix.js uMaa). */
export const rhoElectron = (rhob) => (rhob + 0.1883) / 1.0704;
/** A mineral's U from its Pe and grain density. */
export const uOf = (pe, rho) => pe * rhoElectron(rho);

const ndOf = (name) => ND_LITHOLOGY_LINES.find((l) => l.name === name).pts[0].x;

/**
 * Published endpoint defaults. `nphi` in limestone-porosity units, `pe`
 * in b/e, `u` derived (b/cc). `sigma`, `dt`, `gr` reserved for stage two.
 * The Studio copies this table and lets the user edit it; the copy in
 * play rides in provenance.
 */
export const MINERAL_ENDPOINTS = Object.freeze({
  quartz: Object.freeze({ label: 'Quartz (sandstone)', rho: 2.65, nphi: ndOf('Sandstone'), pe: 1.81, dt: 182, gr: 15 }),
  calcite: Object.freeze({ label: 'Calcite (limestone)', rho: 2.71, nphi: ndOf('Limestone'), pe: 5.08, dt: 155, gr: 10 }),
  dolomite: Object.freeze({ label: 'Dolomite', rho: 2.87, nphi: ndOf('Dolomite'), pe: 3.14, dt: 143, gr: 10 }),
  anhydrite: Object.freeze({ label: 'Anhydrite', rho: 2.98, nphi: -0.01, pe: 5.05, dt: 164, gr: 5 }),
  halite: Object.freeze({ label: 'Halite', rho: 2.03, nphi: -0.03, pe: 4.65, dt: 220, gr: 0 }),
  // a user row: illite-like defaults, to be edited per well
  clay: Object.freeze({ label: 'Clay (edit per well)', rho: 2.55, nphi: 0.30, pe: 3.45, dt: 300, gr: 120 }),
});

/** Fresh-water fluid defaults (rho, nphi in limestone units, U 0.398 b/cc as in uMaa). */
export const FLUID_DEFAULT = Object.freeze({ rho: 1.0, nphi: 1.0, u: 0.398 });

/** Endpoint row with `u` filled in from pe and rho when absent. */
export function withU(row) {
  if (!row) return row;
  return Number.isFinite(row.u) ? row : { ...row, u: uOf(row.pe, row.rho) };
}

export const MINERAL_FLAGS = Object.freeze({ 0: 'accepted', 1: 'singular', 2: 'out of range', 3: 'missing input' });
const RANGE_TOL = 1e-9;

/**
 * One sample. `tools = { rhob, nphi, pef }`; `model = { minerals: [m1, m2,
 * m3], fluid }`, each mineral `{ rho, nphi, pe | u }`, fluid `{ rho, nphi, u }`.
 * Dispatch by mineral count: one mineral is phiDensity itself (byte match
 * by construction), two minerals with density and neutron are
 * twoMineralSolve, three are the 4 by 4 system.
 * @returns {{ ok: boolean, v: number[], phi: number, residual: number, flag: number, reason: string|null, unclamped: {v: number[], phi: number}|null }}
 */
export function solveMineralSample(tools, model) {
  const minerals = (model?.minerals || []).map(withU);
  const fluid = withU({ ...FLUID_DEFAULT, ...(model?.fluid || {}) });
  const k = minerals.length;
  const nan = (flag, reason) => ({ ok: false, v: new Array(k).fill(NaN), phi: NaN, residual: NaN, flag, reason, unclamped: null });
  if (!k || k > 3) return nan(1, `The solver takes one to three minerals; ${k} given.`);
  const { rhob, nphi, pef } = tools || {};
  if (!Number.isFinite(rhob)) return nan(3, 'Bulk density is missing at this sample.');

  let v;
  let phi;
  if (k === 1) {
    phi = phiDensity(rhob, minerals[0].rho, fluid.rho);
    if (!Number.isFinite(phi)) return nan(3, 'Bulk density is missing at this sample.');
    v = [1 - phi];
  } else if (k === 2) {
    if (!Number.isFinite(nphi)) return nan(3, 'Neutron porosity is missing at this sample.');
    const r = twoMineralSolve(rhob, nphi, { m1: minerals[0], m2: minerals[1], fluid });
    if (!Number.isFinite(r.v1)) return nan(1, 'The two minerals are not separable on density and neutron.');
    v = [r.v1, r.v2];
    phi = r.phi;
  } else {
    if (!Number.isFinite(nphi)) return nan(3, 'Neutron porosity is missing at this sample.');
    if (!Number.isFinite(pef)) return nan(3, 'PEF is missing at this sample.');
    const u = pef * rhoElectron(rhob);
    const a = [
      [minerals[0].rho, minerals[1].rho, minerals[2].rho, fluid.rho],
      [minerals[0].nphi, minerals[1].nphi, minerals[2].nphi, fluid.nphi],
      [minerals[0].u, minerals[1].u, minerals[2].u, fluid.u],
      [1, 1, 1, 1],
    ];
    let x;
    try {
      x = solveDense(a, [rhob, nphi, u, 1]);
    } catch {
      return nan(1, 'The mineral set is singular on density, neutron and PEF: two endpoints coincide or one equals the fluid.');
    }
    if (!x.every(Number.isFinite)) return nan(1, 'The mineral set is singular on density, neutron and PEF.');
    v = x.slice(0, 3);
    [, , , phi] = x;
  }
  const all = [...v, phi];
  let excursion = 0;
  for (const f of all) excursion = Math.max(excursion, -f, f - 1);
  const unclamped = { v: [...v], phi };
  if (excursion > RANGE_TOL) {
    return {
      ok: false, v: new Array(k).fill(NaN), phi: NaN, residual: excursion, flag: 2,
      reason: `A fraction leaves zero to one by ${excursion.toFixed(3)}: the sample does not fit this mineral set.`,
      unclamped,
    };
  }
  return { ok: true, v, phi, residual: 0, flag: 0, reason: null, unclamped };
}

/**
 * Per-sample loop over the well: `curves = { RHOB, NPHI, PEF }` (Float
 * arrays on the shared grid). Outputs `V_<KEY>` per mineral (the model's
 * `key`, upper-cased), `PHI_MM`, `MM_RES`, `MM_FLAG` and counts.
 * @returns {{ outputs: Object<string, Float64Array>, counts: {accepted:number, singular:number, outOfRange:number, missing:number}, worstExcursion: number }}
 */
export function solveMineralCurves(curves, model) {
  const n = curves.RHOB ? curves.RHOB.length : (curves.DEPT ? curves.DEPT.length : 0);
  const minerals = model.minerals || [];
  const names = minerals.map((m, i) => `V_${String(m.key || m.label || `M${i + 1}`).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`);
  const outputs = {};
  for (const nm of names) outputs[nm] = new Float64Array(n).fill(NaN);
  outputs.PHI_MM = new Float64Array(n).fill(NaN);
  outputs.MM_RES = new Float64Array(n).fill(NaN);
  outputs.MM_FLAG = new Float64Array(n).fill(3);
  const counts = { accepted: 0, singular: 0, outOfRange: 0, missing: 0 };
  let worstExcursion = 0;
  for (let i = 0; i < n; i++) {
    const r = solveMineralSample({ rhob: curves.RHOB?.[i], nphi: curves.NPHI?.[i], pef: curves.PEF?.[i] }, model);
    outputs.MM_FLAG[i] = r.flag;
    outputs.MM_RES[i] = r.residual;
    if (r.ok) {
      counts.accepted += 1;
      names.forEach((nm, j) => { outputs[nm][i] = r.v[j]; });
      outputs.PHI_MM[i] = r.phi;
    } else if (r.flag === 1) counts.singular += 1;
    else if (r.flag === 2) { counts.outOfRange += 1; if (r.residual > worstExcursion) worstExcursion = r.residual; } else counts.missing += 1;
  }
  return { outputs, names, counts, worstExcursion };
}
