// Sand control engine (Drilling D8 — Perforation & Sand Control
// Designer): sieve statistics, Saucier gravel sizing, screen selection,
// completion-type advisor, and sanding-onset (critical drawdown)
// screening.
//
// Published bases:
//   * Sieve statistics: cumulative weight-percent RETAINED vs grain size
//     (the sand-control convention: D10 is the coarse decile). D-values
//     by log-linear interpolation on the retained curve; uniformity
//     C_u = D40/D90; fines = percent finer than 44 µm (325 mesh).
//   * Saucier (1974, SPE 4030): gravel D50 = 5-6 x formation D50.
//   * Gravel-pack screen: opening smaller than the smallest gravel grain
//     (the standard rule; the pack must not pass the screen).
//   * Standalone screen: Coberly-type D10 slot window (slot between D10
//     and 2·D10) with Tiffin et al. (SPE 39437)-style suitability
//     thresholds on C_u and fines.
//   * Sanding onset: Kirsch hoop stress at the cavity wall with the
//     near-wall pore pressure at flowing pressure (alpha = 1):
//       sigma_theta' = 3·S1 − S2 − 2·pwf
//     onset when sigma_theta' >= U = boostFactor·UCS, i.e.
//       pwf,crit = (3·S1 − S2 − U) / 2
//     SCREENING-GRADE by construction: boostFactor defaults to 1 and is
//     the knob a thick-walled-cylinder (TWC) calibration adjusts.
//
// UNITS: STRICT SI at the API (metres, Pa). Mesh/inch/psi displays live
// app-side; the gravel catalog carries mesh labels as data.
//
// Validation: independent numpy oracle (oracle_perfsand.py); jest gates
// in __tests__/drilling.perfsand.test.js; runner gates A26-A27.

import { tvdAt } from './wellControl.js';
import { GRAVEL_CATALOG, SCREEN_GAUGES_M } from './data/sandControlCatalog.js';

export const FINES_CUTOFF_M = 44e-6; // 325 US mesh

// ---- sieve statistics -------------------------------------------------------

const log = Math.log;

function interpSizeAtRetained(points, target) {
  // points sorted by cumRetainedPct ascending (coarse -> fine).
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (target >= a.cumRetainedPct && target <= b.cumRetainedPct) {
      if (b.cumRetainedPct === a.cumRetainedPct) return a.sizeM;
      const f = (target - a.cumRetainedPct) / (b.cumRetainedPct - a.cumRetainedPct);
      return Math.exp(log(a.sizeM) + f * (log(b.sizeM) - log(a.sizeM)));
    }
  }
  return null; // target outside the measured curve — honest null, no extrapolation
}

/**
 * points: [{ sizeM, cumRetainedPct }] in any order. Returns D-values
 * (metres, null when the curve does not reach the percentile), uniformity
 * C_u = D40/D90, sorting D10/D95, and fines percent (< 44 µm).
 */
export function sieveStats(pointsIn) {
  if (!Array.isArray(pointsIn) || pointsIn.length < 4) {
    throw new Error('Sieve analysis needs at least 4 points.');
  }
  const points = [...pointsIn]
    .map((p, i) => {
      if (!(p.sizeM > 0)) throw new Error(`Sieve point ${i + 1}: size must be positive.`);
      if (!(p.cumRetainedPct >= 0 && p.cumRetainedPct <= 100)) {
        throw new Error(`Sieve point ${i + 1}: cumulative retained must be 0-100%.`);
      }
      return { sizeM: p.sizeM, cumRetainedPct: p.cumRetainedPct };
    })
    .sort((a, b) => a.cumRetainedPct - b.cumRetainedPct);
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].sizeM > points[i - 1].sizeM) {
      throw new Error('Sieve curve must be monotone: size decreases as cumulative retained increases.');
    }
  }

  const d = {};
  for (const pct of [10, 40, 50, 70, 90, 95]) d[`d${pct}M`] = interpSizeAtRetained(points, pct);

  // Fines: percent finer than the 44 µm cutoff = 100 - retained(44 µm).
  let finesPct = null;
  const fine = points[points.length - 1];
  const coarse = points[0];
  if (coarse.sizeM <= FINES_CUTOFF_M) finesPct = 100 - coarse.cumRetainedPct;
  else if (fine.sizeM >= FINES_CUTOFF_M) finesPct = 100 - fine.cumRetainedPct;
  else {
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (FINES_CUTOFF_M <= a.sizeM && FINES_CUTOFF_M >= b.sizeM) {
        const f = (log(a.sizeM) - log(FINES_CUTOFF_M)) / (log(a.sizeM) - log(b.sizeM));
        finesPct = 100 - (a.cumRetainedPct + f * (b.cumRetainedPct - a.cumRetainedPct));
        break;
      }
    }
  }

  const uniformity = d.d40M != null && d.d90M != null ? d.d40M / d.d90M : null;
  const sorting = d.d10M != null && d.d95M != null ? d.d10M / d.d95M : null;
  return { ...d, uniformity, sorting, finesPct, points };
}

