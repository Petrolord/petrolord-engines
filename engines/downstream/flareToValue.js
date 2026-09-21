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

/** A box left empty ('' or null), as opposed to a value left out of the call. */
const isBlank = (v) => v === '' || v === null;

/**
 * On-stream days. Omitted from the call it takes the stated 350; left
 * blank it is missing (MD4-0: blank used to read as 350 too), and it must
 * lie in (0, 366].
 */
const onstreamDaysOf = (v) => {
  if (v === undefined) return { value: 350, error: null };
  const d = num(v);
  if (!(d > 0 && d <= 366)) {
    return { value: null, error: 'On-stream days are required, more than 0 and no more than 366.' };
  }
  return { value: d, error: null };
};

/**
 * One lb-mol of an ideal gas at 60 F and 14.696 psia: R T / P with
 * R = 8.314462618 J/(mol K), T = 288.7056 K, P = 101325 Pa, over
 * 0.45359237 kg/lb and 0.028316846592 m3/ft3, is 379.48 to 379.49. The
 * oracle derives it; it is a convention of the standard conditions, not a
 * definition.
 */
export const SCF_PER_LBMOL = 379.49;
export const LB_PER_KG = 2.20462262;
export const GAL_PER_FT3 = 7.480519;

/**
 * The molar masses the flare's tonnes are weighed at (kg/kmol), from the
 * IUPAC conventional atomic weights C 12.011, O 15.999, H 1.008, as the
 * carbon engine's MW_CO2 and MW_CH4. Exported in MD45-1 so a reader takes
 * them from the engine instead of asking it about an all-CO2 flare.
 * (GAS_COMPONENT_REFERENCE carries CO2 at 44.010, its tabulated value.)
 */
export const FLARE_MOLAR_MASS = Object.freeze({ CO2: 44.009, CH4: 16.043 });

/**
 * The richness words and their lower edges in gallons of C3+ per Mscf:
 * rich at 2.5 and above, moderate at 1 and above, lean below 1. Screening
 * words, labelled as such; a route's own liquids limit governs. Exported in
 * MD45-1.
 */
export const RICHNESS_GPM = Object.freeze({ rich: 2.5, moderate: 1 });

// ---------------------------------------------------------------------------
// The gas that is actually there
// ---------------------------------------------------------------------------

