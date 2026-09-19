/**
 * Refinery planning, the plan-versus-actual variance, and modular refinery
 * feasibility, against independent oracles (MD2-0).
 *
 * Goldens: tools/validation/downstream/oracle_refineryplanning.py (an exact
 * rational simplex whose every answer carries a duality certificate) and
 * oracle_modularrefinery.py (annual accounts with a dated tax-loss ledger).
 * Every assertion calls the engine.
 */
import fs from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { planRefinery, reconcilePeriod } from '../engines/downstream/refineryPlanning.js';
import { attributeVariance, makeEvent, LEDGER, EVENT_TYPE } from '../engines/downstream/streamModel.js';
import {
  feasibilityStreams, feasibilityEconomics, productSlate, scaleComparison, CONFIGURATIONS,
  SUPPLY_SCENARIOS, SCALING_EXPONENT,
} from '../engines/downstream/modularRefinery.js';
import { calculateEconomics } from '../engines/economics/screening.js';

const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'downstream', 'goldens', f), 'utf8'));
const RP = load('refineryplanning_cases.json');
const MR = load('modularrefinery_cases.json');
const rel = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

describe('the goldens, and what they honestly are', () => {
  it('were written by the oracles', () => {
    expect(RP.provenance.method).toMatch(/duality certificate/);
    expect(MR.provenance.method).toMatch(/tax-loss ledger/);
  });
  it('can discriminate: a binding crude unit, a typed zero, an infeasible floor, a loss carried forward', () => {
    const def = RP.cases[0];
    expect(def.unitRuns[0]).toBeGreaterThan(0);
    expect(RP.cases.some((c) => c.status === 'infeasible')).toBe(true);
    const carried = MR.cases.filter((c) => Math.abs(c.npvMM - c.oldPageNpvMM) > 1);
    expect(carried.length).toBeGreaterThanOrEqual(2);
  });
});

describe.each(RP.cases.map((c) => [c.name, c]))('plan: %s', (_n, gc) => {
  const r = planRefinery(gc.input);
  it('reaches the certified status', () => expect(r.status).toBe(gc.status));
  if (gc.status !== 'optimal') return;

  it('reaches the certified margin', () => expect(rel(r.margin, gc.margin, 1e-9)).toBe(true));

  it('runs every barrel of crude through the crude unit', () => {
    const crude = r.crudeRuns.reduce((s, x) => s + x.volume, 0);
    const cdu = r.unitRuns.filter((u) => u.crudeUnit).reduce((s, u) => s + u.throughput, 0);
    expect(rel(crude, gc.crudeThroughCrudeUnits, 1e-9)).toBe(true);
    expect(rel(cdu, crude, 1e-9)).toBe(true);
  });

  it('closes every stream balance as the oracle does', () => {
    gc.streamBalance.forEach((s, i) => {
      const e = r.streamBalance[i];
      expect(e.id).toBe(s.id);
      expect(Math.abs(e.surplus - s.surplus)).toBeLessThan(1e-4);
      expect(e.surplus).toBeGreaterThan(-1e-6);
    });
  });

  it('values one more barrel of each stream as the exact re-solve does', () => {
    gc.streamBalance.forEach((s, i) => {
      if (s.marginalValue === null) return;
      expect(Math.abs(r.streamBalance[i].marginalValue - s.marginalValue)).toBeLessThan(1e-6 * Math.max(1, Math.abs(s.marginalValue)));
    });
  });
});

describe('the inputs that used to fail open', () => {
  const def = RP.cases[0].input;
  it('refuses a blank crude cost, unit operating cost or product price', () => {
    ['', null, undefined].forEach((blank) => {
      expect(planRefinery({ ...def, crudes: def.crudes.map((c, i) => (i ? c : { ...c, cost: blank })) }).status).toBe('invalid');
      expect(planRefinery({ ...def, units: def.units.map((u, i) => (i ? u : { ...u, opex: blank })) }).status).toBe('invalid');
      expect(planRefinery({ ...def, products: def.products.map((p, i) => (i ? p : { ...p, price: blank })) }).status).toBe('invalid');
    });
  });
  it('reads a blank limit as no limit and refuses a negative one', () => {
    expect(planRefinery({ ...def, crudes: def.crudes.map((c) => ({ ...c, available: '' })) }).status).toBe('optimal');
    expect(planRefinery({ ...def, units: def.units.map((u, i) => (i ? { ...u, capacity: -1 } : u)) }).status).toBe('invalid');
  });
});

