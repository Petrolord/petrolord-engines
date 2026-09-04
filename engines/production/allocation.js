/**
 * Production back allocation and well-test QC (Production, extracted
 * from the Suite's Production Allocation Studio P3/P6.5 layer).
 *
 * THE PROBLEM. A facility meters ONE commingled stream. The volumes
 * booked against each well are therefore an ALLOCATION, not a
 * measurement, and every barrel a well is credited with came out of an
 * arithmetic split rather than off an instrument. Back allocation
 * distributes the metered total across the wells in proportion to what
 * each was CAPABLE of producing over the period: its latest valid well
 * test, scaled by the hours it was actually on.
 *
 *   theoretical(well, day) = test rate x uptime fraction
 *   factor(phase, day)     = metered total / sum of theoretical
 *   allocated(well, day)   = theoretical x factor
 *
 * THE FACTOR IS THE OUTPUT, NOT AN INTERNAL. A factor of 1.0 means the
 * wells' tests add up to exactly what the facility measured.
 * Persistently high or low factors mean the tests, the meter or the
 * uptime record disagree, and that disagreement is the signal an
 * allocation engineer works from. So NOTHING here silently normalizes a
 * factor to 1, and nothing clamps it into the warning band: the band
 * raises a diagnostic and the number is reported as it fell out.
 *
 * WHAT IS DELIBERATELY NOT INVENTED. A date with no metered total is
 * not allocated at all rather than being filled in. A well with no test
 * in force takes NO share rather than a guessed rate, and says so as a
 * diagnostic. Injectors and observation wells never take a share of
 * produced volumes.
 *
 * CLOSURE. Because every well's share is its theoretical times the one
 * factor for that phase and day, the allocated volumes sum EXACTLY to
 * the metered total whenever a factor exists. That identity is the
 * first thing the gate checks, and it is the property that makes an
 * allocation defensible.
 *
 * UNITS. Field units throughout, as everywhere else in
 * engines/production. They are not converted internally and they are
 * not optional. This module is a LEDGER module, so its primary
 * quantities are VOLUMES over a day, with rates appearing only where a
 * well test states one:
 *
 *   oil / water volume    stb per ledger row (a calendar day)
 *   gas volume            Mscf per ledger row
 *   oil / water test rate stb/d
 *   gas test rate         Mscf/d
 *   hours on stream       h, 0 to 24
 *   tubing head pressure  psia (crossCheckTestsAgainstNodal only)
 *   watercut              a 0-1 fraction, never a percentage
 *   gas-oil ratio         scf/stb
 *   dates                 ISO yyyy-mm-dd, read as UTC midnight
 *
 * WHAT IS INJECTED, AND WHY. `crossCheckTestsAgainstNodal` takes the
 * well-model builder and the node solver as FUNCTIONS. Same discipline
 * as `nodal.solveNodeCore`: the check is about comparing a measured
 * rate against a solved one and about classifying the outcome, and it
 * is checkable without judgement when the solver is a stub whose answer
 * is known. It also lets a consumer hand in its own validated inflow
 * and multiphase traverse rather than have this module invent one.
 *
 * VALIDATION NOTE. Gated against
 * tools/validation/production/oracle_allocation.py through
 * test-data/production/goldens/allocation_cases.json. The oracle is
 * written from the method statement, not by transcribing this file:
 * it splits the metered total as `measured * theoretical_i / sum
 * theoretical` (the share form) where this module multiplies by a
 * precomputed factor; it selects the test in force by building each
 * test's explicit validity interval and bisecting into it where this
 * module scans forward and breaks; and it forms each monthly factor as
 * the THEORETICAL-VOLUME-WEIGHTED MEAN of that month's daily factors
 * where this module divides one month total by another, which is what
 * actually tests the "volume weighted" claim rather than assuming it.
 */

const MS_DAY = 24 * 60 * 60 * 1000;

const dayNumber = (isoDate) => Math.round(new Date(`${isoDate}T00:00:00Z`).getTime() / MS_DAY);

