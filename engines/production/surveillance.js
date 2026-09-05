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
 * WELL TYPE IS CLASSIFIED ONCE, AT THE DOOR. `classifyWellType` is the
 * only place a `well_type` string is read. It lower-cases and trims,
 * then matches the injector set {injector, water_injector, gas_injector,
 * wag_injector}, the observation set and the producer set. A type that
 * matches none of them, and a well with no type at all, is NOT quietly
 * read as a producer: it is left out of the population and it raises a
 * record in `dataExceptions`, because a mistyped injector read as a
 * producer is surveilled against the wrong rate entirely.
 *
 * THE TWO POPULATIONS ARE DIFFERENT, AND BOTH ARE NAMED.
 * `detectExceptions` surveils every well with points except the
 * observation wells, so an injector is IN. `computeKpis` counts as a
 * producer every well except the injectors, so an observation well is
 * IN. Those are two different sets of the same size on a field with one
 * injector and one observation well, which is why each function returns
 * its `population` as a list of well ids and a `populationFilter`
 * naming the rule that built it. Reconciling the two would move a
 * number a shipped studio prints and is not done here.
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
 * NOTHING HERE READS THE WALL CLOCK. `detectExceptions` and
 * `computeKpis` anchor on the field's own latest ledger date.
 * `summarizeDeferments` cannot derive an anchor from the events alone,
 * because an open event has no end date, so it REQUIRES `asOf` from its
 * caller and refuses without it. Substituting today's date there made
 * the same call answer differently tomorrow.
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

// ---- well type, classified once at the door --------------------------------

/** The only strings read as an injector. Exact after lower-casing and
 *  trimming; nothing else is inferred from a substring. */
export const INJECTOR_WELL_TYPES = Object.freeze([
  'injector', 'water_injector', 'gas_injector', 'wag_injector',
]);
/** Wells that carry no rates of their own to surveil. */
export const OBSERVATION_WELL_TYPES = Object.freeze(['observation']);
/** Wells surveilled on their oil rate. */
export const PRODUCER_WELL_TYPES = Object.freeze(['producer']);

/**
 * Read a `well_type` once, for every consumer in this module.
 *
 * @param {*} wellType the raw value off the well record
 * @returns {{role: ?string, normalized: ?string}} `role` is one of
 *   'injector', 'observation', 'producer', or null when the value is
 *   absent or is not a recognised type. A null role is never treated as
 *   a producer; the caller raises a data exception instead.
 */
export function classifyWellType(wellType) {
  if (typeof wellType !== 'string') return { role: null, normalized: null };
  const normalized = wellType.trim().toLowerCase();
  if (!normalized) return { role: null, normalized: null };
  if (INJECTOR_WELL_TYPES.includes(normalized)) return { role: 'injector', normalized };
  if (OBSERVATION_WELL_TYPES.includes(normalized)) return { role: 'observation', normalized };
  if (PRODUCER_WELL_TYPES.includes(normalized)) return { role: 'producer', normalized };
  return { role: null, normalized };
}

const unknownTypeException = (well, normalized) => ({
  code: 'unknownWellType',
  wellId: well?.id ?? null,
  wellName: well?.name ?? null,
  value: normalized,
  message: normalized
    ? `${well?.name ?? 'A well'} is typed "${normalized}", which is not a recognised producer, injector or observation type. It is left out of this population rather than read as a producer.`
    : `${well?.name ?? 'A well'} has no well type recorded. It is left out of this population rather than read as a producer.`,
});

// ---- series building -------------------------------------------------------

/**
 * Derived per-row quantities. Producing-day rates honestly reflect
 * hours_on: 0 hours means shut in (rate null, not Infinity); missing
 * hours means uptime is unknown and the producing-day rate equals the
 * calendar-day volume. `winjPd` is the injection equivalent, so an
 * injector's message can quote a producing-day rate the same way a
 * producer's does.
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
    winjPd: pd(winj),
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

/**
 * Field-level daily totals with derived watercut/GOR and an on-count.
 *
 * `oilPerWell` is the per-well oil rate for the day, and it is NULL
 * whenever `wellsOn` is zero. A day carrying volume with no well counted
 * on is a ledger contradiction (volumes recorded against zero hours),
 * and dividing by that zero would print Infinity as a record rate.
 * `computeKpis` raises `volumesWithoutHours` when it meets one.
 */
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
      oilPerWell: d.wellsOn > 0 ? d.oil / d.wellsOn : null,
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

