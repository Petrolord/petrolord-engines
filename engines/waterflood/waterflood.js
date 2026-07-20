// Waterflood Efficiency surveillance engine (client-side, pure functions).
//
// This replaces the former server "waterflood-engine" compute, which fabricated
// key analytics with Math.random() (pattern lags, injector recommendations) and
// used a placeholder pressure for the Hall plot. Those non-physical outputs are
// intentionally NOT reproduced here; they are gated in the UI until they can be
// derived from real data (P2). Everything this engine returns is a defensible,
// deterministic computation from the input rate history.
//
// The Voidage Replacement Ratio (VRR) core is UNIFIED with the VRR Monitor app:
// per-day voidage is computed with the same reservoir-barrel physics exported by
// `vrrCalculations.js` (only FREE produced gas adds voidage; solution gas is
// already carried in Bo). This keeps a single source of truth for waterflood
// pressure-maintenance surveillance across the Suite.
//
// Field units: oil (STB/d), water (bbl/d), inj (bbl/d), gas (Mscf/d);
// Bo, Bw in RB/STB(bbl); Bg in RB/Mscf; Rs (solution GOR) in scf/STB.

import { computePeriodVoidage, classifyVRR } from './vrr.js';

export const num = (v, fallback = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

// Column schema shown in the app's "Schema Help" dialog and used to validate input.
export const WATERFLOOD_SCHEMA = {
  required_columns: [
    { name: 'date', note: 'Date of record in YYYY-MM-DD format.' },
    { name: 'well', note: 'Unique identifier for the well.' },
  ],
  optional_columns: [
    { name: 'oil_bbl', note: 'Daily oil production (STB/d). Non-zero marks a PRODUCER.' },
    { name: 'water_bbl', note: 'Daily water production (bbl/d). Non-zero marks a PRODUCER.' },
    { name: 'gas_mcf', note: 'Daily gas production (Mscf/d). Feeds free-gas voidage when Bg & Rs are set.' },
    { name: 'inj_bbl', note: 'Daily water injection (bbl/d). Non-zero marks an INJECTOR.' },
    { name: 'whp_psi', note: 'Measured injection pressure (wellhead or bottomhole, psi) for injector rows. Enables the Hall plot / injectivity diagnostic.' },
  ],
  notes: [
    'The CSV must contain a header row.',
    'A well is an INJECTOR if it ever reports a non-zero `inj_bbl`.',
    'A well is a PRODUCER if it ever reports non-zero `oil_bbl` or `water_bbl`.',
    'Blank cells are treated as zero. Negative rates are zeroed and counted under data quality.',
    'Duplicate (date, well) rows are de-duplicated, keeping the first occurrence.',
    'VRR is computed in reservoir barrels. Set Bg (RB/Mscf) and Rs (scf/STB) to include free-gas voidage; leave Bg blank/0 to use liquid voidage only.',
    'Hall plot / injectivity diagnostics require `whp_psi` on injector rows; without it that analysis is withheld rather than estimated.',
  ],
};

// Trailing simple moving average (window in samples). Mirrors the daily cadence
// of the input series; window <= 1 returns a copy unchanged.
export function movingAverage(data, windowSize) {
  const w = Math.max(1, Math.floor(num(windowSize, 1)));
  if (w <= 1) return data.slice();
  const out = [];
  for (let i = 0; i < data.length; i++) {
    const start = Math.max(0, i - w + 1);
    const window = data.slice(start, i + 1);
    out.push(window.reduce((a, b) => a + b, 0) / window.length);
  }
  return out;
}

function toDateKey(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

// De-duplicate, sanitize and normalize raw rows into a clean, date-sorted set.
// Returns { rows, dataQuality } where dataQuality feeds the Data Quality panel.
export function cleanRows(rawRows, config = {}) {
  const dataQuality = {
    issues: [],
    duplicates_removed: 0,
    negatives_zeroed: 0,
    rows_in: rawRows.length,
    rows_out: 0,
  };

  const startKey = toDateKey(config.start_date);
  const endKey = toDateKey(config.end_date);

  const seen = new Map();
  let outOfRange = 0;
  let invalid = 0;

  rawRows.forEach((r) => {
    const dateKey = toDateKey(r.date);
    const well = (r.well ?? '').toString().trim();
    if (!dateKey || !well) {
      invalid++;
      return;
    }
    if ((startKey && dateKey < startKey) || (endKey && dateKey > endKey)) {
      outOfRange++;
      return;
    }
    const key = `${dateKey}|${well}`;
    if (seen.has(key)) {
      dataQuality.duplicates_removed++;
      return;
    }

    let oil = num(r.oil_bbl);
    let water = num(r.water_bbl);
    let gas = num(r.gas_mcf);
    let inj = num(r.inj_bbl);
    let negativeInRow = false;
    if (oil < 0) { oil = 0; negativeInRow = true; }
    if (water < 0) { water = 0; negativeInRow = true; }
    if (gas < 0) { gas = 0; negativeInRow = true; }
    if (inj < 0) { inj = 0; negativeInRow = true; }
    if (negativeInRow) dataQuality.negatives_zeroed++;

    // Injection pressure is optional and stays null when absent (a blank must not
    // be read as 0 psi, which would corrupt the Hall integral).
    const whpRaw = r.whp_psi;
    const whp = whpRaw != null && whpRaw !== '' && Number.isFinite(parseFloat(whpRaw))
      ? Math.max(0, parseFloat(whpRaw))
      : null;

    seen.set(key, { dateKey, well, oil, water, gas, inj, whp });
  });

  const rows = Array.from(seen.values()).sort((a, b) =>
    a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0
  );
  dataQuality.rows_out = rows.length;
  if (invalid > 0) dataQuality.issues.push(`${invalid} row(s) dropped for missing/invalid date or well.`);
  if (outOfRange > 0) dataQuality.issues.push(`${outOfRange} row(s) outside the selected date range were excluded.`);

  return { rows, dataQuality };
}

// Classify each well as injector / producer / unknown from its full history.
// Injection status wins (a converted producer that is now injecting is treated
// as an injector for surveillance).
export function classifyWells(rows) {
  const wells = new Map();
  rows.forEach((r) => {
    if (!wells.has(r.well)) wells.set(r.well, { well: r.well, type: 'unknown', data: [] });
    const w = wells.get(r.well);
    w.data.push(r);
    if (r.inj > 0) w.type = 'injector';
    else if ((r.oil > 0 || r.water > 0) && w.type !== 'injector') w.type = 'producer';
  });
  const injectors = [];
  const producers = [];
  wells.forEach((w) => {
    if (w.type === 'injector') injectors.push(w.well);
    else if (w.type === 'producer') producers.push(w.well);
  });
  return { wells, injectors, producers };
}

// Aggregate clean rows into a field-level daily series with smoothed variants.
export function aggregateDaily(rows, config = {}) {
  const byDate = new Map();
  rows.forEach((r) => {
    if (!byDate.has(r.dateKey)) {
      byDate.set(r.dateKey, { date: r.dateKey, oil_bpd: 0, water_bpd: 0, gas_mscf: 0, inj_bpd: 0 });
    }
    const d = byDate.get(r.dateKey);
    d.oil_bpd += r.oil;
    d.water_bpd += r.water;
    d.gas_mscf += r.gas;
    d.inj_bpd += r.inj;
  });

  const daily = Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
  daily.forEach((d) => {
    const liquid = d.oil_bpd + d.water_bpd;
    d.wc_pct = liquid > 0 ? (d.water_bpd / liquid) * 100 : 0;
  });

  const smooth = num(config.smooth_window_days, 1);
  return {
    date: daily.map((d) => d.date),
    oil_bpd: daily.map((d) => d.oil_bpd),
    water_bpd: daily.map((d) => d.water_bpd),
    gas_mscf: daily.map((d) => d.gas_mscf),
    inj_bpd: daily.map((d) => d.inj_bpd),
    wc_pct: daily.map((d) => d.wc_pct),
    oil_bpd_s: movingAverage(daily.map((d) => d.oil_bpd), smooth),
    water_bpd_s: movingAverage(daily.map((d) => d.water_bpd), smooth),
    inj_bpd_s: movingAverage(daily.map((d) => d.inj_bpd), smooth),
    wc_pct_s: movingAverage(daily.map((d) => d.wc_pct), smooth),
    _daily: daily,
  };
}

// Resolve the PVT/FVF set used for reservoir-barrel voidage from the config.
function resolveFvf(config = {}) {
  return {
    Bo: num(config.bo, 1.0),
    Bw: num(config.bw, 1.0),
    Bg: num(config.bg, 0), // RB/Mscf; 0 => free-gas voidage excluded
    Rs: num(config.rs, 0), // scf/STB
  };
}

// Field-level VRR series in reservoir barrels, using the SAME per-period voidage
// physics as the VRR Monitor (vrrCalculations.computePeriodVoidage). Produces
// instantaneous (daily), rolling-window and running-cumulative VRR.
export function computeFieldVRR(daily, config = {}) {
  const fvf = resolveFvf(config);
  const windowDays = Math.max(1, Math.floor(num(config.vrr_window_days, 30)));

  const producedVoidage = [];
  const injectedVoidage = [];
  const vrr_daily = [];

  daily.forEach((d) => {
    // Map a field-day onto the shared voidage period: producers -> Np/Wp/Gp,
    // water injection -> Wi. Gas injection (Gi) is not part of the schema.
    const period = { Np: d.oil_bpd, Wp: d.water_bpd, Gp: d.gas_mscf, Wi: d.inj_bpd, Gi: 0 };
    const v = computePeriodVoidage(period, fvf);
    producedVoidage.push(v.producedVoidage);
    injectedVoidage.push(v.injectedVoidage);
    vrr_daily.push(v.producedVoidage > 0 ? v.injectedVoidage / v.producedVoidage : 0);
  });

  const vrr_rolling = [];
  const vrr_cum = [];
  let cumProd = 0;
  let cumInj = 0;
  for (let i = 0; i < daily.length; i++) {
    const start = Math.max(0, i - windowDays + 1);
    let winProd = 0;
    let winInj = 0;
    for (let j = start; j <= i; j++) {
      winProd += producedVoidage[j];
      winInj += injectedVoidage[j];
    }
    vrr_rolling.push(winProd > 0 ? winInj / winProd : 0);

    cumProd += producedVoidage[i];
    cumInj += injectedVoidage[i];
    vrr_cum.push(cumProd > 0 ? cumInj / cumProd : 0);
  }

  return {
    date: daily.map((d) => d.date),
    vrr_daily,
    vrr_rolling,
    vrr_cum,
    produced_voidage_rb: producedVoidage,
    injected_voidage_rb: injectedVoidage,
    cum_produced_voidage_rb: cumProd,
    cum_injected_voidage_rb: cumInj,
  };
}

// Roll-up KPIs. VRR figures are reservoir-barrel voidage ratios (see computeFieldVRR).
export function computeKPIs(daily, vrr) {
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const total_oil_bbl = sum(daily.map((d) => d.oil_bpd));
  const total_water_bbl = sum(daily.map((d) => d.water_bpd));
  const total_injected_bbl = sum(daily.map((d) => d.inj_bpd));
  const liquid = total_oil_bbl + total_water_bbl;
  return {
    avg_water_cut_pct: liquid > 0 ? (total_water_bbl / liquid) * 100 : 0,
    vrr_avg: vrr.vrr_cum.length ? vrr.vrr_cum[vrr.vrr_cum.length - 1] : 0, // cumulative RB VRR
    vrr_rolling: vrr.vrr_rolling.length ? vrr.vrr_rolling[vrr.vrr_rolling.length - 1] : 0,
    total_injected_bbl,
    total_oil_bbl,
    total_water_bbl,
  };
}

// Deterministic, defensible surveillance alerts. Anything requiring cross-well
// timing (pattern breakthrough) or pressure (injectivity) is deferred to a later
// phase rather than guessed here.
export function buildAlerts(kpis, config = {}) {
  const alerts = { high_watercut: [], poor_vrr: [], injectivity_issue: [], breakthrough: [] };
  const target = num(config.target_vrr, 1.0);

  if (kpis.avg_water_cut_pct > 80) {
    alerts.high_watercut.push(`Field average water cut is high at ${kpis.avg_water_cut_pct.toFixed(1)}%.`);
  }
  const vrr = kpis.vrr_rolling;
  if (Number.isFinite(vrr) && vrr > 0) {
    const band = classifyVRR(vrr);
    if (vrr < 0.9 * target) {
      alerts.poor_vrr.push(`Latest rolling VRR is ${vrr.toFixed(2)} (target ${target.toFixed(2)}). ${band.label}`);
    } else if (vrr > 1.1 * target) {
      alerts.poor_vrr.push(`Latest rolling VRR is ${vrr.toFixed(2)} (target ${target.toFixed(2)}). ${band.label}`);
    }
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// Well-level analytics (P2): pattern-response cross-correlation, VRR-balanced
// injection recommendations, and Hall-plot injectivity diagnostics. Everything
// here is a real, deterministic computation from the rate/pressure history, and
// each result is gated (omitted, not guessed) when the data cannot support it.

// Build per-well daily series aligned to a common date axis. Missing days are
// null (not zero) so a data gap is never mistaken for a real zero-rate day.
export function buildWellSeries(rows, wellIndex) {
  const dateSet = new Set(rows.map((r) => r.dateKey));
  const dates = Array.from(dateSet).sort();
  const dateIdx = new Map(dates.map((d, i) => [d, i]));

  const typeOf = new Map(wellIndex.map((w) => [w.well, w.type]));
  const series = new Map();
  wellIndex.forEach((w) => {
    series.set(w.well, {
      well: w.well,
      type: w.type,
      dates,
      inj: new Array(dates.length).fill(null),
      liquid: new Array(dates.length).fill(null),
      oil: new Array(dates.length).fill(null),
      whp: new Array(dates.length).fill(null),
    });
  });

  rows.forEach((r) => {
    const s = series.get(r.well);
    if (!s) return;
    const i = dateIdx.get(r.dateKey);
    if (typeOf.get(r.well) === 'injector') {
      s.inj[i] = r.inj; // include zero-injection days for injectors
    } else {
      s.oil[i] = r.oil;
      s.liquid[i] = r.oil + r.water;
    }
    if (r.whp != null) s.whp[i] = r.whp;
  });

  return { dates, series };
}

// Pearson correlation over pairwise-complete samples.
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null; // a constant series has no correlation
  return sxy / Math.sqrt(sxx * syy);
}

// First difference of an aligned series, preserving null gaps.
function firstDifference(arr) {
  const out = new Array(arr.length).fill(null);
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] != null && arr[i - 1] != null) out[i] = arr[i] - arr[i - 1];
  }
  return out;
}

