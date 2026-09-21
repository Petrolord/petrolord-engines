// Well cost & time engine (Drilling D11): activity-based time-depth
// estimation and AFE-grade cost rollup, all DETERMINISTIC closed forms.
//
// Probabilistics are deliberately NOT here: the Suite samples activity
// and cost uncertainties with its canonical Monte Carlo module
// (src/lib/monteCarlo.js, the CLAUDE.md single-implementation rule) and
// calls these evaluators once per realization. Keeping the engine pure
// makes every published percentile reproducible from the sampled inputs.
//
// Model
//   * A drilling program is an ORDERED list of activities:
//       drill   { fromMdM, toMdM, ropMPerHr }        t = Δmd / ROP
//       trip    { mdM, tripSpeedMPerHr }             t = 2·md / v  (round trip)
//       casing  { mdM, runSpeedMPerHr, flatHr }      t = md / v + flat
//       flat    { durationHr }                       t = duration
//     Hole depth only advances during drill activities, so the
//     time-depth curve is piecewise linear between activity boundaries
//     (the classic drilling curve: sloped while drilling, vertical
//     while flat).
//   * Non-productive time is a single uniform stretch: every activity
//     duration is multiplied by (1 + nptFrac), so nptFrac is a fraction
//     of PRODUCTIVE time, not of total time. The two are different
//     numbers and the difference is not small: nptHr === nptFrac *
//     productiveHr exactly, while the share of ELAPSED time is
//     nptFrac / (1 + nptFrac). A 0.25 allowance is 20 % of the schedule,
//     not 25 %. This header used to say "fraction of total time", which
//     is the reading a planner would act on, and acting on it understates
//     the well: asking for 20 % of elapsed and entering 0.20 gets 16.7 %.
//     Discrete-event NPT belongs to the risk model, not the
//     deterministic base.
//   * AFE items have a basis:
//       per-day    amount = rate · totalDays   (rig, spread, rentals)
//       per-meter  amount = rate · drilledM    (bits, mud, consumables)
//       lump       amount = value              (wellhead, casing, jobs)
//     and a category (tangible | intangible). Contingency is a fraction
//     of the base subtotal, kept as its own line (AFE convention).
//   * The cumulative cost-time curve accrues per-day items linearly in
//     time, per-meter items with drilled length, and lump items as a
//     step at the end of their linked activity (at spud when unlinked).
//     Identity: the final point equals the base subtotal exactly
//     (contingency is a provision, not an accrual).
//   * costPerMeter is the classic drilling cost-per-depth formula
//     (Bourgoyne et al., Applied Drilling Engineering ch.1):
//       C = (C_bit + C_rig·(t_drill + t_conn + t_trip)) / Δmd
//     (armed literature gate L21 replays the published worked example
//     once the owner supplies the PDF).
//
// Units: m, hours (days = hr/24), USD. Depth is MD along hole.
// Validation: independent oracle (oracle_wellcost.py) goldens +
// __tests__/drilling.wellcost.test.js; suite gates A32/A33.

const HOURS_PER_DAY = 24;

export const ACTIVITY_KINDS = ['drill', 'trip', 'casing', 'flat'];
export const COST_BASES = ['per-day', 'per-meter', 'lump'];
export const COST_CATEGORIES = ['tangible', 'intangible'];

function need(cond, msg) {
  if (!cond) throw new Error(msg);
}
const fin = (v) => Number.isFinite(v);

// Productive (un-stretched) duration of one activity, hours.
export function activityDuration(a) {
  switch (a.kind) {
    case 'drill': {
      need(fin(a.fromMdM) && fin(a.toMdM) && a.toMdM > a.fromMdM,
        `drill "${a.label || a.id}": toMdM must exceed fromMdM`);
      need(fin(a.ropMPerHr) && a.ropMPerHr > 0,
        `drill "${a.label || a.id}": ROP must be > 0`);
      return (a.toMdM - a.fromMdM) / a.ropMPerHr;
    }
    case 'trip': {
      need(fin(a.mdM) && a.mdM >= 0, `trip "${a.label || a.id}": mdM must be >= 0`);
      need(fin(a.tripSpeedMPerHr) && a.tripSpeedMPerHr > 0,
        `trip "${a.label || a.id}": trip speed must be > 0`);
      return (2 * a.mdM) / a.tripSpeedMPerHr;
    }
    case 'casing': {
      need(fin(a.mdM) && a.mdM >= 0, `casing "${a.label || a.id}": mdM must be >= 0`);
      need(fin(a.runSpeedMPerHr) && a.runSpeedMPerHr > 0,
        `casing "${a.label || a.id}": run speed must be > 0`);
      const flat = a.flatHr ?? 0;
      need(fin(flat) && flat >= 0, `casing "${a.label || a.id}": flatHr must be >= 0`);
      return a.mdM / a.runSpeedMPerHr + flat;
    }
    case 'flat': {
      need(fin(a.durationHr) && a.durationHr >= 0,
        `flat "${a.label || a.id}": durationHr must be >= 0`);
      return a.durationHr;
    }
    default:
      throw new Error(`Unknown activity kind "${a.kind}".`);
  }
}

