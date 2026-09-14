/**
 * Energy and utilities efficiency (Midstream & Downstream DS8).
 *
 * The first app of Track C, and the one that turns the module's carbon
 * doctrine into arithmetic: every saving found here is priced in money AND
 * in tonnes of CO2, from the same fuel quantity, in the same run.
 *
 * WHAT IS COMPUTED FROM FIRST PRINCIPLES
 *
 * Combustion stoichiometry, from the fuel analysis the user supplies. Air
 * required, flue gas produced and excess air from a measured stack oxygen
 * all follow from the carbon, hydrogen, oxygen and sulfur in the fuel and
 * the composition of air. No chart, no rule of thumb.
 *
 * Pinch targets, by the Problem Table Algorithm. The minimum hot and cold
 * utility for a stream set is a result, not a correlation, and the algorithm
 * that finds it is short enough to write correctly.
 *
 * WHAT IS REFUSED
 *
 * The Solomon Energy Intensity Index. EII is a proprietary benchmark with a
 * specific standard-energy methodology and a subscription behind it.
 * Computing something similar and calling it EII would be wrong in a way
 * that matters commercially, so this computes the plant's OWN energy
 * intensity and compares it against a peer figure the user supplies. It says
 * plainly that this is not EII.
 *
 * The radiation and convection loss. It comes off an ABMA or API 560 chart
 * against surface area and firing rate, which is a published chart. It is a
 * required input with no default.
 *
 * A minimum safe stack oxygen. Below some excess air a burner makes carbon
 * monoxide, and where that point sits depends on the burner, the fuel and
 * the draught control. The app will not recommend a setpoint the user has
 * not declared safe.
 *
 * AND THE BASIS IS ALWAYS DECLARED
 *
 * An efficiency on the lower heating value and an efficiency on the higher
 * heating value differ by about ten percent on natural gas. Quoting one as
 * the other is the single most common error in this field, so every
 * efficiency here carries its basis and the app refuses to compare two
 * efficiencies on different bases.
 */

/** Missing stays missing. */
const num = (v, fallback = NaN) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Rounding policy, as in fuelPricing.js and lpgCng.js: quantities are
 * rounded to the resolution they are reported at, RATES AND RATIOS ARE NOT,
 * because a caller multiplies them back up.
 */
const round = (v, dp = 6) => (Number.isFinite(v)
  ? Math.round(v * 10 ** dp) / 10 ** dp
  : null);

/** Mole fraction of oxygen in dry air. A measured composition, not a guess. */
export const O2_MOLE_FRACTION_DRY_AIR = 0.20946;
export const AIR_MOLAR_MASS = 28.9647;

export const HEATING_VALUE_BASIS = { LHV: 'LHV', HHV: 'HHV' };

/**
 * Fuel components. The ATOM COUNTS ARE DEFINITIONAL - they come from the
 * formula and drive all the stoichiometry. The heating values are a
 * LABELLED REFERENCE: they vary with the fuel and the analysis governs, so
 * a caller passes its own or accepts these knowing what they are.
 */
export const FUEL_REFERENCE = [
  { code: 'CH4', label: 'Methane', c: 1, h: 4, o: 0, s: 0, n: 0, molarMassKgKmol: 16.043, typicalLhvMJKmol: 802.6, typicalHhvMJKmol: 890.8 },
  { code: 'C2H6', label: 'Ethane', c: 2, h: 6, o: 0, s: 0, n: 0, molarMassKgKmol: 30.070, typicalLhvMJKmol: 1428.6, typicalHhvMJKmol: 1560.7 },
  { code: 'C3H8', label: 'Propane', c: 3, h: 8, o: 0, s: 0, n: 0, molarMassKgKmol: 44.096, typicalLhvMJKmol: 2043.1, typicalHhvMJKmol: 2219.2 },
  { code: 'C4H10', label: 'Butane', c: 4, h: 10, o: 0, s: 0, n: 0, molarMassKgKmol: 58.122, typicalLhvMJKmol: 2657.3, typicalHhvMJKmol: 2877.5 },
  { code: 'H2', label: 'Hydrogen', c: 0, h: 2, o: 0, s: 0, n: 0, molarMassKgKmol: 2.016, typicalLhvMJKmol: 241.8, typicalHhvMJKmol: 285.8 },
  { code: 'CO2', label: 'Carbon dioxide (inert)', c: 1, h: 0, o: 2, s: 0, n: 0, molarMassKgKmol: 44.010, typicalLhvMJKmol: 0, typicalHhvMJKmol: 0, inert: true },
  { code: 'N2', label: 'Nitrogen (inert)', c: 0, h: 0, o: 0, s: 0, n: 2, molarMassKgKmol: 28.014, typicalLhvMJKmol: 0, typicalHhvMJKmol: 0, inert: true },
];

