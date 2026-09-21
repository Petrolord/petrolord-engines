/**
 * Refinery planning, scheduling and reconciliation (DS3).
 *
 * The claim this app makes is doctrine 2: that plan, schedule and actuals
 * share one shape so variance is a subtraction. The tests that matter are the
 * ones that hold that claim to account, so most of what follows is
 * identities: the plan's material balance closes, the schedule adds up to the
 * plan it came from, and the variance decomposes exactly.
 */
import {
  planRefinery, cascadeToSchedule, reconcilePeriod,
} from '../engines/downstream/refineryPlanning.js';
import { LEDGER, EVENT_TYPE, makeEvent } from '../engines/downstream/streamModel.js';

// A hydroskimming configuration, small enough to check by hand: one crude
// yielding four straight-run streams, a reformer that upgrades naphtha, and
// three products.
// Offgas has no product outlet on purpose: a configuration always makes
// something it does not sell, and the plan must handle that rather than
// refusing to solve.
const STREAMS = ['naphtha', 'reformate', 'kero', 'gasoil', 'residue', 'offgas'];

const CONFIG = {
  streams: STREAMS,
  crudes: [{
    id: 'crude_a',
    name: 'Crude A',
    cost: 80,
    available: 1000,
    yields: { naphtha: 0.20, kero: 0.15, gasoil: 0.35, residue: 0.28, offgas: 0.02 },
  }],
  units: [{
    id: 'reformer',
    name: 'Reformer',
    capacity: 150,
    opex: 3,
    feed: 'naphtha',
    yields: { reformate: 0.85 },
  }],
  products: [
    { id: 'gasoline', name: 'Gasoline', price: 110, minDemand: 0, maxDemand: 500, recipe: { reformate: 1 } },
    { id: 'jet', name: 'Jet', price: 105, minDemand: 0, maxDemand: 500, recipe: { kero: 1 } },
    { id: 'diesel', name: 'Diesel', price: 100, minDemand: 0, maxDemand: 500, recipe: { gasoil: 1 } },
    { id: 'fuel_oil', name: 'Fuel oil', price: 60, minDemand: 0, maxDemand: 500, recipe: { residue: 1 } },
  ],
};

