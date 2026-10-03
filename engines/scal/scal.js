/**
 * SCAL Studio engine (SC2) — Corey relative permeability + Leverett
 * J-function capillary pressure. Thin-real per the owner lock
 * (ReservoirEngineering-Module.md §4.2): no LET, no hysteresis, no Thomeer,
 * no three-phase models, no displacement math (Buckley-Leverett stays in
 * the Waterflood Design Studio).
 *
 * Dependency direction (locked): this module IMPORTS the Corey primitives
 * from fractionalFlowCalculations.js (shipped, golden-tested, consumed by
 * the Waterflood studio) and never the reverse, so Corey math stays defined
 * in exactly one place. Nonlinear fitting reuses the WTA
 * Levenberg-Marquardt kernel (lmFit.js: bounds + 95% CIs).
 *
 * Unit conventions (field units throughout):
 *   Pc               psi
 *   sigma (IFT)      dyn/cm       theta  degrees
 *   k                md           phi    fraction
 *   height h         ft           gammaW/gammaHc  specific gravity (water = 1)
 *
 * Leverett J-function:
 *   J(Sw) = LEVERETT_C * (Pc / (sigma*cos(theta))) * sqrt(k / phi)
 * LEVERETT_C = 0.21645 is the published field-unit constant (Tiab &
 * Donaldson, Petrophysics; also Amyx-Bass-Whiting). Deriving it from exact
 * CGS conversions (1 psi = 68947.6 dyn/cm^2; 1 md = 9.869233e-12 cm^2)
 * gives 0.21665 — a 0.09% difference. The PUBLISHED constant is adopted
 * verbatim; what matters downstream is the exact Pc <-> J round trip
 * through the same constant, which the jest suite pins at 1e-12.
 *
 * Height above free water level (field units):
 *   h_ft = Pc_psi / (0.4335 * (gammaW - gammaHc))
 * 0.4335 psi/ft is the fresh-water pressure gradient (same constant family
 * the fractional-flow gravity term uses).
 */
import { levenbergMarquardt } from '../../lib/welltest/lmFit.js';
import {
  coreyKr,
  krTableEndpoints,
  validateKrTable,
} from './fractionalFlow.js';

export const LEVERETT_C = 0.21645;
export const PSI_PER_FT_WATER = 0.4335;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ─────────────────────────────────────────────────────────────────────────────
// Corey curve sets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a Corey parameter set. phase: 'oilwater' | 'gasoil'.
 * Returns { ok, errors } with actionable messages.
 */
