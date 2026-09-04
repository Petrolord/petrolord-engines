/**
 * Production surveillance: series building, exception detection,
 * deferment roll-up, field KPIs and the decline overlay (Production,
 * extracted from the Suite's Production Surveillance Studio P2 layer).
 *
 * THE IDEA. Surveillance is the discipline of reading a production
 * ledger and saying WHICH WELLS TO GO AND LOOK AT TODAY. It is not
 * forecasting and it is not allocation. Everything here is a comparison
 * of a recent window against a baseline window on the same well, so the
 * output is always "this well changed", never "this well is bad".
 *
 * THE WINDOWS ANCHOR ON THE DATA, NEVER THE WALL CLOCK. Every window in
 * `detectExceptions` is measured back from the FIELD's latest ledger
 * date. A three-year-old dataset therefore surveils honestly instead of
 * declaring every well stale, which is what anchoring on `new Date()`
 * would do. `asOf` is returned so the reader knows what "recent" meant.
 *
 * THE WINDOWS WIDEN FOR A COARSE LEDGER. A monthly ledger compared over
 * a seven-day recent window is one point against nothing, so the
 * cadence is measured (`seriesCadenceDays`, the median gap) and the
 * windows are stretched to cover enough points. Silently comparing
 * single months would be the worst possible failure mode here because
 * it looks like it worked.
 *
 * PRODUCING-DAY VERSUS CALENDAR-DAY. A ledger row holds a VOLUME over a
 * calendar day and, if the operator recorded it, the HOURS the well was
 * on. The producing-day rate is the volume scaled to 24 hours, and it
 * is the number that says how the well is performing as opposed to how
 * much it made. Zero hours means shut in, and the producing-day rate is
 * then NULL rather than Infinity -- the single most important refusal
 * in this module, because Infinity propagates into every mean
 * downstream and turns a shut-in day into a fabricated record rate.
 *
 * A KNOWN INTERNAL SEAM, STATED RATHER THAN HIDDEN. `computeKpis`
 * forms a period watercut and GOR VOLUMETRICALLY (sum of water over sum
 * of liquid), which is what a period ratio means. `detectExceptions`
 * forms them as the MEAN OF THE DAILY RATIOS, which is a different
 * quantity and is biased by low-rate days. The two disagree, the gate
 * measures by how much on a golden series, and the disagreement is
 * recorded for an owner decision rather than resolved here, because
 * changing it would move numbers a shipped studio displays.
 *
 * UNITS. Field units throughout, as everywhere else in
 * engines/production. They are not converted internally and they are
 * not optional:
 *
 *   oil / water volume    stb per ledger row (a calendar day)
 *   gas volume            Mscf per ledger row
 *   water injection       stb, gas injection Mscf
 *   producing-day rate    stb/d and Mscf/d
 *   hours on stream       h, 0 to 24
 *   watercut              a 0-1 fraction, never a percentage
 *   gas-oil ratio         scf/stb
 *   nominal decline Di    per DAY (the canonical Arps engine's
 *                         convention, and why annualEffectiveDecline
 *                         uses t = 365)
 *   dates                 ISO yyyy-mm-dd, read as UTC midnight
 *
 * DECLINE IS NOT RE-DERIVED HERE. The overlay calls the CANONICAL Arps
 * engine (engines/dca/arps). A second decline implementation would be a
 * second thing to be wrong, and this module would then have to be
 * validated as a decline engine, which it is not.
 *
 * VALIDATION NOTE. Gated against
 * tools/validation/production/oracle_surveillance.py through
 * test-data/production/goldens/surveillance_cases.json. The oracle is
 * written from the method statement, not by transcribing this file:
 * it does all date arithmetic with the calendar (`datetime.date`)
 * where this module works in epoch-millisecond day numbers; it forms
 * every window mean by explicit calendar membership from the STATED
 * window definition rather than the implemented inequality; it
 * measures effective decline as `1 - q(365)/q(0)` evaluated through the
 * Arps rate law where this module evaluates a closed form; and the
 * decline fit is gated against a series SYNTHESISED from known
 * parameters, so the truth is known by construction and no
 * reimplementation of the fitter is involved at all.
 */
import { fitArpsModel, generateForecast } from '../dca/arps.js';

const MS_DAY = 24 * 60 * 60 * 1000;

const dayNumber = (isoDate) => Math.round(new Date(`${isoDate}T00:00:00Z`).getTime() / MS_DAY);

const mean = (values) => {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
};

// ---- series building -------------------------------------------------------

