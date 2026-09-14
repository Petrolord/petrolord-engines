/**
 * Flare gas to value (Midstream & Downstream DS10).
 *
 * The last app of the module and its bridge back upstream. A volume of gas
 * is being burned for nothing; the question is which of a handful of routes
 * turns it into something, given the gas that is actually there rather than
 * the gas the brochure assumed.
 *
 * Today this is screened in ad-hoc spreadsheets, one per bidder, rebuilt for
 * every parcel.
 *
 * THE THING THIS APP EXISTS TO GET RIGHT
 *
 * You cannot claim a flare's whole emission as abatement unless the gas is
 * never burned. Recover it and sell it as CNG and the customer burns it,
 * emitting CO2 in a truck instead of at the flare tip.
 *
 * The abatement is the DIFFERENCE against a stated counterfactual, and it is
 * not reliably smaller OR larger than the flare's gross emission:
 *
 *  - if the product simply adds combustion somewhere that had none, the
 *    abatement is SMALLER than the gross figure, and can even be negative
 *  - if the product displaces a dirtier fuel, the abatement can be LARGER
 *    than the gross figure, because the diesel that is no longer burned is
 *    abated too
 *
 * Which way it goes is not knowable without the counterfactual. That is
 * exactly why one is required, and why a gross claim is not a conservative
 * shortcut but simply a different number from the right one.
 *
 * Nearly every flare-monetisation business case claims the gross figure.
 * This module refuses to compute an abatement at all until the
 * counterfactual is declared, because the number is meaningless without it
 * and a meaningless number in a bid is worse than a missing one.
 *
 * WHAT IT SCREENS ON
 *
 * The gas, not the wish. Each route carries a requirement envelope - volume,
 * inerts, liquids content, heating value - and a gas that fails is reported
 * with WHICH requirement it failed and by how much, because "not feasible"
 * is not an answer anyone can act on. The envelopes are editable data, since
 * they are commercial and technology-specific rather than physical law.
 *
 * WHAT IT DOES NOT DO
 *
 * Value the project. Capital, operating cost and revenue are assembled into
 * a cash flow and handed to the sanctioned economics engine, exactly as the
 * Modular Refinery Feasibility Studio does. A second discounted cash flow
 * here would be a second answer.
 */

import { scaleCapex, SCALING_EXPONENT } from './modularRefinery.js';

/** Missing stays missing. */
const num = (v, fallback = NaN) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const round = (v, dp = 6) => (Number.isFinite(v)
  ? Math.round(v * 10 ** dp) / 10 ** dp
  : null);

/** One lb-mol of an ideal gas at standard conditions, by definition. */
export const SCF_PER_LBMOL = 379.49;
export const LB_PER_KG = 2.20462262;
export const GAL_PER_FT3 = 7.480519;

// ---------------------------------------------------------------------------
// The gas that is actually there
// ---------------------------------------------------------------------------

/**
 * Component data for characterising associated gas.
 *
 * Atom counts and molar masses are DEFINITIONAL. Heating values and liquid
 * densities are a LABELLED REFERENCE - they vary with the source and the
 * gas analysis governs - and nothing here reads them unless a caller passes
 * one in.
 */
export const GAS_COMPONENT_REFERENCE = [
  { code: 'C1', label: 'Methane', c: 1, molarMassLbLbmol: 16.043, typicalGhvBtuScf: 1010, liquidDensityLbGal: null, recoverableAsNgl: false },
  { code: 'C2', label: 'Ethane', c: 2, molarMassLbLbmol: 30.070, typicalGhvBtuScf: 1770, liquidDensityLbGal: 2.971, recoverableAsNgl: true },
  { code: 'C3', label: 'Propane', c: 3, molarMassLbLbmol: 44.096, typicalGhvBtuScf: 2516, liquidDensityLbGal: 4.233, recoverableAsNgl: true },
  { code: 'IC4', label: 'Iso-butane', c: 4, molarMassLbLbmol: 58.122, typicalGhvBtuScf: 3252, liquidDensityLbGal: 4.695, recoverableAsNgl: true },
  { code: 'NC4', label: 'n-Butane', c: 4, molarMassLbLbmol: 58.122, typicalGhvBtuScf: 3263, liquidDensityLbGal: 4.872, recoverableAsNgl: true },
  { code: 'C5', label: 'Pentanes plus', c: 5, molarMassLbLbmol: 72.150, typicalGhvBtuScf: 4010, liquidDensityLbGal: 5.253, recoverableAsNgl: true },
  { code: 'N2', label: 'Nitrogen', c: 0, molarMassLbLbmol: 28.014, typicalGhvBtuScf: 0, liquidDensityLbGal: null, recoverableAsNgl: false, inert: true },
  { code: 'CO2', label: 'Carbon dioxide', c: 1, molarMassLbLbmol: 44.010, typicalGhvBtuScf: 0, liquidDensityLbGal: null, recoverableAsNgl: false, inert: true },
];

