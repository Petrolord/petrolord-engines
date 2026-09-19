/**
 * Refinery planning, scheduling and actuals (Midstream & Downstream DS3).
 *
 * DOCTRINE 2, MADE CONCRETE
 *
 * Incumbents sell planning and scheduling as separate products with separate
 * data models. The month's plan lives in one system, what actually happened
 * lives in another, and the two are reconciled by hand in a spreadsheet,
 * badly, several weeks late. By then the month is over and nobody can act on
 * what it says.
 *
 * Here the plan, the schedule and the actuals are the SAME EVENTS in the same
 * shape, distinguished only by which ledger they sit in (see streamModel.js).
 * So the plan cascades into a calendar of dated events, actuals are recorded
 * against the same shape, and variance is a SUBTRACTION rather than a
 * project. That is the whole design.
 *
 * THE PLAN
 *
 * A configuration-level linear programme over the DS0 solver. Choose how much
 * of each crude to run and how hard to run each unit, so as to maximise
 * margin subject to what the units can pass and what the market will take.
 *
 *   maximise   sum(product revenue) - sum(crude cost) - sum(unit operating cost)
 *   subject to a material balance on every stream,
 *              unit capacities and crude availability as bounds,
 *              product demand floors and ceilings as bounds
 *
 * Yield vectors are DATA, not correlations. A refinery's own yields come from
 * its assays and its unit models, and every planning system in the industry
 * carries them as inputs. This one does the same rather than pretending to
 * predict them: the Crude Assay Studio (DS1) is where a crude's straight-run
 * yields come from.
 *
 * WHAT THE STREAM BALANCE SAYS
 *
 * For every stream: what is made of it, less what units consume of it, less
 * what goes into products, must be at least zero. It is an inequality rather
 * than an equality on purpose. A refinery can leave a stream unplaced (it
 * goes to fuel, or to storage, or is sold as is), and forcing equality would
 * make the plan infeasible for the wrong reason. What is left over is
 * reported as surplus rather than hidden.
 */

import { solveLP, LP_STATUS } from '../../lib/lp/simplex.js';
import { LEDGER, EVENT_TYPE, makeEvent, attributeVariance } from './streamModel.js';

/**
 * Numeric coercion that treats ABSENCE as absent.
 *
 * Number(null) is 0 and Number('') is 0, so the obvious implementation turns
 * a missing value into a real zero. That is the exact failure this module
 * family exists to avoid: a sulfur content nobody supplied is not zero
 * sulfur, an emission factor nobody supplied is not zero carbon, and a dip
 * nobody read is not an empty tank. Missing stays missing.
 */
const num = (v, fallback = 0) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Solve the configuration plan.
 *
 * @param {object} p
 * @param {{id,name,cost,available,yields:{[streamId]:number}}[]} p.crudes
 *        `yields` are volume fractions of the crude into each stream.
 * @param {{id,name,capacity,opex,feed:string,yields:{[streamId]:number}}[]} p.units
 *        One unit of throughput consumes one unit of `feed` and makes
 *        `yields` of the streams named.
 * @param {{id,name,price,minDemand,maxDemand,recipe:{[streamId]:number}}[]} p.products
 *        `recipe` is the volume of each stream per unit of product.
 * @param {string[]} p.streams  every stream id in the configuration
 */