// Detrended time-lagged cross-correlation of injector rate vs producer liquid
// rate. First-differencing removes the shared field trend (injection ramp,
// producer decline) so the lag reflects genuine co-movement, not co-trending.
// Returns the best positive-correlation lag for the pair, or null if no lag
// clears the thresholds (insufficient overlap / variance / correlation).
export function crossCorrelatePair(injSeries, prodSeries, opts = {}) {
  const maxLag = Math.max(1, Math.floor(num(opts.maxLagDays, 20)));
  const minOverlap = Math.max(3, Math.floor(num(opts.minOverlap, 20)));
  const minCorr = num(opts.minCorr, 0.3);

  const dInj = firstDifference(injSeries);
  const dProd = firstDifference(prodSeries);

  let best = null;
  for (let lag = 0; lag <= maxLag; lag++) {
    const xs = [];
    const ys = [];
    for (let t = 0; t + lag < dInj.length; t++) {
      const x = dInj[t];
      const y = dProd[t + lag];
      if (x != null && y != null) { xs.push(x); ys.push(y); }
    }
    if (xs.length < minOverlap) continue;
    const corr = pearson(xs, ys);
    if (corr == null) continue;
    if (best == null || corr > best.corr) best = { lag_days: lag, corr, overlap: xs.length };
  }
  if (!best || best.corr < minCorr) return null;
  return best;
}

