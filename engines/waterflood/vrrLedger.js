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

// ============================================================================
// V3: pressure track + fill-up + correlation-free FVF interpolation
// ============================================================================

// Fractional month coordinate of a date string: whole months since year 0
// plus a deterministic within-month fraction of (day-1)/31. Pure string
// arithmetic (no Date parsing) so locale/timezone can never move a survey.
// Returns null when unparseable.
export function monthCoordOf(date) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(String(date ?? ''));
  if (!m) return null;
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return null;
  const day = m[3] ? parseInt(m[3], 10) : 1;
  return parseInt(m[1], 10) * 12 + (month - 1) + (day - 1) / 31;
}

// Attach reservoir pressure to monthly periods by linear interpolation of
// survey points onto each period's mid-month coordinate, clamped flat
// outside the survey range. Also computes dp/dt in psi/month (central
// difference over the attached pressures; one-sided at the ends).
//
// `periods` needs only YYYY-MM labels (works on buildFieldPeriods output
// or a computeVRRSeries result); `surveys` is [{date, p_psia}]. Periods
// whose label is not a YYYY-MM month, or an empty/invalid survey set,
// yield pressure: null / dpdt: null — the UI gates on that, honestly.
export function attachPressure(periods, surveys) {
  const pts = (surveys || [])
    .map((s) => ({ t: monthCoordOf(s.date), p: parseFloat(s.p_psia) }))
    .filter((s) => s.t != null && Number.isFinite(s.p))
    .sort((a, b) => a.t - b.t);

  const pressureAt = (t) => {
    if (t == null || !pts.length) return null;
    if (t <= pts[0].t) return pts[0].p;
    if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].p;
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i].t) {
        const a = pts[i - 1];
        const b = pts[i];
        return b.t === a.t ? b.p : a.p + ((b.p - a.p) * (t - a.t)) / (b.t - a.t);
      }
    }
    return pts[pts.length - 1].p;
  };

  const coords = periods.map((p) => {
    const c = monthCoordOf(p.label);
    return c == null ? null : c - (c % 1) + 0.5; // mid-month
  });
  const pressures = coords.map((c) => pressureAt(c));

  return periods.map((p, i) => {
    let dpdt = null;
    if (pressures[i] != null) {
      const prev = i > 0 && pressures[i - 1] != null ? i - 1 : i;
      const next = i < pressures.length - 1 && pressures[i + 1] != null ? i + 1 : i;
      if (next !== prev && coords[next] != null && coords[prev] != null && coords[next] !== coords[prev]) {
        dpdt = (pressures[next] - pressures[prev]) / (coords[next] - coords[prev]);
      }
    }
    return { ...p, pressure: pressures[i], dpdt };
  });
}

// Fill-up marker: the first period whose cumulative VRR reaches 1.0.
// Returns { index, label, startedAbove } — startedAbove is true when the
// record's first defined cumulative VRR is already >= 1 (data begins
// mid-flood, so the crossing itself is not in the record) — or null when
// cumulative VRR never reaches 1.
export function findFillUp(series) {
  let firstDefined = -1;
  for (let i = 0; i < series.length; i++) {
    const v = series[i].cumulativeVRR;
    if (v == null || !Number.isFinite(v)) continue;
    if (firstDefined === -1) firstDefined = i;
    if (v >= 1) {
      return { index: i, label: series[i].label, startedAbove: i === firstDefined };
    }
  }
  return null;
}

// Correlation-free FVF track: linearly interpolate a caller-supplied PVT
// table [{p, Bo, Bw, Bg, Rs}] onto an array of pressures (clamped flat
// outside the table range). Null pressures map to null entries. This keeps
// the engine free of black-oil correlations — the Suite derives tables
// from its PVT kit and hands only numbers across.
export function interpolateFvfTrack(fvfTable, pressures) {
  const table = (fvfTable || [])
    .map((r) => ({ p: parseFloat(r.p), Bo: parseFloat(r.Bo), Bw: parseFloat(r.Bw), Bg: parseFloat(r.Bg), Rs: parseFloat(r.Rs) }))
    .filter((r) => Number.isFinite(r.p))
    .sort((a, b) => a.p - b.p);
  if (!table.length) return (pressures || []).map(() => null);

  const lerp = (a, b, f) => (Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * f : Number.isFinite(a) ? a : b);
  const pick = ({ Bo, Bw, Bg, Rs }) => ({ Bo, Bw, Bg, Rs });

  return (pressures || []).map((pRaw) => {
    const p = parseFloat(pRaw);
    if (!Number.isFinite(p)) return null;
    if (p <= table[0].p) return pick(table[0]);
    if (p >= table[table.length - 1].p) return pick(table[table.length - 1]);
    for (let i = 1; i < table.length; i++) {
      if (p <= table[i].p) {
        const a = table[i - 1];
        const b = table[i];
        const f = b.p === a.p ? 0 : (p - a.p) / (b.p - a.p);
        return { Bo: lerp(a.Bo, b.Bo, f), Bw: lerp(a.Bw, b.Bw, f), Bg: lerp(a.Bg, b.Bg, f), Rs: lerp(a.Rs, b.Rs, f) };
      }
    }
    return pick(table[table.length - 1]);
  });
}

