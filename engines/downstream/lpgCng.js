/**
 * LPG and CNG rollout (Midstream & Downstream DS7).
 *
 * Two fuels, one commercial question: what does it take to put this in
 * front of a customer, and does the customer save money by switching.
 *
 * They share more structure than they look like they do. A cylinder in
 * circulation and a CNG trailer shuttling to a daughter station are the same
 * problem - a fleet of assets in a cycle - and both are Little's Law, which
 * is why there is one float model here and not two. A bottling carousel and
 * a dispensing bay are both queues, which is why this calls the rack model
 * built at DS5 rather than writing a third Erlang C.
 *
 * WHAT IT DOES NOT GUESS
 *
 * Fuel properties. Liquid density, latent heat and calorific value vary by
 * product and by supplier, and the certificate of quality is the authority.
 * Typical values are provided as a LABELLED REFERENCE the caller may pass
 * in; nothing here reads them on its own.
 *
 * The LPG fill limit. A pressure vessel in LPG service is filled to a
 * maximum ratio set by code, because liquid LPG expands and a vessel filled
 * liquid-full ruptures hydraulically. That limit is a safety requirement,
 * not a modelling convenience, so it is a REQUIRED INPUT WITH NO DEFAULT.
 * A default here would be a number somebody trusted.
 *
 * WHAT IT DOES COMPUTE HONESTLY
 *
 * Real-gas density at storage pressure. CNG is stored at 200-250 bar, where
 * the compressibility factor is nowhere near one, and the ideal gas law is
 * wrong by about a fifth. This calls the same Dranchuk-Abou-Kassem
 * correlation the Facilities compression app uses rather than a second
 * implementation, reports the Z it used, and says when the correlation is
 * being asked to work outside the range it was fitted over.
 */

import { rackQueue } from './terminalDepot.js';
import { naturalGasZ, suttonPseudoCriticals, toRankine } from '../production/gasProperties.js';
import { compressorTrain } from '../facilities/compression.js';

/** Missing stays missing. See the note in fuelPricing.js. */
const num = (v, fallback = NaN) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Rounding policy, as in fuelPricing.js: quantities are rounded to the
 * resolution they are reported at, but RATES AND RATIOS ARE NOT, because a
 * caller multiplies them back up.
 */
const round = (v, dp = 6) => (Number.isFinite(v)
  ? Math.round(v * 10 ** dp) / 10 ** dp
  : null);

// Unit bridges, stated rather than buried. The compression engine is in
// field units; everything a rollout engineer types is metric.
export const PSI_PER_BAR = 14.503773773;
export const M3_PER_SCF = 0.02831684659;
export const KJ_PER_KWH = 3600;

// ---------------------------------------------------------------------------
// Fleets in a cycle: cylinders and trailers are the same problem
// ---------------------------------------------------------------------------

/**
 * How many assets a cycle needs, by Little's Law.
 *
 * The number of items in a system equals the rate they flow through it
 * times the time each one spends in it. For a cylinder fleet that is
 * `sold per day x days round the cycle`; for a CNG trailer fleet it is
 * `trips per day x days per trip`. Operators usually guess this number and
 * usually guess it low, because the cylinders at a customer's house are
 * invisible and are most of the fleet.
 *
 * The result is a CEILING plus a spares allowance, since half an asset does
 * not exist, and the cycle is reported broken down so the biggest term is
 * obvious - which is nearly always the time the asset spends with the
 * customer, and is the only term the operator can actually negotiate.
 */
export const assetFloat = ({ unitsPerDay, cycleStages = [], sparesFraction = 0 }) => {
  const rate = num(unitsPerDay);
  if (!Number.isFinite(rate) || rate <= 0) {
    return { error: 'A positive throughput per day is required.' };
  }
  const stages = cycleStages
    .map((s) => ({ label: s.label, days: num(s.days) }))
    .filter((s) => Number.isFinite(s.days));
  const missing = cycleStages.length - stages.length;
  if (stages.length === 0) {
    return { error: 'At least one cycle stage with a duration is required.' };
  }
  const cycleDays = stages.reduce((s, x) => s + x.days, 0);
  const inCirculation = rate * cycleDays;
  const spares = inCirculation * num(sparesFraction, 0);
  const total = Math.ceil(inCirculation + spares);
  const dominant = stages.reduce((a, b) => (b.days > a.days ? b : a), stages[0]);

  return {
    error: null,
    complete: missing === 0,
    missingStages: missing,
    cycleDays: round(cycleDays, 4),
    stages: stages.map((s) => ({
      ...s, share: cycleDays > 0 ? round(s.days / cycleDays, 6) : null,
    })),
    // Little's Law, named so the number can be argued with.
    inCirculation: round(inCirculation, 3),
    sparesAllowance: round(spares, 3),
    fleetRequired: total,
    // The rounding is not free and the spare it buys is worth seeing.
    spareCapacityUnits: round(total - inCirculation - spares, 3),
    dominantStage: dominant.label,
    basis: "Little's Law: assets in the system = throughput x time in the system.",
  };
};

