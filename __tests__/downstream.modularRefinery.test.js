/**
 * Modular refinery feasibility (DS4).
 *
 * The app's whole argument rests on one comparison — how capital scales for a
 * modular plant against a stick-built one — so that is tested hardest, along
 * with the identities that keep the streams honest for the economics engine
 * that consumes them.
 */
import {
  SCALING_EXPONENT, scaleCapex, scaleComparison,
  CONFIGURATIONS, productSlate, feasibilityStreams,
  SUPPLY_SCENARIOS, LICENSING_STAGES, licensingProgress,
} from '../engines/downstream/modularRefinery.js';

describe('capital scaling', () => {
  const base = { baseCost: 100e6, baseCapacity: 10000 };

  it('returns the base cost at the reference capacity, whatever the exponent', () => {
    [0.5, 0.6, 0.9, 1.0].forEach((exponent) => {
      expect(scaleCapex({ ...base, capacity: 10000, exponent }).cost).toBeCloseTo(100e6, 4);
    });
  });

  it('follows the six-tenths rule for a stick-built plant', () => {
    // Doubling capacity costs 2^0.6 = about 1.516 times as much.
    const doubled = scaleCapex({ ...base, capacity: 20000, exponent: SCALING_EXPONENT.STICK_BUILT });
    expect(doubled.cost / 100e6).toBeCloseTo(2 ** 0.6, 8);
    expect(doubled.cost / 100e6).toBeCloseTo(1.5157, 3);
  });

  it('scales close to linearly for a modular plant, because you add trains', () => {
    const doubled = scaleCapex({ ...base, capacity: 20000, exponent: SCALING_EXPONENT.MODULAR });
    expect(doubled.cost / 100e6).toBeCloseTo(2 ** 0.9, 8);
    // Much closer to 2 than the six-tenths rule's 1.52.
    expect(doubled.cost / 100e6).toBeGreaterThan(1.8);
  });

  it('shows the small plant losing far less to scale than the six-tenths rule implies', () => {
    // This is the entire argument for a modular project. At a fifth of the
    // reference size, the six-tenths rule says capital per barrel is much
    // worse; modular scaling says it is barely worse.
    const small = 2000;
    const stick = scaleCapex({ ...base, capacity: small, exponent: SCALING_EXPONENT.STICK_BUILT });
    const modular = scaleCapex({ ...base, capacity: small, exponent: SCALING_EXPONENT.MODULAR });
    const referencePerBpd = 100e6 / 10000;
    expect(stick.perBpd / referencePerBpd).toBeGreaterThan(1.7);
    expect(modular.perBpd / referencePerBpd).toBeLessThan(1.3);
    expect(modular.perBpd).toBeLessThan(stick.perBpd);
  });

  it('and the big plant gaining far less, which is the honest other half', () => {
    const big = 100000;
    const stick = scaleCapex({ ...base, capacity: big, exponent: SCALING_EXPONENT.STICK_BUILT });
    const modular = scaleCapex({ ...base, capacity: big, exponent: SCALING_EXPONENT.MODULAR });
    expect(modular.perBpd).toBeGreaterThan(stick.perBpd);
  });

  it('crosses over exactly at the reference size', () => {
    const rows = scaleComparison({ ...base, capacities: [2000, 10000, 50000] });
    expect(rows[1].ratio).toBeCloseTo(1, 8);
    expect(rows[0].ratio).toBeLessThan(1);
    expect(rows[2].ratio).toBeGreaterThan(1);
  });

  it('refuses nonsense rather than returning a number', () => {
    expect(scaleCapex({ baseCost: 0, baseCapacity: 10000, capacity: 5000 }).cost).toBeNull();
    expect(scaleCapex({ ...base, capacity: 0 }).cost).toBeNull();
  });

  it('takes both exponents as parameters rather than burying them', () => {
    expect(SCALING_EXPONENT.STICK_BUILT).toBeCloseTo(0.6, 10);
    const custom = scaleComparison({ ...base, capacities: [20000], modularExponent: 1.0 });
    expect(custom[0].modularCost).toBeCloseTo(200e6, 4);
  });
});