// Cross-correlate every injector against every producer; keep pairs whose peak
// response correlation clears the threshold, sorted strongest first.
export function computePatternLags(wellSeries, injectors, producers, config = {}) {
  const opts = {
    maxLagDays: config.max_lag_days,
    minOverlap: config.min_overlap_days,
    minCorr: config.min_corr,
  };
  const pairs = [];
  injectors.forEach((inj) => {
    const injS = wellSeries.series.get(inj);
    if (!injS) return;
    producers.forEach((prod) => {
      const prodS = wellSeries.series.get(prod);
      if (!prodS) return;
      const r = crossCorrelatePair(injS.inj, prodS.liquid, opts);
      if (r) pairs.push({ injector: inj, producer: prod, lag_days: r.lag_days, corr: r.corr, overlap: r.overlap });
    });
  });
  return pairs.sort((a, b) => b.corr - a.corr);
}

// Field-level VRR-balanced injection recommendation. Over the most recent
// `vrr_window_days` of DATA (not wall-clock — the old engine filtered against
// new Date(), zeroing out for any historical dataset), compute produced/injected
// reservoir-barrel voidage, then scale every injector's recent average rate by
// (target_VRR / current_VRR) so field voidage replacement lands on target.
//
// This is a transparent field balance, NOT a per-pattern geometric optimization
// (which would need well spacing / connectivity the schema does not carry).
export function recommendInjection(rows, wellIndex, injectors, config = {}) {
  if (injectors.length === 0) return { recommendations: [], scale: null, note: null };

  const dates = Array.from(new Set(rows.map((r) => r.dateKey))).sort();
  if (dates.length === 0) return { recommendations: [], scale: null, note: null };
  const windowDays = Math.max(1, Math.floor(num(config.vrr_window_days, 30)));
  const cutoff = dates[Math.max(0, dates.length - windowDays)];
  const recent = rows.filter((r) => r.dateKey >= cutoff);
  const distinctRecentDays = new Set(recent.map((r) => r.dateKey)).size || 1;

  const fvf = resolveFvf(config);
  let prodVoidage = 0;
  let injVoidage = 0;
  recent.forEach((r) => {
    const v = computePeriodVoidage({ Np: r.oil, Wp: r.water, Gp: r.gas, Wi: r.inj, Gi: 0 }, fvf);
    prodVoidage += v.producedVoidage;
    injVoidage += v.injectedVoidage;
  });
  const currentVRR = prodVoidage > 0 ? injVoidage / prodVoidage : null;
  const target = num(config.target_vrr, 1.0);
  const scale = currentVRR && currentVRR > 0 ? target / currentVRR : null;

  const recommendations = injectors.map((inj) => {
    const injRows = recent.filter((r) => r.well === inj);
    const avg = injRows.reduce((s, r) => s + r.inj, 0) / distinctRecentDays;
    const suggested = scale != null ? avg * scale : avg;
    return { injector: inj, avg_inj_last30_bpd: avg, suggested_inj_bpd: suggested, delta_bpd: suggested - avg };
  });

  const note = scale == null
    ? 'No injection in the recent window — cannot scale to target VRR.'
    : `Recent field VRR ${currentVRR.toFixed(2)}; rates scaled by ${scale.toFixed(2)} toward target ${target.toFixed(2)}.`;
  return { recommendations, scale, currentVRR, note };
}