export const planRefinery = ({ crudes = [], units = [], products = [], streams = [] }) => {
  if (crudes.length === 0) return { status: 'invalid', error: 'The plan needs at least one crude.' };
  if (products.length === 0) return { status: 'invalid', error: 'The plan needs at least one product to sell.' };

  // MD2-0 input rules. Every one below used to be a silent number.
  //  - A price or cost nobody typed is not zero: a crude with a blank cost
  //    was free, a product with a blank price was worthless, a unit with a
  //    blank operating cost ran for nothing. Each is refused, named.
  //  - A limit nobody typed is no limit; a typed limit is that limit, and
  //    ZERO IS ZERO. `cap > 0 ? cap : Infinity` used to turn a reformer
  //    typed as shut (capacity 0) into an unlimited one, and the default
  //    plan's margin jumped from 21.9 to 32.0 million.
  const given = (v) => !(v === null || v === undefined || v === '' || v === Infinity);
  const label = (x, i, kind) => x.name || x.id || `${kind} ${i + 1}`;
  const missing = [
    ...crudes.filter((cr) => !Number.isFinite(Number(cr.cost)) || !given(cr.cost)).map((cr, i) => `the cost of ${label(cr, i, 'crude')}`),
    ...units.filter((u) => !Number.isFinite(Number(u.opex)) || !given(u.opex)).map((u, i) => `the operating cost of ${label(u, i, 'unit')}`),
    ...products.filter((pr) => !Number.isFinite(Number(pr.price)) || !given(pr.price)).map((pr, i) => `the price of ${label(pr, i, 'product')}`),
  ];
  if (missing.length > 0) {
    return { status: 'invalid', error: `Missing ${missing.join(', ')}. Enter 0 where the value really is zero.`, missing };
  }
  const limit = (v, what) => {
    if (!given(v)) return Infinity;
    const x = Number(v);
    if (!(x >= 0)) throw new RangeError(`${what} must be zero or more; leave it blank for no limit.`);
    return x;
  };
  let lo;
  let hi;
  try {
    lo = [
      ...crudes.map(() => 0),
      ...units.map(() => 0),
      ...products.map((pr) => (given(pr.minDemand) ? limit(pr.minDemand, `${pr.name || pr.id} minimum demand`) : 0)),
    ];
    hi = [
      ...crudes.map((cr) => limit(cr.available, `${cr.name || cr.id} availability`)),
      ...units.map((u) => limit(u.capacity, `${u.name || u.id} capacity`)),
      ...products.map((pr) => limit(pr.maxDemand, `${pr.name || pr.id} maximum demand`)),
    ];
  } catch (e) {
    return { status: 'invalid', error: e.message };
  }
  const crossed = products.filter((pr, i) => lo[crudes.length + units.length + i] > hi[crudes.length + units.length + i]);
  if (crossed.length > 0) {
    return { status: 'invalid', error: `${crossed.map((pr) => pr.name || pr.id).join(', ')} has a minimum demand above its maximum.` };
  }

  const nC = crudes.length;
  const nU = units.length;
  const nP = products.length;
  const n = nC + nU + nP;
  const idx = { crude: (i) => i, unit: (i) => nC + i, product: (i) => nC + nU + i };

  // Maximise margin. Costs are negative contributions to the objective.
  const c = new Array(n).fill(0);
  crudes.forEach((cr, i) => { c[idx.crude(i)] = -num(cr.cost); });
  units.forEach((u, i) => { c[idx.unit(i)] = -num(u.opex); });
  products.forEach((pr, i) => { c[idx.product(i)] = num(pr.price); });


  const A = [];
  const b = [];
  const ops = [];
  const rowMeta = [];

  // Material balance, one row per stream: made - consumed - placed >= 0.
  streams.forEach((streamId) => {
    const row = new Array(n).fill(0);
    crudes.forEach((cr, i) => { row[idx.crude(i)] += num(cr.yields?.[streamId]); });
    units.forEach((u, i) => {
      row[idx.unit(i)] += num(u.yields?.[streamId]);
      if (u.feed === streamId) row[idx.unit(i)] -= 1;
    });
    products.forEach((pr, i) => { row[idx.product(i)] -= num(pr.recipe?.[streamId]); });
    A.push(row);
    b.push(0);
    ops.push('>=');
    rowMeta.push({ kind: 'stream', id: streamId, name: `${streamId} balance` });
  });

  // Every barrel of crude runs through the crude unit. A unit with NO FEED is
  // a crude unit (atmospheric distillation): its throughput is the crude run.
  // Without this row nothing tied the two together, so at the Suite's default
  // plan the crude distillation unit showed 0 throughput and 0 percent
  // utilisation beside 2.9 million barrels of crude, its capacity never bound
  // and its operating cost (1.20 a barrel, 3.5 million over the month) was
  // never charged. Where no unit is feedless the plan has no crude unit and no
  // such row is written, as before.
  const crudeUnits = units.map((u, i) => (u.feed ? null : i)).filter((i) => i !== null);
  if (crudeUnits.length > 0) {
    const row = new Array(n).fill(0);
    crudes.forEach((cr, i) => { row[idx.crude(i)] = 1; });
    crudeUnits.forEach((i) => { row[idx.unit(i)] = -1; });
    A.push(row);
    b.push(0);
    ops.push('=');
    rowMeta.push({ kind: 'crude-unit', id: 'crude', name: 'crude through the crude unit' });
  }

  const lp = solveLP({ c, A, b, ops, lo, hi, maximize: true });

  if (lp.status === LP_STATUS.INFEASIBLE) {
    return {
      status: 'infeasible',
      error: 'No plan satisfies these constraints. A product floor is probably beyond what the crudes and units can make.',
    };
  }
  if (lp.status === LP_STATUS.UNBOUNDED) {
    return { status: 'unbounded', error: 'The plan is unbounded: a product has a price and no demand ceiling, or a crude has no availability limit and no cost.' };
  }
  if (lp.status !== LP_STATUS.OPTIMAL) {
    return { status: lp.status, error: 'The solver did not reach an optimum.' };
  }

  const x = lp.x;
  const crudeRuns = crudes.map((cr, i) => ({
    id: cr.id, name: cr.name, volume: x[idx.crude(i)], cost: x[idx.crude(i)] * num(cr.cost),
  }));
  const unitRuns = units.map((u, i) => ({
    id: u.id, name: u.name, throughput: x[idx.unit(i)],
    capacity: hi[idx.unit(i)],
    utilisation: Number.isFinite(hi[idx.unit(i)]) && hi[idx.unit(i)] > 0 ? x[idx.unit(i)] / hi[idx.unit(i)] : null,
    crudeUnit: !u.feed,
    cost: x[idx.unit(i)] * num(u.opex),
  }));
  const productMakes = products.map((pr, i) => ({
    id: pr.id, name: pr.name, volume: x[idx.product(i)], revenue: x[idx.product(i)] * num(pr.price),
  }));

  // What each stream balance left on the table. Surplus is a real planning
  // output: it is the stream nobody found a home for.
  const streamBalance = streams.map((streamId, k) => {
    const made = crudes.reduce((s, cr, i) => s + x[idx.crude(i)] * num(cr.yields?.[streamId]), 0)
      + units.reduce((s, u, i) => s + x[idx.unit(i)] * num(u.yields?.[streamId]), 0);
    const consumed = units.reduce((s, u, i) => s + (u.feed === streamId ? x[idx.unit(i)] : 0), 0);
    const placed = products.reduce((s, pr, i) => s + x[idx.product(i)] * num(pr.recipe?.[streamId]), 0);
    return {
      id: streamId,
      made,
      consumed,
      placed,
      surplus: made - consumed - placed,
      // The marginal value of one more barrel of this stream: the classic
      // planning number, and the reason an LP is worth solving rather than a
      // spreadsheet.
      //
      // SIGN. The solver returns d(objective)/d(right-hand side), and the row
      // is written `made - consumed - placed >= 0`. Raising that right-hand
      // side demands MORE surplus, which costs money, so the derivative is
      // negative where the stream is valuable. What a planner means by "what
      // is another barrel worth" is the opposite: a barrel arriving from
      // outside relaxes the row downwards. Hence the negation, which is
      // stated because a marginal value reported with the wrong sign is a
      // silent and expensive error.
      marginalValue: lp.shadowPrices ? -lp.shadowPrices[k] : null,
    };
  });

  const crudeCost = crudeRuns.reduce((s, r) => s + r.cost, 0);
  const unitCost = unitRuns.reduce((s, r) => s + r.cost, 0);
  const revenue = productMakes.reduce((s, r) => s + r.revenue, 0);
  const totalCrude = crudeRuns.reduce((s, r) => s + r.volume, 0);

  return {
    status: 'optimal',
    crudeRuns,
    unitRuns,
    productMakes,
    streamBalance,
    revenue,
    crudeCost,
    unitCost,
    margin: revenue - crudeCost - unitCost,
    totalCrude,
    // The number a refinery is actually judged on.
    grossMarginPerBbl: totalCrude > 0 ? (revenue - crudeCost - unitCost) / totalCrude : null,
  };
};