describe('the schedule', () => {
  // Each zone runs in its own node process started with TZ set: changing
  // process.env.TZ inside a jest worker does not reach its Date, so an
  // in-process test passes in whatever zone the worker has.
  const s = RP.schedule;
  const engine = path.join(__dirname, '..', 'engines', 'downstream', 'refineryPlanning.js');
  const script = `
    import { planRefinery, cascadeToSchedule } from ${JSON.stringify(engine)};
    const def = ${JSON.stringify(RP.cases[0].input)};
    const { events } = cascadeToSchedule({ plan: planRefinery(def), periodStart: '${s.periodStart}', periodDays: ${s.periodDays}, cargoSize: ${s.cargoSize} });
    const pick = (t, m) => events.filter((e) => e.type === t && e.materialId === m).map((e) => e.date);
    console.log(JSON.stringify({ receipts: pick('receipt', 'crude_a'), runs: pick('unit_run', 'cdu'), lifts: pick('delivery', 'jet') }));
  `;
  it.each(['UTC', 'America/New_York', 'America/Los_Angeles', 'Africa/Lagos', 'Pacific/Auckland'])('dates every event by the calendar in %s', (tz) => {
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TZ: tz }, encoding: 'utf8',
    }));
    expect(out.receipts).toEqual(s.cargoDates);
    expect(out.runs).toEqual(s.runDates);
    expect(out.lifts).toEqual(s.liftDates);
  });
});

describe('the variance, signed by what it does to margin', () => {
  const V = RP.variance;
  const ev = (ledger, [m, t], [q, c]) => makeEvent({ id: `${ledger}-${m}-${t}`, ledger, type: t, materialId: m, quantity: q, cost: c });
  const events = V.lines.flatMap((l) => [
    ev(LEDGER.PLAN, [l.materialId, l.type], l.plan), ev(LEDGER.ACTUAL, [l.materialId, l.type], l.actual),
  ]);
  const out = attributeVariance({ events });

  it('splits each line as the ledgers do, and says whether it is a cost or a revenue', () => {
    V.lines.forEach((g) => {
      const l = out.lines.find((x) => x.materialId === g.materialId && x.type === g.type);
      expect(rel(l.volumeVariance, g.volumeVariance)).toBe(true);
      expect(rel(l.priceVariance, g.priceVariance)).toBe(true);
      expect(l.direction).toBe(g.direction);
      expect(rel(l.marginEffect, g.marginEffect)).toBe(true);
      expect(Math.abs(l.unexplained)).toBeLessThan(1e-9);
    });
  });

  it('totals on margin, never adding a revenue gap to a cost gap', () => {
    expect(rel(out.total.totalVariance, V.marginEffect)).toBe(true);
    expect(rel(out.total.cost.totalVariance, V.costTotal)).toBe(true);
    expect(rel(out.total.revenue.totalVariance, V.revenueTotal)).toBe(true);
  });

  it('reconcilePeriod carries the same signed total', () => {
    const rec = reconcilePeriod({ planEvents: events.filter((e) => e.ledger === LEDGER.PLAN), actualEvents: events.filter((e) => e.ledger === LEDGER.ACTUAL) });
    expect(rel(rec.total.totalVariance, V.marginEffect)).toBe(true);
  });

  it('shows money moved with no quantity as unexplained rather than hiding it', () => {
    const odd = [
      makeEvent({ id: 'p', ledger: LEDGER.PLAN, type: EVENT_TYPE.RECEIPT, materialId: 'x', quantity: 100, cost: 8000 }),
      makeEvent({ id: 'a', ledger: LEDGER.ACTUAL, type: EVENT_TYPE.RECEIPT, materialId: 'x', quantity: 0, cost: 500 }),
    ];
    const [l] = attributeVariance({ events: odd }).lines;
    expect(l.unexplained).toBeCloseTo(500, 9);
  });
});

describe('modular refinery: held conventions, PINNED', () => {
  it('scaling exponents', () => expect(SCALING_EXPONENT).toEqual({ STICK_BUILT: 0.6, MODULAR: 0.9 }));
  it('supply scenarios', () => {
    expect(SUPPLY_SCENARIOS.map((s) => [s.id, s.utilisation, s.crudePremium])).toEqual([
      ['firm', 0.92, 0], ['tight', 0.75, 3], ['disrupted', 0.5, 6]]);
  });
  it('mid-year discounting in the screening engine: one flow of 1 in year 0 at 10 percent', () => {
    const r = calculateEconomics({
      projectLife: 1, discountRate: 10, production: { oil: [1e6], gas: [0] }, price: { oil: [1], gas: [0] },
      capex: [0], opexFixed: [0], opexVariable: [0], abandonment: [0],
    });
    expect(r.metrics.npv).toBeCloseTo(1 / 1.1 ** 0.5, 12);
  });
});