// Evaluate the whole program: per-activity schedule rows, the
// time-depth curve breakpoints and the totals.
export function evaluateProgram({ activities, nptFrac = 0 }) {
  need(Array.isArray(activities) && activities.length > 0, 'The program has no activities.');
  need(fin(nptFrac) && nptFrac >= 0, 'nptFrac must be >= 0.');
  const stretch = 1 + nptFrac;

  let tHr = 0;
  let mdM = 0;
  let drilledM = 0;
  const rows = [];
  const curve = [{ tHr: 0, mdM: 0 }];

  activities.forEach((a, i) => {
    if (a.kind === 'drill') {
      need(Math.abs(a.fromMdM - mdM) < 1e-9,
        `drill "${a.label || a.id || i}" starts at ${a.fromMdM} m but the hole is at ${mdM} m.`);
    }
    const productiveHr = activityDuration(a);
    const durationHr = productiveHr * stretch;
    const startHr = tHr;
    const startMdM = mdM;
    tHr += durationHr;
    if (a.kind === 'drill') {
      drilledM += a.toMdM - a.fromMdM;
      mdM = a.toMdM;
    }
    rows.push({
      ...a, index: i, productiveHr, durationHr,
      startHr, endHr: tHr, startMdM, endMdM: mdM, drilledToM: drilledM,
    });
    curve.push({ tHr, mdM });
  });

  const productiveHr = rows.reduce((s, r) => s + r.productiveHr, 0);
  return {
    rows,
    curve,
    totals: {
      productiveHr,
      nptHr: tHr - productiveHr,
      totalHr: tHr,
      totalDays: tHr / HOURS_PER_DAY,
      drilledM,
      tdMdM: mdM,
    },
  };
}

// ---- AFE cost rollup -------------------------------------------------------

function itemAmount(item, { totalDays, drilledM }) {
  need(COST_CATEGORIES.includes(item.category),
    `Cost item "${item.label || item.id}": unknown category "${item.category}".`);
  switch (item.basis) {
    case 'per-day':
      need(fin(item.rate) && item.rate >= 0, `Cost item "${item.label || item.id}": rate must be >= 0.`);
      return item.rate * totalDays;
    case 'per-meter':
      need(fin(item.rate) && item.rate >= 0, `Cost item "${item.label || item.id}": rate must be >= 0.`);
      return item.rate * drilledM;
    case 'lump':
      need(fin(item.value) && item.value >= 0, `Cost item "${item.label || item.id}": value must be >= 0.`);
      return item.value;
    default:
      throw new Error(`Cost item "${item.label || item.id}": unknown basis "${item.basis}".`);
  }
}

export function afeCosts({ items, totalDays, drilledM, contingencyFrac = 0 }) {
  need(Array.isArray(items), 'items must be an array.');
  need(fin(totalDays) && totalDays >= 0, 'totalDays must be >= 0.');
  need(fin(drilledM) && drilledM >= 0, 'drilledM must be >= 0.');
  need(fin(contingencyFrac) && contingencyFrac >= 0, 'contingencyFrac must be >= 0.');

  const byItem = items.map((it) => ({ ...it, amountUsd: itemAmount(it, { totalDays, drilledM }) }));
  const sum = (cat) => byItem.filter((r) => r.category === cat)
    .reduce((s, r) => s + r.amountUsd, 0);
  const tangibleUsd = sum('tangible');
  const intangibleUsd = sum('intangible');
  const baseUsd = tangibleUsd + intangibleUsd;
  const contingencyUsd = contingencyFrac * baseUsd;
  return {
    byItem,
    tangibleUsd,
    intangibleUsd,
    baseUsd,
    contingencyUsd,
    totalUsd: baseUsd + contingencyUsd,
  };
}

