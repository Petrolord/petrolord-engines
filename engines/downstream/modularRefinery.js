/**
 * Modular refinery feasibility (Midstream & Downstream DS4).
 *
 * DOCTRINE 1, MADE CONCRETE: MODULAR SCALE FIRST
 *
 * The tools this competes with were built for 200,000 barrel-a-day
 * stick-built refineries, and their assumptions are baked in. The most
 * consequential one is capital scaling. Stick-built cost follows the
 * six-tenths rule: doubling capacity costs about 1.5 times as much, because
 * a bigger vessel is cheaper per barrel than two smaller ones. That is the
 * single reason the industry believes small refineries cannot work.
 *
 * A modular refinery does not scale that way. You do not build a bigger
 * vessel, you build ANOTHER TRAIN, so the cost is close to linear in
 * capacity and the economy of scale largely disappears. Which cuts both
 * ways, and honestly: the small plant loses much less to scale than the
 * six-tenths rule implies, and the big one gains much less.
 *
 * This engine models BOTH exponents and shows them side by side, because the
 * comparison is the entire argument for or against a modular project and
 * burying it inside one number would be the wrong service. The exponents are
 * named, overridable parameters, not constants hidden in the code.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not compute the fiscal cash flow. That is the Suite's sanctioned
 * economics engine's job, and this engine deliberately produces the annual
 * volume and cost streams for that engine to consume rather than growing a
 * seventh NPV implementation. The Economics module spent a whole phase
 * removing the fifth and sixth. feasibilityEconomics (below) is the one
 * place those streams meet the Suite's screening engine, calculateEconomics.
 */

import { calculateEconomics } from '../economics/screening.js';

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
 * Capital cost scaling exponents.
 *
 * STICK_BUILT is the classic six-tenths rule. MODULAR is close to linear
 * because capacity is added by replicating trains. Both are defaults a user
 * can override with their own vendor data, which is what a real study does.
 */
export const SCALING_EXPONENT = {
  STICK_BUILT: 0.6,
  MODULAR: 0.9,
};

/**
 * Scale a capital cost from a reference point.
 *
 *   cost = baseCost * (capacity / baseCapacity) ^ exponent
 *
 * @returns {{cost:number, perBpd:number, exponent:number}}
 */
export const scaleCapex = ({ baseCost, baseCapacity, capacity, exponent = SCALING_EXPONENT.MODULAR }) => {
  const bc = num(baseCost);
  const bq = num(baseCapacity);
  const q = num(capacity);
  if (!(bc > 0) || !(bq > 0) || !(q > 0)) return { cost: null, perBpd: null, exponent };
  const cost = bc * ((q / bq) ** exponent);
  return { cost, perBpd: cost / q, exponent };
};

/**
 * The scale comparison that is the point of the app.
 *
 * Returns the capital cost per barrel of capacity under both scaling laws
 * across a range of train sizes, so the modular case can be argued or
 * dismissed on the numbers rather than on received wisdom.
 */
export const scaleComparison = ({
  baseCost, baseCapacity, capacities,
  modularExponent = SCALING_EXPONENT.MODULAR,
  stickBuiltExponent = SCALING_EXPONENT.STICK_BUILT,
}) => (capacities || []).map((capacity) => {
  const modular = scaleCapex({ baseCost, baseCapacity, capacity, exponent: modularExponent });
  const stick = scaleCapex({ baseCost, baseCapacity, capacity, exponent: stickBuiltExponent });
  return {
    capacity,
    modularCost: modular.cost,
    modularPerBpd: modular.perBpd,
    stickBuiltCost: stick.cost,
    stickBuiltPerBpd: stick.perBpd,
    // Below the reference size the modular case costs LESS than the
    // six-tenths rule implies, in total and per barrel alike (a fraction
    // raised to 0.9 is smaller than the same fraction raised to 0.6); above
    // it, MORE. MD2-0: this comment used to say the opposite of below the
    // reference. The ratio makes the crossover, at the reference size, visible.
    ratio: stick.cost > 0 && modular.cost !== null ? modular.cost / stick.cost : null,
  };
});