export const FUEL_REFERENCE_NOTE = 'Atom counts are definitional and drive the stoichiometry. Heating values are typical: the fuel analysis governs, and a measured value should replace these.';

/** Typical values a stack-loss calculation needs, labelled as such. */
export const PROPERTY_REFERENCE = {
  fluGasCpKJkgK: { typical: 1.10, range: '1.05-1.20 over 150-400 C', note: 'Mean specific heat of flue gas. Varies with temperature and composition.' },
  waterVapourCpKJkgK: { typical: 1.95, range: '1.9-2.1', note: 'Mean specific heat of water vapour in the stack.' },
  waterLatentHeatKJkg: { typical: 2442, range: 'at 25 C reference', note: 'Latent heat of vaporisation of water at the reference temperature.' },
};

// ---------------------------------------------------------------------------
// Combustion, from the fuel analysis
// ---------------------------------------------------------------------------

/**
 * Stoichiometry of burning one kilomole of the supplied fuel mixture.
 *
 * For each component CcHhOoSs the oxygen demand is c + h/4 + s - o/2, which
 * is conservation of atoms and nothing more. Air follows from the oxygen
 * content of air. The products follow the same way.
 *
 * Inerts in the fuel (CO2, N2) are carried through to the flue gas, which
 * matters: a fuel gas with thirty percent inerts has a very different flue
 * gas from one without, and treating it as if it were pure hydrocarbon
 * misstates every loss downstream.
 */
export const combustionStoichiometry = ({ components = [] }) => {
  const rows = components.map((c) => ({
    code: c.code,
    y: num(c.moleFraction),
    c: num(c.c, 0), h: num(c.h, 0), o: num(c.o, 0), s: num(c.s, 0), n: num(c.n, 0),
    molarMassKgKmol: num(c.molarMassKgKmol),
    lhvMJKmol: num(c.lhvMJKmol, null),
    hhvMJKmol: num(c.hhvMJKmol, null),
  }));
  if (rows.some((r) => !Number.isFinite(r.y))) {
    return { error: 'Every component needs a mole fraction.' };
  }
  const ySum = rows.reduce((s, r) => s + r.y, 0);
  if (!(ySum > 0)) return { error: 'The fuel composition sums to nothing.' };
  const norm = rows.map((r) => ({ ...r, y: r.y / ySum }));

  // Atom balance. This is the whole of the stoichiometry.
  const o2PerKmolFuel = norm.reduce(
    (s, r) => s + r.y * (r.c + r.h / 4 + r.s - r.o / 2), 0,
  );
  const co2 = norm.reduce((s, r) => s + r.y * r.c, 0);
  const h2o = norm.reduce((s, r) => s + r.y * (r.h / 2), 0);
  const so2 = norm.reduce((s, r) => s + r.y * r.s, 0);
  const fuelN2 = norm.reduce((s, r) => s + r.y * (r.n / 2), 0);

  const airPerKmolFuel = o2PerKmolFuel / O2_MOLE_FRACTION_DRY_AIR;
  const airN2 = airPerKmolFuel * (1 - O2_MOLE_FRACTION_DRY_AIR);
  const molarMass = norm.reduce((s, r) => s + r.y * r.molarMassKgKmol, 0);

  const haveLhv = norm.every((r) => r.lhvMJKmol !== null);
  const haveHhv = norm.every((r) => r.hhvMJKmol !== null);

  return {
    error: null,
    normalised: norm.map((r) => ({ code: r.code, moleFraction: round(r.y, 8) })),
    o2PerKmolFuel: round(o2PerKmolFuel, 8),
    stoichAirPerKmolFuel: round(airPerKmolFuel, 8),
    // Mass basis too, because burners are metered on mass.
    stoichAirKgPerKgFuel: molarMass > 0
      ? round((airPerKmolFuel * AIR_MOLAR_MASS) / molarMass, 8) : null,
    fuelMolarMassKgKmol: round(molarMass, 6),
    products: {
      co2PerKmolFuel: round(co2, 8),
      h2oPerKmolFuel: round(h2o, 8),
      so2PerKmolFuel: round(so2, 8),
      n2PerKmolFuel: round(airN2 + fuelN2, 8),
    },
    lhvMJPerKmolFuel: haveLhv ? round(norm.reduce((s, r) => s + r.y * r.lhvMJKmol, 0), 6) : null,
    hhvMJPerKmolFuel: haveHhv ? round(norm.reduce((s, r) => s + r.y * r.hhvMJKmol, 0), 6) : null,
    heatingValueNote: haveLhv && haveHhv ? null
      : 'A heating value missing on any component makes the mixture value missing, not partial.',
  };
};

/**
 * Excess air from the oxygen measured in the dry stack gas.
 *
 * This is the single most useful measurement on a fired heater, and the
 * relation is derived here rather than taken from the usual shortcut
 * formula: with E the excess-air fraction, the dry flue gas contains
 * E x O2stoich of unburnt oxygen in a dry total that also grows with E, and
 * the equation is solved for E directly.
 *
 * Complete combustion is assumed and SAID to be. A stack with carbon
 * monoxide in it is not burning completely, the oxygen reading alone cannot
 * see that, and treating it as if it could is how a heater is tuned into
 * making CO.
 */