// ---------------------------------------------------------------------------
// LPG
// ---------------------------------------------------------------------------

/**
 * Typical LPG component properties, offered as a LABELLED REFERENCE.
 *
 * Molar masses are definitional. Liquid density, latent heat and calorific
 * value vary with product and supplier and the certificate of quality is the
 * authority, so they carry a range and nothing in this module reads them
 * unless a caller passes one in.
 */
export const LPG_REFERENCE = [
  {
    code: 'propane',
    label: 'Propane (C3H8)',
    molarMassKgKmol: 44.096,
    typicalLiquidDensityKgM3: 508,
    liquidDensityRange: '500-515 at 15 C',
    typicalLatentHeatKJkg: 425,
    latentHeatRange: '410-430 at atmospheric boiling',
    typicalBoilingPointC: -42,
  },
  {
    code: 'butane',
    label: 'n-Butane (C4H10)',
    molarMassKgKmol: 58.122,
    typicalLiquidDensityKgM3: 584,
    liquidDensityRange: '575-590 at 15 C',
    typicalLatentHeatKJkg: 385,
    latentHeatRange: '370-395 at atmospheric boiling',
    typicalBoilingPointC: -0.5,
  },
];

export const LPG_PROPERTY_NOTE = 'Typical values only, offered as a starting point. Liquid density, latent heat and calorific value vary with the product and the supplier; the certificate of quality is the authority.';

/**
 * Properties of a propane/butane mix.
 *
 * Every property declares the basis it blends on, which is the rule this
 * module family follows everywhere: liquid density mixes on VOLUME, molar
 * mass mixes on MOLES, and heat of vaporisation per kilogram mixes on MASS.
 * Using the wrong one is a quiet error of several percent that looks
 * entirely plausible.
 */
export const lpgBlendProperties = ({ components = [] }) => {
  const rows = components.map((c) => ({
    code: c.code,
    volumeFraction: num(c.volumeFraction),
    liquidDensityKgM3: num(c.liquidDensityKgM3),
    molarMassKgKmol: num(c.molarMassKgKmol),
    latentHeatKJkg: num(c.latentHeatKJkg),
  }));
  const vSum = rows.reduce((s, r) => s + (Number.isFinite(r.volumeFraction) ? r.volumeFraction : 0), 0);
  if (!(vSum > 0)) return { error: 'Component volume fractions are required.' };
  if (rows.some((r) => !Number.isFinite(r.liquidDensityKgM3))) {
    return { error: 'A liquid density is required for every component; it is not assumed.' };
  }
  const norm = rows.map((r) => ({ ...r, v: r.volumeFraction / vSum }));

  // Volume basis.
  const densityKgM3 = norm.reduce((s, r) => s + r.v * r.liquidDensityKgM3, 0);
  // Mass fractions follow from volume fractions through the densities.
  const massTotal = norm.reduce((s, r) => s + r.v * r.liquidDensityKgM3, 0);
  const withMass = norm.map((r) => ({ ...r, w: (r.v * r.liquidDensityKgM3) / massTotal }));
  // Mass basis.
  const latentHeatKJkg = withMass.every((r) => Number.isFinite(r.latentHeatKJkg))
    ? withMass.reduce((s, r) => s + r.w * r.latentHeatKJkg, 0) : null;
  // Mole basis: moles per unit mass first, then invert.
  const molarMassKgKmol = withMass.every((r) => Number.isFinite(r.molarMassKgKmol))
    ? 1 / withMass.reduce((s, r) => s + r.w / r.molarMassKgKmol, 0) : null;

  return {
    error: null,
    densityKgM3: round(densityKgM3, 6),
    densityBasis: 'volume',
    massFractions: withMass.map((r) => ({ code: r.code, massFraction: round(r.w, 6) })),
    latentHeatKJkg: round(latentHeatKJkg, 6),
    latentHeatBasis: 'mass',
    molarMassKgKmol: round(molarMassKgKmol, 6),
    molarMassBasis: 'mole',
    note: latentHeatKJkg === null || molarMassKgKmol === null
      ? 'A property missing on any component is reported as missing for the blend, not averaged over the components that have it.'
      : null,
  };
};