// ============================================================================
// V4: injector->producer allocation factors + pattern-level VRR + advice
// ============================================================================
//
// allocation shape: { [injectorWell]: { [producerWell]: fraction } }.
// Each injector row should sum to <= 1.0; the shortfall is out-of-zone /
// unallocated injection (a real, reportable quantity, not an error).
// Fractions are the operator's judgement (streamline/CRM/geometric) — this
// module never invents them: with no allocation defined, pattern analyses
// are WITHHELD with a reason, never faked as even splits.

// Validate an allocation matrix. Row sums above 1 (beyond float noise) are
// errors; below 1 is a warning (out-of-zone remainder), negative or
// non-finite fractions are errors.
export function validateAllocation(allocation) {
  const errors = [];
  const warnings = [];
  const rowSums = {};
  Object.entries(allocation || {}).forEach(([inj, row]) => {
    let sum = 0;
    Object.entries(row || {}).forEach(([prod, frac]) => {
      const f = parseFloat(frac);
      if (!Number.isFinite(f) || f < 0) {
        errors.push(`${inj} -> ${prod}: fraction "${frac}" is not a number >= 0.`);
        return;
      }
      sum += f;
    });
    rowSums[inj] = sum;
    if (sum > 1 + 1e-9) errors.push(`${inj}: allocation fractions sum to ${sum.toFixed(3)} (> 1).`);
    else if (sum > 0 && sum < 1 - 1e-9) warnings.push(`${inj}: fractions sum to ${sum.toFixed(3)}; the remaining ${(1 - sum).toFixed(3)} counts as out-of-zone.`);
  });
  return { ok: errors.length === 0, errors, warnings, rowSums };
}

const allocFrac = (allocation, inj, prod) => {
  const f = parseFloat(allocation?.[inj]?.[prod]);
  return Number.isFinite(f) && f > 0 ? f : 0;
};

// Total allocated injection per producer (whole record) plus the
// unallocated remainder — the conservation audit behind the matrix editor:
// sum(perProducer) + unallocated == total injected, exactly.
export function allocateInjection(rows, allocation) {
  const validation = validateAllocation(allocation);
  const perProducer = {};
  const unallocated = { winj_stb: 0, ginj_mscf: 0 };
  rows.forEach((r) => {
    const wi = num(r.winj_stb);
    const gi = num(r.ginj_mscf);
    if (wi <= 0 && gi <= 0) return;
    const injRow = allocation?.[String(r.well ?? '').trim()] || {};
    let allocatedFrac = 0;
    Object.keys(injRow).forEach((prod) => {
      const f = allocFrac(allocation, String(r.well).trim(), prod);
      if (f <= 0) return;
      allocatedFrac += f;
      if (!perProducer[prod]) perProducer[prod] = { winj_stb: 0, ginj_mscf: 0 };
      perProducer[prod].winj_stb += wi * f;
      perProducer[prod].ginj_mscf += gi * f;
    });
    const rest = Math.max(0, 1 - allocatedFrac);
    unallocated.winj_stb += wi * rest;
    unallocated.ginj_mscf += gi * rest;
  });
  return { perProducer, unallocated, validation };
}

// Does any allocation fraction land on this pattern's producers?
export function patternHasAllocation(pattern, allocation) {
  const producers = new Set(pattern?.producers || []);
  return Object.values(allocation || {}).some((row) =>
    Object.entries(row || {}).some(([prod, frac]) => producers.has(prod) && parseFloat(frac) > 0));
}