// ---- gravel + screens -------------------------------------------------------

export const SAUCIER_RANGE = [5, 6];

/** Saucier band and the commercial gravels whose pack D50 falls inside it. */
export function saucierGravel({ d50M }) {
  if (!(d50M > 0)) throw new Error('Formation D50 must be positive.');
  const bandMinM = SAUCIER_RANGE[0] * d50M;
  const bandMaxM = SAUCIER_RANGE[1] * d50M;
  const matches = GRAVEL_CATALOG.filter((g) => g.d50M >= bandMinM && g.d50M <= bandMaxM);
  let nearest = null;
  for (const g of GRAVEL_CATALOG) {
    const mid = (bandMinM + bandMaxM) / 2;
    if (!nearest || Math.abs(g.d50M - mid) < Math.abs(nearest.d50M - mid)) nearest = g;
  }
  return { bandMinM, bandMaxM, matches, nearest, noMatch: matches.length === 0 };
}

/**
 * Screen selection.
 *  mode 'gravel-pack': opening < smallest gravel grain of `gravel`
 *  (a GRAVEL_CATALOG row); recommends the largest standard gauge below it.
 *  mode 'standalone': Coberly-type slot window on the formation D10 with
 *  Tiffin-style suitability read from `stats` (sieveStats result).
 */
export function screenSelection({ mode, gravel = null, stats = null }) {
  if (mode === 'gravel-pack') {
    if (!gravel || !(gravel.minM > 0)) throw new Error('Gravel-pack screen selection needs a gravel catalog row.');
    const maxGaugeM = gravel.minM;
    const gauge = [...SCREEN_GAUGES_M].reverse().find((g) => g < maxGaugeM) ?? null;
    return {
      mode,
      maxGaugeM,
      gaugeM: gauge,
      rule: 'screen opening smaller than the smallest gravel grain',
      noGauge: gauge == null,
    };
  }
  if (mode === 'standalone') {
    if (!stats || !(stats.d10M > 0)) throw new Error('Standalone screen selection needs sieve stats with D10.');
    return {
      mode,
      slotMinM: stats.d10M,
      slotMaxM: 2 * stats.d10M,
      rule: 'Coberly-type window: slot between D10 and 2 x D10',
    };
  }
  throw new Error(`Unknown screen mode "${mode}".`);
}

// Tiffin et al. (SPE 39437)-style selection thresholds, screening grade.
export const ADVISOR_PROVENANCE = 'Tiffin et al. SPE 39437-style thresholds, '
  + 'screening grade; lab PSD + retained-permeability testing governs (L16).';

/** Ordered completion-type indication from uniformity + fines. */
export function sandControlAdvisor(stats) {
  const cu = stats.uniformity;
  const fines = stats.finesPct;
  if (cu == null || fines == null) {
    return {
      indication: 'insufficient sieve coverage',
      checks: [],
      provenance: ADVISOR_PROVENANCE,
    };
  }
  const checks = [
    { rule: 'C_u < 3 and fines < 2%', pass: cu < 3 && fines < 2, indication: 'standalone wire-wrap screen viable' },
    { rule: 'C_u < 5 and fines < 5%', pass: cu < 5 && fines < 5, indication: 'standalone premium screen viable' },
    { rule: 'C_u < 5 and fines < 10%', pass: cu < 5 && fines < 10, indication: 'gravel pack' },
    { rule: 'C_u >= 5 or fines >= 10%', pass: cu >= 5 || fines >= 10, indication: 'gravel pack with fines management / frac-pack evaluation' },
  ];
  const first = checks.find((c) => c.pass);
  return { indication: first.indication, uniformity: cu, finesPct: fines, checks, provenance: ADVISOR_PROVENANCE };
}