// Ordinary-least-squares slope of y vs x over an index window [lo, hi).
function olsSlope(xs, ys, lo, hi) {
  let n = 0;
  let mx = 0;
  let my = 0;
  for (let i = lo; i < hi; i++) { if (xs[i] == null || ys[i] == null) continue; mx += xs[i]; my += ys[i]; n++; }
  if (n < 2) return null;
  mx /= n; my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = lo; i < hi; i++) {
    if (xs[i] == null || ys[i] == null) continue;
    const dx = xs[i] - mx;
    sxy += dx * (ys[i] - my); sxx += dx * dx;
  }
  return sxx > 0 ? sxy / sxx : null;
}

// Real Hall plot per injector from MEASURED injection pressure. The Hall integral
// I = Σ p·Δt is plotted against cumulative injection W = Σ q·Δt; the local slope
// dI/dW = p/q is the flow resistance. A recent-window regression slope well above
// the early baseline signals declining injectivity (skin/plugging); well below
// signals improving injectivity (possible fracturing or thief-zone channeling).
// Injectors without pressure are returned separately and left ungated-off.
export function computeHallPlots(wellSeries, injectors, config = {}) {
  const hall_plots = [];
  const injectivity_alerts = [];
  const injectors_without_pressure = [];
  const minPoints = Math.max(6, Math.floor(num(config.hall_min_points, 10)));
  const hiThreshold = num(config.hall_slope_hi, 1.2);
  const loThreshold = num(config.hall_slope_lo, 0.8);

  injectors.forEach((inj) => {
    const s = wellSeries.series.get(inj);
    if (!s) return;
    const hall_integral = [];
    const cum_injection = [];
    let hallInt = 0;
    let cumInj = 0;
    let prevIdx = null;
    let points = 0;
    for (let i = 0; i < s.dates.length; i++) {
      const p = s.whp[i];
      const q = s.inj[i];
      if (p == null || q == null) continue;
      const dt = prevIdx == null ? 1 : Math.max(1, idxDayGap(s.dates, prevIdx, i));
      hallInt += p * dt;
      cumInj += q * dt;
      hall_integral.push(hallInt);
      cum_injection.push(cumInj);
      prevIdx = i;
      points++;
    }
    if (points < minPoints) {
      injectors_without_pressure.push(inj);
      return;
    }
    const n = hall_integral.length;
    const third = Math.max(2, Math.floor(n / 3));
    const slope_baseline = olsSlope(cum_injection, hall_integral, 0, third);
    const slope_recent = olsSlope(cum_injection, hall_integral, n - third, n);
    const ratio = slope_baseline && slope_baseline > 0 && slope_recent != null ? slope_recent / slope_baseline : null;

    hall_plots.push({ injector: inj, hall_integral, cum_injection, slope_last: slope_recent, slope_baseline, slope_ratio: ratio });

    if (ratio != null && ratio >= hiThreshold) {
      injectivity_alerts.push({ injector: inj, message: `Injector ${inj}: Hall slope up ${(ratio).toFixed(2)}× vs baseline — declining injectivity (rising skin / near-well plugging).` });
    } else if (ratio != null && ratio <= loThreshold) {
      injectivity_alerts.push({ injector: inj, message: `Injector ${inj}: Hall slope down ${(ratio).toFixed(2)}× vs baseline — improving injectivity (possible fracturing or thief-zone channeling).` });
    }
  });

  return { hall_plots, injectivity_alerts, injectors_without_pressure };
}