const median = (values) => {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

/** First of the month for an ISO date, as an ISO date. */
export const monthKey = (isoDate) => `${String(isoDate).slice(0, 7)}-01`;

export const PHASES = [
  { key: 'oil', label: 'Oil', unit: 'stb', rateKey: 'oil_rate_stbd', ledgerKey: 'oil_stb', totalKey: 'oil_stb' },
  { key: 'water', label: 'Water', unit: 'stb', rateKey: 'water_rate_stbd', ledgerKey: 'water_stb', totalKey: 'water_stb' },
  { key: 'gas', label: 'Gas', unit: 'Mscf', rateKey: 'gas_rate_mscfd', ledgerKey: 'gas_mscf', totalKey: 'gas_mscf' },
];

export const DEFAULT_ALLOCATION_SETTINGS = {
  basis: 'test',           // 'test' = well test x uptime, 'ledger' = per-well meter proration
  maxTestAgeDays: 180,     // a test older than this no longer carries its well
  useUptime: true,         // scale the test rate by hours_on / 24
  defaultHours: 24,        // hours assumed for a ledger row with no hours_on
  includeInvalidTests: false, // tests failing QC are excluded by default
  factorWarnLow: 0.7,      // factors outside this band are flagged, never clamped
  factorWarnHigh: 1.3,
};

export const DEFAULT_TEST_QC_SETTINGS = {
  minDurationHours: 4,      // shorter tests rarely reach stable flow
  outlierPct: 50,           // deviation from the well's own test history, %
  ledgerTolerancePct: 30,   // deviation from the ledger rate on the test date, %
  watercutTolerancePts: 10, // deviation from the ledger watercut, percentage points
};

// ---- test selection --------------------------------------------------------

/**
 * Group tests by well id, each list date-ascending. Invalid tests are
 * dropped unless includeInvalid is set (the QC flag is the studio's own
 * verdict, so honoring it here is what makes QC mean something).
 */
export function groupTests(tests, { includeInvalid = false } = {}) {
  const byWell = new Map();
  (tests || []).forEach((t) => {
    if (!t?.well_id || !t.test_date) return;
    if (!includeInvalid && t.is_valid === false) return;
    if (!byWell.has(t.well_id)) byWell.set(t.well_id, []);
    byWell.get(t.well_id).push(t);
  });
  byWell.forEach((list) => list.sort((a, b) => (a.test_date < b.test_date ? -1 : 1)));
  return byWell;
}

/**
 * The test that carries a well on `date`: the most recent one on or
 * before it, within maxTestAgeDays. Returns null when the well has no
 * test in force, which EXCLUDES it from that day's allocation rather
 * than assuming a rate for it.
 */
export function testInForce(wellTests, date, maxTestAgeDays = DEFAULT_ALLOCATION_SETTINGS.maxTestAgeDays) {
  if (!wellTests || !wellTests.length) return null;
  const day = dayNumber(date);
  let chosen = null;
  for (const t of wellTests) {
    if (dayNumber(t.test_date) > day) break;
    chosen = t;
  }
  if (!chosen) return null;
  if (Number.isFinite(maxTestAgeDays) && maxTestAgeDays > 0
    && day - dayNumber(chosen.test_date) > maxTestAgeDays) return null;
  return chosen;
}

// ---- allocation ------------------------------------------------------------

const emptyPhases = () => ({ oil: 0, water: 0, gas: 0 });

/**
 * Back-allocate metered field totals across the wells, day by day.
 *
 * Only dates carrying a metered total are allocated; a date with no
 * total is not invented. Injectors and observation wells never take a
 * share of produced volumes.
 *
 * @param {{wells: Array, tests: Array, ledger: Array, totals: Array,
 *   settings: object}} input
 * @returns {{days: Array, wells: Array, totals: object, diagnostics: Array,
 *   settings: object}}
 */
export function computeAllocation({ wells = [], tests = [], ledger = [], totals = [], settings = {} } = {}) {
  const s = { ...DEFAULT_ALLOCATION_SETTINGS, ...settings };
  const producers = wells.filter((w) => w.well_type !== 'injector' && w.well_type !== 'observation');
  const testsByWell = groupTests(tests, { includeInvalid: s.includeInvalidTests });

  // ledger lookup: wellId -> date -> row
  const ledgerByWell = new Map();
  (ledger || []).forEach((r) => {
    const id = r.well_id || r.well?.id;
    if (!id || !r.prod_date) return;
    if (!ledgerByWell.has(id)) ledgerByWell.set(id, new Map());
    ledgerByWell.get(id).set(r.prod_date, r);
  });

  const diagnostics = [];
  const days = [];
  const perWell = new Map();
  const grand = {
    measured: emptyPhases(), theoretical: emptyPhases(), allocated: emptyPhases(), days: 0,
  };

  const sortedTotals = [...(totals || [])]
    .filter((t) => t?.total_date)
    .sort((a, b) => (a.total_date < b.total_date ? -1 : 1));

  sortedTotals.forEach((total) => {
    const date = total.total_date;
    const measured = {
      oil: total.oil_stb || 0,
      water: total.water_stb || 0,
      gas: total.gas_mscf || 0,
    };

    const entries = [];
    producers.forEach((w) => {
      const ledgerRow = ledgerByWell.get(w.id)?.get(date) || null;
      const hours = Number.isFinite(ledgerRow?.hours_on) ? ledgerRow.hours_on : s.defaultHours;
      const uptime = s.useUptime ? Math.max(0, Math.min(24, hours)) / 24 : 1;

      if (s.basis === 'ledger') {
        // Proration on the wells' own meters: the ledger IS the split,
        // reconciled to the facility total.
        if (!ledgerRow) return;
        entries.push({
          wellId: w.id,
          wellName: w.name,
          uptime,
          testId: null,
          testDate: null,
          theoretical: {
            oil: ledgerRow.oil_stb || 0,
            water: ledgerRow.water_stb || 0,
            gas: ledgerRow.gas_mscf || 0,
          },
        });
        return;
      }

      const test = testInForce(testsByWell.get(w.id), date, s.maxTestAgeDays);
      if (!test) {
        diagnostics.push({
          date, wellId: w.id, wellName: w.name, code: 'no_test_in_force', severity: 'medium',
          message: `${w.name} has no valid test within ${s.maxTestAgeDays} days of ${date} and takes no allocation.`,
        });
        return;
      }
      entries.push({
        wellId: w.id,
        wellName: w.name,
        uptime,
        testId: test.id,
        testDate: test.test_date,
        theoretical: {
          oil: (test.oil_rate_stbd || 0) * uptime,
          water: (test.water_rate_stbd || 0) * uptime,
          gas: (test.gas_rate_mscfd || 0) * uptime,
        },
      });
    });

    const theoretical = emptyPhases();
    entries.forEach((e) => {
      theoretical.oil += e.theoretical.oil;
      theoretical.water += e.theoretical.water;
      theoretical.gas += e.theoretical.gas;
    });

    const factors = {};
    PHASES.forEach(({ key }) => {
      if (theoretical[key] > 0) {
        factors[key] = measured[key] / theoretical[key];
      } else {
        factors[key] = null;
        if (measured[key] > 0) {
          diagnostics.push({
            date, code: 'no_basis', severity: 'high',
            message: `${date}: ${measured[key].toLocaleString()} ${key === 'gas' ? 'Mscf' : 'stb'} of ${key} measured with no well capable of carrying it. Nothing allocated.`,
          });
        }
      }
      if (factors[key] != null && (factors[key] < s.factorWarnLow || factors[key] > s.factorWarnHigh)) {
        diagnostics.push({
          date, code: 'factor_out_of_band', severity: 'medium', phase: key, value: factors[key],
          message: `${date}: ${key} factor ${factors[key].toFixed(2)} is outside the ${s.factorWarnLow} to ${s.factorWarnHigh} band.`,
        });
      }
    });

    const allocated = emptyPhases();
    entries.forEach((e) => {
      e.allocated = {
        oil: factors.oil == null ? 0 : e.theoretical.oil * factors.oil,
        water: factors.water == null ? 0 : e.theoretical.water * factors.water,
        gas: factors.gas == null ? 0 : e.theoretical.gas * factors.gas,
      };
      allocated.oil += e.allocated.oil;
      allocated.water += e.allocated.water;
      allocated.gas += e.allocated.gas;

      if (!perWell.has(e.wellId)) {
        perWell.set(e.wellId, {
          wellId: e.wellId,
          wellName: e.wellName,
          days: 0,
          theoretical: emptyPhases(),
          allocated: emptyPhases(),
        });
      }
      const agg = perWell.get(e.wellId);
      agg.days += 1;
      PHASES.forEach(({ key }) => {
        agg.theoretical[key] += e.theoretical[key];
        agg.allocated[key] += e.allocated[key];
      });
    });

    days.push({ date, measured, theoretical, allocated, factors, entries });
    grand.days += 1;
    PHASES.forEach(({ key }) => {
      grand.measured[key] += measured[key];
      grand.theoretical[key] += theoretical[key];
      grand.allocated[key] += allocated[key];
    });
  });

  const wellRows = [...perWell.values()].sort(
    (a, b) => b.allocated.oil - a.allocated.oil || String(a.wellName).localeCompare(String(b.wellName)),
  );

  return { days, wells: wellRows, totals: grand, diagnostics, settings: s };
}

/**
 * Volume-weighted monthly factors per well, the allocation-factor
 * ledger shape. A well's monthly factor is its allocated volume over
 * its theoretical volume for that month, so it carries the mix of days
 * the well was actually on. Months where a well had no theoretical
 * volume for a phase carry a factor of 1 for that phase (nothing to
 * scale) rather than a divide by zero.
 */
export function monthlyFactors(allocation) {
  const byKey = new Map();
  (allocation?.days || []).forEach((day) => {
    const month = monthKey(day.date);
    day.entries.forEach((e) => {
      const key = `${e.wellId}|${month}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          wellId: e.wellId,
          wellName: e.wellName,
          periodMonth: month,
          theoretical: emptyPhases(),
          allocated: emptyPhases(),
        });
      }
      const agg = byKey.get(key);
      PHASES.forEach(({ key: p }) => {
        agg.theoretical[p] += e.theoretical[p];
        agg.allocated[p] += e.allocated[p];
      });
    });
  });

  return [...byKey.values()]
    .map((r) => ({
      ...r,
      factors: {
        oil: r.theoretical.oil > 0 ? r.allocated.oil / r.theoretical.oil : 1,
        water: r.theoretical.water > 0 ? r.allocated.water / r.theoretical.water : 1,
        gas: r.theoretical.gas > 0 ? r.allocated.gas / r.theoretical.gas : 1,
      },
    }))
    .sort((a, b) => (a.periodMonth < b.periodMonth ? -1 : a.periodMonth > b.periodMonth ? 1
      : String(a.wellName).localeCompare(String(b.wellName))));
}

/**
 * Allocated volumes in the daily-ledger shape, ready to be written back
 * to the ledger with source 'allocation'. hours_on is carried through
 * from the uptime that produced the split, so the ledger stays
 * self-consistent.
 */
export function allocatedLedgerRows(allocation) {
  const rows = [];
  (allocation?.days || []).forEach((day) => {
    day.entries.forEach((e) => {
      rows.push({
        wellId: e.wellId,
        date: day.date,
        oil_stb: e.allocated.oil,
        water_stb: e.allocated.water,
        gas_mscf: e.allocated.gas,
        hours_on: allocation.settings?.useUptime ? e.uptime * 24 : null,
      });
    });
  });
  return rows;
}

/**
 * Imbalance between the metered total and the wells' own ledger for
 * each allocated date -- the unaccounted volume an allocation engineer
 * chases. Positive means the meter saw more than the wells booked.
 */
export function imbalanceSeries(allocation, ledger) {
  const byDate = new Map();
  (ledger || []).forEach((r) => {
    if (!r.prod_date) return;
    if (!byDate.has(r.prod_date)) byDate.set(r.prod_date, emptyPhases());
    const d = byDate.get(r.prod_date);
    d.oil += r.oil_stb || 0;
    d.water += r.water_stb || 0;
    d.gas += r.gas_mscf || 0;
  });

  return (allocation?.days || []).map((day) => {
    const booked = byDate.get(day.date) || emptyPhases();
    const out = { date: day.date, factors: day.factors };
    PHASES.forEach(({ key }) => {
      out[key] = {
        measured: day.measured[key],
        booked: booked[key],
        imbalance: day.measured[key] - booked[key],
        imbalancePct: booked[key] > 0 ? ((day.measured[key] - booked[key]) / booked[key]) * 100 : null,
      };
    });
    return out;
  });
}

// ---- well test QC ----------------------------------------------------------

export const TEST_ISSUES = {
  zero_rate: { label: 'No flow', description: 'The test recorded no oil, water or gas.' },
  short_duration: { label: 'Short test', description: 'Below the minimum duration for stabilized flow.' },
  rate_outlier: { label: 'Rate outlier', description: 'Oil rate is far from the well’s own test history.' },
  ledger_mismatch: { label: 'Ledger mismatch', description: 'Test rate disagrees with the ledger rate on the test date.' },
  watercut_mismatch: { label: 'Watercut mismatch', description: 'Test watercut disagrees with the ledger on the test date.' },
  no_ledger: { label: 'No ledger row', description: 'Nothing in the daily ledger for the test date.' },
};

const SEVERITY_RANK = { high: 0, medium: 1, info: 2 };

/**
 * Data QC over a field's well tests. Every check is against data the
 * ledger already holds -- the well's own test history and the daily
 * ledger on the test date -- so the verdict never depends on a well
 * model that may not exist.
 *
 * @param {Array} tests well-test rows (well attached or well_id set)
 * @param {Array} wellSeries buildWellSeries output (./surveillance.js)
 * @returns {Array<{testId, wellId, wellName, testDate, severity, issues}>}
 */
export function validateWellTests(tests, wellSeries = [], settings = {}) {
  const s = { ...DEFAULT_TEST_QC_SETTINGS, ...settings };
  const pointsByWell = new Map();
  (wellSeries || []).forEach(({ well, points }) => {
    const byDate = new Map();
    points.forEach((p) => byDate.set(p.date, p));
    pointsByWell.set(well.id, byDate);
  });
  const nameById = new Map((wellSeries || []).map(({ well }) => [well.id, well.name]));

  const byWell = new Map();
  (tests || []).forEach((t) => {
    if (!t?.well_id) return;
    if (!byWell.has(t.well_id)) byWell.set(t.well_id, []);
    byWell.get(t.well_id).push(t);
  });
  byWell.forEach((list) => list.sort((a, b) => (a.test_date < b.test_date ? -1 : 1)));

  const results = [];
  byWell.forEach((list, wellId) => {
    list.forEach((t, i) => {
      const issues = [];
      const oil = t.oil_rate_stbd || 0;
      const water = t.water_rate_stbd || 0;
      const gas = t.gas_rate_mscfd || 0;

      if (oil + water + gas <= 0) {
        issues.push({ code: 'zero_rate', severity: 'high', message: 'The test recorded no flow at all.' });
      }
      if (Number.isFinite(t.duration_hours) && t.duration_hours < s.minDurationHours) {
        issues.push({
          code: 'short_duration', severity: 'medium',
          message: `${t.duration_hours} h test, under the ${s.minDurationHours} h minimum for stabilized flow.`,
        });
      }

      // Against the well's own history: the median of its earlier tests.
      const priorOil = list.slice(0, i).map((p) => p.oil_rate_stbd || 0).filter((v) => v > 0);
      if (priorOil.length >= 3 && oil > 0) {
        const base = median(priorOil);
        const dev = Math.abs((oil - base) / base) * 100;
        if (dev >= s.outlierPct) {
          issues.push({
            code: 'rate_outlier', severity: dev >= s.outlierPct * 2 ? 'high' : 'medium',
            message: `Oil ${Math.round(oil).toLocaleString()} stb/d is ${Math.round(dev)}% off this well's ${Math.round(base).toLocaleString()} stb/d test median.`,
          });
        }
      }

      // Against the ledger on the test date (producing-day basis, so a
      // part-day test is compared like for like).
      const point = pointsByWell.get(wellId)?.get(t.test_date);
      if (!point) {
        issues.push({ code: 'no_ledger', severity: 'info', message: 'No daily ledger row on the test date to cross-check against.' });
      } else {
        const ledgerOil = Number.isFinite(point.oilPd) ? point.oilPd : point.oil;
        if (oil > 0 && Number.isFinite(ledgerOil) && ledgerOil > 0) {
          const dev = Math.abs((oil - ledgerOil) / ledgerOil) * 100;
          if (dev >= s.ledgerTolerancePct) {
            issues.push({
              code: 'ledger_mismatch', severity: dev >= s.ledgerTolerancePct * 2 ? 'high' : 'medium',
              message: `Test oil ${Math.round(oil).toLocaleString()} stb/d against ${Math.round(ledgerOil).toLocaleString()} stb/d in the ledger, ${Math.round(dev)}% apart.`,
            });
          }
        }
        const testWatercut = oil + water > 0 ? water / (oil + water) : null;
        if (testWatercut != null && point.watercut != null) {
          const pts = Math.abs(testWatercut - point.watercut) * 100;
          if (pts >= s.watercutTolerancePts) {
            issues.push({
              code: 'watercut_mismatch', severity: 'medium',
              message: `Test watercut ${(testWatercut * 100).toFixed(0)}% against ${(point.watercut * 100).toFixed(0)}% in the ledger.`,
            });
          }
        }
      }

      if (!issues.length) return;
      const severity = issues.reduce(
        (worst, is) => (SEVERITY_RANK[is.severity] < SEVERITY_RANK[worst] ? is.severity : worst),
        'info',
      );
      results.push({
        testId: t.id,
        wellId,
        wellName: t.well?.name || nameById.get(wellId) || 'Unknown well',
        testDate: t.test_date,
        severity,
        issues,
      });
    });
  });

  return results.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || (a.testDate < b.testDate ? 1 : -1));
}