export const excessAirFromFlueOxygen = ({ stoichiometry, dryO2Percent }) => {
  const st = stoichiometry;
  if (!st || st.error) return { error: 'Valid stoichiometry is required.' };
  const o2pc = num(dryO2Percent);
  if (!Number.isFinite(o2pc)) return { error: 'A measured dry stack oxygen is required.' };
  if (o2pc < 0 || o2pc >= O2_MOLE_FRACTION_DRY_AIR * 100) {
    return { error: `Stack oxygen must lie between 0 and ${round(O2_MOLE_FRACTION_DRY_AIR * 100, 2)} percent.` };
  }
  const o2s = st.o2PerKmolFuel;
  const dryProductsStoich = st.products.co2PerKmolFuel + st.products.so2PerKmolFuel
    + st.products.n2PerKmolFuel;

  // Dry flue gas at excess E = stoichiometric dry products + excess air.
  // Unburnt oxygen = E x o2s. Solve  E x o2s / (dry + E x air) = o2pc/100.
  const f = o2pc / 100;
  const air = st.stoichAirPerKmolFuel;
  const denom = o2s - f * air;
  if (!(denom > 0)) {
    return { error: 'That oxygen reading is not reachable with this fuel by excess air alone.' };
  }
  const excess = (f * dryProductsStoich) / denom;

  return {
    error: null,
    excessAirFraction: round(excess, 8),
    excessAirPercent: round(excess * 100, 6),
    actualAirPerKmolFuel: round(air * (1 + excess), 8),
    dryFlueGasPerKmolFuel: round(dryProductsStoich + excess * air, 8),
    wetFlueGasPerKmolFuel: round(dryProductsStoich + excess * air + st.products.h2oPerKmolFuel, 8),
    assumption: 'Complete combustion. An oxygen reading alone cannot see carbon monoxide, so a stack making CO will read as if it had more excess air than it has.',
  };
};

/**
 * Fired-heater or boiler efficiency by the indirect method: losses out of
 * the stack, subtracted from a hundred.
 *
 * The indirect method is used rather than the direct one because it says
 * WHERE the energy went, and that is the difference between a number and an
 * action. Every loss is reported separately for that reason.
 *
 * THE BASIS IS CARRIED THROUGH. Moisture loss on a higher-heating-value
 * basis includes the latent heat of the water made by burning hydrogen;
 * on a lower-heating-value basis that latent heat was never counted as
 * available in the first place. Applying the wrong one is a several-percent
 * error, so the basis is declared and the two are computed differently.
 *
 * The radiation and convection loss is REQUIRED. It comes off a published
 * chart against surface area and firing rate and this module will not invent
 * one.
 */
