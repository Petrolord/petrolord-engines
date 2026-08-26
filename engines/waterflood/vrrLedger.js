// VRR ledger: per-well dated production/injection rows -> monthly field
// periods -> VRR series (V2 of the Voidage Replacement Monitor upgrade).
//
// This module is the data-shaping layer AROUND the oracle-stable VRR core:
// all voidage physics stays in vrr.js (computePeriodVoidage /
// computeVRRSeries are imported, never reimplemented), and vrr.js itself is
// left byte-stable. New capability lives here.
//
// Row schema (one row per well per date; daily or monthly rows both work —
// aggregation is by calendar month either way):
//   { date: 'YYYY-MM-DD' | 'YYYY-MM',  // string, ISO-ordered
//     well: string,
//     oil_stb:   number,   // oil produced, STB
//     water_stb: number,   // water produced, STB
//     gas_mscf:  number,   // gas produced, Mscf
//     winj_stb:  number,   // water injected, bbl
//     ginj_mscf: number }  // gas injected, Mscf
//
// Callers (the Suite importer) validate rows before they reach this module;
// defensively, non-finite volumes coerce to 0 and rows without a parseable
// YYYY-MM month key are ignored.

import { computePeriodVoidage, computeVRRSeries } from './vrr.js';

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// Calendar-month key of a row date ('YYYY-MM'), or null when unparseable.
// String prefix math, not Date parsing, so locale/timezone can never shift
// a volume into the wrong month.
export function monthKeyOf(date) {
  const m = /^(\d{4})-(\d{2})/.exec(String(date ?? ''));
  return m ? `${m[1]}-${m[2]}` : null;
}

// Classify wells from ledger rows. Injection wins: a well that ever injects
// (water OR gas — the ledger extends the daily surveillance rule to gas
// injectors) classifies as an injector even if it also produced (a
// converted well); otherwise any production makes it a producer.
export function classifyLedgerWells(rows) {
  const wells = new Map();
  rows.forEach((r) => {
    const name = String(r.well ?? '').trim();
    if (!name) return;
    if (!wells.has(name)) wells.set(name, { well: name, type: 'unknown' });
    const w = wells.get(name);
    if (num(r.winj_stb) > 0 || num(r.ginj_mscf) > 0) w.type = 'injector';
    else if ((num(r.oil_stb) > 0 || num(r.water_stb) > 0 || num(r.gas_mscf) > 0) && w.type !== 'injector') w.type = 'producer';
  });
  const injectors = [];
  const producers = [];
  wells.forEach((w) => {
    if (w.type === 'injector') injectors.push(w.well);
    else if (w.type === 'producer') producers.push(w.well);
  });
  return { wells, injectors, producers };
}

// Aggregate ledger rows into the ordered monthly field periods consumed by
// the untouched computeVRRSeries: [{label: 'YYYY-MM', Np, Wp, Gp, Wi, Gi}].
// Daily rows aggregate transparently (a month's periods are identical
// whether volumes arrive as one monthly row or thirty daily rows).
export function buildFieldPeriods(rows) {
  const byMonth = new Map();
  rows.forEach((r) => {
    const key = monthKeyOf(r.date);
    if (!key) return;
    if (!byMonth.has(key)) byMonth.set(key, { label: key, Np: 0, Wp: 0, Gp: 0, Wi: 0, Gi: 0 });
    const p = byMonth.get(key);
    p.Np += num(r.oil_stb);
    p.Wp += num(r.water_stb);
    p.Gp += num(r.gas_mscf);
    p.Wi += num(r.winj_stb);
    p.Gi += num(r.ginj_mscf);
  });
  return Array.from(byMonth.values()).sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

// Trailing rolling-window VRR over a computeVRRSeries result: for each
// period, sum(injectedVoidage) / sum(producedVoidage) over the last
// `windowPeriods` periods (partial windows at the start use what exists,
// the computeFieldVRR convention). Null (not 0) when the window produced
// no voidage, matching vrr.js semantics.
export function computeRollingVRR(series, windowPeriods = 3) {
  const w = Math.max(1, Math.floor(num(windowPeriods) || 1));
  return series.map((_, i) => {
    const start = Math.max(0, i - w + 1);
    let winProd = 0;
    let winInj = 0;
    for (let j = start; j <= i; j++) {
      winProd += series[j].producedVoidage;
      winInj += series[j].injectedVoidage;
    }
    return winProd > 0 ? winInj / winProd : null;
  });
}

// Per-period status against a configurable operator target band (the
// classifyVRR 0.9/1.1 bands are interpretation defaults and stay untouched;
// this is the operator-target layer). Returns 'under' | 'in-band' | 'over'
// per period, or null where instantaneous VRR is undefined.
export function flagPeriods(series, band = { min: 1.0, max: 1.2 }) {
  const min = num(band?.min ?? 1.0);
  const max = num(band?.max ?? 1.2);
  return series.map((p) => {
    const v = p.instantaneousVRR;
    if (v == null || !Number.isFinite(v)) return null;
    if (v < min) return 'under';
    if (v > max) return 'over';
    return 'in-band';
  });
}

// Convenience: full ledger analysis in one call (what the Suite context
// consumes). Pure function of (rows, fvf, settings).
export function analyzeLedger(rows, fvf, settings = {}) {
  const { injectors, producers } = classifyLedgerWells(rows);
  const periods = buildFieldPeriods(rows);
  const series = computeVRRSeries(periods, fvf);
  const rolling = computeRollingVRR(series, settings.rollingWindow ?? 3);
  const flags = flagPeriods(series, settings.targetBand);
  return { injectors, producers, periods, series, rolling, flags };
}

// Re-exported so ledger consumers keep a single import surface.
export { computePeriodVoidage, computeVRRSeries };