export const GAS_REFERENCE_NOTE = 'Molar masses and carbon numbers are definitional. Heating values and liquid densities are typical: the gas analysis and the certificate govern, and a measured value should replace these.';

/**
 * Characterise the gas: heating value, inerts, carbon, and the liquids in it.
 *
 * The liquids content - gallons of recoverable hydrocarbon per thousand
 * standard cubic feet - is the number that decides whether extracting LPG is
 * even a conversation, and it is DERIVED here from the composition and the
 * component liquid densities rather than read off a table. gal/Mscf follows
 * from the moles in a thousand cubic feet, the molar mass and the liquid
 * density, and nothing else.
 *
 * Inerts are tracked separately because they are the killer for several of
 * these routes: nitrogen cannot be burned out and carbon dioxide has to be
 * removed before anything is liquefied.
 */
export const characteriseGas = ({ components = [] }) => {
  const rows = components.map((c) => ({
    code: c.code,
    y: num(c.moleFraction),
    c: num(c.c, 0),
    molarMassLbLbmol: num(c.molarMassLbLbmol),
    ghvBtuScf: num(c.ghvBtuScf, null),
    liquidDensityLbGal: num(c.liquidDensityLbGal, null),
    recoverableAsNgl: !!c.recoverableAsNgl,
    inert: !!c.inert,
  }));
  if (rows.some((r) => !Number.isFinite(r.y))) {
    return { error: 'Every component needs a mole fraction.' };
  }
  const sum = rows.reduce((s, r) => s + r.y, 0);
  if (!(sum > 0)) return { error: 'The gas composition sums to nothing.' };
  const norm = rows.map((r) => ({ ...r, y: r.y / sum }));

  const haveGhv = norm.every((r) => r.ghvBtuScf !== null);
  const ghv = haveGhv ? norm.reduce((s, r) => s + r.y * r.ghvBtuScf, 0) : null;
  const inertFraction = norm.filter((r) => r.inert).reduce((s, r) => s + r.y, 0);
  const co2Fraction = norm.filter((r) => r.code === 'CO2').reduce((s, r) => s + r.y, 0);
  const carbonPerMol = norm.reduce((s, r) => s + r.y * r.c, 0);
  const molarMass = norm.reduce((s, r) => s + r.y * r.molarMassLbLbmol, 0);

  // Gallons of liquid per Mscf, from first principles:
  //   lbmol per Mscf = 1000 / 379.49
  //   lb of component = lbmol x y x MW
  //   gallons        = lb / (liquid density in lb/gal)
  const lbmolPerMscf = 1000 / SCF_PER_LBMOL;
  const nglRows = norm.filter((r) => r.recoverableAsNgl);
  const missingDensity = nglRows.filter((r) => r.liquidDensityLbGal === null).map((r) => r.code);
  const gpmOf = (codes) => {
    const set = nglRows.filter((r) => codes.includes(r.code) && r.liquidDensityLbGal !== null);
    return set.reduce(
      (s, r) => s + (lbmolPerMscf * r.y * r.molarMassLbLbmol) / r.liquidDensityLbGal, 0,
    );
  };
  const gpmC2Plus = gpmOf(['C2', 'C3', 'IC4', 'NC4', 'C5']);
  const gpmC3Plus = gpmOf(['C3', 'IC4', 'NC4', 'C5']);

  return {
    error: null,
    normalised: norm.map((r) => ({ code: r.code, moleFraction: round(r.y, 8) })),
    ghvBtuScf: round(ghv, 4),
    ghvNote: haveGhv ? null
      : 'A heating value missing on any component makes the mixture value missing, not partial.',
    inertMoleFraction: round(inertFraction, 8),
    co2MoleFraction: round(co2Fraction, 8),
    carbonPerMol: round(carbonPerMol, 8),
    molarMassLbLbmol: round(molarMass, 6),
    // The number that decides whether liquids extraction is a conversation.
    gpmC2Plus: round(gpmC2Plus, 6),
    gpmC3Plus: round(gpmC3Plus, 6),
    gpmBasis: 'Derived from the composition and the component liquid densities: gallons per Mscf follows from the moles in a thousand cubic feet, the molar mass and the liquid density.',
    missingLiquidDensity: missingDensity,
    richness: gpmC3Plus >= 2.5 ? 'rich' : gpmC3Plus >= 1 ? 'moderate' : 'lean',
  };
};

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