export const stackLossEfficiency = ({
  stoichiometry, excessAir,
  stackTempC, combustionAirTempC,
  basis = HEATING_VALUE_BASIS.LHV,
  flueGasCpKJkgK, waterVapourCpKJkgK, waterLatentHeatKJkg,
  radiationLossPercent,
  unburnedLossPercent = 0,
  referenceTempC = 25,
}) => {
  const st = stoichiometry;
  const ea = excessAir;
  if (!st || st.error) return { error: 'Valid stoichiometry is required.' };
  if (!ea || ea.error) return { error: 'A valid excess-air result is required.' };
  const tStack = num(stackTempC);
  const tAir = num(combustionAirTempC);
  const cpFlue = num(flueGasCpKJkgK);
  const rad = num(radiationLossPercent);
  if (!Number.isFinite(tStack) || !Number.isFinite(tAir)) {
    return { error: 'A stack temperature and a combustion air temperature are required.' };
  }
  if (!Number.isFinite(cpFlue)) return { error: 'A flue gas specific heat is required.' };
  if (!Number.isFinite(rad)) {
    return {
      error: 'A radiation and convection loss is required and is not defaulted. It comes off a published chart against surface area and firing rate, which this module does not reproduce.',
    };
  }
  const heatingValue = basis === HEATING_VALUE_BASIS.HHV
    ? st.hhvMJPerKmolFuel : st.lhvMJPerKmolFuel;
  if (heatingValue === null || !(heatingValue > 0)) {
    return { error: `The fuel has no ${basis} to work from; supply heating values for every component.` };
  }

  const tRef = num(referenceTempC, 25);
  // Dry flue gas: sensible heat carried out of the stack. Masses via molar
  // masses of the products, so the composition actually matters.
  const P = st.products;
  const dryMolPerKmolFuel = P.co2PerKmolFuel + P.so2PerKmolFuel + P.n2PerKmolFuel
    + ea.excessAirFraction * st.stoichAirPerKmolFuel;
  const dryMassKg = P.co2PerKmolFuel * 44.010 + P.so2PerKmolFuel * 64.066
    + P.n2PerKmolFuel * 28.014 + ea.excessAirFraction * st.stoichAirPerKmolFuel * AIR_MOLAR_MASS;
  const dryLossKJ = dryMassKg * cpFlue * (tStack - tAir);

  // Moisture from burning hydrogen.
  const h2oMassKg = P.h2oPerKmolFuel * 18.015;
  const cpV = num(waterVapourCpKJkgK, null);
  const hfg = num(waterLatentHeatKJkg, null);
  let moistureLossKJ = null;
  let moistureBasisNote = null;
  if (basis === HEATING_VALUE_BASIS.HHV) {
    if (cpV === null || hfg === null) {
      return { error: 'On a higher-heating-value basis the moisture loss needs both the latent heat of water and the vapour specific heat.' };
    }
    // HHV counted the latent heat as available, so losing it is a real loss.
    moistureLossKJ = h2oMassKg * (hfg + cpV * (tStack - tRef));
    moistureBasisNote = 'On HHV the latent heat of the water made from hydrogen is a loss, because HHV counted it as available.';
  } else {
    if (cpV === null) {
      return { error: 'The moisture loss needs a vapour specific heat.' };
    }
    // LHV never counted it, so only the sensible heat of the vapour is lost.
    moistureLossKJ = h2oMassKg * cpV * (tStack - tRef);
    moistureBasisNote = 'On LHV only the sensible heat of the water vapour is a loss, because LHV never counted the latent heat as available.';
  }

  const hvKJ = heatingValue * 1000; // MJ/kmol -> kJ/kmol
  const dryPct = (dryLossKJ / hvKJ) * 100;
  const moisturePct = (moistureLossKJ / hvKJ) * 100;
  const unburned = num(unburnedLossPercent, 0);

  const losses = [
    { label: 'Dry flue gas', percent: round(dryPct, 6) },
    { label: 'Moisture from hydrogen', percent: round(moisturePct, 6) },
    { label: 'Radiation and convection', percent: round(rad, 6) },
    { label: 'Unburned and other', percent: round(unburned, 6) },
  ];
  const totalLoss = dryPct + moisturePct + rad + unburned;

  return {
    error: null,
    basis,
    losses,
    totalLossPercent: round(totalLoss, 6),
    efficiencyPercent: round(100 - totalLoss, 6),
    dryFlueGasKgPerKmolFuel: round(dryMassKg, 6),
    moistureKgPerKmolFuel: round(h2oMassKg, 6),
    excessAirPercent: ea.excessAirPercent,
    moistureBasisNote,
    // The comparison trap, named at source.
    comparisonWarning: `This efficiency is on ${basis}. An efficiency on the other basis is a different number for the same heater and the two must not be compared.`,
  };
};

/**
 * What tuning the excess air down is worth.
 *
 * Two efficiencies, same heater, same fuel, different stack oxygen. The
 * fuel saving is the ratio of the efficiencies, not their difference.
 *
 * Fuel is duty over efficiency, so the saving is 1 - e_current/e_target,
 * which is (e_target - e_current) / e_target. Subtracting the efficiency
 * percentages divides that same gap by a hundred instead of by the target
 * efficiency, and since the target is below a hundred the shortcut
 * UNDERSTATES the saving. It is the safer error of the two and it is still
 * an error: it is why tuning projects are turned down on a business case
 * that was never right.
 *
 * THE TARGET MUST BE DECLARED SAFE. Below some excess air a burner makes
 * carbon monoxide, and where that sits depends on the burner, the fuel and
 * the draught control. This will not recommend a setpoint the user has not
 * said is reachable.
 */
export const excessAirSaving = ({
  current, target, minimumSafeO2Percent, targetO2Percent, annualFuelEnergyGJ = null,
}) => {
  if (!current || current.error) return { error: 'A valid current efficiency is required.' };
  if (!target || target.error) return { error: 'A valid target efficiency is required.' };
  if (current.basis !== target.basis) {
    return { error: `The two efficiencies are on different bases (${current.basis} and ${target.basis}) and cannot be compared.` };
  }
  const floor = num(minimumSafeO2Percent);
  const tgt = num(targetO2Percent);
  if (!Number.isFinite(floor)) {
    return {
      error: 'A minimum safe stack oxygen is required and is not defaulted. Below some excess air a burner makes carbon monoxide, and where that point sits depends on the burner, the fuel and the draught control.',
    };
  }
  if (Number.isFinite(tgt) && tgt < floor) {
    return {
      error: `A target of ${tgt} percent oxygen is below the ${floor} percent declared safe for this burner. Raise the target or re-declare the floor after a combustion test.`,
      belowSafeFloor: true,
    };
  }
  const ec = current.efficiencyPercent;
  const et = target.efficiencyPercent;
  if (!(ec > 0) || !(et > 0)) return { error: 'Both efficiencies must be positive.' };

  // Same duty, so fuel scales inversely with efficiency.
  const fuelRatio = ec / et;
  const savingFraction = 1 - fuelRatio;
  const annual = num(annualFuelEnergyGJ, null);

  return {
    error: null,
    basis: current.basis,
    currentEfficiencyPercent: ec,
    targetEfficiencyPercent: et,
    fuelSavingFraction: round(savingFraction, 10),
    fuelSavingPercent: round(savingFraction * 100, 6),
    annualEnergySavedGJ: annual === null ? null : round(annual * savingFraction, 6),
    method: 'Fuel scales inversely with efficiency at the same duty, so the saving is (target - current) / target. Subtracting the efficiency percentages divides by a hundred instead of by the target efficiency, and understates the saving.',
  };
};