// Day gap between two aligned date indices (dates are ISO YYYY-MM-DD strings).
function idxDayGap(dates, i, j) {
  const a = new Date(dates[i]).getTime();
  const b = new Date(dates[j]).getTime();
  const days = Math.round((b - a) / (24 * 3600 * 1000));
  return Number.isFinite(days) && days > 0 ? days : 1;
}

// ---------------------------------------------------------------------------
// Chan water-control diagnostics (Chan, SPE 30775, 1995). Log–log plots of the
// water–oil ratio WOR(t) and its time derivative WOR'(t) reveal the dominant
// excess-water mechanism from the SHAPE of the derivative:
//   * channeling (multilayer / fracture / behind-pipe): WOR and WOR' both rise,
//     roughly parallel — WOR' has a positive log–log slope;
//   * coning / normal displacement: WOR climbs then flattens and WOR' is flat-
//     to-declining (negative log–log slope, often dipping negative).
// The plot is exact math; the mechanism label is an INDICATIVE heuristic on the
// late-time WOR' slope and must be confirmed with engineering judgment — so the
// panel always shows the computed slope alongside the label.
export function classifyChan(lateSlope) {
  if (lateSlope == null || !Number.isFinite(lateSlope)) {
    return { code: 'indeterminate', label: 'Indeterminate — not enough late-time water history to read the WOR′ trend.' };
  }
  if (lateSlope >= 0.4) {
    return { code: 'channeling', label: 'Channeling-like — WOR′ rising on log–log (multilayer channeling, fracture or behind-pipe communication).' };
  }
  if (lateSlope <= 0.0) {
    return { code: 'coning', label: 'Coning / normal-displacement-like — WOR′ flat-to-declining on log–log.' };
  }
  return { code: 'transitional', label: 'Transitional — WOR′ slope sits between the coning and channeling regimes.' };
}