// ---- the nodal cross-check -------------------------------------------------
//
// The strongest test QC there is, and the one that needs a well model.
// A well test records a rate and a tubing head pressure. Feed that
// pressure to the well's own model, solve the node where inflow meets
// outflow, and the rate that falls out is what the well SHOULD have
// made at that wellhead pressure. A test that disagrees badly with its
// own well is either a bad test or a well that has changed, and both
// are worth knowing before that test is used to allocate a month of
// production.
//
// It is kept OUT of validateWellTests deliberately. Every check in
// there is arithmetic on rows already in memory; this one marches a
// multiphase traverse per rate per test, so it is an explicit run a
// consumer asks for rather than something that happens on every render.

/** How far a test may sit from its well's nodal solution before it is flagged. */
export const DEFAULT_NODAL_CHECK_SETTINGS = {
  tolerancePct: 35,   // deviation from the nodal rate, %
  minRateStbd: 1,     // below this a percentage deviation says nothing
};

/**
 * Cross-check well tests against each well's own nodal model.
 *
 * @param {object} args
 * @param {Array}  args.tests       well-test rows
 * @param {Map}    args.wellModels  wellId -> well-model INPUTS
 * @param {Function} args.buildModel  builds a solvable model from those
 *                                  inputs, injected so this module has
 *                                  no import cycle and is testable with
 *                                  a stub
 * @param {Function} args.solveNode   the node solver, same reason
 * @param {object} [args.settings]
 *
 * returns [{ testId, wellId, wellName, testDate, measuredStbd,
 *            nodalStbd, deviationPct, status, message }]
 *
 * `status` is one of:
 *   'ok'        the test agrees with the well's model
 *   'off'       it does not, by more than the tolerance
 *   'dead'      the model says the well should not flow at that pressure
 *   'no-model'  the well has no model to check against
 *   'no-thp'    the test recorded no tubing head pressure
 */