/**
 * LPG storage: usable inventory, cover and the reorder point.
 *
 * THE FILL RATIO IS REQUIRED AND HAS NO DEFAULT. An LPG vessel is never
 * filled liquid-full: the liquid expands with temperature and a vessel with
 * no vapour space ruptures hydraulically. The maximum is set by the code in
 * force for the product and the vessel, so this app implements the
 * arithmetic and refuses to supply the limit.
 */
export const lpgStorageSizing = ({
  vesselCapacityM3, maxFillRatio, liquidDensityKgM3,
  demandTonnesPerDay, deliveryTonnes = null, leadTimeDays = 0, safetyDays = 0,
}) => {
  const cap = num(vesselCapacityM3);
  const fill = num(maxFillRatio);
  const rho = num(liquidDensityKgM3);
  const demand = num(demandTonnesPerDay);
  if (!Number.isFinite(cap) || cap <= 0) return { error: 'A vessel capacity is required.' };
  if (!Number.isFinite(fill)) {
    return {
      error: 'A maximum fill ratio is required and is not defaulted. It is a code limit for the product and the vessel: LPG expands and a vessel filled liquid-full ruptures hydraulically.',
    };
  }
  if (fill <= 0 || fill >= 1) return { error: 'The maximum fill ratio must lie between 0 and 1.' };
  if (!Number.isFinite(rho) || rho <= 0) return { error: 'A liquid density is required; it is not assumed.' };
  if (!Number.isFinite(demand) || demand <= 0) return { error: 'A demand is required.' };

  const usableM3 = cap * fill;
  const usableTonnes = (usableM3 * rho) / 1000;
  const coverDays = usableTonnes / demand;
  const safetyTonnes = demand * num(safetyDays, 0);
  const reorderTonnes = demand * num(leadTimeDays, 0) + safetyTonnes;
  const load = num(deliveryTonnes, null);
  const ullageAtReorder = usableTonnes - reorderTonnes;

  return {
    error: null,
    usableM3: round(usableM3, 4),
    usableTonnes: round(usableTonnes, 4),
    // The vapour space is not spare capacity; it is the reason the vessel
    // does not fail, so it is reported rather than left as a subtraction.
    vapourSpaceM3: round(cap - usableM3, 4),
    coverDays: round(coverDays, 3),
    safetyStockTonnes: round(safetyTonnes, 4),
    reorderAtTonnes: round(reorderTonnes, 4),
    ullageAtReorderTonnes: round(ullageAtReorder, 4),
    deliveryTonnes: load,
    deliveryFitsUllage: load === null ? null : load <= ullageAtReorder,
    deliveryWarning: load !== null && load > ullageAtReorder
      ? `A ${load} tonne delivery does not fit the ${round(ullageAtReorder, 2)} tonnes of room at the reorder point. Order earlier or order a part load.`
      : null,
    deliveriesPerMonth: load === null || load <= 0 ? null : round((demand * 30) / load, 3),
  };
};

/**
 * Vaporizer duty.
 *
 * Three terms, kept separate because they answer different questions: warm
 * the liquid to its boiling point, boil it, then superheat the vapour clear
 * of the dew point so it does not re-condense in the line. Skipping the
 * third is how a vaporizer that is correctly sized on paper drops liquid
 * into a burner.
 *
 * Latent heat is a property of the product and is required.
 */