describe('configurations', () => {
  it('offers the three that matter, each with a full barrel of yields', () => {
    ['topping', 'hydroskimming', 'conversion'].forEach((id) => {
      const cfg = CONFIGURATIONS[id];
      expect(cfg).toBeTruthy();
      const total = Object.values(cfg.productYields).reduce((s, v) => s + v, 0);
      expect(total).toBeCloseTo(1, 6);
    });
  });

  it('gives conversion a better transport-fuel slate than topping', () => {
    // The reason to spend the extra capital: residue becomes transport fuel.
    const topping = CONFIGURATIONS.topping.productYields;
    const conversion = CONFIGURATIONS.conversion.productYields;
    expect(conversion.fuelOil).toBeLessThan(topping.fuelOil);
    const toppingTransport = topping.diesel + (topping.gasoline ?? 0) + (topping.naphtha ?? 0);
    const conversionTransport = conversion.diesel + (conversion.gasoline ?? 0);
    expect(conversionTransport).toBeGreaterThan(toppingTransport - 0.05);
  });
});

describe('the product slate', () => {
  const prices = { lpg: 55, gasoline: 108, kerosene: 100, diesel: 104, fuelOil: 58, naphtha: 78 };

  it('values a barrel as its yields times the prices', () => {
    const slate = productSlate({ productYields: CONFIGURATIONS.hydroskimming.productYields, prices });
    const y = CONFIGURATIONS.hydroskimming.productYields;
    const expected = y.lpg * 55 + y.gasoline * 108 + y.kerosene * 100 + y.diesel * 104 + y.fuelOil * 58;
    expect(slate.grossValuePerBbl).toBeCloseTo(expected, 8);
  });

  it('excludes losses from the value but counts them in the barrel', () => {
    const slate = productSlate({ productYields: CONFIGURATIONS.topping.productYields, prices });
    expect(slate.rows.some((r) => r.id === 'loss')).toBe(false);
    expect(slate.yieldsClose).toBe(true);
  });

  it('names an unpriced product rather than valuing it at zero', () => {
    const slate = productSlate({
      productYields: CONFIGURATIONS.topping.productYields,
      prices: { ...prices, fuelOil: undefined },
    });
    expect(slate.unpriced).toContain('fuelOil');
  });

  it('says when the yields do not account for the whole barrel', () => {
    const slate = productSlate({ productYields: { diesel: 0.5, fuelOil: 0.2 }, prices });
    expect(slate.yieldsClose).toBe(false);
    expect(slate.yieldTotal).toBeCloseTo(0.7, 8);
  });
});

describe('the annual streams', () => {
  const slate = productSlate({
    productYields: CONFIGURATIONS.hydroskimming.productYields,
    prices: { lpg: 55, gasoline: 108, kerosene: 100, diesel: 104, fuelOil: 58 },
  });
  const streams = feasibilityStreams({
    capacityBpd: 10000, onstreamDays: 340, utilisation: 0.9,
    crudeCostPerBbl: 80, slate,
    fixedOpexPerYear: 12e6, variableOpexPerBbl: 3.5,
    projectLife: 20, constructionYears: 2, capex: 250e6,
  });

  it('runs the plant for the life after the build', () => {
    expect(streams.years).toHaveLength(22);
    expect(streams.years.filter((y) => y.producing)).toHaveLength(20);
    expect(streams.years[0].producing).toBe(false);
  });

  it('spreads the capital across the construction years and stops', () => {
    const spent = streams.years.reduce((s, y) => s + y.capex, 0);
    expect(spent).toBeCloseTo(250e6, 4);
    expect(streams.years[0].capex).toBeCloseTo(125e6, 4);
    expect(streams.years[2].capex).toBe(0);
  });

  it('starts fixed operating cost with the plant, not with the build', () => {
    // A plant under construction has a project team, not an operating one.
    expect(streams.years[0].fixedOpex).toBe(0);
    expect(streams.years[2].fixedOpex).toBeCloseTo(12e6, 6);
  });

  it('computes throughput from capacity, on-stream days and utilisation', () => {
    expect(streams.annualBbl).toBeCloseTo(10000 * 340 * 0.9, 6);
    expect(streams.years[2].crudeBbl).toBeCloseTo(streams.annualBbl, 6);
  });

  it('reports a gross margin equal to slate value less crude and variable cost', () => {
    expect(streams.grossMarginPerBbl).toBeCloseTo(slate.grossValuePerBbl - 80 - 3.5, 8);
  });

  it('keeps revenue and costs consistent with the throughput', () => {
    const y = streams.years[5];
    expect(y.revenue).toBeCloseTo(y.crudeBbl * slate.grossValuePerBbl, 4);
    expect(y.crudeCost).toBeCloseTo(y.crudeBbl * 80, 4);
    expect(y.variableOpex).toBeCloseTo(y.crudeBbl * 3.5, 4);
  });

  it('handles a project with no construction period', () => {
    const immediate = feasibilityStreams({
      capacityBpd: 1000, crudeCostPerBbl: 80, slate,
      fixedOpexPerYear: 1e6, variableOpexPerBbl: 3, projectLife: 5,
      constructionYears: 0, capex: 10e6,
    });
    expect(immediate.years[0].producing).toBe(true);
    expect(immediate.years.every((y) => y.capex === 0)).toBe(true);
  });
});