// ---------------------------------------------------------------------------
// Steam
// ---------------------------------------------------------------------------

/**
 * Steam lost through a failed trap, as choked flow through an orifice.
 *
 * A trap that has failed open is a hole in the steam system, and above a
 * pressure ratio of about two the flow through a hole is CHOKED: it depends
 * on the upstream pressure and not at all on what is downstream. That is
 * why a failed trap venting to atmosphere and one venting to a condensate
 * header lose nearly the same steam, which surprises people.
 *
 * The discharge coefficient is REQUIRED: it depends on the orifice geometry
 * and on how the trap failed, and a default would put a spurious precision
 * on a number that is already an estimate.
 */
export const steamTrapLoss = ({
  orificeDiameterMm, upstreamPressureBarA, dischargeCoefficient,
  steamDensityKgM3, specificHeatRatio = 1.3,
  hoursPerYear = 8760, steamCostPerTonne = null,
  steamEnergyMJPerTonne = null, emissionFactorKgCo2ePerGJ = null,
  boilerEfficiencyFraction = 1,
}) => {
  const d = num(orificeDiameterMm);
  const p = num(upstreamPressureBarA);
  const cd = num(dischargeCoefficient);
  const rho = num(steamDensityKgM3);
  const k = num(specificHeatRatio, 1.3);
  if (![d, p, rho].every((v) => Number.isFinite(v) && v > 0)) {
    return { error: 'An orifice diameter, an upstream pressure and a steam density are required.' };
  }
  if (!Number.isFinite(cd) || cd <= 0 || cd > 1) {
    return { error: 'A discharge coefficient in (0, 1] is required and is not defaulted: it depends on the orifice and on how the trap failed.' };
  }
  const areaM2 = Math.PI * (d / 1000) ** 2 / 4;
  const pPa = p * 1e5;
  // Choked mass flux: G = Cd x sqrt( k x rho x P x (2/(k+1))^((k+1)/(k-1)) ).
  const term = (2 / (k + 1)) ** ((k + 1) / (k - 1));
  const massFluxKgM2s = cd * Math.sqrt(k * rho * pPa * term);
  const kgPerHour = massFluxKgM2s * areaM2 * 3600;
  const hours = num(hoursPerYear, 8760);
  const tonnesPerYear = (kgPerHour * hours) / 1000;

  const cost = num(steamCostPerTonne, null);
  const energyPerTonne = num(steamEnergyMJPerTonne, null);
  const ef = num(emissionFactorKgCo2ePerGJ, null);
  const eta = num(boilerEfficiencyFraction, 1);
  const fuelGJ = energyPerTonne === null || !(eta > 0)
    ? null : (tonnesPerYear * energyPerTonne) / 1000 / eta;

  return {
    error: null,
    kgPerHour: round(kgPerHour, 8),
    tonnesPerYear: round(tonnesPerYear, 8),
    choked: true,
    chokedNote: 'Choked flow: the loss depends on the upstream pressure and not on what is downstream, so a trap blowing into a condensate header loses much the same steam as one blowing to atmosphere.',
    annualCost: cost === null ? null : round(tonnesPerYear * cost, 2),
    annualFuelGJ: fuelGJ === null ? null : round(fuelGJ, 8),
    annualTonnesCo2e: fuelGJ === null || ef === null ? null : round((fuelGJ * ef) / 1000, 8),
    carbonNote: fuelGJ === null || ef === null
      ? 'Carbon needs the steam energy content, the boiler efficiency and an emission factor. Without them it is absent rather than zero.'
      : null,
  };
};

/**
 * What returning condensate is worth.
 *
 * Condensate carries sensible heat AND is treated water. Losing it costs
 * fuel to reheat the makeup and costs the treatment again, and the second
 * is routinely left out of the business case. Both are reported, and the
 * treatment cost is an input rather than an assumption.
 */