/**
 * Refinery configurations, as the set of products a barrel can become.
 *
 * `productYields` are volume fractions of crude. They are DEFAULTS for a
 * screening pass and are overridable, because a real study takes them from
 * the crude's own assay: the Crude Assay Studio computes exactly this from a
 * TBP curve and a cut set. The point of shipping defaults is that a
 * feasibility screen should not begin with an empty table.
 */
export const CONFIGURATIONS = {
  topping: {
    id: 'topping',
    name: 'Topping',
    description: 'Atmospheric distillation only. The simplest modular plant: it separates the barrel and sells what comes out, with no upgrading at all.',
    units: ['Crude distillation'],
    productYields: { lpg: 0.02, naphtha: 0.18, kerosene: 0.14, diesel: 0.30, fuelOil: 0.34, loss: 0.02 },
  },
  hydroskimming: {
    id: 'hydroskimming',
    name: 'Hydroskimming',
    description: 'Distillation plus reforming and hydrotreating. Makes on-specification gasoline and low-sulfur diesel, which is usually what a local market actually wants.',
    units: ['Crude distillation', 'Naphtha reformer', 'Diesel hydrotreater'],
    productYields: { lpg: 0.03, gasoline: 0.20, kerosene: 0.13, diesel: 0.32, fuelOil: 0.30, loss: 0.02 },
  },
  conversion: {
    id: 'conversion',
    name: 'Conversion',
    description: 'Adds a cracking unit, so residue that would leave as fuel oil becomes transport fuel. More capital, and a far better product slate on a heavy crude.',
    units: ['Crude distillation', 'Naphtha reformer', 'Diesel hydrotreater', 'Fluid catalytic cracker'],
    productYields: { lpg: 0.05, gasoline: 0.34, kerosene: 0.12, diesel: 0.33, fuelOil: 0.14, loss: 0.02 },
  },
};

/**
 * The product slate and its gross value per barrel of crude.
 *
 * A product with no price is NAMED rather than valued at zero: a missing
 * price treated as free understates the project and loses the argument for
 * the wrong reason. Losses are carried explicitly so the yields visibly
 * account for the whole barrel.
 */
export const productSlate = ({ productYields, prices }) => {
  const rows = Object.entries(productYields || {})
    .filter(([id]) => id !== 'loss')
    .map(([id, y]) => {
      const price = num(prices?.[id], NaN);
      return {
        id,
        yieldFraction: num(y),
        pricePerBbl: Number.isFinite(price) ? price : null,
        valuePerBblCrude: Number.isFinite(price) ? num(y) * price : null,
      };
    });
  const priced = rows.filter((r) => r.valuePerBblCrude !== null);
  const yieldTotal = Object.values(productYields || {}).reduce((s, v) => s + num(v), 0);
  return {
    rows,
    grossValuePerBbl: priced.reduce((s, r) => s + r.valuePerBblCrude, 0),
    unpriced: rows.filter((r) => r.valuePerBblCrude === null).map((r) => r.id),
    yieldTotal,
    // Yields that do not account for the whole barrel are a modelling error,
    // and the app says so rather than normalising them away.
    yieldsClose: Math.abs(yieldTotal - 1) < 0.005,
  };
};

/**
 * Annual physical and cash streams, for the economics engine to value.
 *
 * Deliberately stops at the streams. The Suite has one sanctioned screening
 * economics engine and one full-fiscal engine, and this does not become a
 * seventh: it produces production, revenue and cost by year, and the caller
 * runs them through the engine that owns that arithmetic.
 *
 * @returns {{years:object[], capex:number, capexPerBpd:number}}
 */