// Cumulative base-cost accrual over the program's time-depth curve.
// Points at every activity boundary; the final value equals
// costs.baseUsd exactly (contingency excluded by design).
export function costTimeCurve({ program, items }) {
  const perDayRate = items.filter((i) => i.basis === 'per-day')
    .reduce((s, i) => s + i.rate, 0);
  const perMeterRate = items.filter((i) => i.basis === 'per-meter')
    .reduce((s, i) => s + i.rate, 0);

  // Lump steps: keyed by the END time of the linked activity (spud = 0).
  const lumpAt = new Map();
  for (const it of items) {
    if (it.basis !== 'lump') continue;
    let t = 0;
    if (it.atActivityId != null) {
      const row = program.rows.find((r) => r.id === it.atActivityId);
      need(row, `Lump item "${it.label || it.id}" links unknown activity "${it.atActivityId}".`);
      t = row.endHr;
    }
    lumpAt.set(t, (lumpAt.get(t) ?? 0) + it.value);
  }

  let lumpCum = 0;
  const times = [...lumpAt.keys()].sort((a, b) => a - b);
  const points = [];
  const breakpoints = [{ tHr: 0, drilledM: 0 }].concat(
    program.rows.map((r) => ({ tHr: r.endHr, drilledM: r.drilledToM })),
  );
  let ti = 0;
  for (const bp of breakpoints) {
    while (ti < times.length && times[ti] <= bp.tHr + 1e-12) {
      lumpCum += lumpAt.get(times[ti]);
      ti += 1;
    }
    const usd = (perDayRate * bp.tHr) / HOURS_PER_DAY + perMeterRate * bp.drilledM + lumpCum;
    points.push({ tHr: bp.tHr, usd });
  }
  return points;
}

// Classic drilling cost per unit depth (ADE ch.1 form), USD/m.
export function costPerMeter({ bitCostUsd, rigRateUsdPerHr, drillingHr, connectionHr, tripHr, intervalM }) {
  need(fin(intervalM) && intervalM > 0, 'intervalM must be > 0.');
  for (const [k, v] of Object.entries({ bitCostUsd, rigRateUsdPerHr, drillingHr, connectionHr, tripHr })) {
    need(fin(v) && v >= 0, `${k} must be >= 0.`);
  }
  return (bitCostUsd + rigRateUsdPerHr * (drillingHr + connectionHr + tripHr)) / intervalM;
}

// ---- default program from the shared hole-section spine --------------------

// Build a starter activity program from wp_wellbore_geometry-style hole
// sections (ascending section TDs). Per section: drill, round trip, run
// & cement casing. Front matter: one flat rig-move/spud activity.
export function programFromSections(sections, {
  moveHr = 24,
  ropMPerHr = 15,
  tripSpeedMPerHr = 500,
  casingRunSpeedMPerHr = 400,
  casingFlatHr = 18,
  completionHr = 0,
} = {}) {
  need(Array.isArray(sections) && sections.length > 0, 'No hole sections.');
  const acts = [];
  let n = 0;
  const id = () => { n += 1; return `act-${n}`; };
  if (moveHr > 0) acts.push({ id: id(), kind: 'flat', label: 'Rig move and spud', durationHr: moveHr });
  let prevMd = 0;
  for (const s of sections) {
    need(fin(s.endMdM) && s.endMdM > prevMd,
      `Section "${s.name || s.endMdM}": TDs must be ascending.`);
    const tag = s.name || `${s.endMdM} m section`;
    acts.push({
      id: id(), kind: 'drill', label: `Drill ${tag}`,
      fromMdM: prevMd, toMdM: s.endMdM, ropMPerHr: s.ropMPerHr ?? ropMPerHr,
    });
    acts.push({
      id: id(), kind: 'trip', label: `Round trip at ${s.endMdM} m`,
      mdM: s.endMdM, tripSpeedMPerHr,
    });
    acts.push({
      id: id(), kind: 'casing', label: `Run and cement casing at ${s.endMdM} m`,
      mdM: s.endMdM, runSpeedMPerHr: casingRunSpeedMPerHr, flatHr: casingFlatHr,
    });
    prevMd = s.endMdM;
  }
  if (completionHr > 0) {
    acts.push({ id: id(), kind: 'flat', label: 'Completion and handover', durationHr: completionHr });
  }
  return acts;
}