describe('modular refinery: the scale crossover', () => {
  const rows = scaleComparison({ baseCost: 100e6, baseCapacity: 10000, capacities: MR.scale.map((s) => s.capacity) });
  it.each(MR.scale.map((s) => [s.capacity, s]))('at %d bpd', (_q, g) => {
    const r = rows.find((x) => x.capacity === g.capacity);
    expect(rel(r.modularCost, g.modularCost)).toBe(true);
    expect(rel(r.stickBuiltCost, g.stickBuiltCost)).toBe(true);
    expect(r.modularCost < r.stickBuiltCost).toBe(g.modularCheaper);
  });
});

describe.each(MR.cases.map((c) => [c.name, c]))('feasibility: %s', (_n, gc) => {
  const inp = gc.inputs;
  const scenario = SUPPLY_SCENARIOS.find((s) => s.id === inp.scenarioId);
  const slate = productSlate({
    productYields: CONFIGURATIONS[inp.configurationId].productYields,
    prices: { lpg: 55, gasoline: 108, naphtha: 78, kerosene: 100, diesel: 104, fuelOil: 58 },
  });
  const streams = feasibilityStreams({
    capacityBpd: inp.capacityBpd, onstreamDays: inp.onstreamDays, utilisation: scenario.utilisation,
    crudeCostPerBbl: inp.crudeCostPerBbl + scenario.crudePremium, slate,
    fixedOpexPerYear: inp.fixedOpexPerYear, variableOpexPerBbl: inp.variableOpexPerBbl,
    projectLife: inp.projectLife, constructionYears: inp.constructionYears, capex: gc.capex,
  });
  const econ = feasibilityEconomics({ streams, discountRate: inp.discountRate, taxRate: inp.taxRate, startYear: 2026 });

  it('keeps the annual accounts', () => {
    expect(rel(slate.grossValuePerBbl, gc.grossValuePerBbl)).toBe(true);
    expect(streams.years).toHaveLength(gc.years.length);
    gc.years.forEach((g, i) => {
      const y = streams.years[i];
      ['revenue', 'capex', 'variableOpex'].forEach((k) => {
        const gk = k === 'variableOpex' ? 'variable' : k;
        expect(Math.abs(y[k] - g[gk])).toBeLessThan(1e-6 * Math.max(1, Math.abs(g[gk])));
      });
    });
  });

  it('pays the tax the loss ledger says, year by year', () => {
    gc.years.forEach((g, i) => expect(Math.abs(econ.cashflow[i].tax * 1e6 - g.tax)).toBeLessThan(1e-3));
  });

  it('reaches the NPV of the accounts, through the canonical engine, with revenue as revenue', () => {
    expect(Math.abs(econ.metrics.npv - gc.npvMM)).toBeLessThan(1e-9 * Math.max(1, Math.abs(gc.npvMM)));
    const revenue = econ.cashflow.reduce((s, c) => s + c.grossRevenue, 0);
    expect(rel(revenue, gc.totalRevenueMM, 1e-9)).toBe(true);
    expect(econ.inputs.royaltyRate).toBe(0);
  });
});

describe('modular refinery: the inputs that used to fail open', () => {
  const slate = productSlate({ productYields: CONFIGURATIONS.hydroskimming.productYields, prices: { gasoline: 108 } });
  const base = { capacityBpd: 10000, crudeCostPerBbl: 80, slate, fixedOpexPerYear: 12e6, variableOpexPerBbl: 3.5, capex: 1e8 };
  it('refuses a blank crude cost, capacity or capital cost', () => {
    ['crudeCostPerBbl', 'capacityBpd', 'capex'].forEach((k) => {
      expect(feasibilityStreams({ ...base, [k]: '' }).error).toMatch(/Missing/);
    });
  });
  it('refuses a utilisation typed as a percentage instead of clamping it to 100 percent', () => {
    expect(feasibilityStreams({ ...base, utilisation: 90 }).error).toMatch(/fraction between 0 and 1/);
  });
});