export function validateCoreyParams(p, phase = 'oilwater') {
  const errors = [];
  const between01 = (v, name, exclusive = false) => {
    if (!isNum(v) || v < 0 || v > 1 || (exclusive && (v === 0 || v === 1))) {
      errors.push(`${name} must be a fraction between 0 and 1.`);
    }
  };
  if (phase === 'gasoil') {
    between01(p?.Swc, 'Connate water saturation Swc');
    between01(p?.Sgc ?? 0, 'Critical gas saturation Sgc');
    between01(p?.Sorg, 'Residual oil to gas Sorg');
    if (isNum(p?.Swc) && isNum(p?.Sorg) && (p.Swc + (p.Sgc ?? 0) + p.Sorg >= 1)) {
      errors.push('Swc + Sgc + Sorg leaves no mobile gas saturation range.');
    }
    for (const [key, label] of [['krgMax', 'krg endpoint'], ['krogMax', 'krog endpoint']]) {
      if (!isNum(p?.[key]) || p[key] <= 0 || p[key] > 1) errors.push(`${label} must be in (0, 1].`);
    }
    for (const [key, label] of [['ng', 'Gas Corey exponent'], ['nog', 'Oil Corey exponent']]) {
      if (!isNum(p?.[key]) || p[key] < 0.5 || p[key] > 8) errors.push(`${label} must be between 0.5 and 8.`);
    }
  } else {
    between01(p?.Swc, 'Connate water saturation Swc');
    between01(p?.Sor, 'Residual oil saturation Sor');
    if (isNum(p?.Swc) && isNum(p?.Sor) && p.Swc + p.Sor >= 1) {
      errors.push('Swc + Sor leaves no mobile saturation range.');
    }
    for (const [key, label] of [['krwMax', 'krw endpoint'], ['kroMax', 'kro endpoint']]) {
      if (!isNum(p?.[key]) || p[key] <= 0 || p[key] > 1) errors.push(`${label} must be in (0, 1].`);
    }
    for (const [key, label] of [['nw', 'Water Corey exponent'], ['no', 'Oil Corey exponent']]) {
      if (!isNum(p?.[key]) || p[key] < 0.5 || p[key] > 8) errors.push(`${label} must be between 0.5 and 8.`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Sampled oil-water Corey set over the mobile range (fullRange false) or
 * the whole [0, 1] axis (fullRange true, endpoints flat outside the mobile
 * window — how the curves are drawn).
 * -> { rows: [{Sw, krw, kro}], endpoints: {Swc, Sor, krwMax, kroMax} }
 */
export function buildCoreyOilWater(p, { n = 101, fullRange = false } = {}) {
  const lo = fullRange ? 0 : p.Swc;
  const hi = fullRange ? 1 : 1 - p.Sor;
  const rows = [];
  for (let i = 0; i <= n; i++) {
    const Sw = lo + ((hi - lo) * i) / n;
    const { krw, kro } = coreyKr(Sw, p);
    rows.push({ Sw, krw, kro });
  }
  return { rows, endpoints: { Swc: p.Swc, Sor: p.Sor, krwMax: p.krwMax, kroMax: p.kroMax } };
}

/**
 * Gas-oil Corey point at gas saturation Sg (oil-gas system at connate
 * water; no three-phase model — thin-real lock):
 *   Sgn  = (Sg - Sgc) / (1 - Swc - Sorg - Sgc), clamped to [0, 1]
 *   krg  = krgMax * Sgn^ng
 *   krog = krogMax * (1 - Sgn)^nog
 */
export function coreyKrGasOil(Sg, p) {
  const { Swc, Sgc = 0, Sorg, krgMax, krogMax, ng, nog } = p;
  const denom = 1 - Swc - Sorg - Sgc;
  const Sgn = denom > 0 ? clamp01((Sg - Sgc) / denom) : 0;
  return {
    Sgn,
    krg: krgMax * Math.pow(Sgn, ng),
    krog: krogMax * Math.pow(1 - Sgn, nog),
  };
}

/** Sampled gas-oil Corey set over the mobile gas range. */
export function buildCoreyGasOil(p, { n = 101, fullRange = false } = {}) {
  const { Swc, Sgc = 0, Sorg } = p;
  const lo = fullRange ? 0 : Sgc;
  const hi = fullRange ? 1 - Swc : 1 - Swc - Sorg;
  const rows = [];
  for (let i = 0; i <= n; i++) {
    const Sg = lo + ((hi - lo) * i) / n;
    const { krg, krog } = coreyKrGasOil(Sg, p);
    rows.push({ Sg, krg, krog });
  }
  return { rows, endpoints: { Swc, Sgc, Sorg, krgMax: p.krgMax, krogMax: p.krogMax } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint (two-point) normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a kr table onto Swn = (Sw - Swc)/(1 - Swc - Sor) with curves
 * scaled by their own endpoint values (krwN = krw/krw_at_1-Sor,
 * kroN = kro/kro_at_Swc). This is how multiple core samples are compared
 * for exponent consistency. Denormalization onto target endpoints is the
 * existing scaleKrTable in fractionalFlowCalculations.
 * -> { rows: [{Swn, krwN, kroN}], endpoints }
 */
export function normalizeKrTable(rows, endpoints = null) {
  const { ok, errors, table } = validateKrTable(rows);
  if (!ok) return { ok: false, errors };
  const ep = endpoints ?? krTableEndpoints(table);
  const span = 1 - ep.Swc - ep.Sor;
  if (!(span > 0)) return { ok: false, errors: ['Swc + Sor leaves no mobile saturation range.'] };
  const krwMax = table[table.length - 1].krw;
  const kroMax = table[0].kro;
  if (!(krwMax > 0) || !(kroMax > 0)) {
    return { ok: false, errors: ['Endpoint kr values must be positive to normalize.'] };
  }
  return {
    ok: true,
    rows: table.map((r) => ({
      Swn: clamp01((r.Sw - ep.Swc) / span),
      krwN: r.krw / krwMax,
      kroN: r.kro / kroMax,
    })),
    endpoints: { ...ep, krwMax, kroMax },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Corey exponent fitting to lab kr data (Levenberg-Marquardt)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fit Corey exponents (and optionally endpoint kr values) to a lab kr
 * table. Residuals are joint log10 mismatches over BOTH curves so the
 * near-endpoint decades are not drowned by the high-kr points; rows with
 * either kr below krFloor are excluded from that curve's residuals (log of
 * a hard zero is not usable and endpoint zeros are definitional anyway).
 *
 * opts:
 *   fixedEndpoints  {Swc, Sor} stated by the caller. Without it Swc and Sor
 *                   are the first and last Sw of the table, which must then
 *                   carry krw = 0 and kro = 0 (validateKrTable). With it
 *                   (SCAL-U2-003) the table may stop short of either end
 *                   point: every row must lie inside [Swc, 1 - Sor], and an
 *                   end point kr the table does not reach is fitted.
 *   fitEndpoints    false -> theta = [nw, no] plus any end point kr the
 *                   table does not reach; true -> theta = [nw, no, krwMax,
 *                   kroMax] whatever the table holds
 *   krFloor         default 1e-4
 *
 * End point kr: krw at 1 - Sor is the table's last krw when its last Sw is
 * 1 - Sor (within 1e-6), and kro at Swc the first kro when its first Sw is
 * Swc; otherwise that value is a fitted parameter. `endpointSource` says
 * which, per end point ('table', 'entered' or 'fitted').
 *
 * -> { ok, params: {Swc, Sor, krwMax, kroMax, nw, no}, ci95: {nw, no,
 *      krwMax?, kroMax?}, endpointSource, rmsLog, r2Log, ssr, converged,
 *      iterations, pointsUsed } | { ok: false, errors }
 */
export function fitCoreyToKrTable(rows, opts = {}) {
  const { fixedEndpoints = null, fitEndpoints = false, krFloor = 1e-4 } = opts;
  const { ok, errors, table } = validateKrTable(rows, { requireEndpoints: !fixedEndpoints });
  if (!ok) return { ok: false, errors };
  if (fixedEndpoints && (!isNum(fixedEndpoints.Swc) || !isNum(fixedEndpoints.Sor)
    || fixedEndpoints.Swc < 0 || fixedEndpoints.Sor < 0)) {
    return { ok: false, errors: ['The stated Swc and Sor must both be fractions of at least 0.'] };
  }
  const ep = fixedEndpoints ? { Swc: fixedEndpoints.Swc, Sor: fixedEndpoints.Sor } : krTableEndpoints(table);
  if (!(1 - ep.Swc - ep.Sor > 0)) {
    return { ok: false, errors: ['Swc + Sor leaves no mobile saturation range.'] };
  }
  const first = table[0];
  const last = table[table.length - 1];
  const tol = 1e-6;
  if (fixedEndpoints) {
    if (first.Sw < ep.Swc - tol) {
      return { ok: false, errors: [`The table starts at Sw ${first.Sw}, below the stated Swc ${ep.Swc}: water cannot flow below Swc.`] };
    }
    if (last.Sw > 1 - ep.Sor + tol) {
      return { ok: false, errors: [`The table reaches Sw ${last.Sw}, above 1 - Sor (${1 - ep.Sor}): oil cannot flow above it.`] };
    }
  }
  const reachesLow = Math.abs(first.Sw - ep.Swc) <= tol;
  const reachesHigh = Math.abs(last.Sw - (1 - ep.Sor)) <= tol;
  const freeKrw = fitEndpoints || !reachesHigh;
  const freeKro = fitEndpoints || !reachesLow;
  const krwMaxTable = last.krw;
  const kroMaxTable = first.kro;
  if ((!freeKrw && !(krwMaxTable > 0)) || (!freeKro && !(kroMaxTable > 0))) {
    return { ok: false, errors: ['Endpoint kr values must be positive to fit.'] };
  }
  const krwStart = Math.min(1, Math.max(krwMaxTable, 1e-3));
  const kroStart = Math.min(1, Math.max(kroMaxTable, 1e-3));

  // Residual targets: (curve, Sw, log10 kr) for every usable lab point.
  const targets = [];
  for (const r of table) {
    if (r.krw > krFloor) targets.push({ curve: 'w', Sw: r.Sw, logKr: Math.log10(r.krw) });
    if (r.kro > krFloor) targets.push({ curve: 'o', Sw: r.Sw, logKr: Math.log10(r.kro) });
  }
  const nTheta = 2 + (freeKrw ? 1 : 0) + (freeKro ? 1 : 0);
  if (targets.length < nTheta + 2) {
    return { ok: false, errors: ['Too few usable lab points above the kr floor to fit.'] };
  }
  const iKrw = freeKrw ? 2 : -1;
  const iKro = freeKro ? (freeKrw ? 3 : 2) : -1;
  const paramsOf = (theta) => ({
    Swc: ep.Swc,
    Sor: ep.Sor,
    nw: theta[0],
    no: theta[1],
    krwMax: freeKrw ? theta[iKrw] : krwMaxTable,
    kroMax: freeKro ? theta[iKro] : kroMaxTable,
  });

  const residualsFn = (theta) => {
    const p = paramsOf(theta);
    return targets.map((t) => {
      const { krw, kro } = coreyKr(t.Sw, p);
      const model = t.curve === 'w' ? krw : kro;
      const safe = Math.max(model, 1e-12);
      return Math.log10(safe) - t.logKr;
    });
  };

  const theta0 = [2, 2];
  const bounds = [[0.5, 8], [0.5, 8]];
  if (freeKrw) { theta0.push(krwStart); bounds.push([1e-3, 1]); }
  if (freeKro) { theta0.push(kroStart); bounds.push([1e-3, 1]); }
  const lm = levenbergMarquardt(residualsFn, theta0, { bounds, maxIterations: 60 });

  const params = paramsOf(lm.theta);
  const m = targets.length;
  const rmsLog = Math.sqrt(lm.ssr / m);
  const meanLog = targets.reduce((s, t) => s + t.logKr, 0) / m;
  const sst = targets.reduce((s, t) => s + (t.logKr - meanLog) ** 2, 0);
  const r2Log = sst > 0 ? Math.max(0, 1 - lm.ssr / sst) : 0;
  const ci95 = {
    nw: lm.confidence95[0],
    no: lm.confidence95[1],
    ...(freeKrw ? { krwMax: lm.confidence95[iKrw] } : {}),
    ...(freeKro ? { kroMax: lm.confidence95[iKro] } : {}),
  };
  return {
    ok: true,
    params,
    ci95,
    endpointSource: {
      Swc: fixedEndpoints ? 'entered' : 'table',
      Sor: fixedEndpoints ? 'entered' : 'table',
      krwMax: freeKrw ? 'fitted' : 'table',
      kroMax: freeKro ? 'fitted' : 'table',
    },
    rmsLog,
    r2Log,
    ssr: lm.ssr,
    converged: lm.converged,
    iterations: lm.iterations,
    pointsUsed: m,
  };
}

/**
 * Fit a gas-oil Corey set to a lab table at connate water (SCAL-U2-004).
 * rows: [{Sg, krg, krog}]. The gas-oil Corey form is the oil-water form on
 * the gas axis: with Sw -> Sg, Swc -> Sgc, Sor -> Swc + Sorg, krw -> krg,
 * kro -> krog (coreyKrGasOil and coreyKr agree to rounding), so the fit is
 * fitCoreyToKrTable on the mapped table and nothing is fitted twice.
 *
 * opts:
 *   Swc             connate water of the test (required: a gas-oil table
 *                   alone cannot say it)
 *   fixedEndpoints  {Sgc, Sorg} stated by the caller; without it Sgc is the
 *                   first Sg and Sorg = 1 - Swc - last Sg
 *   fitEndpoints, krFloor as fitCoreyToKrTable
 *
 * -> { ok, params: {Swc, Sgc, Sorg, krgMax, krogMax, ng, nog}, ci95: {ng,
 *      nog, krgMax?, krogMax?}, endpointSource, rmsLog, r2Log, ssr,
 *      converged, iterations, pointsUsed } | { ok: false, errors }
 */
export function fitCoreyGasOilToKrTable(rows, opts = {}) {
  const { Swc, fixedEndpoints = null, fitEndpoints = false, krFloor = 1e-4 } = opts;
  if (!isNum(Swc) || Swc < 0 || Swc >= 1) {
    return { ok: false, errors: ['State the connate water saturation Swc of the gas-oil test (a fraction).'] };
  }
  const mapped = (rows ?? []).map((r) => ({ Sw: r?.Sg, krw: r?.krg, kro: r?.krog }));
  const v = validateKrTable(mapped, { requireEndpoints: !fixedEndpoints });
  if (!v.ok) {
    return {
      ok: false,
      errors: v.errors.map((e) => e
        .replace('krw at the lowest Sw should be 0 (connate water immobile).', 'krg at the lowest Sg should be 0 (gas immobile below Sgc).')
        .replace('kro at the highest Sw should be 0 (residual oil immobile).', 'krog at the highest Sg should be 0 (residual oil to gas immobile).')
        .replace('krw must be non-decreasing in Sw.', 'krg must be non-decreasing in Sg.')
        .replace('kro must be non-increasing in Sw.', 'krog must be non-increasing in Sg.')
        .replace('Sw/krw/kro', 'Sg/krg/krog')
        .replace('Duplicate Sw values.', 'Duplicate Sg values.')),
    };
  }
  if (fixedEndpoints && (!isNum(fixedEndpoints.Sgc) || !isNum(fixedEndpoints.Sorg))) {
    return { ok: false, errors: ['The stated Sgc and Sorg must both be fractions.'] };
  }
  const ep = fixedEndpoints
    ? { Swc: fixedEndpoints.Sgc, Sor: Swc + fixedEndpoints.Sorg }
    : { Swc: v.table[0].Sw, Sor: 1 - v.table[v.table.length - 1].Sw };
  if (ep.Sor - Swc < -1e-9) {
    return { ok: false, errors: [`The table reaches Sg ${v.table[v.table.length - 1].Sw}, above 1 - Swc (${1 - Swc}): there is no room for the stated connate water.`] };
  }
  const fit = fitCoreyToKrTable(mapped, { fixedEndpoints: ep, fitEndpoints, krFloor });
  if (!fit.ok) {
    return {
      ok: false,
      errors: fit.errors.map((e) => e.replace(/\bSw\b/g, 'Sg').replace('Swc + Sor', 'Swc + Sgc + Sorg').replace('below the stated Swc', 'below the stated Sgc').replace('above 1 - Sor', 'above 1 - Swc - Sorg')),
    };
  }
  const p = fit.params;
  return {
    ok: true,
    params: {
      Swc,
      Sgc: p.Swc,
      Sorg: Math.max(0, p.Sor - Swc),
      krgMax: p.krwMax,
      krogMax: p.kroMax,
      ng: p.nw,
      nog: p.no,
    },
    ci95: {
      ng: fit.ci95.nw,
      nog: fit.ci95.no,
      ...(fit.ci95.krwMax ? { krgMax: fit.ci95.krwMax } : {}),
      ...(fit.ci95.kroMax ? { krogMax: fit.ci95.kroMax } : {}),
    },
    endpointSource: {
      Sgc: fixedEndpoints ? 'entered' : 'table',
      Sorg: fixedEndpoints ? 'entered' : 'table',
      krgMax: fit.endpointSource.krwMax,
      krogMax: fit.endpointSource.kroMax,
    },
    rmsLog: fit.rmsLog,
    r2Log: fit.r2Log,
    ssr: fit.ssr,
    converged: fit.converged,
    iterations: fit.iterations,
    pointsUsed: fit.pointsUsed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Leverett J-function
// ─────────────────────────────────────────────────────────────────────────────

/** Validate rock/fluid sample properties used for J scaling. */
export function validateSampleProps(s) {
  const errors = [];
  if (!isNum(s?.k_md) || s.k_md <= 0) errors.push('Permeability k must be positive (md).');
  if (!isNum(s?.phi) || s.phi <= 0 || s.phi >= 1) errors.push('Porosity must be a fraction between 0 and 1.');
  if (!isNum(s?.sigma_dyncm) || s.sigma_dyncm <= 0) errors.push('Interfacial tension sigma must be positive (dyn/cm).');
  if (!isNum(s?.thetaDeg) || s.thetaDeg < 0 || s.thetaDeg >= 90) errors.push('Contact angle must be between 0 and 90 degrees.');
  return { ok: errors.length === 0, errors };
}

/** Validate a lab Pc table: Sw in (0,1], Pc >= 0, Pc non-increasing in Sw. */
export function validatePcTable(rows) {
  const errors = [];
  if (!Array.isArray(rows) || rows.length < 3) {
    return { ok: false, errors: ['A capillary pressure table needs at least 3 rows.'], table: [] };
  }
  const table = rows
    .map((r) => ({ Sw: Number(r.Sw), Pc_psi: Number(r.Pc_psi) }))
    .filter((r) => Number.isFinite(r.Sw) && Number.isFinite(r.Pc_psi))
    .sort((a, b) => a.Sw - b.Sw);
  if (table.length < 3) errors.push('Fewer than 3 numeric rows.');
  for (const r of table) {
    if (r.Sw <= 0 || r.Sw > 1) { errors.push('Sw values must be within (0, 1].'); break; }
  }
  if (table.some((r) => r.Pc_psi < 0)) errors.push('Pc values must not be negative.');
  for (let i = 1; i < table.length; i++) {
    if (table[i].Sw - table[i - 1].Sw < 1e-9) { errors.push('Duplicate Sw values.'); break; }
  }
  for (let i = 1; i < table.length; i++) {
    if (table[i].Pc_psi > table[i - 1].Pc_psi + 1e-9) {
      errors.push('Pc must be non-increasing in Sw (drainage curve).');
      break;
    }
  }
  return { ok: errors.length === 0, errors, table };
}

const sigmaCos = (sample) =>
  sample.sigma_dyncm * Math.cos((sample.thetaDeg * Math.PI) / 180);

/**
 * Lab Pc rows -> dimensionless J rows for one sample.
 * pcRows: [{Sw, Pc_psi}]; sample: {k_md, phi, sigma_dyncm, thetaDeg}.
 * -> { ok, rows: [{Sw, Pc_psi, J}] } | { ok: false, errors }
 */
export function computeJTable(pcRows, sample) {
  const sv = validateSampleProps(sample);
  if (!sv.ok) return { ok: false, errors: sv.errors };
  const pv = validatePcTable(pcRows);
  if (!pv.ok) return { ok: false, errors: pv.errors };
  const sc = sigmaCos(sample);
  const rootKphi = Math.sqrt(sample.k_md / sample.phi);
  return {
    ok: true,
    rows: pv.table.map((r) => ({
      Sw: r.Sw,
      Pc_psi: r.Pc_psi,
      J: LEVERETT_C * (r.Pc_psi / sc) * rootKphi,
    })),
  };
}

/**
 * Fit a power law J = a * Sw*^(-b) on normalized saturation
 * Sw* = (Sw - Swirr)/(1 - Swirr), with Swirr defaulting to just below the
 * lowest Sw in the data. Fit in log space via the LM kernel (uniform CI
 * API). Rows with J <= 0 are excluded (log). Thin by design: users whose
 * data will not power-law use the tabulated jSpec instead — no Thomeer, no
 * Brooks-Corey lambda machinery (thin-real lock).
 * -> { ok, a, b, Swirr, ci95: {a, b}, rmsLog, r2Log, converged } |
 *    { ok: false, errors }
 */
export function fitJPowerLaw(jRows, { Swirr = null } = {}) {
  const rows = (jRows ?? []).filter((r) => isNum(r.Sw) && isNum(r.J) && r.J > 0);
  if (rows.length < 3) return { ok: false, errors: ['Need at least 3 positive J points to fit.'] };
  const swMin = Math.min(...rows.map((r) => r.Sw));
  const swirr = isNum(Swirr) ? Swirr : Math.max(0, swMin - 0.02);
  if (swirr >= swMin) {
    return { ok: false, errors: ['Swirr must sit below the lowest Sw in the data.'] };
  }
  const targets = rows.map((r) => ({
    x: (r.Sw - swirr) / (1 - swirr),
    logJ: Math.log(r.J),
  }));
  // log J = log a - b * log Sw*  -> linear, but run through LM for the
  // uniform bounds + CI API (theta = [log a, b]).
  const residualsFn = (theta) => targets.map((t) => theta[0] - theta[1] * Math.log(t.x) - t.logJ);
  const lm = levenbergMarquardt(residualsFn, [0, 1], {
    bounds: [[-20, 20], [0.05, 10]],
    maxIterations: 60,
  });
  const m = targets.length;
  const meanLog = targets.reduce((s, t) => s + t.logJ, 0) / m;
  const sst = targets.reduce((s, t) => s + (t.logJ - meanLog) ** 2, 0);
  return {
    ok: true,
    a: Math.exp(lm.theta[0]),
    b: lm.theta[1],
    Swirr: swirr,
    ci95: {
      a: lm.confidence95[0].map((v) => Math.exp(v)),
      b: lm.confidence95[1],
    },
    rmsLog: Math.sqrt(lm.ssr / m),
    r2Log: sst > 0 ? Math.max(0, 1 - lm.ssr / sst) : 0,
    converged: lm.converged,
  };
}

/**
 * J evaluator from a spec:
 *   { type: 'power', a, b, Swirr }
 *   { type: 'table', rows: [{Sw, J}] }  (log-J linear interpolation, clamped
 *                                        ends — the makeKrFunction pattern)
 * -> { j: (Sw) => J, domain: {SwMin, SwMax} }
 */
export function makeJFunction(jSpec) {
  if (jSpec?.type === 'power') {
    const { a, b, Swirr } = jSpec;
    return {
      j: (Sw) => {
        const x = (Sw - Swirr) / (1 - Swirr);
        if (!(x > 0)) return Infinity;
        return a * Math.pow(x, -b);
      },
      domain: { SwMin: Swirr, SwMax: 1 },
    };
  }
  if (jSpec?.type === 'table') {
    const rows = [...(jSpec.rows ?? [])]
      .filter((r) => isNum(r.Sw) && isNum(r.J) && r.J > 0)
      .sort((a, b) => a.Sw - b.Sw);
    if (rows.length < 2) throw new Error('A tabulated J spec needs at least 2 positive rows.');
    const j = (Sw) => {
      if (Sw <= rows[0].Sw) return rows[0].J;
      const last = rows[rows.length - 1];
      if (Sw >= last.Sw) return last.J;
      let i = 1;
      while (rows[i].Sw < Sw) i++;
      const a = rows[i - 1];
      const b = rows[i];
      const t = (Sw - a.Sw) / (b.Sw - a.Sw);
      return Math.exp(Math.log(a.J) + t * (Math.log(b.J) - Math.log(a.J)));
    };
    return { j, domain: { SwMin: rows[0].Sw, SwMax: rows[rows.length - 1].Sw } };
  }
  throw new Error(`Unknown J spec type: ${jSpec?.type}`);
}

/**
 * Average J curves across samples: each sample's J rows are normalized to
 * Sw* with a shared Swirr (default: derived per sample from its own lowest
 * Sw), resampled onto a common Sw* grid via the tabulated evaluator, and
 * combined with a GEOMETRIC mean (J is log-distributed) plus min/max band.
 * A power-law fit of the mean curve is returned as the reservoir jSpec
 * candidate.
 * samples: [{ name, jRows: [{Sw, J}] }]
 * opts.Swirr: explicit irreducible saturation shared by all samples (the
 * Capillary tab's override). Without it each sample defaults to just below
 * its own lowest Sw — a convenience that distorts the Sw* axis when the
 * true Swirr sits lower; the refit r2Log tells the user when to override.
 * -> { ok, grid: [{SwStar, Jmean, Jmin, Jmax, count}], fit } |
 *    { ok: false, errors }
 */
export function averageJCurves(samples, { nGrid = 41, Swirr = null } = {}) {
  const prepared = [];
  for (const s of samples ?? []) {
    const rows = (s.jRows ?? []).filter((r) => isNum(r.Sw) && isNum(r.J) && r.J > 0);
    if (rows.length < 3) continue;
    const swMin = Math.min(...rows.map((r) => r.Sw));
    const swirr = isNum(Swirr) && Swirr < swMin ? Swirr : Math.max(0, swMin - 0.02);
    const starRows = rows
      .map((r) => ({ Sw: (r.Sw - swirr) / (1 - swirr), J: r.J }))
      .sort((a, b) => a.Sw - b.Sw);
    prepared.push({
      name: s.name,
      evaluator: makeJFunction({ type: 'table', rows: starRows }),
      min: starRows[0].Sw,
      max: starRows[starRows.length - 1].Sw,
    });
  }
  if (prepared.length === 0) {
    return { ok: false, errors: ['No sample carries at least 3 positive J points.'] };
  }
  const lo = Math.max(...prepared.map((p) => p.min));
  const hi = Math.min(...prepared.map((p) => p.max));
  if (!(hi > lo)) {
    return { ok: false, errors: ['The samples share no overlapping normalized saturation range.'] };
  }
  const grid = [];
  for (let i = 0; i <= nGrid - 1; i++) {
    const SwStar = lo + ((hi - lo) * i) / (nGrid - 1);
    const values = prepared.map((p) => p.evaluator.j(SwStar)).filter((v) => isNum(v) && v > 0);
    const logMean = values.reduce((s, v) => s + Math.log(v), 0) / values.length;
    grid.push({
      SwStar,
      Jmean: Math.exp(logMean),
      Jmin: Math.min(...values),
      Jmax: Math.max(...values),
      count: values.length,
    });
  }
  // Refit a power law on the mean curve (Sw* is already normalized, so the
  // fit runs with Swirr = 0 on rows keyed by Sw = Sw*).
  const fit = fitJPowerLaw(grid.map((g) => ({ Sw: g.SwStar, J: g.Jmean })), { Swirr: 0 });
  return { ok: true, grid, fit: fit.ok ? fit : null, sampleCount: prepared.length };
}

/**
 * Scale a J spec back to reservoir rock -> Pc(Sw) in psi.
 * NOTE for power-law specs: the spec's saturation axis is normalized Sw*
 * only when it came from averageJCurves (Swirr = 0 on the Sw* axis); a
 * fitJPowerLaw spec carries its own Swirr and evaluates on true Sw.
 * reservoir: {k_md, phi, sigma_dyncm, thetaDeg}.
 * -> { ok, rows: [{Sw, Pc_psi}] } | { ok: false, errors }
 */
export function pcFromJ(jSpec, reservoir, { n = 61, SwMin = null, SwMax = null } = {}) {
  const sv = validateSampleProps(reservoir);
  if (!sv.ok) return { ok: false, errors: sv.errors };
  const { j, domain } = makeJFunction(jSpec);
  const lo = isNum(SwMin) ? SwMin : Math.max(domain.SwMin + 1e-6, domain.SwMin * 1.001 + 1e-6);
  const hi = isNum(SwMax) ? SwMax : domain.SwMax;
  const sc = sigmaCos(reservoir);
  const factor = sc / (LEVERETT_C * Math.sqrt(reservoir.k_md / reservoir.phi));
  const rows = [];
  for (let i = 0; i <= n; i++) {
    const Sw = lo + ((hi - lo) * i) / n;
    const J = j(Sw);
    if (!isNum(J)) continue;
    rows.push({ Sw, Pc_psi: J * factor });
  }
  return { ok: true, rows };
}

// ─────────────────────────────────────────────────────────────────────────────
// Height above free water level
// ─────────────────────────────────────────────────────────────────────────────

/** h_ft = Pc / (0.4335 * (gammaW - gammaHc)); throws on non-positive density contrast. */
export function heightFromPc(Pc_psi, fluids) {
  const { gammaW, gammaHc } = fluids ?? {};
  if (!isNum(gammaW) || !isNum(gammaHc) || gammaW - gammaHc <= 0) {
    throw new Error('Height conversion needs specific gravities with gammaW greater than gammaHc.');
  }
  return Pc_psi / (PSI_PER_FT_WATER * (gammaW - gammaHc));
}

/**
 * Saturation-height profile: Sw grid -> Pc via pcFromJ -> h via
 * heightFromPc. Sorted by height ascending (FWL at h = 0).
 * -> { ok, rows: [{Sw, Pc_psi, h_ft}] } | { ok: false, errors }
 */
export function swVsHeight(jSpec, reservoir, fluids, opts = {}) {
  const pc = pcFromJ(jSpec, reservoir, opts);
  if (!pc.ok) return pc;
  try {
    const rows = pc.rows
      .map((r) => ({ ...r, h_ft: heightFromPc(r.Pc_psi, fluids) }))
      .sort((a, b) => a.h_ft - b.h_ft);
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV parsers (Lab Data tab)
// ─────────────────────────────────────────────────────────────────────────────

function parseCsvRows(text, headerMap) {
  const lines = String(text ?? '').trim().split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return { rows: [], errors: ['The CSV needs a header row and at least one data row.'] };
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idx = {};
  const errors = [];
  for (const [key, aliases] of Object.entries(headerMap)) {
    const at = headers.findIndex((h) => aliases.includes(h));
    if (at < 0) errors.push(`Missing column "${aliases[0]}" (accepted headers: ${aliases.join(', ')}).`);
    idx[key] = at;
  }
  if (errors.length) return { rows: [], errors };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const row = {};
    let bad = false;
    for (const key of Object.keys(headerMap)) {
      const v = Number(cells[idx[key]]);
      if (!Number.isFinite(v)) { bad = true; break; }
      row[key] = v;
    }
    if (bad) errors.push(`Row ${i + 1}: non-numeric value skipped.`);
    else rows.push(row);
  }
  return { rows, errors };
}

/** CSV headers: Sw, krw, kro (aliases accepted). */
export function parseKrCsv(text) {
  return parseCsvRows(text, {
    Sw: ['sw', 'sw_frac', 'water saturation'],
    krw: ['krw', 'kr_w'],
    kro: ['kro', 'kr_o'],
  });
}

/** CSV headers: Sw, Pc_psi (aliases accepted). */
export function parsePcCsv(text) {
  return parseCsvRows(text, {
    Sw: ['sw', 'sw_frac', 'water saturation'],
    Pc_psi: ['pc_psi', 'pc', 'capillary pressure'],
  });
}