/**
 * Cascade a plan into a dated schedule of events.
 *
 * The plan says how much over the period; the schedule says when. Crude
 * arrives in cargoes of a stated size, units run at a steady rate across the
 * days available, and product lifts are spread over the period.
 *
 * Everything produced is a plan-ledger event on the shared model, so an
 * actual recorded later can be subtracted from it directly.
 *
 * The spreading is deliberately simple and SAYS SO: a real schedule is
 * constrained by tank capacity, jetty windows and turnarounds. This gives the
 * shape of the month, against which the actuals can be read, rather than
 * pretending to be a berth-level scheduler.
 */
export const cascadeToSchedule = ({ plan, periodStart, periodDays = 30, cargoSize = 500000 }) => {
  if (!plan || plan.status !== 'optimal') return { events: [], note: 'No optimal plan to cascade.' };
  // Calendar arithmetic in UTC. It used local setDate and then printed the
  // UTC date, so west of Greenwich a schedule crossing a daylight-saving
  // change put every later event on the previous day.
  const start = new Date(periodStart || Date.now());
  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const dayAt = (d) => new Date(startUtc + d * 86400000).toISOString().split('T')[0];

  const events = [];
  let seq = 0;
  const nextId = (prefix) => `${prefix}-${(seq += 1)}`;

  // Crude receipts, in cargoes, evenly spaced across the period.
  plan.crudeRuns.filter((r) => r.volume > 0).forEach((run) => {
    const cargoes = Math.max(1, Math.ceil(run.volume / Math.max(1, cargoSize)));
    const per = run.volume / cargoes;
    const spacing = Math.max(1, Math.floor(periodDays / cargoes));
    for (let k = 0; k < cargoes; k += 1) {
      events.push(makeEvent({
        id: nextId('rcpt'),
        ledger: LEDGER.PLAN,
        type: EVENT_TYPE.RECEIPT,
        materialId: run.id,
        quantity: per,
        date: dayAt(Math.min(periodDays - 1, k * spacing)),
        cost: (run.cost / run.volume) * per,
        meta: { cargo: k + 1, of: cargoes },
      }));
    }
  });

  // Unit runs, as one event per week of the period, because a unit runs
  // continuously and a weekly grain is what a plan is reviewed at.
  const weeks = Math.max(1, Math.ceil(periodDays / 7));
  plan.unitRuns.filter((r) => r.throughput > 0).forEach((run) => {
    const per = run.throughput / weeks;
    for (let w = 0; w < weeks; w += 1) {
      events.push(makeEvent({
        id: nextId('run'),
        ledger: LEDGER.PLAN,
        type: EVENT_TYPE.UNIT_RUN,
        materialId: run.id,
        quantity: per,
        date: dayAt(Math.min(periodDays - 1, w * 7)),
        unitId: run.id,
        cost: (run.cost / run.throughput) * per,
        meta: { week: w + 1, of: weeks },
      }));
    }
  });

  // Product lifts, weekly.
  plan.productMakes.filter((r) => r.volume > 0).forEach((make) => {
    const per = make.volume / weeks;
    for (let w = 0; w < weeks; w += 1) {
      events.push(makeEvent({
        id: nextId('lift'),
        ledger: LEDGER.PLAN,
        type: EVENT_TYPE.DELIVERY,
        materialId: make.id,
        quantity: per,
        date: dayAt(Math.min(periodDays - 1, w * 7 + 6)),
        cost: (make.revenue / make.volume) * per,
        meta: { week: w + 1, of: weeks },
      }));
    }
  });

  return {
    events,
    note: 'Crude arrives in evenly spaced cargoes and units and lifts are spread evenly across the period. Tank capacity, jetty windows and turnarounds are not modelled: this is the shape of the month to read actuals against, not a berth-level schedule.',
  };
};