/**
 * Component data for characterising associated gas.
 *
 * Atom counts and molar masses are DEFINITIONAL. Heating values and liquid
 * densities are a LABELLED REFERENCE - they vary with the source and the
 * gas analysis governs - and nothing here reads them unless a caller passes
 * one in. *
 * CO2 is tabulated at 44.010 (the GPA-style value on the older atomic
 * weights, 44.0095) for the gas's mass and liquids; the flare's tonnes are
 * weighed at FLARE_MOLAR_MASS (44.009, IUPAC 2024). The two differ by
 * 2.3e-5 relative, and the table is kept so the route ceilings the course
 * grades do not move (MD45-1, stated rather than merged).
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
  // MD4-0: a component with no carbon number used to count as carbon-free,
  // so a hydrocarbon typed without one burned to nothing at the flare. It is
  // taken from the reference by code, and refused when the code is unknown.
  const carbonOf = (c) => {
    const typed = num(c.c, null);
    if (typed !== null) return typed;
    const r = GAS_COMPONENT_REFERENCE.find((x) => x.code === c.code);
    return r ? r.c : NaN;
  };
  const rows = components.map((c) => ({
    code: c.code,
    y: num(c.moleFraction),
    c: carbonOf(c),
    molarMassLbLbmol: num(c.molarMassLbLbmol),
    ghvBtuScf: num(c.ghvBtuScf, null),
    liquidDensityLbGal: num(c.liquidDensityLbGal, null),
    recoverableAsNgl: !!c.recoverableAsNgl,
    inert: !!c.inert,
  }));
  if (rows.some((r) => !Number.isFinite(r.y))) {
    return { error: 'Every component needs a mole fraction.' };
  }
  if (rows.some((r) => r.y < 0)) {
    return { error: 'A mole fraction cannot be negative.' };
  }
  const noCarbon = rows.filter((r) => !Number.isFinite(r.c)).map((r) => r.code);
  if (noCarbon.length) {
    return { error: `No carbon number for ${noCarbon.join(', ')}. The flare's CO2 is counted atom by atom, so it is not assumed.` };
  }
  const sum = rows.reduce((s, r) => s + r.y, 0);
  if (!(sum > 0)) return { error: 'The gas composition sums to nothing.' };
  const norm = rows.map((r) => ({ ...r, y: r.y / sum }));

  const haveGhv = norm.every((r) => r.ghvBtuScf !== null);
  const ghv = haveGhv ? norm.reduce((s, r) => s + r.y * r.ghvBtuScf, 0) : null;
  const inertFraction = norm.filter((r) => r.inert).reduce((s, r) => s + r.y, 0);
  const co2Fraction = norm.filter((r) => r.code === 'CO2').reduce((s, r) => s + r.y, 0);
  const carbonPerMol = norm.reduce((s, r) => s + r.y * r.c, 0);
  // MD4-0: the flare's CO2 and methane follow 40 CFR 98.233(n): the
  // hydrocarbons burn (carbon atom by atom), the CO2 in the gas passes
  // through unburned, and the methane that escapes is the METHANE in the
  // gas, not every unburned carbon counted as if it were methane.
  const hydrocarbonCarbonPerMol = norm
    .filter((r) => !r.inert && r.code !== 'CO2').reduce((s, r) => s + r.y * r.c, 0);
  const methaneFraction = norm.filter((r) => r.code === 'C1').reduce((s, r) => s + r.y, 0);
  const molarMass = norm.reduce((s, r) => s + r.y * r.molarMassLbLbmol, 0);
  // Mass in a thousand standard cubic feet, and the part of it that is
  // propane and heavier. These are the physical ceilings on a route's yield.
  const lbPerMscf = (rs) => rs.reduce((s, r) => s + (1000 / SCF_PER_LBMOL) * r.y * r.molarMassLbLbmol, 0);
  const kgPerMscf = lbPerMscf(norm) / LB_PER_KG;
  const c3PlusRows = norm.filter((r) => ['C3', 'IC4', 'NC4', 'C5'].includes(r.code));
  const c3PlusKgPerMscf = lbPerMscf(c3PlusRows) / LB_PER_KG;

  // Gallons of liquid per Mscf, from first principles:
  //   lbmol per Mscf = 1000 / 379.49
  //   lb of component = lbmol x y x MW
  //   gallons        = lb / (liquid density in lb/gal)
  const lbmolPerMscf = 1000 / SCF_PER_LBMOL;
  const nglRows = norm.filter((r) => r.recoverableAsNgl);
  const missingDensity = nglRows.filter((r) => r.liquidDensityLbGal === null).map((r) => r.code);
  // MD4-0: a component with no liquid density used to be left out of the
  // sum, so the liquids content was a partial figure the richness verdict
  // was then read from. Like the heating value, it is now missing, not partial.
  const gpmOf = (codes) => {
    const all = nglRows.filter((r) => codes.includes(r.code));
    if (all.some((r) => r.liquidDensityLbGal === null)) return NaN;
    return all.reduce(
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
      : 'A heating value missing on any component leaves the mixture value missing too. No partial average is reported.',
    inertMoleFraction: round(inertFraction, 8),
    co2MoleFraction: round(co2Fraction, 8),
    carbonPerMol: round(carbonPerMol, 8),
    hydrocarbonCarbonPerMol: round(hydrocarbonCarbonPerMol, 8),
    methaneMoleFraction: round(methaneFraction, 8),
    molarMassLbLbmol: round(molarMass, 6),
    kgPerMscf: round(kgPerMscf, 8),
    c3PlusKgPerMscf: round(c3PlusKgPerMscf, 8),
    rawMoleFractionSum: round(sum, 8),
    normalisationNote: Math.abs(sum - 1) > 1e-6
      ? `The mole fractions summed to ${round(sum, 6)} and were scaled to one. Check the analysis if that was not intended.`
      : null,
    // The number that decides whether liquids extraction is a conversation.
    gpmC2Plus: round(gpmC2Plus, 6),
    gpmC3Plus: round(gpmC3Plus, 6),
    gpmBasis: 'Derived from the composition and the component liquid densities: gallons per Mscf follows from the moles in a thousand cubic feet, the molar mass and the liquid density.',
    missingLiquidDensity: missingDensity,
    richness: !Number.isFinite(gpmC3Plus) ? null
      : gpmC3Plus >= RICHNESS_GPM.rich ? 'rich' : gpmC3Plus >= RICHNESS_GPM.moderate ? 'moderate' : 'lean',
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
    yieldBasis: { unit: 'kg', ceiling: 'gas mass' },
    requirements: [
      { key: 'minVolumeMMscfd', label: 'Minimum volume', unit: 'MMscfd', limit: null, direction: 'min' },
      { key: 'maxInertFraction', label: 'Maximum inerts', unit: 'mole fraction', limit: null, direction: 'max' },
      { key: 'minGhvBtuScf', label: 'Minimum heating value', unit: 'Btu/scf', limit: null, direction: 'min' },
    ],
  },
  {
    id: 'mini_lng', label: 'Mini LNG',
    yieldBasis: { unit: 't', ceiling: 'gas mass' },
    requirements: [
      { key: 'minVolumeMMscfd', label: 'Minimum volume', unit: 'MMscfd', limit: null, direction: 'min' },
      { key: 'maxCo2Fraction', label: 'Maximum CO2 before treatment', unit: 'mole fraction', limit: null, direction: 'max', note: 'CO2 freezes in a liquefaction train and must be removed first. The limit is the licensor\'s.' },
      { key: 'maxInertFraction', label: 'Maximum inerts', unit: 'mole fraction', limit: null, direction: 'max' },
    ],
  },
  {
    id: 'lpg_extraction', label: 'LPG and condensate extraction',
    yieldBasis: { unit: 't', ceiling: 'propane and heavier' },
    requirements: [
      { key: 'minVolumeMMscfd', label: 'Minimum volume', unit: 'MMscfd', limit: null, direction: 'min' },
      { key: 'minGpmC3Plus', label: 'Minimum liquids content', unit: 'gal/Mscf of C3+', limit: null, direction: 'min', note: 'Below this the liquids do not pay for the plant, whatever the gas is worth.' },
    ],
  },
  {
    id: 'gas_to_power', label: 'Gas to power or gas to wire',
    yieldBasis: { unit: 'MWh', ceiling: 'heating value' },
    requirements: [
      { key: 'minVolumeMMscfd', label: 'Minimum volume', unit: 'MMscfd', limit: null, direction: 'min' },
      { key: 'minGhvBtuScf', label: 'Minimum heating value', unit: 'Btu/scf', limit: null, direction: 'min' },
      { key: 'maxInertFraction', label: 'Maximum inerts', unit: 'mole fraction', limit: null, direction: 'max' },
    ],
  },
];

/** One MWh in International Table Btu: 3.6e9 J over 1055.05585262 J/Btu. */
export const BTU_PER_MWH = 3.6e9 / 1055.05585262;