export const feasibilityStreams = ({
  capacityBpd, onstreamDays = 340, utilisation = 0.9,
  crudeCostPerBbl, slate, fixedOpexPerYear, variableOpexPerBbl,
  projectLife = 20, constructionYears = 2, capex,
}) => {
  // MD2-0. This module's num() reads a blank as ZERO, which is right for a
  // yield table and wrong here: a blank crude price made crude free, a blank
  // capex made the plant free, and a blank utilisation read as 100 percent.
  // The money and the size are required. The schedule terms (on-stream days,
  // utilisation, project life, construction years) take their stated default
  // when absent OR blank. MD2-1: this comment used to say blank did not, and
  // construction years alone read a blank as 0 where absent gave 2.
  const absent = (v) => v === null || v === undefined || v === '';
  const need = [
    ['capacity', capacityBpd], ['crude cost', crudeCostPerBbl], ['capital cost', capex],
    ['fixed operating cost', fixedOpexPerYear], ['variable operating cost', variableOpexPerBbl],
  ].filter(([, v]) => absent(v) || !Number.isFinite(Number(v))).map(([k]) => k);
  if (need.length > 0) {
    return { error: `Missing ${need.join(', ')}. Enter 0 where the value really is zero.`, years: [], missing: need };
  }
  const util = num(utilisation, 0.9);
  if (!(util >= 0 && util <= 1)) {
    // It used to be clamped, so a utilisation typed as a percentage (90)
    // quietly became 100 percent.
    return { error: 'Utilisation is a fraction between 0 and 1 (0.9 for 90 percent).', years: [] };
  }
  const runDays = num(onstreamDays, 340);
  if (!(runDays > 0 && runDays <= 366)) {
    return { error: 'On-stream days must be between 1 and 366.', years: [] };
  }
  const cap = num(capacityBpd);
  const annualBbl = cap * runDays * util;

  const years = [];
  const build = Math.max(0, Math.round(num(constructionYears, 2)));
  const life = Math.max(1, Math.round(num(projectLife, 20)));

  for (let y = 0; y < build + life; y += 1) {
    const producing = y >= build;
    const throughput = producing ? annualBbl : 0;
    years.push({
      year: y,
      producing,
      crudeBbl: throughput,
      revenue: throughput * num(slate?.grossValuePerBbl),
      crudeCost: throughput * num(crudeCostPerBbl),
      // Fixed operating cost starts when the plant does, not when the build
      // does: a plant under construction has a project team, not an
      // operating one.
      fixedOpex: producing ? num(fixedOpexPerYear) : 0,
      variableOpex: throughput * num(variableOpexPerBbl),
      // Capital spread evenly across the construction years. With no
      // construction period it is spent in year 0, the first operating year.
      // It used to vanish from the streams entirely.
      capex: build > 0 ? (producing ? 0 : num(capex) / build) : (y === 0 ? num(capex) : 0),
    });
  }

  return {
    years,
    annualBbl,
    capex: num(capex),
    capexPerBpd: cap > 0 ? num(capex) / cap : null,
    grossMarginPerBbl: num(slate?.grossValuePerBbl) - num(crudeCostPerBbl) - num(variableOpexPerBbl),
  };
};

/**
 * Value the streams through the Suite's screening economics engine.
 *
 * The Suite page did this itself and fed PRODUCT REVENUE IN AS A NEGATIVE
 * OPERATING COST, with the production row empty. The engine therefore saw no
 * revenue at all, so its royalty (a share of gross revenue) was always zero
 * whatever rate was typed, and its revenue and cost totals were meaningless.
 * Here revenue goes in as revenue: product barrels at the slate's value per
 * barrel of crude.
 *
 * Two choices are made here, and stated:
 *  - NO ROYALTY. A royalty is a charge on producing petroleum; a refinery
 *    buys its crude and pays none. The page's royalty box is removed.
 *  - LOSSES CARRY FORWARD. The plant is built before it earns; the capital is
 *    expensed in the construction years, and with no carry-forward that whole
 *    deduction was thrown away. Carried forward, it shelters the first
 *    operating years, which is how a company's losses are treated for income
 *    tax.
 *
 * @returns {object} calculateEconomics' result, plus the inputs it was given
 */