export const condensateReturnValue = ({
  steamTonnesPerHour, currentReturnFraction, targetReturnFraction,
  condensateTempC, makeupTempC, waterCpKJkgK = 4.19,
  boilerEfficiencyFraction, fuelCostPerGJ = null,
  waterCostPerTonne = null, treatmentCostPerTonne = null,
  emissionFactorKgCo2ePerGJ = null, hoursPerYear = 8760,
}) => {
  const flow = num(steamTonnesPerHour);
  const cur = num(currentReturnFraction);
  const tgt = num(targetReturnFraction);
  const tC = num(condensateTempC);
  const tM = num(makeupTempC);
  const cp = num(waterCpKJkgK, 4.19);
  const eta = num(boilerEfficiencyFraction);
  if (![flow, cur, tgt, tC, tM].every(Number.isFinite)) {
    return { error: 'Steam flow, both return fractions and both temperatures are required.' };
  }
  if ([cur, tgt].some((v) => v < 0 || v > 1)) {
    return { error: 'Return fractions must lie between 0 and 1.' };
  }
  if (!Number.isFinite(eta) || eta <= 0 || eta > 1) {
    return { error: 'A boiler efficiency in (0, 1] is required: the fuel saved depends on it and it is not assumed.' };
  }
  const hours = num(hoursPerYear, 8760);
  const extraTonnesPerYear = flow * (tgt - cur) * hours;
  const energyPerTonneMJ = (cp * (tC - tM) * 1000) / 1000;
  const fuelGJ = (extraTonnesPerYear * energyPerTonneMJ) / 1000 / eta;

  const fuelCost = num(fuelCostPerGJ, null);
  const water = num(waterCostPerTonne, null);
  const treat = num(treatmentCostPerTonne, null);
  const ef = num(emissionFactorKgCo2ePerGJ, null);

  const components = [
    { label: 'Fuel not burned reheating makeup', amount: fuelCost === null ? null : fuelGJ * fuelCost },
    { label: 'Raw water not bought', amount: water === null ? null : extraTonnesPerYear * water },
    { label: 'Treatment not repeated', amount: treat === null ? null : extraTonnesPerYear * treat },
  ];
  const missing = components.filter((c) => c.amount === null).map((c) => c.label);

  return {
    error: null,
    extraCondensateTonnesPerYear: round(extraTonnesPerYear, 3),
    energySavedGJPerYear: round(fuelGJ, 6),
    components: components.map((c) => ({ ...c, amount: round(c.amount, 2) })),
    annualValue: round(components.reduce((s, c) => s + (c.amount ?? 0), 0), 2),
    complete: missing.length === 0,
    missingInputs: missing,
    valueNote: missing.length
      ? `A floor, not the value: ${missing.join(', ')} not priced. The treatment cost is the one usually left out.`
      : null,
    annualTonnesCo2e: ef === null ? null : round((fuelGJ * ef) / 1000, 8),
  };
};

// ---------------------------------------------------------------------------
// Energy intensity
// ---------------------------------------------------------------------------

/**
 * The plant's own energy intensity, against a peer figure the user supplies.
 *
 * THIS IS NOT EII. The Solomon Energy Intensity Index is a proprietary
 * benchmark with a specific standard-energy methodology behind it, and
 * computing something similar and labelling it EII would be wrong in a way
 * that matters commercially. This computes energy in per unit of throughput,
 * which is a real and useful number, and compares it against whatever peer
 * figure the user has a right to use. The disclaimer is part of the result.
 */
export const energyIntensity = ({
  energyStreams = [], throughputTonnes, peerIntensityMJPerTonne = null,
}) => {
  const rows = energyStreams.map((s) => ({
    label: s.label, energyGJ: num(s.energyGJ),
  }));
  const missing = rows.filter((r) => !Number.isFinite(r.energyGJ)).map((r) => r.label);
  const t = num(throughputTonnes);
  if (!Number.isFinite(t) || t <= 0) return { error: 'A throughput is required.' };
  const totalGJ = rows.reduce((s, r) => s + (Number.isFinite(r.energyGJ) ? r.energyGJ : 0), 0);
  const intensity = (totalGJ * 1000) / t;
  const peer = num(peerIntensityMJPerTonne, null);

  return {
    error: null,
    totalEnergyGJ: round(totalGJ, 3),
    intensityMJPerTonne: round(intensity, 4),
    streams: rows.map((r) => ({
      ...r,
      energyGJ: round(r.energyGJ, 3),
      share: totalGJ > 0 && Number.isFinite(r.energyGJ) ? round(r.energyGJ / totalGJ, 6) : null,
    })),
    complete: missing.length === 0,
    missingStreams: missing,
    peerIntensityMJPerTonne: peer,
    versusPeer: peer === null || !(peer > 0) ? null : round(intensity / peer, 6),
    gapMJPerTonne: peer === null ? null : round(intensity - peer, 4),
    disclaimer: 'This is the plant\'s own energy per tonne of throughput. It is NOT the Solomon Energy Intensity Index, which is a proprietary benchmark with its own standard-energy methodology. Any peer figure compared here is one you supplied and have the right to use.',
  };
};