/**
 * Derived per-row quantities. Producing-day rates honestly reflect
 * hours_on: 0 hours means shut in (rate null, not Infinity); missing
 * hours means uptime is unknown and the producing-day rate equals the
 * calendar-day volume.
 */
export function derivePoint(row) {
  const oil = row.oil_stb || 0;
  const water = row.water_stb || 0;
  const gas = row.gas_mscf || 0;
  const winj = row.winj_stb || 0;
  const ginj = row.ginj_mscf || 0;
  const hoursOn = Number.isFinite(row.hours_on) ? row.hours_on : null;
  const liquid = oil + water;
  const pd = (vol) => {
    if (hoursOn == null) return vol;
    if (hoursOn <= 0) return null;
    return (vol * 24) / hoursOn;
  };
  return {
    date: row.prod_date,
    oil, water, gas, winj, ginj, hoursOn, liquid,
    watercut: liquid > 0 ? water / liquid : null,
    gor: oil > 0 ? (gas * 1000) / oil : null,
    oilPd: pd(oil),
    waterPd: pd(water),
    gasPd: pd(gas),
    liquidPd: pd(liquid),
  };
}

/**
 * Group a field's ledger (rows carrying `well`) into per-well series,
 * date-ascending, wells name-sorted.
 * @returns {Array<{well: object, points: Array}>}
 */
export function buildWellSeries(rows) {
  const byWell = new Map();
  (rows || []).forEach((r) => {
    if (!r?.well?.id || !r.prod_date) return;
    if (!byWell.has(r.well.id)) byWell.set(r.well.id, { well: r.well, points: [] });
    byWell.get(r.well.id).points.push(derivePoint(r));
  });
  const series = [...byWell.values()];
  series.forEach((s) => s.points.sort((a, b) => (a.date < b.date ? -1 : 1)));
  series.sort((a, b) => String(a.well.name).localeCompare(String(b.well.name)));
  return series;
}