// ---- sanding onset ----------------------------------------------------------

/**
 * Screening critical flowing pressure at one depth. S1/S2 are the max/min
 * total far-field stresses in the plane normal to the cavity axis.
 * Onset when pwf <= pwfCritPa; no sanding risk at any drawdown when
 * pwfCritPa <= 0.
 */
export function sandingOnset({ s1Pa, s2Pa, ucsPa, boostFactor = 1 }) {
  if (!(s1Pa >= s2Pa)) throw new Error('Need S1 >= S2.');
  if (!(ucsPa > 0)) throw new Error('UCS must be positive.');
  if (!(boostFactor > 0)) throw new Error('Strength boost factor must be positive.');
  const uPa = boostFactor * ucsPa;
  const pwfCritPa = (3 * s1Pa - s2Pa - uPa) / 2;
  return { pwfCritPa, uPa, screeningGrade: true };
}

export const CAVITY_GEOMETRIES = ['perf-tunnel', 'openhole'];

/**
 * Critical-drawdown profile over a perforated interval. curves are the
 * gm-1.0.0/pp-1.0.0 grids: { tvdM[], svPa[], shmaxPa[], shminPa[],
 * ppPa[], ucsPa[] }. Geometry picks the cavity-normal stress pair:
 *   'perf-tunnel' (cased + perforated, worst-case tunnel azimuth):
 *       S1/S2 = max/min of (Sv, SHmax)
 *   'openhole' (vertical wellbore wall / standalone screen):
 *       S1/S2 = SHmax/SHmin
 * Returns rows { mdM, tvdM, ppPa, pwfCritPa, cdpPa } where
 * cdpPa = pp − pwfCrit (drawdown margin; negative = sanding indicated at
 * any drawdown), plus the governing (minimum-margin) row.
 */
export function cdpAlongInterval({
  stations, curves, topMdM, bottomMdM,
  geometry = 'perf-tunnel', boostFactor = 1, stepMdM = 10,
}) {
  if (!CAVITY_GEOMETRIES.includes(geometry)) throw new Error(`Unknown cavity geometry "${geometry}".`);
  if (!(bottomMdM > topMdM)) throw new Error('Interval bottom must be below top.');
  if (!(stepMdM > 0)) throw new Error('Step must be positive.');
  const grid = curves.tvdM;
  if (!grid?.length) throw new Error('Empty curve grid.');

  const at = (arr, tvd) => {
    if (tvd <= grid[0]) return arr[0];
    const last = grid.length - 1;
    if (tvd >= grid[last]) return arr[last];
    let i = 1;
    while (grid[i] < tvd) i += 1;
    const f = (tvd - grid[i - 1]) / (grid[i] - grid[i - 1]);
    return arr[i - 1] + f * (arr[i] - arr[i - 1]);
  };

  const rows = [];
  let governing = null;
  for (let md = topMdM; md <= bottomMdM + 1e-9; md += stepMdM) {
    const m = Math.min(md, bottomMdM);
    const tvd = tvdAt(stations, m);
    const sv = at(curves.svPa, tvd);
    const shmax = at(curves.shmaxPa, tvd);
    const shmin = at(curves.shminPa, tvd);
    const pp = at(curves.ppPa, tvd);
    const ucs = at(curves.ucsPa, tvd);
    const [s1, s2] = geometry === 'perf-tunnel'
      ? [Math.max(sv, shmax), Math.min(sv, shmax)]
      : [shmax, shmin];
    const { pwfCritPa } = sandingOnset({ s1Pa: s1, s2Pa: s2, ucsPa: ucs, boostFactor });
    const row = { mdM: m, tvdM: tvd, ppPa: pp, pwfCritPa, cdpPa: pp - pwfCritPa };
    rows.push(row);
    if (!governing || row.cdpPa < governing.cdpPa) governing = row;
    if (m >= bottomMdM) break;
  }
  return { rows, governing, geometry, boostFactor, screeningGrade: true };
}