// ---------------------------------------------------------------------------
// Pinch targeting
// ---------------------------------------------------------------------------

/**
 * Minimum hot and cold utility for a set of streams, by the Problem Table
 * Algorithm.
 *
 * This is a RESULT, not a correlation. Shift every temperature by half the
 * minimum approach - hot streams down, cold streams up - so that any heat
 * exchange feasible in shifted space is feasible in real space. Cascade the
 * surplus down the temperature intervals. The most negative point in the
 * cascade is the heat that has to come in from a hot utility; adding it
 * makes every cascade value non-negative, and the point that becomes zero
 * is the pinch.
 *
 * The pinch is where the design is constrained. Above it the process needs
 * heat and below it needs cooling, and any heat carried ACROSS the pinch
 * costs double: one unit more hot utility AND one unit more cold utility.
 * That is the single most valuable thing this calculation says.
 */
export const pinchTargets = ({ streams = [], minimumApproachC }) => {
  const dTmin = num(minimumApproachC);
  if (!Number.isFinite(dTmin) || dTmin < 0) {
    return { error: 'A minimum approach temperature is required and must not be negative.' };
  }
  const parsed = streams.map((s, i) => ({
    label: s.label || `Stream ${i + 1}`,
    supplyC: num(s.supplyC),
    targetC: num(s.targetC),
    cpKWperK: num(s.cpKWperK),
  }));
  if (parsed.some((s) => !Number.isFinite(s.supplyC) || !Number.isFinite(s.targetC) || !Number.isFinite(s.cpKWperK))) {
    return { error: 'Every stream needs a supply temperature, a target temperature and a heat capacity flowrate.' };
  }
  const active = parsed.filter((s) => s.supplyC !== s.targetC && s.cpKWperK !== 0);
  if (active.length === 0) return { error: 'No stream changes temperature, so there is nothing to target.' };

  // Hot streams give heat up (supply above target); cold streams take it.
  const typed = active.map((s) => {
    const hot = s.supplyC > s.targetC;
    const half = dTmin / 2;
    return {
      ...s,
      hot,
      duty: Math.abs(s.cpKWperK * (s.supplyC - s.targetC)),
      // Shifted so that a feasible match in shifted space is feasible in real
      // space: hot streams look colder, cold streams look hotter.
      shiftedHigh: hot ? Math.max(s.supplyC, s.targetC) - half : Math.max(s.supplyC, s.targetC) + half,
      shiftedLow: hot ? Math.min(s.supplyC, s.targetC) - half : Math.min(s.supplyC, s.targetC) + half,
    };
  });

  const boundaries = [...new Set(typed.flatMap((s) => [s.shiftedHigh, s.shiftedLow]))]
    .sort((a, b) => b - a);

  const intervals = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const top = boundaries[i];
    const bottom = boundaries[i + 1];
    const dT = top - bottom;
    const cpHot = typed.filter((s) => s.hot && s.shiftedHigh >= top && s.shiftedLow <= bottom)
      .reduce((a, s) => a + Math.abs(s.cpKWperK), 0);
    const cpCold = typed.filter((s) => !s.hot && s.shiftedHigh >= top && s.shiftedLow <= bottom)
      .reduce((a, s) => a + Math.abs(s.cpKWperK), 0);
    // Positive means the interval has surplus heat to pass down.
    intervals.push({ top, bottom, dT, cpHot, cpCold, surplus: (cpHot - cpCold) * dT });
  }

  // First cascade, starting from zero at the top.
  let running = 0;
  const first = intervals.map((iv) => {
    running += iv.surplus;
    return { ...iv, cascade: running };
  });
  const mostNegative = Math.min(0, ...first.map((iv) => iv.cascade));
  const qhMin = -mostNegative;

  // Feasible cascade: add the hot utility at the top.
  let feasible = qhMin;
  const cascade = [{ shiftedC: boundaries[0], heatFlowKW: round(feasible, 6) }];
  const rows = first.map((iv) => {
    feasible += iv.surplus;
    cascade.push({ shiftedC: iv.bottom, heatFlowKW: round(feasible, 6) });
    return {
      topShiftedC: round(iv.top, 6),
      bottomShiftedC: round(iv.bottom, 6),
      cpHotKWperK: round(iv.cpHot, 6),
      cpColdKWperK: round(iv.cpCold, 6),
      surplusKW: round(iv.surplus, 6),
      cascadeKW: round(feasible, 6),
    };
  });
  const qcMin = feasible;

  // The pinch is where the feasible cascade touches zero.
  const TOL = 1e-9;
  const zeroPoints = cascade.filter((p) => Math.abs(p.heatFlowKW) < 1e-6);
  const pinchShifted = zeroPoints.length ? zeroPoints[0].shiftedC : null;

  const totalHotDuty = typed.filter((s) => s.hot).reduce((a, s) => a + s.duty, 0);
  const totalColdDuty = typed.filter((s) => !s.hot).reduce((a, s) => a + s.duty, 0);

  return {
    error: null,
    minimumApproachC: dTmin,
    hotUtilityKW: round(qhMin, 6),
    coldUtilityKW: round(qcMin, 6),
    // Below the tolerance a "threshold problem" has no pinch, and saying
    // there is one anyway would invent a constraint.
    pinchShiftedC: pinchShifted,
    pinchHotC: pinchShifted === null ? null : round(pinchShifted + dTmin / 2, 6),
    pinchColdC: pinchShifted === null ? null : round(pinchShifted - dTmin / 2, 6),
    thresholdProblem: qhMin < TOL || qcMin < TOL,
    intervals: rows,
    grandComposite: cascade,
    totalHotStreamDutyKW: round(totalHotDuty, 6),
    totalColdStreamDutyKW: round(totalColdDuty, 6),
    // The energy balance the whole thing must satisfy.
    heatRecoveredKW: round(totalHotDuty - qcMin, 6),
    balanceCheck: round((qhMin + totalHotDuty) - (qcMin + totalColdDuty), 6),
    crossPinchNote: 'Heat carried across the pinch costs twice: one unit more hot utility and one unit more cold utility. That is what makes the pinch the constraint rather than a curiosity.',
  };
};