export function crossCheckTestsAgainstNodal({
  tests, wellModels, buildModel, solveNode, settings = {},
}) {
  const s = { ...DEFAULT_NODAL_CHECK_SETTINGS, ...settings };
  const built = new Map();
  const results = [];

  (tests || []).forEach((t) => {
    if (!t?.well_id) return;
    const wellName = t.well?.name || 'Unknown well';
    const base = {
      testId: t.id, wellId: t.well_id, wellName, testDate: t.test_date,
      measuredStbd: t.oil_rate_stbd || 0,
    };

    const inputs = wellModels?.get ? wellModels.get(t.well_id) : null;
    if (!inputs) {
      results.push({
        ...base, nodalStbd: null, deviationPct: null, status: 'no-model',
        message: 'This well has no model on the spine, so there is nothing to check the test against. Save one from any of the lift studios.',
      });
      return;
    }
    const thp = Number(t.thp_psia);
    if (!Number.isFinite(thp) || thp <= 0) {
      results.push({
        ...base, nodalStbd: null, deviationPct: null, status: 'no-thp',
        message: 'The test recorded no tubing head pressure, and the nodal solution is found at that pressure.',
      });
      return;
    }

    if (!built.has(t.well_id)) built.set(t.well_id, buildModel(inputs));
    const model = built.get(t.well_id);
    if (!model) {
      results.push({
        ...base, nodalStbd: null, deviationPct: null, status: 'no-model',
        message: 'This well\'s saved model is not complete enough to solve.',
      });
      return;
    }

    // The test's OWN conditions, not the model's: a well model holds
    // what the well is, and the test says what it was doing that day.
    const oil = t.oil_rate_stbd || 0;
    const water = t.water_rate_stbd || 0;
    const gas = t.gas_rate_mscfd || 0;
    const liquid = oil + water;
    const rates = {
      wct: liquid > 0 ? water / liquid : (model.vlp.rates?.wct ?? 0),
      gor: oil > 0 && gas > 0 ? (gas * 1000) / oil : 0,
    };

    let solved = null;
    try {
      solved = solveNode({ ipr: model.ipr, vlp: { ...model.vlp, whp: thp, rates } });
    } catch (e) {
      results.push({
        ...base, nodalStbd: null, deviationPct: null, status: 'no-model',
        message: `The nodal solution could not be found: ${e.message}`,
      });
      return;
    }

    if (!solved?.op) {
      results.push({
        ...base,
        nodalStbd: null,
        deviationPct: null,
        status: 'dead',
        message: `At ${Math.round(thp)} psia wellhead this well's model does not flow, yet the test recorded ${Math.round(oil).toLocaleString()} stb/d. Either the model is wrong or the test is.`,
      });
      return;
    }

    const nodal = solved.op.q;
    if (!(oil > s.minRateStbd) || !(nodal > s.minRateStbd)) {
      results.push({
        ...base, nodalStbd: nodal, deviationPct: null, status: 'ok',
        message: 'Both the test and the model are near zero; a percentage comparison would say nothing.',
      });
      return;
    }
    const deviationPct = ((oil - nodal) / nodal) * 100;
    const off = Math.abs(deviationPct) >= s.tolerancePct;
    results.push({
      ...base,
      nodalStbd: nodal,
      deviationPct,
      status: off ? 'off' : 'ok',
      message: off
        ? `Test ${Math.round(oil).toLocaleString()} stb/d against a nodal ${Math.round(nodal).toLocaleString()} stb/d at ${Math.round(thp)} psia, ${Math.round(Math.abs(deviationPct))}% ${deviationPct > 0 ? 'above' : 'below'}. Check the test, the wellhead pressure, or whether the well's model is still current.`
        : `Test ${Math.round(oil).toLocaleString()} stb/d against a nodal ${Math.round(nodal).toLocaleString()} stb/d, within tolerance.`,
    });
  });

  const RANK = { dead: 0, off: 1, 'no-thp': 2, 'no-model': 3, ok: 4 };
  return results.sort((a, b) => RANK[a.status] - RANK[b.status]
    || Math.abs(b.deviationPct || 0) - Math.abs(a.deviationPct || 0));
}