export const vaporizerDuty = ({
  massFlowKgHr, latentHeatKJkg,
  liquidCpKJkgK = null, inletTempC = null, boilingPointC = null,
  vapourCpKJkgK = null, outletTempC = null,
  designMarginPercent = 0,
}) => {
  const m = num(massFlowKgHr);
  const hfg = num(latentHeatKJkg);
  if (!Number.isFinite(m) || m <= 0) return { error: 'A mass flow is required.' };
  if (!Number.isFinite(hfg) || hfg <= 0) {
    return { error: 'A latent heat of vaporisation is required; it is a property of the product and is not assumed.' };
  }
  const cpL = num(liquidCpKJkgK, null);
  const tIn = num(inletTempC, null);
  const tBp = num(boilingPointC, null);
  const cpV = num(vapourCpKJkgK, null);
  const tOut = num(outletTempC, null);

  const sensibleLiquid = cpL !== null && tIn !== null && tBp !== null
    ? m * cpL * (tBp - tIn) : null;
  const latent = m * hfg;
  const superheat = cpV !== null && tOut !== null && tBp !== null
    ? m * cpV * (tOut - tBp) : null;

  const terms = [
    { label: 'Warm the liquid to boiling', kJPerHr: sensibleLiquid },
    { label: 'Boil it', kJPerHr: latent },
    { label: 'Superheat the vapour', kJPerHr: superheat },
  ];
  const known = terms.filter((t) => t.kJPerHr !== null);
  const missing = terms.filter((t) => t.kJPerHr === null).map((t) => t.label);
  const totalKJHr = known.reduce((s, t) => s + t.kJPerHr, 0);
  const margin = num(designMarginPercent, 0);

  return {
    error: null,
    complete: missing.length === 0,
    missingTerms: missing,
    terms: terms.map((t) => ({
      ...t,
      kW: t.kJPerHr === null ? null : round(t.kJPerHr / KJ_PER_KWH, 6),
      share: t.kJPerHr === null || totalKJHr <= 0 ? null : round(t.kJPerHr / totalKJHr, 6),
    })),
    dutyKW: round(totalKJHr / KJ_PER_KWH, 6),
    designDutyKW: round((totalKJHr / KJ_PER_KWH) * (1 + margin / 100), 6),
    note: missing.length
      ? `Duty covers only the terms supplied. Missing: ${missing.join(', ')}. It is a floor, not the duty.`
      : null,
  };
};

/**
 * Bottling plant: how many filling positions the demand needs.
 *
 * A carousel is a queue, so this calls the rack model rather than dividing
 * demand by capacity and calling the answer a utilisation. Availability is
 * separate from utilisation on purpose: a position that is down for
 * maintenance is not a position that is busy, and conflating the two is how
 * a plant is commissioned one carousel short.
 */
export const bottlingPlant = ({
  cylindersPerDay, fillMinutesPerCylinder, positions,
  shiftHoursPerDay = 8, availabilityFraction = 1,
}) => {
  const demand = num(cylindersPerDay);
  const fillMin = num(fillMinutesPerCylinder);
  const pos = num(positions);
  const hours = num(shiftHoursPerDay, 8);
  const avail = num(availabilityFraction, 1);
  if (![demand, fillMin, pos].every((v) => Number.isFinite(v) && v > 0)) {
    return { error: 'Demand, fill time and a position count are required and must be positive.' };
  }
  if (!(hours > 0) || !(avail > 0) || avail > 1) {
    return { error: 'Shift hours must be positive and availability must lie in (0, 1].' };
  }
  const effectivePositions = pos * avail;
  const arrivalsPerHour = demand / hours;
  // A queue has a whole number of servers. Availability gives a fractional
  // count of working positions, so it is rounded HERE and reported, rather
  // than being rounded silently inside the queue model where nobody sees it.
  const queuePositions = Math.max(1, Math.round(effectivePositions));
  const queue = rackQueue({
    arrivalsPerHour, loadMinutes: fillMin, bays: queuePositions,
  });
  // The count that would just meet the demand, before any allowance for the
  // queue that count would produce.
  const minimumPositions = Math.ceil((demand * fillMin) / (hours * 60 * avail));

  return {
    error: null,
    arrivalsPerHour: round(arrivalsPerHour, 4),
    effectivePositions: round(effectivePositions, 6),
    // What the queue model actually ran on, and why it differs.
    queuePositions,
    positionRoundingNote: queuePositions === effectivePositions ? null
      : `The queue is computed on ${queuePositions} working positions, rounded from ${round(effectivePositions, 2)}, because a queue has a whole number of servers. The throughput capacity below uses the unrounded figure.`,
    minimumPositionsForThroughput: minimumPositions,
    queue,
    throughputCapacityPerDay: round((effectivePositions * hours * 60) / fillMin, 2),
    meetsDemand: (effectivePositions * hours * 60) / fillMin >= demand,
    note: 'Availability reduces the positions that are working; utilisation is how busy the working ones are. They are different numbers and a plant sized on one alone comes up short.',
  };
};

// ---------------------------------------------------------------------------
// CNG
// ---------------------------------------------------------------------------

/**
 * The DAK correlation's fitted range. Outside it the correlation is being
 * extrapolated, and the caller is told rather than left to find out.
 */
export const DAK_RANGE = { pprMin: 0.2, pprMax: 30, tprMin: 1.0, tprMax: 3.0 };