/**
 * Stride-decimate a long series for charting; always keeps the last
 * point. Under maxPoints, the input comes back untouched.
 *
 * THE CAP IS A CAP. The stride is taken over the INTERVALS, not the
 * points, so the slot the last point is always appended into is
 * reserved before the stride is chosen. Striding on `length / maxPoints`
 * returned maxPoints + 1 points whenever the appended last point did not
 * already fall on the stride: 1501 points off a 3000 point series
 * against a cap of 1500.
 */
export function decimate(points, maxPoints = 1500) {
  if (!points) return [];
  if (!Number.isFinite(maxPoints) || maxPoints < 1) {
    return {
      ok: false,
      code: 'invalidMaxPoints',
      error: `decimate needs a finite maxPoints of at least 1, received ${maxPoints}.`,
    };
  }
  if (points.length <= maxPoints) return points;
  if (maxPoints < 2) return [points[points.length - 1]];
  const stride = Math.ceil((points.length - 1) / (maxPoints - 1));
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
  downtimeHours: 20,    // mean hours-on below this flags downtime
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
 * A ratio over a window taken VOLUMETRICALLY: the sum of the numerator
 * over the sum of the denominator, which is what a period watercut or a
 * period gas-oil ratio means.
 *
 * The mean of the daily ratios is a different quantity and is biased by
 * low-rate days: a day making 2 stb of oil and 8 of water counts as
 * heavily in it as a day making 200 and 800, so a well that goes
 * intermittent looks like a well that has watered out. `computeKpis`
 * has always been volumetric; `detectExceptions` was not, and the two
 * disagreed about the same well. Item 18.
 *
 * Returns NaN when the denominator over the window is not positive,
 * which is the same "no answer" a mean of no points gives.
 */
const windowVolumetricRatio = (points, numeratorKeys, denominatorKeys, fromDay, toDay) => {
  let num = 0;
  let den = 0;
  let count = 0;
  points.forEach((p) => {
    const day = dayNumber(p.date);
    if (!(day > fromDay && day <= toDay)) return;
    const n = numeratorKeys.reduce((a, k) => a + (Number.isFinite(p[k]) ? p[k] : 0), 0);
    const dsum = denominatorKeys.reduce((a, k) => a + (Number.isFinite(p[k]) ? p[k] : 0), 0);
    if (!denominatorKeys.every((k) => Number.isFinite(p[k]))) return;
    num += n;
    den += dsum;
    count += 1;
  });
  return { ratio: den > 0 ? num / den : NaN, count, numerator: num, denominator: den };
};

/** What `detectExceptions` surveils, stated in the return so the count
 *  can never be confused with the one `computeKpis` reports. */
export const EXCEPTION_POPULATION_FILTER = 'Every well with ledger points whose type is a recognised producer or injector type. Observation wells are excluded because they carry no rates of their own, so an injector IS surveilled here.';

/**
 * Exception surveillance over a field's well series. All windows anchor
 * on the FIELD's latest ledger date (never the wall clock, so old
 * datasets surveil honestly). Monthly ledgers widen the windows to
 * cover enough points instead of silently comparing single days.
 *
 * The surveilled set is returned as `population` (well ids) beside
 * `populationFilter`, which states the rule that built it. It is NOT
 * the same set `computeKpis` counts as producers.
 *
 * @returns {{asOf: ?string, exceptions: Array<{wellId, wellName, type,
 *   severity, value, baseline, message}>, population: Array<string>,
 *   populationFilter: string, dataExceptions: Array}}
 */
export function detectExceptions(wellSeries, settings = {}) {
  const s = { ...DEFAULT_SURVEILLANCE_SETTINGS, ...settings };
  // Well type is read exactly once, here. Observation wells carry no
  // rates of their own to surveil; a type that is not recognised at all
  // is NOT read as a producer, because surveilling a mistyped injector
  // on its oil rate compares it against a rate it never had.
  const dataExceptions = [];
  const all = [];
  (wellSeries || []).forEach((w) => {
    const { role, normalized } = classifyWellType(w.well?.well_type);
    if (role === null) {
      dataExceptions.push(unknownTypeException(w.well, normalized));
      return;
    }
    if (role === 'observation') return;
    if (!w.points.length) return;
    all.push({ ...w, isInjector: role === 'injector' });
  });
  const population = all.map((w) => w.well.id);
  if (!all.length) {
    return {
      asOf: null,
      exceptions: [],
      population,
      populationFilter: EXCEPTION_POPULATION_FILTER,
      dataExceptions,
    };
  }

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

  all.forEach(({ well, points, isInjector }) => {
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

    // TWO BASES, AND EACH TEST TAKES THE ONE THAT ANSWERS ITS QUESTION.
    // The calendar mean answers "did this well stop": a well that made
    // nothing all week made nothing, whatever its hours say. The
    // producing-day rate answers "did this well weaken": a well cut back
    // to twelve hours a day halves its calendar volume without its rate
    // moving at all, and reading the change off calendar volumes calls
    // that a fifty percent decline. That is item 73, and the well the
    // engineer has to look at is the one whose RATE fell.
    const rateKey = isInjector ? 'winj' : 'oil';
    const recent = windowMean(points, rateKey, asOfDay - recentDays, asOfDay);
    const base = windowMean(points, rateKey, asOfDay - recentDays - baselineDays, asOfDay - recentDays);
    const pdKey = isInjector ? 'winjPd' : 'oilPd';
    const recentPd = windowMean(points, pdKey, asOfDay - recentDays, asOfDay);
    const basePd = windowMean(points, pdKey, asOfDay - recentDays - baselineDays, asOfDay - recentDays);
    const rate = (m) => (Number.isFinite(m)
      ? `${Math.round(m).toLocaleString()} stb/d`
      : 'no producing day rate on record');
    const vol = (m) => (Number.isFinite(m)
      ? `${Math.round(m).toLocaleString()} stb a day`
      : 'no calendar volume on record');
    if (base.count && recent.count && base.mean >= s.minOilRate) {
      if (recent.mean <= 0) {
        push(well, 'shut_in', 'high', 0, base.mean,
          `${isInjector ? 'Injection' : 'Production'} stopped. Baseline producing day rate ${rate(basePd.mean)} of ${isInjector ? 'water' : 'oil'}.`);
      } else if (basePd.count && recentPd.count && basePd.mean >= s.minOilRate) {
        const drop = ((basePd.mean - recentPd.mean) / basePd.mean) * 100;
        if (drop >= s.rateDropPct) {
          // The calendar clause is added only when the two bases
          // disagree, because on a well that ran full hours they are the
          // same number twice and saying it twice reads as two findings.
          const calendarDrop = ((base.mean - recent.mean) / base.mean) * 100;
          const bases = Math.abs(calendarDrop - drop) >= 1
            ? ` Calendar volumes fell ${pct(calendarDrop)} over the same windows, ${vol(recent.mean)} against ${vol(base.mean)}, so part of this is hours and part is rate.`
            : '';
          push(well, isInjector ? 'injection_drop' : 'rate_drop',
            drop >= s.rateDropPct * 2 ? 'high' : 'medium', recentPd.mean, basePd.mean,
            `${isInjector ? 'Water injection' : 'Oil'} down ${pct(drop)} on producing day rates: ${rate(recentPd.mean)} against a ${rate(basePd.mean)} baseline.${bases}`);
        }
      } else if (!basePd.count || !recentPd.count) {
        // The rate test cannot be run on a well with no hours recorded,
        // and the calendar volumes are not a substitute for it. It is
        // said once, as a data exception, rather than silently skipped
        // or answered on the other basis.
        dataExceptions.push({
          code: 'rateChangeWithoutHours',
          wellId: well.id,
          wellName: well.name,
          value: null,
          message: `${well.name} has ledger volumes but no hours on stream over one of the comparison windows, so the change in its rate could not be tested. Calendar volumes alone cannot tell a well that weakened from one that was cut back.`,
        });
      }
    }

    if (!isInjector) {
      // Item 18. Volumetric, total over total, the same way computeKpis
      // forms it, so the two functions describe the same well the same
      // way.
      const wcRecent = windowVolumetricRatio(points, ['water'], ['oil', 'water'], asOfDay - recentDays, asOfDay);
      const wcBase = windowVolumetricRatio(points, ['water'], ['oil', 'water'], asOfDay - recentDays - baselineDays, asOfDay - recentDays);
      if (wcRecent.count && wcBase.count
        && Number.isFinite(wcRecent.ratio) && Number.isFinite(wcBase.ratio)) {
        const risePts = (wcRecent.ratio - wcBase.ratio) * 100;
        if (risePts >= s.watercutRisePts) {
          push(well, 'watercut_rise', risePts >= s.watercutRisePts * 2 ? 'high' : 'medium',
            wcRecent.ratio, wcBase.ratio,
            `Watercut up ${risePts.toFixed(0)} points on period volumes: ${(wcRecent.ratio * 100).toFixed(0)}% vs ${(wcBase.ratio * 100).toFixed(0)}% baseline.`);
        }
      }

      // Item 18 again. Gas is Mscf and oil is stb, so the volumetric
      // ratio carries the same 1000 the per-row one does.
      const gorRecentVol = windowVolumetricRatio(points, ['gas'], ['oil'], asOfDay - recentDays, asOfDay);
      const gorBaseVol = windowVolumetricRatio(points, ['gas'], ['oil'], asOfDay - recentDays - baselineDays, asOfDay - recentDays);
      const gorRecent = { count: gorRecentVol.count, ratio: gorRecentVol.ratio * 1000 };
      const gorBase = { count: gorBaseVol.count, ratio: gorBaseVol.ratio * 1000 };
      if (gorRecent.count && gorBase.count && gorBase.ratio > 0
        && Number.isFinite(gorRecent.ratio)
        && (base.mean == null || base.mean >= s.minOilRate)) {
        const rise = ((gorRecent.ratio - gorBase.ratio) / gorBase.ratio) * 100;
        if (rise >= s.gorRisePct) {
          push(well, 'gor_rise', rise >= s.gorRisePct * 2 ? 'high' : 'medium',
            gorRecent.ratio, gorBase.ratio,
            `GOR up ${pct(rise)} on period volumes: ${Math.round(gorRecent.ratio).toLocaleString()} vs ${Math.round(gorBase.ratio).toLocaleString()} scf/stb baseline.`);
        }
      }

      // Item 79, first half. The `hrs.mean > 0` clause meant a well
      // averaging exactly 0.00 hours on stream was the one well that
      // could never be reported for downtime: the worst case the check
      // exists for was the case it excluded. It is gone, and the golden
      // carries the exception it raises.
      const hrs = windowMean(points, 'hoursOn', asOfDay - recentDays, asOfDay);
      if (hrs.count && hrs.mean < s.downtimeHours) {
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
  return {
    asOf,
    exceptions,
    population,
    populationFilter: EXCEPTION_POPULATION_FILTER,
    dataExceptions,
  };
}

// ---- deferments and KPIs ---------------------------------------------------

/**
 * Roll up deferment events: per-category counts, event-days and
 * deferred volumes, worst category first (by oil). Open events accrue
 * days to `asOf`, which is the field's latest ledger date.
 *
 * `asOf` IS REQUIRED. An open event has no end date, so the anchor is
 * what decides how many days it has run, and reading it off the wall
 * clock made the same call on the same data answer differently
 * tomorrow. Refuses with `missingAsOf` when it is absent and
 * `unreadableAsOf` when it is not an ISO date, and returns the anchor
 * it used so the reader can see what the roll-up was measured to.
 */
export function summarizeDeferments(deferments, asOf) {
  if (typeof asOf !== 'string' || !asOf.trim()) {
    return {
      ok: false,
      code: 'missingAsOf',
      error: 'summarizeDeferments needs an asOf date, because an open deferment accrues days up to it. Pass the field ledger\'s latest date as an ISO yyyy-mm-dd string.',
    };
  }
  const asOfDay = dayNumber(asOf);
  if (!Number.isFinite(asOfDay)) {
    return {
      ok: false,
      code: 'unreadableAsOf',
      error: `summarizeDeferments could not read the asOf date "${asOf}". It must be an ISO yyyy-mm-dd string.`,
    };
  }
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
  return { asOf, byCategory, totals, openCount };
}

/** What `computeKpis` counts as a producer, stated in the return so the
 *  count can never be confused with the one `detectExceptions`
 *  surveils. */
export const KPI_POPULATION_FILTER = 'Every well in the series whose type is a recognised producer or observation type. Injectors are excluded from the producer count and from uptime, so an observation well IS counted here.';

/**
 * Field KPIs over the trailing `windowDays` of the field series: mean
 * daily rates, watercut, GOR and (where hours_on was reported) uptime.
 *
 * The watercut and GOR here are VOLUMETRIC over the window, a ratio of
 * the window means, which is what a period ratio means and is NOT what
 * detectExceptions compares against a baseline. See the seam note in
 * the module header.
 *
 * `producerCount` counts the wells in `population`, and
 * `populationFilter` states the rule that built it. It is NOT the set
 * `detectExceptions` surveils: this one keeps the observation wells and
 * drops the injectors, and that one does the reverse.
 *
 * `oilPerWell` is the window's mean oil rate per well on stream, and it
 * is NULL when no well was counted on. A window carrying oil with no
 * well on raises `volumesWithoutHours` in `dataExceptions` rather than
 * dividing by that zero.
 */
export function computeKpis(wellSeries, fieldSeries, { windowDays = 7 } = {}) {
  if (!fieldSeries || !fieldSeries.length) return null;
  const asOf = fieldSeries[fieldSeries.length - 1].date;
  const fromDay = dayNumber(asOf) - windowDays + 1;
  const window = fieldSeries.filter((d) => dayNumber(d.date) >= fromDay);

  // Well type is read exactly once, here. An unrecognised or absent
  // type is not counted as a producer; it raises a data exception.
  const dataExceptions = [];
  const counted = [];
  (wellSeries || []).forEach((w) => {
    const { role, normalized } = classifyWellType(w.well?.well_type);
    if (role === null) {
      dataExceptions.push(unknownTypeException(w.well, normalized));
      return;
    }
    if (role === 'injector') return;
    counted.push(w);
  });

  let hoursSum = 0;
  let hoursSlots = 0;
  counted.forEach(({ points }) => {
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
  const wellsOn = mean(window.map((d) => d.wellsOn));
  const volumeInWindow = window.some((d) => (d.oil || 0) + (d.water || 0) + (d.gas || 0) > 0);
  if (volumeInWindow && !(Number.isFinite(wellsOn) && wellsOn > 0)) {
    dataExceptions.push({
      code: 'volumesWithoutHours',
      wellId: null,
      wellName: null,
      value: oil,
      message: `The ${windowDays} day window to ${asOf} carries produced volume with no well counted on stream, so hours on stream contradict the volumes. The per-well rate is not reported.`,
    });
  }
  return {
    asOf,
    windowDays,
    oil, water, gas,
    winj: mean(window.map((d) => d.winj)),
    liquid: oil != null && water != null ? oil + water : null,
    watercut: oil + water > 0 ? water / (oil + water) : null,
    gor: oil > 0 ? (gas * 1000) / oil : null,
    wellsOn,
    oilPerWell: Number.isFinite(wellsOn) && wellsOn > 0 && Number.isFinite(oil)
      ? oil / wellsOn
      : null,
    uptimePct: hoursSlots ? (hoursSum / (hoursSlots * 24)) * 100 : null,
    wellCount: (wellSeries || []).length,
    producerCount: counted.length,
    population: counted.map((w) => w.well.id),
    populationFilter: KPI_POPULATION_FILTER,
    dataExceptions,
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
 *
 * THE FAMILY IS CHOSEN BY modelType, NEVER BY A BROKEN b. The old guard
 * was `modelType === 'Exponential' || !b`, and `!NaN` is true, so a
 * hyperbolic call carrying b as NaN, null or undefined silently
 * returned the EXPONENTIAL answer: at Di = 0.0015 per day that is
 * 42.16 per cent, a number a reviewer has seen before and would not
 * question. A negative b raised a negative bracket to a power and
 * returned a number too. A hyperbolic fit whose exponent cannot be read
 * has no answer, so it refuses with `invalidDeclineExponent` rather
 * than borrowing another family's.
 */
export function annualEffectiveDecline(Di, b, modelType) {
  if (!Number.isFinite(Di) || Di <= 0) return null;
  const t = 365;
  if (modelType === 'Exponential') return (1 - Math.exp(-Di * t)) * 100;
  if (modelType === 'Harmonic') return (1 - 1 / (1 + Di * t)) * 100;
  if (!Number.isFinite(b) || b <= 0) {
    return {
      ok: false,
      code: 'invalidDeclineExponent',
      error: `A ${modelType || 'hyperbolic'} decline needs a finite b greater than zero, received ${b}. The effective decline is not reported.`,
    };
  }
  if (b === 1) return (1 - 1 / (1 + Di * t)) * 100;
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