describe('crude supply scenarios', () => {
  it('names three futures and prices each, without inventing probabilities', () => {
    expect(SUPPLY_SCENARIOS).toHaveLength(3);
    SUPPLY_SCENARIOS.forEach((s) => {
      expect(s.utilisation).toBeGreaterThan(0);
      expect(s.utilisation).toBeLessThanOrEqual(1);
      expect(s.note).toBeTruthy();
      // Attaching an invented likelihood to a scenario would not be honest.
      expect(s.probability).toBeUndefined();
    });
  });

  it('gets worse in both utilisation and crude premium together', () => {
    const [firm, tight, disrupted] = SUPPLY_SCENARIOS;
    expect(tight.utilisation).toBeLessThan(firm.utilisation);
    expect(disrupted.utilisation).toBeLessThan(tight.utilisation);
    expect(disrupted.crudePremium).toBeGreaterThan(tight.crudePremium);
  });

  it('changes the economics enough to matter', () => {
    const slate = productSlate({
      productYields: CONFIGURATIONS.hydroskimming.productYields,
      prices: { lpg: 55, gasoline: 108, kerosene: 100, diesel: 104, fuelOil: 58 },
    });
    const run = (s) => feasibilityStreams({
      capacityBpd: 10000, utilisation: s.utilisation,
      crudeCostPerBbl: 80 + s.crudePremium, slate,
      fixedOpexPerYear: 12e6, variableOpexPerBbl: 3.5, capex: 250e6, constructionYears: 2,
    });
    const firm = run(SUPPLY_SCENARIOS[0]);
    const disrupted = run(SUPPLY_SCENARIOS[2]);
    expect(disrupted.annualBbl).toBeLessThan(firm.annualBbl * 0.6);
    expect(disrupted.grossMarginPerBbl).toBeLessThan(firm.grossMarginPerBbl);
  });
});

describe('licensing', () => {
  it('has the three stages in order', () => {
    expect(LICENSING_STAGES.map((s) => s.id)).toEqual(['lte', 'ltc', 'lto']);
    LICENSING_STAGES.forEach((s, i) => expect(s.stage).toBe(i + 1));
  });

  it('points at the next stage', () => {
    expect(licensingProgress([]).nextStage.id).toBe('lte');
    expect(licensingProgress(['lte']).nextStage.id).toBe('ltc');
    expect(licensingProgress(['lte', 'ltc', 'lto']).nextStage).toBeNull();
  });

  it('flags an out-of-order tick, which is a data-entry error', () => {
    // You cannot hold a construction licence without an establishment one.
    expect(licensingProgress(['ltc']).outOfOrder).toBe(true);
    expect(licensingProgress(['lte', 'ltc']).outOfOrder).toBe(false);
  });

  it('lists what each stage typically needs, as an aid rather than a rule', () => {
    LICENSING_STAGES.forEach((s) => {
      expect(s.typicalEvidence.length).toBeGreaterThan(2);
    });
  });
});