/**
 * Mass of gas in a vessel, with real-gas Z.
 *
 * m = P V M / (Z R T). At 200-250 bar the compressibility factor is around
 * 0.8, so a vessel holds appreciably MORE gas than the ideal gas law says,
 * and sizing a cascade on ideal gas gets the storage wrong by about a fifth
 * in a direction nobody notices until the station is built.
 *
 * The ideal figure is returned alongside so the difference is visible rather
 * than asserted, and the Z that was used is returned so the number can be
 * checked against the operator's own data.
 */
export const gasMassInVessel = ({
  volumeM3, pressureBar, temperatureC, gasSg = 0.6,
}) => {
  const v = num(volumeM3);
  const p = num(pressureBar);
  const t = num(temperatureC);
  const sg = num(gasSg, 0.6);
  if (!Number.isFinite(v) || v <= 0) return { error: 'A vessel volume is required.' };
  if (!Number.isFinite(p) || p <= 0) return { error: 'A pressure is required.' };
  if (!Number.isFinite(t)) return { error: 'A temperature is required.' };

  const pPsia = p * PSI_PER_BAR;
  const tF = t * 9 / 5 + 32;
  const z = naturalGasZ({ pPsia, tF, gasSg: sg });
  const crit = suttonPseudoCriticals(sg);
  const ppr = pPsia / crit.ppcPsia;
  const tpr = toRankine(tF) / crit.tpcR;
  const inRange = ppr >= DAK_RANGE.pprMin && ppr <= DAK_RANGE.pprMax
    && tpr >= DAK_RANGE.tprMin && tpr <= DAK_RANGE.tprMax;

  // SI: P in Pa, V in m3, R = 8.314 J/(mol K), M in kg/kmol -> kg.
  const R = 8.3144626;
  const molarMass = sg * 28.9625; // kg/kmol, relative to air
  const tK = t + 273.15;
  const idealKg = ((p * 1e5) * v * molarMass) / (R * 1000 * tK);
  const realKg = idealKg / z;

  return {
    error: null,
    z: round(z, 6),
    ppr: round(ppr, 4),
    tpr: round(tpr, 4),
    correlationInRange: inRange,
    correlationNote: inRange ? null
      : 'Outside the range the Dranchuk-Abou-Kassem correlation was fitted over. The value is an extrapolation and should be checked against measured data.',
    massKg: round(realKg, 6),
    idealMassKg: round(idealKg, 6),
    // Positive means the ideal gas law UNDERSTATES what the vessel holds.
    realVersusIdeal: round(realKg / idealKg, 6),
  };
};

/**
 * Cascade storage: how many vehicles a bank set fills before it needs the
 * compressor.
 *
 * The physics that makes a cascade a cascade: a bank can only push gas into
 * a vehicle while its pressure EXCEEDS the vehicle's. Once they equalise the
 * bank is finished for that vehicle no matter how much gas it still holds,
 * which is why stations run three banks at different pressures instead of
 * one big one. Gas left in a bank below the vehicle's target is real gas and
 * is reported as unusable rather than counted as inventory.
 *
 * Each fill is modelled as taking gas from the lowest bank that can still
 * deliver, which is how a cascade is actually sequenced, and the bank
 * pressure is updated after every fill rather than treated as constant.
 */