/**
 * The routes, with the shape of their requirement envelopes.
 *
 * The LIMITS ARE NULL. They are commercial and technology-specific rather
 * than physical law - a licensor's CO2 limit for a liquefaction train is a
 * design choice, and the minimum volume that makes a route worth building
 * moves with the market. Shipping numbers here would be shipping somebody
 * else's project as if it were a rule.
 */
export const ROUTE_TEMPLATES = [
  {
    id: 'cng', label: 'Compressed natural gas',
    requirements: [
      { key: 'minVolumeMMscfd', label: 'Minimum volume', unit: 'MMscfd', limit: null, direction: 'min' },
      { key: 'maxInertFraction', label: 'Maximum inerts', unit: 'mole fraction', limit: null, direction: 'max' },
      { key: 'minGhvBtuScf', label: 'Minimum heating value', unit: 'Btu/scf', limit: null, direction: 'min' },
    ],
  },
  {
    id: 'mini_lng', label: 'Mini LNG',
    requirements: [
      { key: 'minVolumeMMscfd', label: 'Minimum volume', unit: 'MMscfd', limit: null, direction: 'min' },
      { key: 'maxCo2Fraction', label: 'Maximum CO2 before treatment', unit: 'mole fraction', limit: null, direction: 'max', note: 'CO2 freezes in a liquefaction train and must be removed first. The limit is the licensor\'s.' },
      { key: 'maxInertFraction', label: 'Maximum inerts', unit: 'mole fraction', limit: null, direction: 'max' },
    ],
  },
  {
    id: 'lpg_extraction', label: 'LPG and condensate extraction',
    requirements: [
      { key: 'minVolumeMMscfd', label: 'Minimum volume', unit: 'MMscfd', limit: null, direction: 'min' },
      { key: 'minGpmC3Plus', label: 'Minimum liquids content', unit: 'gal/Mscf of C3+', limit: null, direction: 'min', note: 'Below this the liquids do not pay for the plant, whatever the gas is worth.' },
    ],
  },
  {
    id: 'gas_to_power', label: 'Gas to power or gas to wire',
    requirements: [
      { key: 'minVolumeMMscfd', label: 'Minimum volume', unit: 'MMscfd', limit: null, direction: 'min' },
      { key: 'minGhvBtuScf', label: 'Minimum heating value', unit: 'Btu/scf', limit: null, direction: 'min' },
      { key: 'maxInertFraction', label: 'Maximum inerts', unit: 'mole fraction', limit: null, direction: 'max' },
    ],
  },
];

export const ROUTE_TEMPLATE_NOTE = 'Requirement limits are yours to set. They are commercial and technology-specific rather than physical law: a licensor\'s CO2 limit is a design choice and the minimum viable volume moves with the market.';

/**
 * Screen a gas against a route.
 *
 * "Not feasible" is not an answer anybody can act on, so a failure names
 * WHICH requirement failed, what the gas is, what the limit was and by how
 * much it missed. A requirement with no limit set is reported as UNCHECKED
 * rather than passed, because an unset limit is not a satisfied one.
 */