// Monthly periods for one pattern: production summed over the pattern's
// producers; injection = allocation-weighted share of every injector's
// volumes landing on those producers. Same shape as buildFieldPeriods, so
// the untouched computeVRRSeries consumes it directly. When every
// injector row sums to 1 and one pattern holds all producers, the pattern
// periods equal the field periods exactly (jest-pinned invariant).
export function buildPatternPeriods(rows, pattern, allocation) {
  const producers = new Set(pattern?.producers || []);
  const byMonth = new Map();
  const ensure = (key) => {
    if (!byMonth.has(key)) byMonth.set(key, { label: key, Np: 0, Wp: 0, Gp: 0, Wi: 0, Gi: 0 });
    return byMonth.get(key);
  };
  rows.forEach((r) => {
    const key = monthKeyOf(r.date);
    if (!key) return;
    const well = String(r.well ?? '').trim();
    if (producers.has(well)) {
      const p = ensure(key);
      p.Np += num(r.oil_stb);
      p.Wp += num(r.water_stb);
      p.Gp += num(r.gas_mscf);
    }
    const wi = num(r.winj_stb);
    const gi = num(r.ginj_mscf);
    if (wi > 0 || gi > 0) {
      let intoPattern = 0;
      producers.forEach((prod) => { intoPattern += allocFrac(allocation, well, prod); });
      if (intoPattern > 0) {
        const p = ensure(key);
        p.Wi += wi * intoPattern;
        p.Gi += gi * intoPattern;
      }
    }
  });
  return Array.from(byMonth.values()).sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

// Recommendation scale caps: a suggested step change beyond these is
// operationally implausible — the scale is clamped and the clamp reported.
const SCALE_MIN = 0.5;
const SCALE_MAX = 2.0;

// Water-injection advice for one pattern: scale recent allocated injection
// by target/current rolling VRR (the recommendInjection philosophy at
// monthly, allocation-aware resolution). Gas injection is reported but not
// scaled — gas-injection targets are compression-constrained decisions the
// ledger cannot see. Withheld (never faked) when the pattern has no
// allocation or no produced voidage in the window.
export function recommendPatternInjection(rows, pattern, allocation, fvf, opts = {}) {
  const targetVRR = num(opts.targetVRR) > 0 ? num(opts.targetVRR) : 1.0;
  const windowPeriods = Math.max(1, Math.floor(num(opts.windowPeriods) || 3));

  if (!patternHasAllocation(pattern, allocation)) {
    return { withheld: true, reason: `No allocation factors route injection to "${pattern?.name ?? 'this pattern'}" — define the injector-producer split first; even splits are never assumed.` };
  }
  const periods = buildPatternPeriods(rows, pattern, allocation);
  if (!periods.length) {
    return { withheld: true, reason: 'No dated rows fall in this pattern.' };
  }
  const series = computeVRRSeries(periods, fvf);
  const rolling = computeRollingVRR(series, windowPeriods);
  const currentVRR = rolling[rolling.length - 1];
  if (currentVRR == null || currentVRR <= 0) {
    return { withheld: true, reason: 'No produced voidage (or no injection) in the rolling window — nothing to scale against.' };
  }

  const rawScale = targetVRR / currentVRR;
  const scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, rawScale));
  const clamped = scale !== rawScale;

  const start = Math.max(0, series.length - windowPeriods);
  const windowLabels = new Set(series.slice(start).map((p) => p.label));
  const nWindow = windowLabels.size || 1;
  const producers = new Set(pattern?.producers || []);

  const byInjector = new Map();
  rows.forEach((r) => {
    const key = monthKeyOf(r.date);
    if (!key || !windowLabels.has(key)) return;
    const well = String(r.well ?? '').trim();
    const wi = num(r.winj_stb);
    if (wi <= 0) return;
    let intoPattern = 0;
    producers.forEach((prod) => { intoPattern += allocFrac(allocation, well, prod); });
    if (intoPattern <= 0) return;
    byInjector.set(well, (byInjector.get(well) || 0) + wi * intoPattern);
  });

  const perInjector = Array.from(byInjector.entries()).map(([well, total]) => {
    const currentWi = total / nWindow; // allocated bbl/period into this pattern
    return { well, currentWi, recommendedWi: currentWi * scale, deltaWi: currentWi * (scale - 1) };
  }).sort((a, b) => b.currentWi - a.currentWi);

  const avgWi = series.slice(start).reduce((s, p) => s + p.Wi, 0) / nWindow;

  return {
    withheld: false,
    currentVRR,
    targetVRR,
    scale,
    clamped,
    windowPeriods: nWindow,
    currentWi: avgWi,
    recommendedWi: avgWi * scale,
    perInjector,
  };
}

// Re-exported so ledger consumers keep a single import surface.
export { computePeriodVoidage, computeVRRSeries };