describe('the plan', () => {
  it('solves the configuration', () => {
    const plan = planRefinery(CONFIG);
    expect(plan.status).toBe('optimal');
    expect(plan.totalCrude).toBeGreaterThan(0);
  });

  it('closes the material balance on every stream', () => {
    // The identity: nothing is made from nothing, and nothing is placed that
    // was not made.
    const plan = planRefinery(CONFIG);
    plan.streamBalance.forEach((s) => {
      expect(s.made - s.consumed - s.placed).toBeCloseTo(s.surplus, 8);
      expect(s.surplus).toBeGreaterThanOrEqual(-1e-7);
    });
  });

  it('never runs a unit above its capacity or a crude above availability', () => {
    const plan = planRefinery(CONFIG);
    plan.unitRuns.forEach((u) => expect(u.throughput).toBeLessThanOrEqual(u.capacity + 1e-7));
    expect(plan.crudeRuns[0].volume).toBeLessThanOrEqual(1000 + 1e-7);
  });

  it('never feeds a unit more than the stream it eats was made', () => {
    const plan = planRefinery(CONFIG);
    const naphthaMade = plan.crudeRuns[0].volume * 0.20;
    expect(plan.unitRuns[0].throughput).toBeLessThanOrEqual(naphthaMade + 1e-7);
  });

  it('reports a margin equal to the revenue and costs it lists', () => {
    const plan = planRefinery(CONFIG);
    expect(plan.margin).toBeCloseTo(plan.revenue - plan.crudeCost - plan.unitCost, 6);
    expect(plan.grossMarginPerBbl).toBeCloseTo(plan.margin / plan.totalCrude, 8);
  });

  it('runs the reformer, because upgrading naphtha pays here', () => {
    // Naphtha has no product outlet of its own in this configuration, so the
    // only way to sell it is through the reformer. A plan that leaves the
    // reformer idle would be leaving money on the table.
    const plan = planRefinery(CONFIG);
    expect(plan.unitRuns[0].throughput).toBeGreaterThan(0);
  });

  it('stops running the reformer when its operating cost exceeds the uplift', () => {
    // Reformate sells for 110 and 0.85 of a barrel of naphtha becomes 93.5 of
    // revenue. Charge 200 a barrel to run the unit and it is not worth it.
    const expensive = {
      ...CONFIG,
      units: [{ ...CONFIG.units[0], opex: 200 }],
    };
    const plan = planRefinery(expensive);
    expect(plan.status).toBe('optimal');
    expect(plan.unitRuns[0].throughput).toBeCloseTo(0, 6);
  });

  it('leaves an unplaceable stream as reported surplus, not as infeasible', () => {
    // Offgas has no product recipe in this configuration. A plan that refused
    // to solve because of that would be wrong: a refinery burns it, stores it
    // or flares it, and the plan's job is to report it, not to reject it.
    const plan = planRefinery(CONFIG);
    const offgas = plan.streamBalance.find((s) => s.id === 'offgas');
    expect(offgas.surplus).toBeGreaterThan(0);
    expect(offgas.placed).toBeCloseTo(0, 8);
  });

  it('prices each stream at its margin', () => {
    const plan = planRefinery(CONFIG);
    const gasoil = plan.streamBalance.find((s) => s.id === 'gasoil');
    // Gasoil goes straight to diesel at 100, so a barrel more of it is worth
    // about that.
    expect(gasoil.marginalValue).toBeCloseTo(100, 4);
    // Offgas has nowhere to go, so another barrel of it is worth nothing.
    const offgas = plan.streamBalance.find((s) => s.id === 'offgas');
    expect(Math.abs(offgas.marginalValue)).toBeLessThan(1e-6);
  });

  it('respects a product demand floor', () => {
    const withFloor = {
      ...CONFIG,
      products: CONFIG.products.map((p) => (p.id === 'jet' ? { ...p, minDemand: 100 } : p)),
    };
    const plan = planRefinery(withFloor);
    expect(plan.status).toBe('optimal');
    expect(plan.productMakes.find((p) => p.id === 'jet').volume).toBeGreaterThanOrEqual(100 - 1e-7);
  });

  it('says infeasible when a demand floor is beyond what the crude can make', () => {
    // 1000 barrels of crude at 15 percent kero is 150 of jet at most.
    const impossible = {
      ...CONFIG,
      products: CONFIG.products.map((p) => (p.id === 'jet' ? { ...p, minDemand: 400, maxDemand: 500 } : p)),
    };
    const plan = planRefinery(impossible);
    expect(plan.status).toBe('infeasible');
    expect(plan.error).toMatch(/product floor/i);
  });

  it('refuses a configuration with no crude or no product', () => {
    expect(planRefinery({ ...CONFIG, crudes: [] }).status).toBe('invalid');
    expect(planRefinery({ ...CONFIG, products: [] }).status).toBe('invalid');
  });
});

describe('the cascade to a schedule', () => {
  const plan = planRefinery(CONFIG);
  const { events, note } = cascadeToSchedule({
    plan, periodStart: '2026-09-01', periodDays: 28, cargoSize: 300,
  });

  it('produces plan-ledger events on the shared model', () => {
    expect(events.length).toBeGreaterThan(0);
    events.forEach((e) => {
      expect(e.ledger).toBe(LEDGER.PLAN);
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.quantity).toBeGreaterThan(0);
    });
  });

  it('schedules exactly the volume the plan called for', () => {
    // The identity that makes the cascade trustworthy: the calendar adds up
    // to the plan it came from.
    const receipts = events
      .filter((e) => e.type === EVENT_TYPE.RECEIPT)
      .reduce((s, e) => s + e.quantity, 0);
    expect(receipts).toBeCloseTo(plan.crudeRuns[0].volume, 6);

    const runs = events
      .filter((e) => e.type === EVENT_TYPE.UNIT_RUN)
      .reduce((s, e) => s + e.quantity, 0);
    expect(runs).toBeCloseTo(plan.unitRuns[0].throughput, 6);

    plan.productMakes.filter((p) => p.volume > 0).forEach((p) => {
      const lifted = events
        .filter((e) => e.type === EVENT_TYPE.DELIVERY && e.materialId === p.id)
        .reduce((s, e) => s + e.quantity, 0);
      expect(lifted).toBeCloseTo(p.volume, 6);
    });
  });

  it('carries the plan cost into the events, so the ledgers agree', () => {
    const receiptCost = events
      .filter((e) => e.type === EVENT_TYPE.RECEIPT)
      .reduce((s, e) => s + e.cost, 0);
    expect(receiptCost).toBeCloseTo(plan.crudeRuns[0].cost, 4);
  });

  it('splits crude into cargoes of the size asked for', () => {
    const receipts = events.filter((e) => e.type === EVENT_TYPE.RECEIPT);
    expect(receipts.length).toBeGreaterThan(1);
    receipts.forEach((e) => expect(e.quantity).toBeLessThanOrEqual(300 + 1e-6));
  });

  it('keeps every event inside the period', () => {
    const dates = events.map((e) => e.date).sort();
    expect(dates[0] >= '2026-09-01').toBe(true);
    expect(dates[dates.length - 1] <= '2026-09-28').toBe(true);
  });

  it('says what it does not model rather than implying a berth-level schedule', () => {
    expect(note).toMatch(/Tank capacity, jetty windows and turnarounds are not modelled/);
  });

  it('returns nothing for a plan that did not solve', () => {
    const out = cascadeToSchedule({ plan: { status: 'infeasible' } });
    expect(out.events).toEqual([]);
  });
});