/** Field-level daily totals with derived watercut/GOR and an on-count. */
export function buildFieldSeries(rows) {
  const byDate = new Map();
  (rows || []).forEach((r) => {
    if (!r.prod_date) return;
    if (!byDate.has(r.prod_date)) {
      byDate.set(r.prod_date, { date: r.prod_date, oil: 0, water: 0, gas: 0, winj: 0, ginj: 0, wellsOn: 0 });
    }
    const d = byDate.get(r.prod_date);
    d.oil += r.oil_stb || 0;
    d.water += r.water_stb || 0;
    d.gas += r.gas_mscf || 0;
    d.winj += r.winj_stb || 0;
    d.ginj += r.ginj_mscf || 0;
    const producing = (r.oil_stb || 0) + (r.water_stb || 0) + (r.gas_mscf || 0) > 0
      && (r.hours_on == null || r.hours_on > 0);
    if (producing) d.wellsOn += 1;
  });
  return [...byDate.values()]
    .map((d) => ({
      ...d,
      liquid: d.oil + d.water,
      watercut: d.oil + d.water > 0 ? d.water / (d.oil + d.water) : null,
      gor: d.oil > 0 ? (d.gas * 1000) / d.oil : null,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Median gap between consecutive points, in days (1 = daily ledger,
 *  ~30 = monthly). null when under two points. */
export function seriesCadenceDays(points) {
  if (!points || points.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < points.length; i += 1) {
    gaps.push(dayNumber(points[i].date) - dayNumber(points[i - 1].date));
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

/**
 * Trailing moving average of `key` over a date window (not a point
 * count, so daily and monthly ledgers both average real time). Returns
 * values aligned with `points`; null where the point's value is null.
 */
export function movingAverage(points, key, windowDays) {
  const days = (points || []).map((p) => dayNumber(p.date));
  return (points || []).map((p, i) => {
    if (!Number.isFinite(p[key])) return null;
    const from = days[i] - windowDays + 1;
    const window = [];
    for (let j = i; j >= 0 && days[j] >= from; j -= 1) {
      if (Number.isFinite(points[j][key])) window.push(points[j][key]);
    }
    return window.length ? window.reduce((a, b) => a + b, 0) / window.length : null;
  });
}

/** Stride-decimate a long series for charting; always keeps the last
 *  point. Under maxPoints, the input comes back untouched. */
export function decimate(points, maxPoints = 1500) {
  if (!points || points.length <= maxPoints) return points || [];
  const stride = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

// ---- exception surveillance ------------------------------------------------

export const DEFAULT_SURVEILLANCE_SETTINGS = {
  recentDays: 7,        // test window (auto-widens on monthly cadence)
  baselineDays: 30,     // baseline window preceding the test window
  rateDropPct: 20,      // oil (producers) / injection drop trigger, %
  watercutRisePts: 10,  // watercut rise trigger, percentage points
  gorRisePct: 30,       // GOR rise trigger, %
  downtimeHours: 12,    // mean hours-on below this flags downtime
  staleDays: 7,         // no data within this of the field's last date
  minOilRate: 5,        // baselines below this skip drop/ratio checks (stb/d)
};

export const EXCEPTION_TYPES = {
  shut_in: { label: 'Shut in', description: 'Producing in the baseline window, nothing in the test window.' },
  rate_drop: { label: 'Rate drop', description: 'Oil rate fell against the well baseline.' },
  injection_drop: { label: 'Injection drop', description: 'Water injection fell against the well baseline.' },
  watercut_rise: { label: 'Watercut rise', description: 'Watercut climbed against the well baseline.' },
  gor_rise: { label: 'GOR rise', description: 'Gas-oil ratio climbed against the well baseline.' },
  downtime: { label: 'Downtime', description: 'Mean hours on stream below the operating threshold.' },
  stale_data: { label: 'Stale data', description: 'No ledger rows near the field’s latest date.' },
};

const SEVERITY_RANK = { high: 0, medium: 1, info: 2 };

const windowMean = (points, key, fromDay, toDay) => {
  const vals = [];
  points.forEach((p) => {
    const d = dayNumber(p.date);
    if (d > fromDay && d <= toDay) vals.push(p[key]);
  });
  return { mean: mean(vals), count: vals.filter((v) => Number.isFinite(v)).length };
};

/**
 * Exception surveillance over a field's well series. All windows anchor
 * on the FIELD's latest ledger date (never the wall clock -- old
 * datasets surveil honestly). Monthly ledgers widen the windows to
 * cover enough points instead of silently comparing single days.
 *
 * @returns {{asOf: ?string, exceptions: Array<{wellId, wellName, type,
 *   severity, value, baseline, message}>}}
 */
export function detectExceptions(wellSeries, settings = {}) {
  const s = { ...DEFAULT_SURVEILLANCE_SETTINGS, ...settings };
  // Observation wells carry no rates of their own to surveil; every
  // other type is read as a producer unless it is typed as an injector.
  const all = (wellSeries || [])
    .filter((w) => w.points.length && w.well.well_type !== 'observation');
  if (!all.length) return { asOf: null, exceptions: [] };

  const asOf = all.reduce((max, w) => {
    const last = w.points[w.points.length - 1].date;
    return last > max ? last : max;
  }, '0000-00-00');
  const asOfDay = dayNumber(asOf);

  const exceptions = [];
  const push = (well, type, severity, value, baseline, message) => {
    exceptions.push({ wellId: well.id, wellName: well.name, type, severity, value, baseline, message });
  };
  const pct = (v) => `${Math.round(v)}%`;

  all.forEach(({ well, points }) => {
    const isInjector = well.well_type === 'injector';
    const cadence = seriesCadenceDays(points) || 1;
    const recentDays = Math.max(s.recentDays, Math.ceil(cadence * 1.5));
    const baselineDays = Math.max(s.baselineDays, Math.ceil(cadence * 4));
    const staleDays = Math.max(s.staleDays, Math.ceil(cadence * 1.5));

    // Stale data: nothing recorded near the field's frontier.
    const lastDay = dayNumber(points[points.length - 1].date);
    const gap = asOfDay - lastDay;
    if (gap > staleDays) {
      push(well, 'stale_data', gap > staleDays * 2 ? 'medium' : 'info', gap, staleDays,
        `No data for ${gap} days (field ledger runs to ${asOf}).`);
      return; // the comparison windows below would be empty
    }

    const rateKey = isInjector ? 'winj' : 'oil';
    const recent = windowMean(points, rateKey, asOfDay - recentDays, asOfDay);
    const base = windowMean(points, rateKey, asOfDay - recentDays - baselineDays, asOfDay - recentDays);
    if (base.count && recent.count && base.mean >= s.minOilRate) {
      if (recent.mean <= 0) {
        push(well, 'shut_in', 'high', 0, base.mean,
          `${isInjector ? 'Injection' : 'Production'} stopped (baseline ${Math.round(base.mean).toLocaleString()} ${isInjector ? 'stb/d water' : 'stb/d oil'}).`);
      } else {
        const drop = ((base.mean - recent.mean) / base.mean) * 100;
        if (drop >= s.rateDropPct) {
          push(well, isInjector ? 'injection_drop' : 'rate_drop',
            drop >= s.rateDropPct * 2 ? 'high' : 'medium', recent.mean, base.mean,
            `${isInjector ? 'Water injection' : 'Oil'} down ${pct(drop)}: ${Math.round(recent.mean).toLocaleString()} vs ${Math.round(base.mean).toLocaleString()} stb/d baseline.`);
        }
      }
    }

    if (!isInjector) {
      const wcRecent = windowMean(points, 'watercut', asOfDay - recentDays, asOfDay);
      const wcBase = windowMean(points, 'watercut', asOfDay - recentDays - baselineDays, asOfDay - recentDays);
      if (wcRecent.count && wcBase.count) {
        const risePts = (wcRecent.mean - wcBase.mean) * 100;
        if (risePts >= s.watercutRisePts) {
          push(well, 'watercut_rise', risePts >= s.watercutRisePts * 2 ? 'high' : 'medium',
            wcRecent.mean, wcBase.mean,
            `Watercut up ${risePts.toFixed(0)} points: ${(wcRecent.mean * 100).toFixed(0)}% vs ${(wcBase.mean * 100).toFixed(0)}% baseline.`);
        }
      }

      const gorRecent = windowMean(points, 'gor', asOfDay - recentDays, asOfDay);
      const gorBase = windowMean(points, 'gor', asOfDay - recentDays - baselineDays, asOfDay - recentDays);
      if (gorRecent.count && gorBase.count && gorBase.mean > 0
        && (base.mean == null || base.mean >= s.minOilRate)) {
        const rise = ((gorRecent.mean - gorBase.mean) / gorBase.mean) * 100;
        if (rise >= s.gorRisePct) {
          push(well, 'gor_rise', rise >= s.gorRisePct * 2 ? 'high' : 'medium',
            gorRecent.mean, gorBase.mean,
            `GOR up ${pct(rise)}: ${Math.round(gorRecent.mean).toLocaleString()} vs ${Math.round(gorBase.mean).toLocaleString()} scf/stb baseline.`);
        }
      }

      const hrs = windowMean(points, 'hoursOn', asOfDay - recentDays, asOfDay);
      if (hrs.count && hrs.mean < s.downtimeHours && hrs.mean > 0) {
        push(well, 'downtime', 'medium', hrs.mean, s.downtimeHours,
          `Averaging ${hrs.mean.toFixed(1)} hours on stream against a ${s.downtimeHours}-hour threshold.`);
      }
    }
  });

  exceptions.sort((a, b) => {
    const r = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (r !== 0) return r;
    return String(a.wellName).localeCompare(String(b.wellName));
  });
  return { asOf, exceptions };
}

// ---- deferments and KPIs ---------------------------------------------------

/**
 * Roll up deferment events: per-category counts, event-days and
 * deferred volumes, worst category first (by oil). Open events accrue
 * days to `asOf` (the field's latest ledger date, or today).
 */
export function summarizeDeferments(deferments, asOf) {
  const asOfDay = dayNumber(asOf || new Date().toISOString().slice(0, 10));
  const byCat = new Map();
  let openCount = 0;
  (deferments || []).forEach((d) => {
    const endDay = d.end_date ? dayNumber(d.end_date) : asOfDay;
    const days = Math.max(1, endDay - dayNumber(d.start_date) + 1);
    if (!d.end_date) openCount += 1;
    if (!byCat.has(d.category)) {
      byCat.set(d.category, { category: d.category, events: 0, days: 0, oil: 0, water: 0, gas: 0 });
    }
    const c = byCat.get(d.category);
    c.events += 1;
    c.days += days;
    c.oil += d.oil_deferred_stb || 0;
    c.water += d.water_deferred_stb || 0;
    c.gas += d.gas_deferred_mscf || 0;
  });
  const byCategory = [...byCat.values()].sort((a, b) => b.oil - a.oil || b.days - a.days);
  const totals = byCategory.reduce(
    (t, c) => ({
      events: t.events + c.events, days: t.days + c.days,
      oil: t.oil + c.oil, water: t.water + c.water, gas: t.gas + c.gas,
    }),
    { events: 0, days: 0, oil: 0, water: 0, gas: 0 },
  );
  return { byCategory, totals, openCount };
}

/**
 * Field KPIs over the trailing `windowDays` of the field series: mean
 * daily rates, watercut, GOR and (where hours_on was reported) uptime.
 *
 * The watercut and GOR here are VOLUMETRIC over the window -- a ratio
 * of the window means -- which is what a period ratio means and is NOT
 * what detectExceptions compares against a baseline. See the seam note
 * in the module header.
 */
export function computeKpis(wellSeries, fieldSeries, { windowDays = 7 } = {}) {
  if (!fieldSeries || !fieldSeries.length) return null;
  const asOf = fieldSeries[fieldSeries.length - 1].date;
  const fromDay = dayNumber(asOf) - windowDays + 1;
  const window = fieldSeries.filter((d) => dayNumber(d.date) >= fromDay);

  let hoursSum = 0;
  let hoursSlots = 0;
  (wellSeries || []).forEach(({ well, points }) => {
    if (well.well_type === 'injector') return;
    points.forEach((p) => {
      if (dayNumber(p.date) >= fromDay && p.hoursOn != null) {
        hoursSum += p.hoursOn;
        hoursSlots += 1;
      }
    });
  });

  const oil = mean(window.map((d) => d.oil));
  const water = mean(window.map((d) => d.water));
  const gas = mean(window.map((d) => d.gas));
  return {
    asOf,
    windowDays,
    oil, water, gas,
    winj: mean(window.map((d) => d.winj)),
    liquid: oil != null && water != null ? oil + water : null,
    watercut: oil + water > 0 ? water / (oil + water) : null,
    gor: oil > 0 ? (gas * 1000) / oil : null,
    uptimePct: hoursSlots ? (hoursSum / (hoursSlots * 24)) * 100 : null,
    wellCount: (wellSeries || []).length,
    producerCount: (wellSeries || []).filter((w) => w.well.well_type !== 'injector').length,
  };
}

// ---- decline overlay (canonical Arps engine) -------------------------------

export const FIT_STREAMS = {
  oil: { key: 'oilPd', calendarKey: 'oil', label: 'Oil', unit: 'stb/d' },
  gas: { key: 'gasPd', calendarKey: 'gas', label: 'Gas', unit: 'Mscf/d' },
  liquid: { key: 'liquidPd', calendarKey: 'liquid', label: 'Liquid', unit: 'stb/d' },
};

/** {date, rate} series for the canonical fitter. Producing-day basis
 *  skips shut-in days (rate null); zero rates are dropped either way
 *  (the Arps fit is log-space). */
export function rateSeriesForFit(points, stream = 'oil', basis = 'producing') {
  const def = FIT_STREAMS[stream] || FIT_STREAMS.oil;
  const key = basis === 'calendar' ? def.calendarKey : def.key;
  return (points || [])
    .filter((p) => Number.isFinite(p[key]) && p[key] > 0)
    .map((p) => ({ date: p.date, rate: p[key] }));
}

/**
 * Effective decline over the first year (per cent), the number an
 * engineer reads off a fit. Di from the Arps engine is NOMINAL PER DAY;
 * exponential and harmonic are the b -> 0 and b = 1 limits of the
 * hyperbolic form. Returns null for a non-declining or unusable Di.
 */
export function annualEffectiveDecline(Di, b, modelType) {
  if (!Number.isFinite(Di) || Di <= 0) return null;
  const t = 365;
  if (modelType === 'Exponential' || !b) return (1 - Math.exp(-Di * t)) * 100;
  if (modelType === 'Harmonic' || b === 1) return (1 - 1 / (1 + Di * t)) * 100;
  return (1 - (1 + b * Di * t) ** (-1 / b)) * 100;
}

/**
 * Fit + forecast one well's decline through the canonical engine.
 * Returns { fit, forecast, fitSeries } or { insufficient: true } when
 * under 3 usable points -- never a fake fit.
 */
export function fitWellDecline(points, {
  stream = 'oil', basis = 'producing', modelType = 'Auto-Select',
  window = null, forecastDays = 1825, economicLimit = 0,
} = {}) {
  const fitSeries = rateSeriesForFit(points, stream, basis);
  if (fitSeries.length < 3) return { insufficient: true, fitSeries };
  const fit = fitArpsModel(fitSeries, modelType, window, null);
  if (!fit || !fit.parameters || fit.parameters.modelType === 'None') {
    return { insufficient: true, fitSeries };
  }
  const forecast = generateForecast(
    fit.parameters,
    { forecastDurationDays: forecastDays, economicLimit, stopAtLimit: economicLimit > 0 },
    fit.t0,
  );
  return { fit, forecast, fitSeries };
}