/**
 * The most product one Mscf of this gas can physically make, in the route's
 * yield unit (MD4-0). The page's LPG route used to default to 0.02 t/Mscf
 * from a gas holding 0.0056 t of propane and heavier per Mscf: 3.6 times
 * what was there. A yield is a design outcome and is the user's; a yield
 * above what the gas contains is not a design, and is refused.
 */
export const yieldCeiling = ({ yieldBasis, gas }) => {
  if (!yieldBasis || !gas || gas.error) return null;
  const perUnit = { kg: 1, t: 1 / 1000 };
  // Own keys only: 'constructor' used to read a function here, the ceiling
  // came out NaN and a yield above what the gas holds was never refused.
  const factor = Object.prototype.hasOwnProperty.call(perUnit, yieldBasis.unit) ? perUnit[yieldBasis.unit] : undefined;
  if (yieldBasis.ceiling === 'gas mass' && factor) {
    return gas.kgPerMscf === null ? null : gas.kgPerMscf * factor;
  }
  if (yieldBasis.ceiling === 'propane and heavier' && factor) {
    return gas.c3PlusKgPerMscf === null ? null : gas.c3PlusKgPerMscf * factor;
  }
  if (yieldBasis.ceiling === 'heating value' && yieldBasis.unit === 'MWh') {
    return gas.ghvBtuScf === null ? null : (gas.ghvBtuScf * 1000) / BTU_PER_MWH;
  }
  return null;
};

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
    const actual = Object.prototype.hasOwnProperty.call(values, r.key) ? values[r.key] : undefined;
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
  const days = onstreamDaysOf(onstreamDays);
  const yieldPerMscf = num(productUnitPerMscf);
  const rec = num(recoveryFraction);
  const price = num(pricePerProductUnit, null);
  if (!(v > 0)) return { error: 'A gas volume is required.' };
  if (days.error) return { error: days.error };
  if (!(yieldPerMscf > 0)) {
    return { error: `Route "${route.label}" needs a positive product yield per Mscf.` };
  }
  const template = ROUTE_TEMPLATES.find((t) => t.id === route.id);
  const yieldBasis = route.yieldBasis || (template ? template.yieldBasis : null);
  const ceiling = yieldCeiling({ yieldBasis, gas });
  if (ceiling !== null && yieldPerMscf > ceiling * (1 + 1e-9)) {
    return {
      error: `Route "${route.label}" yields ${round(yieldPerMscf, 6)} ${yieldBasis.unit} per Mscf, more than the ${round(ceiling, 6)} ${yieldBasis.unit} the gas holds (${yieldBasis.ceiling}). A yield above what the gas contains is refused.`,
      yieldCeilingPerMscf: round(ceiling, 8),
    };
  }
  if (!Number.isFinite(rec) || rec <= 0 || rec > 1) {
    return {
      error: `Route "${route.label}" needs a recovery fraction in (0, 1]. A recovery assumed at 100 percent is the quiet optimism that sinks these cases.`,
    };
  }

  const mscfPerYear = v * 1000 * days.value;
  const productPerYear = mscfPerYear * yieldPerMscf * rec;
  const revenue = price === null ? null : productPerYear * price;

  const capex = scaleCapex({
    baseCost: num(referenceCapitalCost, null),
    baseCapacity: num(referenceCapacityMMscfd, null),
    capacity: v,
    exponent: num(scalingExponent, SCALING_EXPONENT.MODULAR),
  });
  // MD4-0: a blank cost box was read as 0 without a word. It is still taken
  // as zero, and named, so the margin says what it rests on.
  const assumedZero = [];
  if (isBlank(fixedOpexPerYear)) assumedZero.push('fixed operating cost');
  if (isBlank(variableOpexPerMscf)) assumedZero.push('variable operating cost');
  const opex = num(fixedOpexPerYear, 0) + mscfPerYear * num(variableOpexPerMscf, 0);

  return {
    error: null,
    routeId: route.id,
    label: route.label,
    mscfPerYear: round(mscfPerYear, 3),
    onstreamDays: days.value,
    recoveryFraction: rec,
    yieldCeilingPerMscf: round(ceiling, 8),
    assumedZero,
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
  flareCombustionEfficiency = null,
  recoveryFraction,
  productCombustionTonnesCo2ePerYear = null,
  displacedFuelTonnesCo2ePerYear = null,
  gwpMethane = null,
  counterfactualLabel = null,
}) => {
  if (!gas || gas.error) return { error: 'A characterised gas is required.' };
  const v = num(volumeMMscfd);
  const days = onstreamDaysOf(onstreamDays);
  const eta = num(flareDestructionEfficiency);
  if (!(v > 0)) return { error: 'A gas volume is required.' };
  if (days.error) return { error: days.error };
  if (!Number.isFinite(eta) || eta <= 0 || eta > 1) {
    return { error: 'A flare destruction efficiency in (0, 1] is required. For a flare it is most of the answer and it is contested, so it is not assumed.' };
  }
  // 40 CFR 98.233(n) separates the DESTRUCTION efficiency (hydrocarbon
  // destroyed; it sets the methane) from the COMBUSTION efficiency
  // (hydrocarbon oxidised to CO2; it sets the CO2). Without a combustion
  // efficiency the destruction efficiency stands in for it, and the result
  // says so.
  const etaCInput = num(flareCombustionEfficiency, null);
  if (etaCInput !== null && !(etaCInput > 0 && etaCInput <= eta)) {
    return { error: 'A flare combustion efficiency must lie in (0, 1] and cannot exceed the destruction efficiency.' };
  }
  const etaC = etaCInput === null ? eta : etaCInput;

  // Moles of gas a year.
  const scfPerYear = v * 1e6 * days.value;
  const lbmolPerYear = scfPerYear / SCF_PER_LBMOL;
  const tonnesFrom = (lbmol, mw) => (lbmol * mw) / LB_PER_KG / 1000;

  // MD4-0: every unburned carbon used to be counted as methane, and the CO2
  // already in the gas was "burned" with the fuel, so its unburned share
  // became methane too. At the page's gas (78 percent methane, 1.30 carbon
  // per mole) that overstated the methane slip by 67 percent.
  const hcCarbon = gas.hydrocarbonCarbonPerMol;
  const yCo2 = gas.co2MoleFraction;
  const yCh4 = gas.methaneMoleFraction;
  const flareCo2 = tonnesFrom(lbmolPerYear * (etaC * hcCarbon + yCo2), FLARE_MOLAR_MASS.CO2);
  const flareCh4 = tonnesFrom(lbmolPerYear * yCh4 * (1 - eta), FLARE_MOLAR_MASS.CH4);
  const gwp = num(gwpMethane, null);
  const flareCo2e = gwp === null ? null : flareCo2 + flareCh4 * gwp;

  // MD4-0: the recovery. Gas the plant does not recover is still flared,
  // so only the recovered share of the flare is avoided. The abatement used
  // to credit the whole flare to a plant recovering 90 percent of it.
  const rec = num(recoveryFraction, null);
  const recOk = rec !== null && rec > 0 && rec <= 1;
  const avoidedCo2e = flareCo2e === null || !recOk ? null : flareCo2e * rec;

  const productCo2e = num(productCombustionTonnesCo2ePerYear, null);
  const displacedCo2e = num(displacedFuelTonnesCo2ePerYear, null);
  const counterfactualDeclared = !!counterfactualLabel
    && productCo2e !== null && displacedCo2e !== null;

  const net = avoidedCo2e === null || !counterfactualDeclared
    ? null : avoidedCo2e - productCo2e + displacedCo2e;

  const blockedBy = gwp === null
    ? 'no methane global warming potential supplied'
    : !recOk
      ? 'no recovery fraction in (0, 1]: gas the plant does not recover is still flared'
      : !counterfactualDeclared
        ? 'the counterfactual is not declared: what the product displaces, and what burning it emits'
        : null;

  return {
    error: null,
    scfPerYear: round(scfPerYear, 0),
    flareCo2Tonnes: round(flareCo2, 3),
    flareCh4Tonnes: round(flareCh4, 3),
    flareCo2eTonnes: round(flareCo2e, 3),
    destructionEfficiency: eta,
    combustionEfficiency: etaC,
    combustionEfficiencyNote: etaCInput === null
      ? 'No combustion efficiency was given, so the destruction efficiency stands in for it. 40 CFR 98.233(n) puts combustion 1.5 points below destruction, so the CO2 here is slightly high.'
      : null,
    basis: '40 CFR 98.233(n): CO2 = the CO2 in the gas plus the combustion efficiency times the hydrocarbon carbon; CH4 = the methane in the gas times one less the destruction efficiency. Unburned ethane and heavier are not methane and carry no GWP here.',
    gwpMethane: gwp,
    recoveryFraction: recOk ? rec : null,
    avoidedFlareCo2eTonnes: round(avoidedCo2e, 3),
    productCombustionTonnesCo2ePerYear: productCo2e,
    displacedFuelTonnesCo2ePerYear: displacedCo2e,
    counterfactualLabel,
    counterfactualDeclared,
    netAbatementTonnesCo2ePerYear: round(net, 3),
    // The claim the app exists to stop.
    grossClaimIfNoCounterfactual: round(flareCo2e, 3),
    blockedBy,
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
  // MD4-0: a project that ADDS emissions used to "sell" negative credits,
  // which read as a cost that grew with the credit price. There is nothing
  // to issue, so it is refused.
  if (!(t > 0)) {
    return {
      error: `The net abatement is ${round(t, 3)} tCO2e a year: the project does not abate, so there are no credits to sell.`,
    };
  }
  const margin = num(grossMarginPerYear, null);
  // MD4-0: a blank hurdle read as 0. Omitted it keeps the stated 0; blank
  // it is missing, and no verdict is given without it.
  const hurdle = isBlank(hurdleMarginPerYear) ? null : num(hurdleMarginPerYear, NaN);
  if (hurdle !== null && !Number.isFinite(hurdle)) {
    return { error: 'The hurdle margin is not a number.' };
  }
  const known = margin !== null && hurdle !== null;
  const points = creditPrices.map((p) => {
    const price = num(p);
    const creditRevenue = Number.isFinite(price) ? t * price : null;
    const total = margin === null || creditRevenue === null ? null : margin + creditRevenue;
    return {
      creditPrice: price,
      creditRevenuePerYear: round(creditRevenue, 2),
      totalMarginPerYear: round(total, 2),
      clearsHurdle: total === null || hurdle === null ? null : total >= hurdle,
    };
  });
  const standsAlone = known ? margin >= hurdle : null;
  // MD4-0: the price needed used to be the FIRST price in the list that
  // cleared, in the order typed, so "60, 15" reported 60. It is now the
  // breakeven in closed form, (hurdle - margin) / tonnes, and the lowest
  // tested price that clears is reported beside it.
  const breakeven = !known ? null : standsAlone ? 0 : (hurdle - margin) / t;
  const clearing = points.filter((p) => p.clearsHurdle).map((p) => p.creditPrice);
  const lowestClearing = clearing.length ? Math.min(...clearing) : null;

  let verdict;
  if (!known) {
    verdict = margin === null
      ? 'No margin for this route, so whether it needs credits cannot be said. Supply its price and costs.'
      : 'No hurdle margin, so whether it needs credits cannot be said.';
  } else if (standsAlone) {
    verdict = 'Clears the hurdle on its own. Credits are upside; the case stands without them.';
  } else {
    verdict = `Needs a credit price of ${round(breakeven, 2)} per tonne to clear the hurdle${lowestClearing === null && points.length ? ', above every price tested' : ''}. This is a bet on the credit price.`;
  }

  return {
    error: null,
    netAbatementTonnesCo2ePerYear: round(t, 3),
    points,
    hurdleMarginPerYear: hurdle,
    // The distinction that matters for a bid.
    standsAloneWithoutCredits: standsAlone,
    breakevenCreditPrice: round(breakeven, 6),
    lowestTestedClearingPrice: lowestClearing,
    creditPriceNeeded: round(breakeven, 6),
    verdict,
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

  // MD4-0: a route nobody had screened (every limit unset, which is how the
  // page opens) used to be crowned "best on value". The best is now drawn
  // only from routes that PASS; the leader among routes not fully screened
  // is reported apart, as provisional.
  const top = (list) => (list.length
    ? list.reduce((a, b) => (b.valuePerMscf > a.valuePerMscf ? b : a)) : null);
  const valued = rows.filter((r) => r.valuePerMscf !== null);
  const best = top(valued.filter((r) => r.verdict === 'passes'));
  const provisional = top(valued.filter((r) => r.verdict !== 'fails'));

  return {
    rows,
    // Kept, not dropped: a missing route reads as one nobody considered.
    screenedOut: rows.filter((r) => r.verdict === 'fails').map((r) => r.label),
    notFullyScreened: rows.filter((r) => r.verdict === 'not fully screened').map((r) => r.label),
    bestByValuePerMscf: best ? best.routeId : null,
    leaderNotFullyScreened: !best && provisional ? provisional.routeId : null,
    rankingNote: best
      ? 'Ranked on gross margin per Mscf, which ignores the capital. Compare that against the capital column before concluding, and value the shortlist in the sanctioned economics engine.'
      : provisional
        ? `No route passes screening yet, so none is ranked best. ${provisional.label} leads on value among routes not fully screened; set the limits before relying on it.`
        : 'No route both passes screening and has a value; supply the missing prices and limits.',
  };
};