export const feasibilityEconomics = ({ streams, discountRate, taxRate, startYear = new Date().getFullYear() }) => {
  if (!streams || streams.error || !Array.isArray(streams.years) || streams.years.length === 0) {
    return { error: streams?.error ?? 'No streams to value.' };
  }
  // MD2-1: Number('') and Number(null) are 0, so a blank tax rate used to
  // value the plant tax-free (NPV 94.02 against 61.80 at 30 percent on the
  // course case). Absent or blank is refused.
  const given = (v) => !(v === null || v === undefined || v === '');
  const r = given(discountRate) ? Number(discountRate) : NaN;
  const t = given(taxRate) ? Number(taxRate) : NaN;
  if (!Number.isFinite(r) || !Number.isFinite(t)) {
    return { error: 'A discount rate and a tax rate are needed to value the project.' };
  }
  const ys = streams.years;
  const mm = (v) => v / 1e6;
  const inputs = {
    startYear,
    projectLife: ys.length,
    discountRate: r,
    fiscalType: 'TaxRoyalty',
    production: { oil: ys.map((y) => y.crudeBbl), gas: ys.map(() => 0) },
    // Revenue per barrel of crude run: the slate's gross value.
    price: { oil: ys.map((y) => (y.crudeBbl > 0 ? y.revenue / y.crudeBbl : 0)), gas: ys.map(() => 0) },
    capex: ys.map((y) => mm(y.capex)),
    opexFixed: ys.map((y) => mm(y.fixedOpex + y.crudeCost)),
    opexVariable: ys.map((y) => mm(y.variableOpex)),
    abandonment: ys.map(() => 0),
    royaltyRate: 0,
    taxRate: t,
    lossCarryForward: true,
  };
  return { ...calculateEconomics(inputs), inputs };
};

/**
 * Crude supply scenarios: the constraint that actually kills these projects.
 *
 * A modular refinery in a producing country is rarely defeated by its
 * engineering. It is defeated by not being able to buy crude at a price and
 * a reliability it can plan around. So supply is modelled as a scenario on
 * UTILISATION and on the crude premium, and the app puts it beside the
 * economics rather than in an appendix.
 *
 * These are scenarios, not probabilities: naming three futures and pricing
 * each is honest, whereas attaching invented likelihoods to them would not
 * be. A user who has a real distribution should run it in the Monte Carlo.
 */
export const SUPPLY_SCENARIOS = [
  { id: 'firm', name: 'Firm supply', utilisation: 0.92, crudePremium: 0, note: 'A term contract that is honoured, at the market price.' },
  { id: 'tight', name: 'Tight supply', utilisation: 0.75, crudePremium: 3, note: 'Cargoes are available but contested: the plant runs below nameplate and pays up for barrels.' },
  { id: 'disrupted', name: 'Disrupted supply', utilisation: 0.50, crudePremium: 6, note: 'Interruptions are routine. Half the nameplate and a hard premium, which is where most of these projects are actually decided.' },
];

/**
 * The licensing sequence, as a tracking checklist.
 *
 * A PROCESS AID AND NOT LEGAL ADVICE. The stages and their order are the
 * shape of the Nigerian process; what each requires in any given year is set
 * by the regulator and changes. The app tracks where a project has got to and
 * says plainly that the regulator's current requirements govern.
 */
export const LICENSING_STAGES = [
  {
    id: 'lte',
    name: 'Licence to Establish',
    stage: 1,
    summary: 'Approval to proceed with a project at a named site, granted before any construction.',
    typicalEvidence: ['Feasibility study', 'Site title or lease', 'Evidence of funding', 'Environmental impact assessment scoping'],
  },
  {
    id: 'ltc',
    name: 'Licence to Construct',
    stage: 2,
    summary: 'Approval to build what was approved in principle, once the design and the safety case exist.',
    typicalEvidence: ['Detailed engineering design', 'Approved environmental impact assessment', 'Construction HSE plan', 'Financing close'],
  },
  {
    id: 'lto',
    name: 'Licence to Operate',
    stage: 3,
    summary: 'Approval to run the plant, after it is built, commissioned and inspected.',
    typicalEvidence: ['Mechanical completion and commissioning records', 'Pre-startup safety review', 'Operating and emergency procedures', 'Product quality assurance'],
  },
];

/** Progress through the licensing sequence, from what the user has ticked. */
export const licensingProgress = (completedIds = []) => {
  const done = new Set(completedIds);
  const stages = LICENSING_STAGES.map((s) => ({ ...s, complete: done.has(s.id) }));
  const nextStage = stages.find((s) => !s.complete) ?? null;
  return {
    stages,
    completeCount: stages.filter((s) => s.complete).length,
    nextStage,
    // Out-of-order completion is a data-entry error worth surfacing: you
    // cannot hold a construction licence without an establishment one.
    outOfOrder: stages.some((s, i) => s.complete && stages.slice(0, i).some((p) => !p.complete)),
  };
};