export const screenRoute = ({ route, gas, volumeMMscfd }) => {
  if (!gas || gas.error) return { error: 'A characterised gas is required.' };
  const v = num(volumeMMscfd);
  const values = {
    minVolumeMMscfd: v,
    maxInertFraction: gas.inertMoleFraction,
    maxCo2Fraction: gas.co2MoleFraction,
    minGhvBtuScf: gas.ghvBtuScf,
    minGpmC3Plus: gas.gpmC3Plus,
  };

  const checks = (route.requirements || []).map((r) => {
    const limit = num(r.limit, null);
    const actual = values[r.key];
    if (limit === null) {
      return { ...r, actual: round(actual, 6), status: 'unchecked', margin: null };
    }
    if (actual === null || !Number.isFinite(actual)) {
      return { ...r, actual: null, status: 'no data', margin: null };
    }
    const pass = r.direction === 'min' ? actual >= limit : actual <= limit;
    const margin = r.direction === 'min' ? actual - limit : limit - actual;
    return {
      ...r, actual: round(actual, 6), status: pass ? 'pass' : 'fail', margin: round(margin, 6),
    };
  });

  const failures = checks.filter((c) => c.status === 'fail');
  const unchecked = checks.filter((c) => c.status === 'unchecked' || c.status === 'no data');

  return {
    error: null,
    routeId: route.id,
    label: route.label,
    checks,
    // Three states, not two. An unset limit is not a satisfied one.
    verdict: failures.length ? 'fails' : unchecked.length ? 'not fully screened' : 'passes',
    failures: failures.map((f) => ({
      requirement: f.label,
      limit: num(f.limit, null),
      actual: f.actual,
      shortfall: round(Math.abs(f.margin), 6),
      unit: f.unit,
    })),
    uncheckedRequirements: unchecked.map((c) => c.label),
  };
};

// ---------------------------------------------------------------------------
// What the route produces and what it costs
// ---------------------------------------------------------------------------

/**
 * Product and revenue for a route, from a recovery and a price.
 *
 * The recovery is an input per route, because it is a process design
 * outcome rather than a property of the gas, and a recovery assumed at a
 * hundred percent is the quiet optimism that sinks these business cases.
 *
 * Capital is scaled from a reference plant by the SAME power law the Modular
 * Refinery Feasibility Studio uses, rather than a second implementation.
 */
export const routeEconomics = ({
  route, gas, volumeMMscfd, onstreamDays = 350,
  productUnitPerMscf, recoveryFraction, pricePerProductUnit, productUnitLabel,
  referenceCapitalCost, referenceCapacityMMscfd, scalingExponent = SCALING_EXPONENT.MODULAR,
  fixedOpexPerYear = 0, variableOpexPerMscf = 0,
}) => {
  if (!gas || gas.error) return { error: 'A characterised gas is required.' };
  const v = num(volumeMMscfd);
  const days = num(onstreamDays, 350);
  const yieldPerMscf = num(productUnitPerMscf);
  const rec = num(recoveryFraction);
  const price = num(pricePerProductUnit, null);
  if (!(v > 0)) return { error: 'A gas volume is required.' };
  if (!Number.isFinite(yieldPerMscf)) {
    return { error: `Route "${route.label}" needs a product yield per Mscf.` };
  }
  if (!Number.isFinite(rec) || rec <= 0 || rec > 1) {
    return {
      error: `Route "${route.label}" needs a recovery fraction in (0, 1]. A recovery assumed at 100 percent is the quiet optimism that sinks these cases.`,
    };
  }

  const mscfPerYear = v * 1000 * days;
  const productPerYear = mscfPerYear * yieldPerMscf * rec;
  const revenue = price === null ? null : productPerYear * price;

  const capex = scaleCapex({
    baseCost: num(referenceCapitalCost, null),
    baseCapacity: num(referenceCapacityMMscfd, null),
    capacity: v,
    exponent: num(scalingExponent, SCALING_EXPONENT.MODULAR),
  });
  const opex = num(fixedOpexPerYear, 0) + mscfPerYear * num(variableOpexPerMscf, 0);

  return {
    error: null,
    routeId: route.id,
    label: route.label,
    mscfPerYear: round(mscfPerYear, 3),
    recoveryFraction: rec,
    productPerYear: round(productPerYear, 4),
    productUnitLabel,
    pricePerProductUnit: price,
    revenuePerYear: round(revenue, 2),
    capitalCost: round(capex.cost, 2),
    scalingExponent: capex.exponent,
    operatingCostPerYear: round(opex, 2),
    grossMarginPerYear: revenue === null ? null : round(revenue - opex, 2),
    valuePerMscf: revenue === null || mscfPerYear === 0
      ? null : round((revenue - opex) / mscfPerYear, 6),
    capexNote: capex.cost === null
      ? 'No capital cost: a reference plant cost and capacity are required to scale from.' : null,
    // Handed over, not discounted here.
    cashFlow: {
      year0: capex.cost === null ? null : round(-capex.cost, 2),
      recurring: revenue === null ? null : round(revenue - opex, 2),
    },
    valuationNote: 'Capital, operating cost and revenue are assembled here and handed to the sanctioned economics engine. A second discounted cash flow in this module would be a second answer.',
  };
};