// Build a Chan series {t, wor, worDeriv} from aligned oil/water arrays.
// t = days since first water-bearing production (+1 so log(t) is defined at
// onset). WOR' = d(WOR)/dt via a smoothed centered difference.
function buildChanSeries(oilArr, waterArr, dates, config) {
  const minPoints = Math.max(8, Math.floor(num(config.chan_min_points, 10)));
  const pts = [];
  let t0 = null;
  for (let i = 0; i < dates.length; i++) {
    const oil = oilArr[i];
    const water = waterArr[i];
    if (oil == null || oil <= 0 || water == null || water < 0) continue;
    const wor = water / oil;
    if (!(wor > 0)) continue;
    const ms = new Date(dates[i]).getTime();
    if (t0 == null) t0 = ms;
    const t = (ms - t0) / (24 * 3600 * 1000) + 1;
    pts.push({ t, wor });
  }
  if (pts.length < minPoints) return null;

  const worS = movingAverage(pts.map((p) => p.wor), num(config.chan_smooth, 3));
  const points = pts.map((p, i) => {
    const lo = Math.max(0, i - 1);
    const hi = Math.min(pts.length - 1, i + 1);
    const dt = pts[hi].t - pts[lo].t;
    const worDeriv = dt > 0 ? (worS[hi] - worS[lo]) / dt : 0;
    return { t: p.t, wor: worS[i], worDeriv };
  });

  // Late-time (last 40%) log–log slope of WOR' over positive-derivative points.
  const start = Math.floor(points.length * 0.6);
  const logT = [];
  const logD = [];
  for (let i = start; i < points.length; i++) {
    if (points[i].worDeriv > 0 && points[i].t > 0) {
      logT.push(Math.log(points[i].t));
      logD.push(Math.log(points[i].worDeriv));
    }
  }
  const lateSlope = logT.length >= 3 ? olsSlope(logT, logD, 0, logT.length) : null;
  return { points, lateSlope, classification: classifyChan(lateSlope) };
}