describe('reconciling the period', () => {
  const plan = planRefinery(CONFIG);
  const { events: planEvents } = cascadeToSchedule({ plan, periodStart: '2026-09-01', periodDays: 28 });

  it('splits the cost gap into volume and price, exactly', () => {
    // The month ran 10 percent light on crude and paid 5 dollars more for it.
    const planned = planEvents.filter((e) => e.type === EVENT_TYPE.RECEIPT);
    const plannedVolume = planned.reduce((s, e) => s + e.quantity, 0);
    const plannedCost = planned.reduce((s, e) => s + e.cost, 0);
    const actualVolume = plannedVolume * 0.9;
    const unitPlan = plannedCost / plannedVolume;

    const actualEvents = [makeEvent({
      id: 'a1', ledger: LEDGER.ACTUAL, type: EVENT_TYPE.RECEIPT,
      materialId: 'crude_a', quantity: actualVolume, cost: actualVolume * (unitPlan + 5),
      date: '2026-09-05',
    })];

    const out = reconcilePeriod({ planEvents, actualEvents, plan });
    const line = out.lines.find((l) => l.materialId === 'crude_a');
    expect(line.volumeVariance + line.priceVariance).toBeCloseTo(line.totalVariance, 8);
    // Less crude than planned at the planned price is a favourable volume
    // variance on a cost line; paying more per barrel is adverse.
    expect(line.volumeVariance).toBeLessThan(0);
    expect(line.priceVariance).toBeGreaterThan(0);
  });

  it('reports each unit against its plan', () => {
    const actualEvents = [makeEvent({
      id: 'u1', ledger: LEDGER.ACTUAL, type: EVENT_TYPE.UNIT_RUN,
      materialId: 'reformer', quantity: plan.unitRuns[0].throughput * 0.8,
      cost: 100, date: '2026-09-10',
    })];
    const out = reconcilePeriod({ planEvents, actualEvents, plan });
    const reformer = out.unitPerformance.find((u) => u.unitId === 'reformer');
    expect(reformer.utilisationOfPlan).toBeCloseTo(0.8, 6);
    expect(reformer.difference).toBeLessThan(0);
  });

  it('reports the margin gap between the two ledgers', () => {
    const actualEvents = [makeEvent({
      id: 'd1', ledger: LEDGER.ACTUAL, type: EVENT_TYPE.DELIVERY,
      materialId: 'diesel', quantity: 10, cost: 1000, date: '2026-09-20',
    })];
    const out = reconcilePeriod({ planEvents, actualEvents, plan });
    expect(out.marginVariance).toBeCloseTo(out.actualMargin - out.planMargin, 8);
  });

  it('reports an unplanned movement as unmatched rather than as a price effect', () => {
    const actualEvents = [makeEvent({
      id: 'x1', ledger: LEDGER.ACTUAL, type: EVENT_TYPE.RECEIPT,
      materialId: 'crude_surprise', quantity: 50, cost: 4500, date: '2026-09-12',
    })];
    const out = reconcilePeriod({ planEvents, actualEvents, plan });
    expect(out.unmatched.some((u) => u.materialId === 'crude_surprise')).toBe(true);
  });

  it('handles a period with no actuals recorded yet', () => {
    const out = reconcilePeriod({ planEvents, actualEvents: [], plan });
    expect(out.lines).toEqual([]);
    expect(out.unmatched.length).toBeGreaterThan(0);
    expect(Number.isFinite(out.marginVariance)).toBe(true);
  });
});