/**
 * Attribute the gap between the plan and what happened.
 *
 * Delegates to the shared model's attribution, which splits the cost
 * difference exactly into a volume part and a price part. Adds the two
 * refinery-specific readings on top: how each unit ran against plan, and the
 * margin gap.
 */
export const reconcilePeriod = ({ planEvents = [], actualEvents = [], plan = null }) => {
  const events = [...planEvents, ...actualEvents];
  const variance = attributeVariance({ events });

  const throughputByLedger = (ledger) => {
    const map = new Map();
    events.filter((e) => e.ledger === ledger && e.type === EVENT_TYPE.UNIT_RUN).forEach((e) => {
      map.set(e.materialId, (map.get(e.materialId) || 0) + e.quantity);
    });
    return map;
  };
  const planned = throughputByLedger(LEDGER.PLAN);
  const actual = throughputByLedger(LEDGER.ACTUAL);
  const unitIds = new Set([...planned.keys(), ...actual.keys()]);
  const unitPerformance = [...unitIds].map((id) => {
    const p = planned.get(id) ?? 0;
    const a = actual.get(id) ?? 0;
    return {
      unitId: id,
      planned: p,
      actual: a,
      difference: a - p,
      // Below plan on a unit is usually downtime; the app does not guess
      // which, it reports the gap and lets the user attribute it.
      utilisationOfPlan: p > 0 ? a / p : null,
    };
  });

  const ledgerMargin = (ledger) => {
    const rows = events.filter((e) => e.ledger === ledger && e.cost !== null);
    const revenue = rows.filter((e) => e.type === EVENT_TYPE.DELIVERY).reduce((s, e) => s + e.cost, 0);
    const spend = rows.filter((e) => e.type !== EVENT_TYPE.DELIVERY).reduce((s, e) => s + e.cost, 0);
    return revenue - spend;
  };

  const planMargin = ledgerMargin(LEDGER.PLAN);
  const actualMargin = ledgerMargin(LEDGER.ACTUAL);

  return {
    ...variance,
    unitPerformance,
    planMargin,
    actualMargin,
    marginVariance: actualMargin - planMargin,
    planGrossMarginPerBbl: plan?.grossMarginPerBbl ?? null,
  };
};