// Field-level and per-producer Chan diagnostics.
export function computeChanDiagnostics(dailyField, wellSeries, producers, config = {}) {
  const field = buildChanSeries(
    dailyField.map((d) => d.oil_bpd),
    dailyField.map((d) => d.water_bpd),
    dailyField.map((d) => d.date),
    config
  );

  const perProducer = [];
  producers.forEach((name) => {
    const s = wellSeries.series.get(name);
    if (!s) return;
    const water = s.liquid.map((l, i) => (l == null || s.oil[i] == null ? null : l - s.oil[i]));
    const chan = buildChanSeries(s.oil, water, s.dates, config);
    if (chan) perProducer.push({ producer: name, ...chan });
  });

  const available = Boolean(field) || perProducer.length > 0;
  return { field: field ? { producer: 'Field (all wells)', ...field } : null, producers: perProducer, available };
}

// Full analysis orchestrator. Returns the exact shape the dashboard panels read:
// { data_quality, daily_series, vrr_series, kpis, alerts, wells }.
export function analyzeWaterflood(rawRows, config = {}) {
  const { rows, dataQuality } = cleanRows(rawRows || [], config);
  const { wells, injectors, producers } = classifyWells(rows);
  if (injectors.length === 0) {
    dataQuality.issues.push('No injector wells detected (no non-zero inj_bbl). VRR reflects production voidage only.');
  }

  const dailySeries = aggregateDaily(rows, config);
  const vrr = computeFieldVRR(dailySeries._daily, config);
  const kpis = computeKPIs(dailySeries._daily, vrr);
  const alerts = buildAlerts(kpis, config);

  // ---- Well-level P2 analytics + capability gating -----------------------
  const wellIndex = Array.from(wells.values());
  const wellSeries = buildWellSeries(rows, wellIndex);

  const pattern_lags = injectors.length && producers.length
    ? computePatternLags(wellSeries, injectors, producers, config)
    : [];

  const rec = recommendInjection(rows, wellIndex, injectors, config);
  const recommendations = rec.recommendations;

  const hall = computeHallPlots(wellSeries, injectors, config);
  const hall_plots = hall.hall_plots;
  alerts.injectivity_issue = hall.injectivity_alerts;

  const chan = computeChanDiagnostics(dailySeries._daily, wellSeries, producers, config);

  const capabilities = {
    pattern_lags: {
      available: injectors.length > 0 && producers.length > 0,
      hasResults: pattern_lags.length > 0,
      reason:
        injectors.length === 0 ? 'No injector wells in the dataset.'
          : producers.length === 0 ? 'No producer wells in the dataset.'
            : pattern_lags.length === 0 ? 'No injector–producer pair showed a significant time-lagged response above the correlation threshold.'
              : null,
    },
    recommendations: {
      available: injectors.length > 0,
      hasResults: recommendations.length > 0,
      note: rec.note,
      currentVRR: rec.currentVRR ?? null,
      reason: injectors.length === 0 ? 'No injector wells to recommend rates for.' : null,
    },
    hall: {
      available: hall_plots.length > 0,
      hasResults: hall_plots.length > 0,
      injectorsWithoutPressure: hall.injectors_without_pressure,
      reason: hall_plots.length === 0
        ? 'Hall plot requires measured injection pressure (whp_psi) on injector rows; none was provided.'
        : null,
    },
    chan: {
      available: chan.available,
      hasResults: chan.available,
      reason: chan.available
        ? null
        : 'Chan diagnostics need a producing history with both oil and water rates over enough time.',
    },
  };

  // Strip the internal _daily helper before returning to the UI.
  const { _daily, ...daily_series } = dailySeries;

  return {
    data_quality: dataQuality,
    daily_series,
    vrr_series: {
      date: vrr.date,
      vrr_daily: vrr.vrr_daily,
      vrr_rolling: vrr.vrr_rolling,
      vrr_cum: vrr.vrr_cum,
    },
    kpis,
    alerts,
    wells: { injectors, producers },
    pattern_lags,
    recommendations,
    hall_plots,
    chan,
    capabilities,
  };
}