// ---------------------------------------------------------------------------
// The abatement, and the thing everybody gets wrong
// ---------------------------------------------------------------------------

/**
 * Emissions abated by recovering the gas instead of flaring it.
 *
 * THE COUNTERFACTUAL IS REQUIRED AND THERE IS NO DEFAULT.
 *
 * Flaring the gas emits CO2 from the carbon that burns and methane from the
 * carbon that does not. Recovering it avoids all of that - and then the
 * product gets burned by somebody else, which emits CO2 in a truck or a
 * turbine instead of at the flare tip. The abatement is the DIFFERENCE, and
 * it depends entirely on what the product displaces.
 *
 * Selling CNG that displaces diesel abates MORE than the flare emitted,
 * because the diesel is abated as well. Selling gas that displaces the same
 * gas from a pipeline abates only the flare itself. Selling into a market
 * that was burning nothing abates less than the flare emitted, and can abate
 * nothing at all. Three different answers from one flare.
 *
 * Claiming the flare's gross emission as abatement is what nearly every
 * flare-monetisation business case does, and it is wrong unless the gas is
 * never burned at all. This module will not produce a number until the
 * counterfactual is stated.
 */
export const abatement = ({
  gas, volumeMMscfd, onstreamDays = 350,
  flareDestructionEfficiency,
  productCombustionTonnesCo2ePerYear = null,
  displacedFuelTonnesCo2ePerYear = null,
  gwpMethane = null,
  counterfactualLabel = null,
}) => {
  if (!gas || gas.error) return { error: 'A characterised gas is required.' };
  const v = num(volumeMMscfd);
  const days = num(onstreamDays, 350);
  const eta = num(flareDestructionEfficiency);
  if (!(v > 0)) return { error: 'A gas volume is required.' };
  if (!Number.isFinite(eta) || eta <= 0 || eta > 1) {
    return { error: 'A flare destruction efficiency in (0, 1] is required. For a flare it is most of the answer and it is contested, so it is not assumed.' };
  }

  // Moles of gas a year, and the carbon in them.
  const scfPerYear = v * 1e6 * days;
  const lbmolPerYear = scfPerYear / SCF_PER_LBMOL;
  const carbonLbmol = lbmolPerYear * gas.carbonPerMol;
  const tonnesFrom = (lbmol, mw) => (lbmol * mw) / LB_PER_KG / 1000;

  const flareCo2 = tonnesFrom(carbonLbmol * eta, 44.009);
  const flareCh4Lbmol = carbonLbmol * (1 - eta);
  const flareCh4 = tonnesFrom(flareCh4Lbmol, 16.043);
  const gwp = num(gwpMethane, null);
  const flareCo2e = gwp === null ? null : flareCo2 + flareCh4 * gwp;

  const productCo2e = num(productCombustionTonnesCo2ePerYear, null);
  const displacedCo2e = num(displacedFuelTonnesCo2ePerYear, null);
  const counterfactualDeclared = !!counterfactualLabel
    && productCo2e !== null && displacedCo2e !== null;

  const net = flareCo2e === null || !counterfactualDeclared
    ? null : flareCo2e - productCo2e + displacedCo2e;

  return {
    error: null,
    scfPerYear: round(scfPerYear, 0),
    flareCo2Tonnes: round(flareCo2, 3),
    flareCh4Tonnes: round(flareCh4, 3),
    flareCo2eTonnes: round(flareCo2e, 3),
    gwpMethane: gwp,
    productCombustionTonnesCo2ePerYear: productCo2e,
    displacedFuelTonnesCo2ePerYear: displacedCo2e,
    counterfactualLabel,
    counterfactualDeclared,
    netAbatementTonnesCo2ePerYear: round(net, 3),
    // The claim the app exists to stop.
    grossClaimIfNoCounterfactual: round(flareCo2e, 3),
    blockedBy: gwp === null
      ? 'no methane global warming potential supplied'
      : !counterfactualDeclared
        ? 'the counterfactual is not declared: what the product displaces, and what burning it emits'
        : null,
    warning: counterfactualDeclared ? null
      : 'No abatement is reported. The flare\'s gross emission is not the abatement: recover the gas and somebody burns it, and if that displaces a dirtier fuel the abatement is larger while if it displaces nothing it is smaller. State what the product displaces and what burning it emits.',
    // Useful even before the counterfactual: the flare's own footprint.
    methaneShareOfFlareCo2e: flareCo2e === null || flareCo2e === 0 || gwp === null
      ? null : round((flareCh4 * gwp) / flareCo2e, 6),
  };
};