/**
 * A composite curve for one side, as a list of (enthalpy, temperature)
 * points. Real temperatures, not shifted, because this is what gets plotted
 * and read against process conditions.
 */
export const compositeCurve = ({ streams = [], side = 'hot' }) => {
  const parsed = streams
    .map((s, i) => ({
      label: s.label || `Stream ${i + 1}`,
      supplyC: num(s.supplyC), targetC: num(s.targetC), cpKWperK: num(s.cpKWperK),
    }))
    .filter((s) => Number.isFinite(s.supplyC) && Number.isFinite(s.targetC)
      && Number.isFinite(s.cpKWperK) && s.supplyC !== s.targetC && s.cpKWperK !== 0)
    .filter((s) => (side === 'hot' ? s.supplyC > s.targetC : s.supplyC < s.targetC));
  if (parsed.length === 0) return { points: [], totalDutyKW: 0 };

  const temps = [...new Set(parsed.flatMap((s) => [s.supplyC, s.targetC]))].sort((a, b) => a - b);
  const points = [{ temperatureC: temps[0], enthalpyKW: 0 }];
  let h = 0;
  for (let i = 0; i < temps.length - 1; i += 1) {
    const lo = temps[i];
    const hi = temps[i + 1];
    const cp = parsed
      .filter((s) => Math.min(s.supplyC, s.targetC) <= lo && Math.max(s.supplyC, s.targetC) >= hi)
      .reduce((a, s) => a + Math.abs(s.cpKWperK), 0);
    h += cp * (hi - lo);
    points.push({ temperatureC: hi, enthalpyKW: round(h, 6) });
  }
  return { points, totalDutyKW: round(h, 6) };
};

// ---------------------------------------------------------------------------
// The dual ledger
// ---------------------------------------------------------------------------

/**
 * One saving, priced in money and in carbon from the SAME energy.
 *
 * Doctrine 3 made arithmetic: the two figures cannot disagree because they
 * come from one number in one call. The emission factor is required and its
 * absence leaves the carbon figure absent rather than zero.
 */
export const priceSaving = ({
  energySavedGJ, fuelCostPerGJ = null, emissionFactorKgCo2ePerGJ = null,
  implementationCost = null,
}) => {
  const gj = num(energySavedGJ);
  if (!Number.isFinite(gj)) return { error: 'An energy saving is required.' };
  const cost = num(fuelCostPerGJ, null);
  const ef = num(emissionFactorKgCo2ePerGJ, null);
  const capex = num(implementationCost, null);
  const annualValue = cost === null ? null : gj * cost;
  const tCo2 = ef === null ? null : (gj * ef) / 1000;

  return {
    error: null,
    energySavedGJ: round(gj, 6),
    annualValue: round(annualValue, 2),
    annualTonnesCo2e: round(tCo2, 8),
    implementationCost: capex,
    simplePaybackYears: capex === null || annualValue === null || annualValue <= 0
      ? null : round(capex / annualValue, 8),
    // The number a marginal abatement cost curve is built from, handed over
    // rather than ranked here: that is the Carbon Studio's job at DS9.
    costPerTonneCo2e: capex === null || tCo2 === null || tCo2 === 0
      ? null : round((capex - (annualValue ?? 0)) / tCo2, 6),
    carbonNote: ef === null
      ? 'No emission factor supplied, so the carbon figure is absent rather than zero.' : null,
    valueNote: cost === null
      ? 'No fuel cost supplied, so the saving is in energy only.' : null,
  };
};