export const cascadeFills = ({
  banks = [], vehicleTankM3, vehicleStartBar, vehicleTargetBar,
  temperatureC = 15, gasSg = 0.6, maxFills = 500,
}) => {
  const vTank = num(vehicleTankM3);
  const pStart = num(vehicleStartBar);
  const pTarget = num(vehicleTargetBar);
  const t = num(temperatureC, 15);
  if (!Number.isFinite(vTank) || vTank <= 0) return { error: 'A vehicle tank volume is required.' };
  if (!Number.isFinite(pStart) || !Number.isFinite(pTarget) || pTarget <= pStart) {
    return { error: 'A start and a higher target pressure are required.' };
  }
  const parsed = banks.map((b, i) => ({
    label: b.label || `Bank ${i + 1}`,
    volumeM3: num(b.volumeM3),
    pressureBar: num(b.pressureBar),
  }));
  if (parsed.some((b) => !Number.isFinite(b.volumeM3) || !Number.isFinite(b.pressureBar))) {
    return { error: 'Every bank needs a volume and a pressure.' };
  }

  const massAt = (volumeM3, pressureBar) => {
    const r = gasMassInVessel({ volumeM3, pressureBar, temperatureC: t, gasSg });
    return r.error ? NaN : r.massKg;
  };
  const pressureForMass = (volumeM3, targetKg, hiBar) => {
    // Z depends on pressure, so invert by bisection rather than by algebra.
    let lo = 0.01; let hi = hiBar;
    for (let i = 0; i < 60; i += 1) {
      const mid = (lo + hi) / 2;
      if (massAt(volumeM3, mid) > targetKg) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  };

  const state = parsed.map((b) => ({ ...b, currentBar: b.pressureBar }));
  const perFillKg = massAt(vTank, pTarget) - massAt(vTank, pStart);
  if (!Number.isFinite(perFillKg) || perFillKg <= 0) {
    return { error: 'The fill does not add gas at these pressures.' };
  }

  /**
   * A bank is exhausted when the gas it can still DELIVER runs out, which is
   * not the same as its pressure reaching the target: bisection lands a hair
   * above, and a bank sitting a hair above the target delivers nothing while
   * still testing as usable. Judging exhaustion on deliverable mass rather
   * than on pressure is what makes the sequence terminate correctly.
   */
  const EPS_KG = 1e-6;
  const fills = [];
  let guard = 0;
  let shortfallKg = null;
  while (guard < num(maxFills, 500)) {
    guard += 1;
    // Draw from the lowest bank that can still deliver and work upward,
    // taking from as many banks as one fill needs. That is how a cascade is
    // sequenced, and it is why the low bank is emptied before the high bank
    // is touched.
    const candidates = state
      .map((b) => ({ b, available: massAt(b.volumeM3, b.currentBar) - massAt(b.volumeM3, pTarget) }))
      .filter((x) => x.available > EPS_KG)
      .sort((a, x) => a.b.currentBar - x.b.currentBar);
    const totalAvailable = candidates.reduce((s, x) => s + x.available, 0);
    if (totalAvailable + EPS_KG < perFillKg) {
      // A part fill is not a fill. What is left is reported rather than
      // counted, because a vehicle that leaves under-filled did not get one.
      shortfallKg = round(totalAvailable, 4);
      break;
    }
    let remaining = perFillKg;
    const used = [];
    for (let i = 0; i < candidates.length && remaining > EPS_KG; i += 1) {
      const x = candidates[i];
      const take = Math.min(x.available, remaining);
      x.b.currentBar = pressureForMass(
        x.b.volumeM3, massAt(x.b.volumeM3, x.b.currentBar) - take, x.b.pressureBar,
      );
      remaining -= take;
      used.push(x.b.label);
    }
    fills.push({ fill: fills.length + 1, banks: used });
  }

  const strandedKg = state.reduce((s, b) => s + massAt(b.volumeM3, Math.min(b.currentBar, pTarget)), 0);
  const totalKg = parsed.reduce((s, b) => s + massAt(b.volumeM3, b.pressureBar), 0);
  const deliveredKg = fills.length * perFillKg;

  return {
    error: null,
    kgPerFill: round(perFillKg, 4),
    fillsBeforeRecharge: fills.length,
    deliveredKg: round(deliveredKg, 3),
    storedKg: round(totalKg, 3),
    // Gas below the vehicle's target pressure cannot be delivered by the
    // cascade at all. It is inventory, and it is not usable.
    strandedBelowTargetKg: round(strandedKg, 3),
    cascadeEfficiency: totalKg > 0 ? round(deliveredKg / totalKg, 6) : null,
    banksAfter: state.map((b) => ({
      label: b.label, startBar: round(b.pressureBar, 3), endBar: round(b.currentBar, 3),
    })),
    // Gas that is above the target but not enough for a whole fill.
    partialFillAvailableKg: shortfallKg,
    hitFillLimit: guard >= num(maxFills, 500),
    note: 'A bank delivers only while its pressure exceeds the vehicle tank. That is why a station runs several banks at different pressures rather than one large one.',
  };
};

/**
 * Compression duty for a CNG station.
 *
 * This does NOT reimplement compression. It converts the station's metric
 * inputs to the field units the Facilities compression engine speaks, calls
 * it, and converts the answer back. Staging, polytropic head, real-gas Z at
 * suction and discharge, interstage cooling and the temperature limit that
 * usually governs stage count all come from there.
 */
export const cngCompression = ({
  throughputKgPerHour, suctionBar, dischargeBar, suctionTempC,
  gasSg = 0.6, k = 1.31, polytropicEfficiency = 0.75, mechanicalEfficiency = 0.97,
  interstageCoolToC = null, maxRatioPerStage = 4, maxDischargeC = 149,
}) => {
  const kgHr = num(throughputKgPerHour);
  const pS = num(suctionBar);
  const pD = num(dischargeBar);
  const tS = num(suctionTempC);
  const sg = num(gasSg, 0.6);
  if (!Number.isFinite(kgHr) || kgHr <= 0) return { error: 'A throughput is required.' };
  if (!Number.isFinite(pS) || !Number.isFinite(pD) || pD <= pS) {
    return { error: 'A suction pressure and a higher discharge pressure are required.' };
  }
  if (!Number.isFinite(tS)) return { error: 'A suction temperature is required.' };

  // Mass to standard volume: one lb-mol occupies 379.49 scf, so
  // scf = (kg / M[kg/kmol]) * 1000 mol/kmol ... done in consistent SI-to-field
  // terms via the molar mass and the standard molar volume.
  const molarMass = sg * 28.9625;
  const SCF_PER_KMOL = 836.6; // 379.49 scf/lbmol x 2.20462 lbmol/kmol
  const scfPerHour = (kgHr / molarMass) * SCF_PER_KMOL;
  const qMMscfd = (scfPerHour * 24) / 1e6;

  const train = compressorTrain({
    qMMscfd,
    pSuctionPsia: pS * PSI_PER_BAR,
    tSuctionF: tS * 9 / 5 + 32,
    pDischargePsia: pD * PSI_PER_BAR,
    gasSg: sg, k, polytropicEfficiency, mechanicalEfficiency,
    interstageCoolToF: interstageCoolToC === null ? undefined : num(interstageCoolToC) * 9 / 5 + 32,
    maxRatioPerStage,
    maxDischargeF: num(maxDischargeC, 149) * 9 / 5 + 32,
  });
  if (train.error) return { error: train.error };

  const HP_TO_KW = 0.745699872;
  return {
    error: null,
    qMMscfd: round(qMMscfd, 6),
    stages: train.stages.map((s) => ({
      stage: s.stage,
      suctionBar: round(s.pSuctionPsia / PSI_PER_BAR, 3),
      dischargeBar: round(s.pDischargePsia / PSI_PER_BAR, 3),
      dischargeC: round((s.tDischargeF - 32) * 5 / 9, 2),
      ratio: round(s.ratio, 4),
      z: round(s.zAvg, 5),
      brakeKW: round(s.brakeHp * HP_TO_KW, 6),
      warning: s.warning || null,
    })),
    stageCount: train.stages.length,
    governedBy: train.governedBy || null,
    totalBrakeKW: round(train.totalBrakeHp * HP_TO_KW, 6),
    specificEnergyKWhPerKg: kgHr > 0 ? round((train.totalBrakeHp * HP_TO_KW) / kgHr, 6) : null,
    coolingDutyKW: round((train.totalCoolingBtuHr * 0.29307107) / 1000, 3),
    finalDischargeC: round((train.finalDischargeF - 32) * 5 / 9, 2),
    basis: 'Staging, polytropic head and real-gas Z from the Facilities compression engine; this converts units and does not reimplement the thermodynamics.',
  };
};

/**
 * Dispensing capacity: a forecourt of CNG dispensers is a queue.
 *
 * Same model as the loading rack and the petrol forecourt. A CNG fill takes
 * minutes rather than seconds, so the queue bites at much lower traffic than
 * operators expect from their liquid-fuel experience, which is the point of
 * computing it rather than assuming.
 */
export const cngDispensing = ({
  vehiclesPerHour, fillMinutes, dispensers, kgPerFill = null,
}) => {
  const arr = num(vehiclesPerHour);
  const fill = num(fillMinutes);
  const bays = num(dispensers);
  if (![arr, fill, bays].every((v) => Number.isFinite(v) && v > 0)) {
    return { error: 'Arrivals, fill time and a dispenser count are required and must be positive.' };
  }
  const queue = rackQueue({ arrivalsPerHour: arr, loadMinutes: fill, bays });
  const kg = num(kgPerFill, null);
  return {
    error: null,
    queue,
    vehiclesPerDayAtThisRate: round(arr * 24, 2),
    kgPerHour: kg === null ? null : round(arr * kg, 3),
    note: 'A CNG fill takes minutes, so a forecourt queues at traffic a liquid-fuel operator would think of as quiet.',
  };
};

// ---------------------------------------------------------------------------
// The customer's decision
// ---------------------------------------------------------------------------

/**
 * Conversion economics, on an ENERGY basis.
 *
 * Petrol is sold by the litre, diesel by the litre, CNG by the kilogram and
 * LPG by the kilogram or the litre. Comparing prices per unit sold is
 * meaningless across those; the comparison has to be per unit of USEFUL
 * ENERGY, or better still per kilometre, which is what the customer
 * actually buys.
 *
 * Where the alternative fuel's consumption is measured, it is used. Where it
 * is not, it is derived from energy equivalence with an EXPLICIT efficiency
 * ratio - stated as an assumption rather than hidden as a constant, because
 * a converted engine is not necessarily as efficient on the new fuel and
 * that ratio moves the answer more than the fuel price does.
 *
 * IT STOPS AT THE CASH FLOW. Simple payback is reported because it is the
 * number this decision is actually made on, and it is labelled as
 * undiscounted. Anything requiring a discount rate belongs in the sanctioned
 * economics engine, not here.
 */
export const conversionEconomics = ({
  annualDistanceKm,
  baseFuel: {
    label: baseLabel = 'Base fuel',
    consumptionPer100Km: baseConsumption,
    pricePerUnit: basePrice,
    energyPerUnitMJ: baseEnergy = null,
    emissionFactorKgCo2ePerUnit: baseEf = null,
  } = {},
  newFuel: {
    label: newLabel = 'New fuel',
    consumptionPer100Km: newConsumption = null,
    pricePerUnit: newPrice,
    energyPerUnitMJ: newEnergy = null,
    emissionFactorKgCo2ePerUnit: newEf = null,
    efficiencyRatio = 1,
  } = {},
  conversionCost, annualExtraMaintenance = 0,
}) => {
  const km = num(annualDistanceKm);
  const bc = num(baseConsumption);
  const bp = num(basePrice);
  const np = num(newPrice);
  if (![km, bc, bp, np].every(Number.isFinite)) {
    return { error: 'Annual distance, base consumption and both fuel prices are required.' };
  }

  let nc = num(newConsumption, null);
  let derived = false;
  if (nc === null) {
    const be = num(baseEnergy, null);
    const ne = num(newEnergy, null);
    const eta = num(efficiencyRatio, 1);
    if (be === null || ne === null || !(ne > 0) || !(eta > 0)) {
      return {
        error: 'Either a measured consumption on the new fuel, or both fuels\' energy content and an efficiency ratio, are required. Neither is assumed.',
      };
    }
    // Same useful energy per km, adjusted by how well the engine uses it.
    nc = (bc * be) / (ne * eta);
    derived = true;
  }

  const baseUnits = (bc / 100) * km;
  const newUnits = (nc / 100) * km;
  const baseCost = baseUnits * bp;
  const newCost = newUnits * np;
  const maintenance = num(annualExtraMaintenance, 0);
  const annualSaving = baseCost - newCost - maintenance;
  const capex = num(conversionCost, null);

  const bef = num(baseEf, null);
  const nef = num(newEf, null);
  const carbonAvoided = bef !== null && nef !== null
    ? baseUnits * bef - newUnits * nef : null;

  return {
    error: null,
    consumptionSource: derived ? 'derived from energy equivalence' : 'as measured',
    newFuelConsumptionPer100Km: round(nc, 6),
    baseFuel: {
      label: baseLabel, unitsPerYear: round(baseUnits, 3), costPerYear: round(baseCost, 2),
      costPerKm: km > 0 ? round(baseCost / km, 6) : null,
    },
    newFuel: {
      label: newLabel, unitsPerYear: round(newUnits, 3), costPerYear: round(newCost, 2),
      costPerKm: km > 0 ? round(newCost / km, 6) : null,
    },
    annualExtraMaintenance: round(maintenance, 2),
    annualSaving: round(annualSaving, 2),
    savingPerKm: km > 0 ? round(annualSaving / km, 6) : null,
    conversionCost: capex,
    // Undiscounted, and said to be. It is the number this decision is made
    // on; it is not a valuation.
    simplePaybackYears: capex === null || annualSaving <= 0 ? null : round(capex / annualSaving, 6),
    paybackNote: annualSaving <= 0
      ? 'The conversion does not save money at these prices, so there is no payback to report.'
      : 'Simple payback is undiscounted. Anything needing a discount rate belongs in the sanctioned economics engine.',
    kgCo2eAvoidedPerYear: carbonAvoided === null ? null : round(carbonAvoided, 2),
    carbonNote: carbonAvoided === null
      ? 'An emission factor for each fuel is required for the carbon figure; without both it is absent rather than zero.'
      : null,
    // Ready to hand to the sanctioned engine rather than valued here.
    annualCashFlow: {
      year0: capex === null ? null : -capex,
      recurring: round(annualSaving, 2),
    },
  };
};