/**
 * Whether the project needs carbon credits to work.
 *
 * That is the question for a bid, and it is a different question from what
 * the credits are worth. A project that clears the hurdle without them is
 * robust; one that only clears with them is a bet on a credit price, and the
 * app says which it is at each price rather than adding a line of revenue
 * and moving on.
 */
export const creditSensitivity = ({
  netAbatementTonnesCo2ePerYear, creditPrices = [],
  grossMarginPerYear = null, hurdleMarginPerYear = 0,
}) => {
  const t = num(netAbatementTonnesCo2ePerYear, null);
  if (t === null) {
    return {
      error: 'No net abatement to sell. Declare the counterfactual first: a credit computed from a gross flare figure is a credit that cannot be issued.',
    };
  }
  const margin = num(grossMarginPerYear, null);
  const hurdle = num(hurdleMarginPerYear, 0);
  const points = creditPrices.map((p) => {
    const price = num(p);
    const creditRevenue = Number.isFinite(price) ? t * price : null;
    const total = margin === null || creditRevenue === null ? null : margin + creditRevenue;
    return {
      creditPrice: price,
      creditRevenuePerYear: round(creditRevenue, 2),
      totalMarginPerYear: round(total, 2),
      clearsHurdle: total === null ? null : total >= hurdle,
    };
  });
  const standsAlone = margin === null ? null : margin >= hurdle;
  const firstClearing = points.find((p) => p.clearsHurdle);

  return {
    error: null,
    netAbatementTonnesCo2ePerYear: round(t, 3),
    points,
    hurdleMarginPerYear: hurdle,
    // The distinction that matters for a bid.
    standsAloneWithoutCredits: standsAlone,
    creditPriceNeeded: standsAlone ? 0
      : firstClearing ? firstClearing.creditPrice : null,
    verdict: standsAlone
      ? 'Clears the hurdle on its own. Credits are upside, not the case.'
      : firstClearing
        ? `Only clears the hurdle at a credit price of ${firstClearing.creditPrice} or above. This is a bet on the credit price.`
        : 'Does not clear the hurdle at any credit price tested.',
  };
};

/**
 * The bid summary: routes side by side on the things a decision turns on.
 *
 * Routes that FAILED SCREENING ARE KEPT IN THE TABLE with their failure
 * named, rather than dropped. A route missing from a comparison looks like a
 * route nobody considered, and in a bid that is the difference between
 * thorough and careless.
 */
export const compareRoutes = ({ screenings = [], economics = [], abatements = {} }) => {
  const byId = (arr) => new Map(arr.filter((x) => x && !x.error).map((x) => [x.routeId, x]));
  const econ = byId(economics);
  const rows = screenings.filter((s) => s && !s.error).map((s) => {
    const e = econ.get(s.routeId) || null;
    const a = abatements[s.routeId] || null;
    return {
      routeId: s.routeId,
      label: s.label,
      verdict: s.verdict,
      failures: s.failures,
      uncheckedRequirements: s.uncheckedRequirements,
      capitalCost: e ? e.capitalCost : null,
      revenuePerYear: e ? e.revenuePerYear : null,
      grossMarginPerYear: e ? e.grossMarginPerYear : null,
      valuePerMscf: e ? e.valuePerMscf : null,
      netAbatementTonnesCo2ePerYear: a && !a.error ? a.netAbatementTonnesCo2ePerYear : null,
    };
  });

  const eligible = rows.filter((r) => r.verdict !== 'fails' && r.valuePerMscf !== null);
  const best = eligible.length
    ? eligible.reduce((a, b) => (b.valuePerMscf > a.valuePerMscf ? b : a))
    : null;

  return {
    rows,
    // Kept, not dropped: a missing route reads as one nobody considered.
    screenedOut: rows.filter((r) => r.verdict === 'fails').map((r) => r.label),
    notFullyScreened: rows.filter((r) => r.verdict === 'not fully screened').map((r) => r.label),
    bestByValuePerMscf: best ? best.routeId : null,
    rankingNote: best
      ? 'Ranked on gross margin per Mscf, which ignores the capital. Compare that against the capital column before concluding, and value the shortlist in the sanctioned economics engine.'
      : 'No route both passes screening and has a value; supply the missing prices and limits.',
  };
};