// ---------------------------------------------------------------------------
// Sample data — deterministic (no randomness), physically self-consistent, and
// correctly shaped: injectors carry inj_bbl and whp_psi (the old sample put the
// injection volume in gas_mcf and left inj_bbl blank, so nothing classified as
// an injector). Two 5-spot-style patterns over 90 days:
//   * injection ramps up so cumulative VRR climbs from under-injection (~0.7)
//     toward balance — the canonical pressure-maintenance surveillance story;
//   * a deterministic injection ripple echoes into the paired producer's rate
//     a fixed number of days later, so the pattern-response cross-correlation
//     has a real lag to recover (10 d for INJ-1, 6 d for INJ-2). The two
//     patterns ripple at DIFFERENT periods so only the truly connected
//     injector–producer pair correlates strongly;
//   * INJ-1 wellhead pressure rises faster than its rate (p/q climbing) to
//     exercise the Hall injectivity-decline alert, while INJ-2 pressure tracks
//     its rate (steady injectivity, no alert).
export function sampleWaterfloodRows() {
  const rows = [];
  const start = new Date('2024-01-01T00:00:00Z');
  const days = 90;
  const patterns = [
    { inj: 'INJ-1', prod: 'PROD-1', inj0: 340, injRamp: 3.4, injAmp: 60, respAmp: 32, lag: 10, period: 25, oil0: 320, oilDecl: 1.6, water0: 40, waterRise: 3.2, gor: 0.6, whp0: 2000, whpSlope: 40, whpPerRate: null },
    { inj: 'INJ-2', prod: 'PROD-2', inj0: 235, injRamp: 2.6, injAmp: 40, respAmp: 22, lag: 6, period: 17, oil0: 260, oilDecl: 1.2, water0: 30, waterRise: 2.6, gor: 0.5, whp0: null, whpSlope: null, whpPerRate: 8.0 },
  ];
  const ripple = (t, amp, phase, period) => amp * Math.sin((2 * Math.PI * (t - phase)) / period);

  for (let t = 0; t < days; t++) {
    const d = new Date(start.getTime() + t * 24 * 3600 * 1000);
    const dateKey = d.toISOString().split('T')[0];
    patterns.forEach((p) => {
      const inj = Math.max(0, Math.round(p.inj0 + p.injRamp * t + ripple(t, p.injAmp, 0, p.period)));
      const oil = Math.max(0, Math.round(p.oil0 - p.oilDecl * t));
      // Producer liquid carries a lagged echo of the injection ripple (in water).
      const water = Math.max(0, Math.round(p.water0 + p.waterRise * t + ripple(t, p.respAmp, p.lag, p.period)));
      const gas = Math.round(oil * p.gor); // Mscf/d, tracks oil via a fixed producing GOR
      const whp = p.whpPerRate != null ? Math.round(p.whpPerRate * inj) : Math.round(p.whp0 + p.whpSlope * t);
      rows.push({ date: dateKey, well: p.inj, oil_bbl: '', water_bbl: '', gas_mcf: '', inj_bbl: inj, whp_psi: whp });
      rows.push({ date: dateKey, well: p.prod, oil_bbl: oil, water_bbl: water, gas_mcf: gas, inj_bbl: '', whp_psi: '' });
    });
  }
  return rows;
}

export function sampleWaterfloodCSV() {
  const header = 'date,well,oil_bbl,water_bbl,gas_mcf,inj_bbl,whp_psi';
  const lines = sampleWaterfloodRows().map((r) =>
    [r.date, r.well, r.oil_bbl, r.water_bbl, r.gas_mcf, r.inj_bbl, r.whp_psi].join(',')
  );
  return [header, ...lines].join('\n') + '\n';
}
