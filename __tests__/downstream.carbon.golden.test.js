/**
 * Carbon footprint, abatement and energy efficiency against independent
 * oracles (MD5-0).
 *
 * Goldens: tools/validation/downstream/oracle_carbonabatement.py (combustion
 * by mass in exact rationals, the inventory as a ledger, the abatement cost
 * levelised from a PV ledger, the curve by explicit rank, the path as a year
 * ledger) and oracle_energyefficiency.py (a species ledger with a mass
 * balance that must close, excess air by bisection, a duty ledger for the
 * saving, an isentropic nozzle for the trap, pinch by the largest heat
 * deficit with no cascade). Every assertion calls the engine.
 */
import fs from 'fs';
import path from 'path';
import {
  makeFactor, makeGwpSet, combustionCo2FromCarbon, emissionLine, buildInventory,
  carbonIntensity, abatementCost, abatementCurve, decarbonisationPath, MW_CO2, MW_CH4, MW_C,
  atomBalanceLines,
} from '../engines/downstream/carbonAbatement.js';
import {
  combustionStoichiometry, excessAirFromFlueOxygen, stackLossEfficiency, excessAirSaving,
  steamTrapLoss, condensateReturnValue, energyIntensity, pinchTargets, priceSaving,
  FUEL_REFERENCE, HEATING_VALUE_BASIS, O2_MOLE_FRACTION_DRY_AIR, AIR_MOLAR_MASS,
  ATMOSPHERIC_N2_MOLAR_MASS, ATMOSPHERE_BAR_A, PRODUCT_MOLAR_MASS,
} from '../engines/downstream/energyEfficiency.js';
import { createRequire } from 'module';

const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'downstream', 'goldens', f), 'utf8'));
const CA = load('carbonabatement_cases.json');
const EE = load('energyefficiency_cases.json');
const rel = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

describe('the goldens, and what they honestly are', () => {
  it('were written by the oracles, with published GWPs as inputs only', () => {
    expect(CA.provenance.published).toMatch(/GHG Protocol/);
    expect(CA.provenance.published).toMatch(/synthetic/);
    expect(EE.provenance.published).toMatch(/SYNTHETIC/);
  });
});

// ---------------------------------------------------------------------------
// Carbon
// ---------------------------------------------------------------------------

describe('molar masses are the IUPAC conventional atomic weights', () => {
  it('CO2, CH4 and C match the oracle built from the atomic weights', () => {
    expect(MW_CO2).toBeCloseTo(CA.molarMasses.CO2, 9);
    expect(MW_CH4).toBeCloseTo(CA.molarMasses.CH4, 9);
    expect(MW_C).toBeCloseTo(CA.molarMasses.C, 9);
  });
});

describe.each(Object.entries(CA.combustion))('combustion by mass: %s', (_n, g) => {
  it('matches the mass route to the gram', () => {
    const r = combustionCo2FromCarbon(g);
    expect(r.error).toBeNull();
    expect(rel(r.co2Tonnes, g.co2Tonnes, 1e-9)).toBe(true);
    expect(rel(r.ch4Tonnes, g.ch4Tonnes, 1e-9)).toBe(true);
    expect(rel(r.carbonKmolPerYear, g.carbonKmolPerYear, 1e-12)).toBe(true);
  });
});

describe.each(CA.combustionRefusals.map((c) => [c.name, c]))('combustion refuses: %s', (_n, c) => {
  it('returns an error and no tonnes', () => {
    const r = combustionCo2FromCarbon(c.args);
    expect(r.error).toBeTruthy();
    expect(r.co2Tonnes).toBeUndefined();
  });
});

describe('a blank flare destruction efficiency is not 100 percent (MD5-0 C1)', () => {
  it('refuses, where the old engine gave the best case', () => {
    const r = combustionCo2FromCarbon({ fuelKmolPerYear: 45000, carbonPerKmolFuel: 1.4, destructionEfficiencyFraction: null });
    expect(r.error).toMatch(/destruction efficiency is required/);
    // left out of the call entirely, complete combustion is still the stated default
    const omitted = combustionCo2FromCarbon({ fuelKmolPerYear: 45000, carbonPerKmolFuel: 1.4 });
    expect(rel(omitted.co2Tonnes, CA.combustion.flare100.co2Tonnes)).toBe(true);
    expect(omitted.ch4Tonnes).toBe(0);
  });
});

const factorLine = (l, gwpSet) => emissionLine({
  label: l.label, scope: l.scope, activity: l.activity,
  factor: makeFactor({
    label: `${l.label} factor`, value: l.factor, unit: 't/t', gas: l.gas,
    source: l.sourced ? 'oracle case' : null, version: l.sourced ? 'MD5-0' : null,
  }),
  gwpSet,
});

describe('the inventory as the page opens', () => {
  const g = CA.inventoryAtOpen;
  const gwpSet = makeGwpSet({ label: null, values: {} });
  const inv = buildInventory({ lines: g.lines.map((l) => factorLine(l, gwpSet)), gwpSet });
  it('totals only what it could compute', () => {
    expect(rel(inv.totalTonnes, g.totalTonnes, 1e-9)).toBe(true);
    expect(rel(inv.scope2Tonnes, g.scope2Tonnes, 1e-9)).toBe(true);
  });
  it('names every blocked line and is not reportable', () => {
    expect(inv.blockedLines.map((b) => b.label).sort()).toEqual(g.blocked.map((b) => b.label).sort());
    expect(inv.reportable).toBe(false);
    expect(inv.notReportableBecause.join(' ')).toMatch(/not declared/);
  });
});

describe.each([['AR6', CA.inventoryFilled], ['AR5', CA.inventoryFilledAR5]])('the filled inventory on %s', (report, g) => {
  const gwpSet = makeGwpSet({ label: `IPCC ${report} GWP100 (fossil CH4)`, values: g.gwp });
  const inv = buildInventory({ lines: CA.inventoryFilled.lines.map((l) => factorLine(l, gwpSet)), gwpSet });
  it('matches the ledger line by line and by scope', () => {
    expect(rel(inv.scope1Tonnes, g.scope1Tonnes, 1e-9)).toBe(true);
    expect(rel(inv.scope2Tonnes, g.scope2Tonnes, 1e-9)).toBe(true);
    expect(rel(inv.totalTonnes, g.totalTonnes, 1e-9)).toBe(true);
    g.ledger.forEach((row) => {
      const line = inv.lines.find((l) => l.label === row.label);
      expect(rel(line.tCo2e, row.tCo2e, 1e-9)).toBe(true);
    });
  });
  it('is reportable, and says which set produced it', () => {
    expect(inv.reportable).toBe(g.reportable);
    expect(inv.gwpSetLabel).toMatch(report);
  });
});

describe('the GWP set', () => {
  it('uses the published AR6 and AR5 values the oracle carries, which the engine never ships', () => {
    expect(CA.gwp.AR6.CH4_fossil).toBe(29.8);
    expect(CA.gwp.AR6.CH4_nonfossil).toBe(27);
    expect(CA.gwp.AR6.N2O).toBe(273);
    expect(CA.gwp.AR5.CH4_fossil).toBe(30);
    expect(makeGwpSet({ label: 'x', values: {} }).declared).toBe(false);
  });
  it('says which methane value is consistent with the atom balance', () => {
    expect(makeGwpSet({ label: 'AR6', values: { CH4: 29.8 } }).methaneNote).toMatch(/fossil value is the consistent one/);
  });
});

describe('the inventory blocks what it cannot total (MD5-0 C2, C3)', () => {
  const gwpSet = makeGwpSet({ label: 'AR6', values: { CH4: 29.8 } });
  const good = factorLine({ label: 'Heaters', scope: 1, gas: 'CO2', activity: 100, factor: 1, sourced: true }, gwpSet);
  it('an errored line is blocked, and the inventory is not reportable', () => {
    const inv = buildInventory({ lines: [good, emissionLine({ label: 'No factor' })], gwpSet });
    expect(inv.reportable).toBe(false);
    expect(inv.blockedLines.map((b) => b.label)).toContain('No factor');
    expect(inv.totalTonnes).toBe(100);
  });
  it('a line on another scope is blocked and named', () => {
    const s3 = factorLine({ label: 'Product use', scope: 3, gas: 'CO2', activity: 5, factor: 1, sourced: true }, gwpSet);
    const inv = buildInventory({ lines: [good, s3], gwpSet });
    expect(inv.reportable).toBe(false);
    expect(inv.blockedLines[0].reason).toMatch(/not Scope 1 or Scope 2/);
  });
  it('a scope given as text is still totalled', () => {
    const s = factorLine({ label: 'Power', scope: '2', gas: 'CO2', activity: 7, factor: 1, sourced: true }, gwpSet);
    const inv = buildInventory({ lines: [good, s], gwpSet });
    expect(inv.scope2Tonnes).toBe(7);
    expect(inv.reportable).toBe(true);
  });
  it('an intensity carries its inventory\'s status', () => {
    const inv = buildInventory({ lines: [good, emissionLine({ label: 'No factor' })], gwpSet });
    const r = carbonIntensity({ inventory: inv, denominatorValue: 10, denominatorUnit: 't', boundaryLabel: 'site' });
    expect(r.reportable).toBe(false);
    expect(r.notReportableBecause).toBeTruthy();
  });
});

describe.each(CA.measures.map((m, i) => [m.label, m, CA.costed[i]]))('abatement cost, levelised: %s', (_n, m, g) => {
  const r = abatementCost({ ...m, discountRate: CA.discountRate });
  it('agrees with the PV ledger', () => {
    expect(rel(r.costPerTonne, g.costPerTonne, 1e-7)).toBe(true);
    expect(rel(r.netAnnualCost, g.netAnnualCost, 1e-7)).toBe(true);
    expect(rel(r.capitalRecoveryFactor, g.capitalRecoveryFactor, 1e-7)).toBe(true);
    expect(r.paysForItself).toBe(g.paysForItself);
  });
});

describe.each(CA.abatementRefusals.map((c) => [c.name, c]))('abatement refuses: %s', (_n, c) => {
  it('returns an error and no cost per tonne', () => {
    const r = abatementCost(c.args);
    expect(r.error).toBeTruthy();
    expect(r.costPerTonne).toBeUndefined();
  });
});

describe('abatement: blank running figures are named, omitted ones are the stated 0', () => {
  it('names a blank saving', () => {
    const r = abatementCost({ label: 'X', capitalCost: 0, annualSavings: '', annualCost: 5, tonnesAbatedPerYear: 10 });
    expect(r.assumedZero).toEqual(['annual savings']);
    expect(abatementCost({ label: 'X', tonnesAbatedPerYear: 10 }).assumedZero).toEqual([]);
  });
});

describe('the page curve', () => {
  const costed = CA.measures.map((m) => abatementCost({ ...m, discountRate: CA.discountRate }));
  const c = abatementCurve({ measures: costed, sourceEmissions: CA.sourceEmissions, targetTonnes: CA.curve.targetTonnes });
  it('orders as the explicit rank does and tiles the axis', () => {
    expect(c.steps.map((s) => s.label)).toEqual(CA.curve.order);
    c.steps.forEach((s, i) => {
      expect(rel(s.cumulativeEndTonnes, CA.curve.steps[i].end)).toBe(true);
    });
    expect(c.paysForItselfMeasures).toEqual(CA.curve.paysForItselfMeasures);
    expect(rel(c.weightedAverageCostPerTonne, CA.curve.weightedAverageCostPerTonne, 1e-7)).toBe(true);
  });
  it('flags the heater measures as interacting and the flare claim as more than the flare emits', () => {
    expect(c.interactions.map((i) => i.sourceId)).toEqual(CA.curve.interactions);
    expect(c.overClaims).toHaveLength(1);
    expect(c.overClaims[0].sourceId).toBe('flare');
    expect(rel(c.overClaims[0].emittedTonnes, CA.curve.overClaims[0].emittedTonnes, 1e-9)).toBe(true);
  });
  it('does not say it meets the target on tonnes that do not exist (MD5-0 C7)', () => {
    expect(c.meetsTarget).toBe(CA.curve.meetsTarget);
    expect(c.meetsTarget).toBeNull();
    expect(c.targetBasis).toMatch(/exceed/);
  });
  it('without the over-claim, the steam claim still cannot be checked (MD45-1 F1; MD5-0 said "upper bound")', () => {
    const d = abatementCurve({ measures: costed.slice(0, 3), sourceEmissions: CA.sourceEmissions, targetTonnes: CA.curveWithoutFlareRecovery.targetTonnes });
    expect(d.meetsTarget).toBe(CA.curveWithoutFlareRecovery.meetsTarget);
    expect(d.meetsTarget).toBeNull();
    expect(d.uncheckedSources).toEqual(CA.curveWithoutFlareRecovery.uncheckedSources);
    expect(d.targetBasis).toMatch(/not assessed/);
    expect(d.targetBasis).toMatch(/steam/);
  });
});

describe('the path, as a year ledger', () => {
  const target = (g) => {
    const t = {};
    g.rows.forEach((r) => { t[r.year] = r.targetTonnes; });
    return t;
  };
  it('matches every year', () => {
    const g = CA.path;
    const p = decarbonisationPath({
      baselineTonnes: g.baselineTonnes, measures: CA.measures, startYear: g.startYear, endYear: g.endYear, targetByYear: target(g),
    });
    p.rows.forEach((r, i) => {
      // the engine reports tonnes to 4 dp
      expect(Math.abs(r.emissionsTonnes - g.rows[i].emissionsTonnes)).toBeLessThanOrEqual(5e-5);
      expect(Math.abs(r.unabatedGapTonnes - g.rows[i].unabatedGapTonnes)).toBeLessThanOrEqual(1e-4);
    });
    expect(p.firstShortfallYear).toBe(g.firstShortfallYear);
    expect(p.unscheduledMeasures).toEqual([]);
  });
  it('names a measure with no start year (MD5-0 C8)', () => {
    const measures = CA.measures.map((m, i) => (i === 3 ? { ...m, startYear: '' } : m));
    const p = decarbonisationPath({
      baselineTonnes: CA.path.baselineTonnes, measures, startYear: 2026, endYear: 2032, targetByYear: target(CA.pathUnscheduled),
    });
    expect(p.unscheduledMeasures.map((m) => m.label)).toEqual(CA.pathUnscheduled.unscheduled);
    expect(Math.abs(p.rows[6].emissionsTonnes - CA.pathUnscheduled.rows[6].emissionsTonnes)).toBeLessThanOrEqual(5e-5);
  });
  it('refuses a baseline of nothing', () => {
    expect(decarbonisationPath({ baselineTonnes: 0, startYear: 2026, endYear: 2030 }).error).toMatch(/positive/);
  });
});

// ---------------------------------------------------------------------------
// Energy efficiency
// ---------------------------------------------------------------------------

const ref = (code) => FUEL_REFERENCE.find((f) => f.code === code);
const stoich = (fuel) => combustionStoichiometry({
  components: fuel.map(({ code, moleFraction }) => ({
    ...ref(code), moleFraction, lhvMJKmol: ref(code).typicalLhvMJKmol, hhvMJKmol: ref(code).typicalHhvMJKmol,
  })),
});
const heater = (st, o2, basis) => stackLossEfficiency({
  stoichiometry: st, excessAir: excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: o2 }),
  ...Object.fromEntries(Object.entries(EE.heater).map(([k, v]) => [k, Number(v)])), basis,
});

describe('the air constants', () => {
  it('are the pinned composition, and atmospheric nitrogen closes air\'s own mass', () => {
    expect(O2_MOLE_FRACTION_DRY_AIR).toBe(0.20946);
    expect(AIR_MOLAR_MASS).toBe(28.9647);
    expect(ATMOSPHERIC_N2_MOLAR_MASS).toBeCloseTo(EE.molarMasses.N2atm, 9);
  });
});

describe.each(Object.entries(EE.stoichiometry))('stoichiometry, species ledger: %s', (_n, g) => {
  const st = stoich(g.fuel);
  it('matches the ledger', () => {
    expect(rel(st.o2PerKmolFuel, g.o2PerKmolFuel, 1e-8)).toBe(true);
    expect(rel(st.stoichAirPerKmolFuel, g.stoichAirPerKmolFuel, 1e-8)).toBe(true);
    expect(rel(st.products.co2PerKmolFuel, g.co2PerKmolFuel, 1e-8)).toBe(true);
    expect(rel(st.products.h2oPerKmolFuel, g.h2oPerKmolFuel, 1e-8)).toBe(true);
    expect(rel(st.products.n2PerKmolFuel, g.n2PerKmolFuel, 1e-8)).toBe(true);
    expect(rel(st.stoichAirKgPerKgFuel, g.stoichAirKgPerKgFuel, 1e-8)).toBe(true);
    expect(rel(st.lhvMJPerKmolFuel, g.lhvMJPerKmolFuel, 1e-9)).toBe(true);
  });
  it('finds the excess air the bisection finds', () => {
    const ea = excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: 3 });
    expect(rel(ea.excessAirFraction, g.at3.excessAirFraction, 1e-7)).toBe(true);
  });
  it('conserves mass: fuel and air in, flue gas out (MD5-0 E8)', () => {
    const ea = excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: 3 });
    const r = stackLossEfficiency({
      stoichiometry: st, excessAir: ea, stackTempC: 200, combustionAirTempC: 25,
      flueGasCpKJkgK: 1.1, waterVapourCpKJkgK: 1.95, waterLatentHeatKJkg: 2442, radiationLossPercent: 1,
    });
    expect(rel(r.dryFlueGasKgPerKmolFuel, g.at3.dryFlueGasKgPerKmolFuel, 1e-6)).toBe(true);
    const out = r.dryFlueGasKgPerKmolFuel + r.moistureKgPerKmolFuel;
    const inn = st.fuelMolarMassKgKmol + ea.actualAirPerKmolFuel * AIR_MOLAR_MASS;
    // MD45-1: tightened from 1e-6. With every molar mass built from the same
    // atomic weights the balance closes to the engine's rounding.
    expect(Math.abs(out - inn) / inn).toBeLessThan(1e-8);
    expect(rel(st.fuelMolarMassKgKmol, g.fuelMolarMassKgKmol, 1e-9)).toBe(true);
  });
});

describe.each(Object.entries(EE.excessAir))('excess air at %s percent oxygen', (o2, g) => {
  it('matches the bisection', () => {
    const st = stoich(EE.stoichiometry.page.fuel);
    expect(rel(excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: Number(o2) }).excessAirFraction, g, 1e-7)).toBe(true);
  });
});

describe.each(Object.entries(EE.efficiency))('heater efficiency, loss ledger: %s', (key, g) => {
  it('matches', () => {
    const [basis, o2] = key.split('@');
    const r = heater(stoich(EE.stoichiometry.page.fuel), Number(o2), basis);
    expect(Math.abs(r.efficiencyPercent - g.efficiencyPercent)).toBeLessThan(2e-6);
    expect(Math.abs(r.losses[0].percent - g.dryPercent)).toBeLessThan(2e-6);
    expect(Math.abs(r.losses[1].percent - g.moisturePercent)).toBeLessThan(2e-6);
  });
});

describe('the tuning saving, as a duty ledger', () => {
  const st = stoich(EE.stoichiometry.page.fuel);
  const current = heater(st, 6, HEATING_VALUE_BASIS.LHV);
  const target = heater(st, 3, HEATING_VALUE_BASIS.LHV);
  it('matches the ledger, and exceeds the percentage-point shortcut', () => {
    const r = excessAirSaving({ current, target, minimumSafeO2Percent: 2, targetO2Percent: 3, annualFuelEnergyGJ: 500000 });
    expect(Math.abs(r.fuelSavingFraction - EE.saving.fuelSavingFraction)).toBeLessThan(1e-7);
    expect(Math.abs(r.annualEnergySavedGJ - EE.saving.annualEnergySavedGJ)).toBeLessThan(0.05);
    expect(r.fuelSavingFraction).toBeGreaterThan(EE.saving.differenceShortcut);
  });
  it('refuses a blank target oxygen: the floor cannot be checked without it (MD5-0 E2)', () => {
    const r = excessAirSaving({ current, target, minimumSafeO2Percent: 2, targetO2Percent: null });
    expect(r.error).toMatch(/target stack oxygen is required/);
  });
  it('refuses a target below the floor and a mixed basis', () => {
    expect(excessAirSaving({ current, target, minimumSafeO2Percent: 4, targetO2Percent: 3 }).belowSafeFloor).toBe(true);
    const hhv = heater(st, 3, HEATING_VALUE_BASIS.HHV);
    expect(excessAirSaving({ current, target: hhv, minimumSafeO2Percent: 2, targetO2Percent: 3 }).error).toMatch(/different bases/);
  });
});

describe.each(Object.entries(EE.trap))('steam trap, isentropic nozzle, k = %s', (k, g) => {
  const r = steamTrapLoss({
    orificeDiameterMm: 3, upstreamPressureBarA: 11, dischargeCoefficient: 0.7, steamDensityKgM3: 5.6,
    specificHeatRatio: Number(k), hoursPerYear: 8760, steamCostPerTonne: 25, steamEnergyMJPerTonne: 2700,
    boilerEfficiencyFraction: 0.85, emissionFactorKgCo2ePerGJ: 56,
  });
  it('matches the nozzle', () => {
    expect(rel(r.kgPerHour, g.kgPerHour, 1e-9)).toBe(true);
    expect(rel(r.annualFuelGJ, g.annualFuelGJ, 1e-8)).toBe(true);
    expect(rel(r.annualTonnesCo2e, g.annualTonnesCo2e, 1e-8)).toBe(true);
  });
});

describe('steam trap defaults that invented data (MD5-0 E3, E4)', () => {
  const base = { orificeDiameterMm: 3, upstreamPressureBarA: 11, dischargeCoefficient: 0.7, steamDensityKgM3: 5.6, specificHeatRatio: 1.135 };
  it('requires the isentropic exponent', () => {
    expect(steamTrapLoss({ ...base, specificHeatRatio: undefined }).error).toMatch(/isentropic exponent/);
  });
  it('gives no fuel without a boiler efficiency, where it used to assume 1', () => {
    const r = steamTrapLoss({ ...base, steamEnergyMJPerTonne: 2700, emissionFactorKgCo2ePerGJ: 56 });
    expect(r.annualFuelGJ).toBeNull();
    expect(r.annualTonnesCo2e).toBeNull();
    expect(r.fuelNote).toMatch(/not assumed to be 1/);
  });
  it('refuses blank hours rather than reading a full year', () => {
    expect(steamTrapLoss({ ...base, hoursPerYear: '' }).error).toMatch(/Hours in service/);
  });
});

describe('condensate return, as a ledger', () => {
  const g = EE.condensate;
  const args = {
    steamTonnesPerHour: 20, currentReturnFraction: 0.4, targetReturnFraction: 0.7, condensateTempC: 90, makeupTempC: 25,
    boilerEfficiencyFraction: 0.85, fuelCostPerGJ: 8, waterCostPerTonne: 0.6, emissionFactorKgCo2ePerGJ: 56, hoursPerYear: 8760,
  };
  it('the page default is a floor with the treatment unpriced', () => {
    const r = condensateReturnValue({ ...args, treatmentCostPerTonne: '' });
    expect(rel(r.energySavedGJPerYear, g.energySavedGJPerYear, 1e-8)).toBe(true);
    expect(Math.abs(r.annualValue - g.annualValueFloor)).toBeLessThan(0.01);
    expect(r.complete).toBe(false);
    expect(rel(r.annualTonnesCo2e, g.annualTonnesCo2e, 1e-8)).toBe(true);
  });
  it('priced in full', () => {
    const r = condensateReturnValue({ ...args, treatmentCostPerTonne: 1.2 });
    expect(Math.abs(r.annualValue - g.annualValueFull)).toBeLessThan(0.01);
    expect(r.complete).toBe(true);
  });
  it('refuses blank hours', () => {
    expect(condensateReturnValue({ ...args, hoursPerYear: null }).error).toMatch(/Hours in service/);
  });
});

describe('energy intensity', () => {
  const g = EE.intensity;
  const streams = [{ label: 'Fuel gas', energyGJ: 900000 }, { label: 'Purchased power', energyGJ: 120000 }, { label: 'Imported steam', energyGJ: 60000 }];
  it('matches the ledger and compares with a peer when complete', () => {
    const r = energyIntensity({ energyStreams: streams, throughputTonnes: 1500000, peerIntensityMJPerTonne: g.peer });
    expect(rel(r.intensityMJPerTonne, g.intensityMJPerTonne, 1e-9)).toBe(true);
    expect(rel(r.versusPeer, g.versusPeer, 1e-6)).toBe(true);
    expect(rel(r.gapMJPerTonne, g.gap, 1e-6)).toBe(true);
  });
  it('does not compare a floor with a peer (MD5-0 E7)', () => {
    const r = energyIntensity({
      energyStreams: [streams[0], { label: 'Purchased power', energyGJ: null }, streams[2]], throughputTonnes: 1500000, peerIntensityMJPerTonne: g.peer,
    });
    expect(rel(r.intensityMJPerTonne, g.withoutPowerIntensity, 1e-9)).toBe(true);
    expect(r.versusPeer).toBeNull();
    expect(r.gapMJPerTonne).toBeNull();
    expect(r.peerNote).toMatch(/floor/);
  });
});

describe.each(Object.entries(EE.pinch))('pinch by the largest deficit, at %s C', (dt, g) => {
  const r = pinchTargets({ streams: EE.pinchStreams, minimumApproachC: Number(dt) });
  it('matches the utilities, the pinch and the threshold verdict', () => {
    expect(rel(r.hotUtilityKW, g.hotUtilityKW, 1e-9)).toBe(true);
    expect(rel(r.coldUtilityKW, g.coldUtilityKW, 1e-9)).toBe(true);
    expect(rel(r.heatRecoveredKW, g.heatRecoveredKW, 1e-9)).toBe(true);
    expect(r.thresholdProblem).toBe(g.thresholdProblem);
    expect(r.pinchHotC).toBe(g.pinchHotC);
    expect(r.pinchColdC).toBe(g.pinchColdC);
  });
});

describe('pinch refusals and thresholds (MD5-0 E5, E6)', () => {
  it('reports no pinch for a threshold problem', () => {
    const r = pinchTargets({
      streams: [{ supplyC: 200, targetC: 50, cpKWperK: 10 }, { supplyC: 30, targetC: 60, cpKWperK: 1 }], minimumApproachC: 10,
    });
    expect(r.thresholdProblem).toBe(true);
    expect(r.pinchHotC).toBe(EE.threshold.pinchHotC);
    expect(rel(r.coldUtilityKW, EE.threshold.coldUtilityKW)).toBe(true);
  });
  it('refuses a negative heat capacity flowrate', () => {
    expect(pinchTargets({ streams: [{ supplyC: 200, targetC: 50, cpKWperK: -10 }, { supplyC: 30, targetC: 60, cpKWperK: 1 }], minimumApproachC: 10 }).error)
      .toMatch(/cannot be negative/);
  });
});

describe('the dual ledger hands on a levelised cost per tonne (MD5-0 E1)', () => {
  it('matches the PV ledger', () => {
    const r = priceSaving({
      energySavedGJ: 12000, fuelCostPerGJ: 8, emissionFactorKgCo2ePerGJ: 56,
      implementationCost: 250000, lifeYears: 10, discountRate: 0.1,
    });
    expect(rel(r.costPerTonneCo2e, EE.priceSaving.costPerTonneCo2e, 1e-7)).toBe(true);
    expect(rel(r.annualValue, EE.priceSaving.annualValue)).toBe(true);
  });
  it('gives none without a life, where it used to set capital against one year', () => {
    const r = priceSaving({ energySavedGJ: 12000, fuelCostPerGJ: 8, emissionFactorKgCo2ePerGJ: 56, implementationCost: 250000 });
    expect(r.costPerTonneCo2e).toBeNull();
  });
  it('refuses a price and a factor on different heating value bases (MD5-0 E9)', () => {
    const r = priceSaving({
      energySavedGJ: 12000, fuelCostPerGJ: 8, emissionFactorKgCo2ePerGJ: 56, energyBasis: 'LHV', fuelCostBasis: 'HHV',
    });
    expect(r.error).toMatch(/cannot be multiplied together/);
    expect(priceSaving({ energySavedGJ: 1, energyBasis: 'LHV', emissionFactorBasis: 'LHV' }).basis).toBe('LHV');
    expect(priceSaving({ energySavedGJ: 1 }).basisNote).toMatch(/No heating value basis declared/);
  });
});

// ---------------------------------------------------------------------------
// MD45-1: what the carbon course foundations found
// ---------------------------------------------------------------------------

const M45 = CA.md45;
const E45 = EE.md45;
const costedPage = () => CA.measures.map((m) => abatementCost({ ...m, discountRate: CA.discountRate }));

describe('MD45-1 F1: a claim that cannot be checked against its source leaves the target unassessed', () => {
  it('AT THE PAGE DEFAULTS: the flare refused and left out, the verdict is no longer "met"', () => {
    const g = M45.curveAtOpen;
    const c = abatementCurve({ measures: costedPage(), sourceEmissions: g.sourceEmissions, targetTonnes: g.targetTonnes });
    expect(rel(c.totalAbatementTonnes, g.totalAbatementTonnes)).toBe(true);
    expect(c.totalAbatementTonnes).toBeGreaterThan(c.targetTonnes); // it WOULD have said met
    expect(c.meetsTarget).toBe(g.meetsTarget);
    expect(c.meetsTarget).toBeNull();
    expect(c.overClaims).toEqual([]);
    expect(c.uncheckedSources).toEqual(g.uncheckedSources);
    expect(c.targetBasis).toMatch(/not assessed/);
    g.uncheckedSources.forEach((sid) => expect(c.targetBasis).toContain(sid));
    expect(c.uncheckedClaims.find((u) => u.sourceId === 'flare').reason).toMatch(/no emission was given/);
  });
  it('with every source given and no over-claim, a verdict again as an upper bound', () => {
    [M45.curveAllSourcesChecked, M45.curveAllSourcesCheckedMet].forEach((g) => {
      const c = abatementCurve({ measures: costedPage().slice(0, 3), sourceEmissions: g.sourceEmissions, targetTonnes: g.targetTonnes });
      expect(c.meetsTarget).toBe(g.meetsTarget);
      expect(c.uncheckedSources).toEqual([]);
      expect(c.targetBasis).toMatch(/upper bound/);
    });
    expect(M45.curveAllSourcesCheckedMet.meetsTarget).toBe(true);
  });
  it('every source given, the flare over-claimed: the over-claim alone keeps it unassessed (MD5-0 C7)', () => {
    const g = M45.curveOverClaimAllGiven;
    const c = abatementCurve({ measures: costedPage(), sourceEmissions: g.sourceEmissions, targetTonnes: g.targetTonnes });
    expect(c.uncheckedSources).toEqual([]);
    expect(c.overClaims.map((o) => o.sourceId)).toEqual(['flare']);
    expect(c.meetsTarget).toBe(g.meetsTarget);
    expect(c.meetsTarget).toBeNull();
    expect(c.targetBasis).toMatch(/exceed/);
  });
  it('a source given with no computed emission is unchecked and named', () => {
    const g = M45.curveSourceNotComputed;
    const c = abatementCurve({ measures: costedPage().slice(0, 3), sourceEmissions: g.sourceEmissions, targetTonnes: g.targetTonnes });
    expect(c.meetsTarget).toBeNull();
    expect(c.uncheckedSources).toEqual(g.uncheckedSources);
    expect(c.uncheckedClaims[0].reason).toMatch(/given with no computed emission/);
    const nan = abatementCurve({ measures: costedPage().slice(0, 3), sourceEmissions: { ...g.sourceEmissions, steam: NaN }, targetTonnes: g.targetTonnes });
    expect(nan.meetsTarget).toBeNull();
  });
  it('a source given as a negative emission is unchecked and named', () => {
    const g = M45.curveNegativeSource;
    const c = abatementCurve({ measures: costedPage().slice(0, 3), sourceEmissions: g.sourceEmissions, targetTonnes: g.targetTonnes });
    expect(g.meetsTarget).toBeNull();
    expect(c.meetsTarget).toBeNull();
    expect(c.uncheckedSources).toEqual(g.uncheckedSources);
  });
  it('a measure that names no source is unchecked and named', () => {
    const g = M45.curveUnsourcedMeasure;
    const c = abatementCurve({ measures: [{ ...costedPage()[0], actsOn: [] }], sourceEmissions: g.sourceEmissions, targetTonnes: g.targetTonnes });
    expect(c.meetsTarget).toBeNull();
    expect(c.uncheckedClaims.map((u) => u.measure)).toEqual(g.unsourcedMeasures);
    expect(c.targetBasis).toMatch(/names no source/);
  });
});

describe('MD45-1 F3: a refused measure is named in the curve', () => {
  it('lists it with the engine\'s reason and keeps its tonnes out', () => {
    const g = M45.curveWithRefused;
    const refused = abatementCost(g.refusedArgs);
    expect(refused.error).toBeTruthy();
    expect(refused.label).toBe(g.refusedArgs.label);
    const c = abatementCurve({ measures: [costedPage()[0], refused], sourceEmissions: g.sourceEmissions, targetTonnes: g.targetTonnes });
    expect(rel(c.totalAbatementTonnes, g.totalAbatementTonnes)).toBe(true);
    expect(c.meetsTarget).toBe(g.meetsTarget);
    expect(c.refusedMeasures.map((m) => m.label)).toEqual(g.refusedMeasures.map((m) => m.label));
    g.refusedMeasures.forEach((m, i) => expect(c.refusedMeasures[i].reason).toContain(m.reasonContains));
    expect(c.refusedNote).toMatch(/refused/);
    expect(abatementCurve({ measures: [costedPage()[0]] }).refusedMeasures).toEqual([]);
  });
});

describe('MD45-1 F4: a negative activity or factor is a blocked line, and the inventory is not reportable', () => {
  const gwp = makeGwpSet({ label: 'AR6', values: CA.inventoryFilled.gwp });
  M45.negativeLines.forEach((g) => {
    it(g.name, () => {
      const f = makeFactor({ label: 'f', value: g.line.factor, unit: 't/t', gas: g.line.gas, source: 's', version: '1' });
      const l = emissionLine({ label: g.line.label, scope: g.line.scope, activity: g.line.activity, factor: f, gwpSet: gwp });
      expect(l.tCo2e).toBeNull();
      expect(l.blockedBy).toContain(g.blocked[0].reason);
      const inv = buildInventory({ lines: [l], gwpSet: gwp });
      expect(inv.reportable).toBe(g.reportable);
      expect(inv.reportable).toBe(false);
      expect(inv.totalTonnes).toBe(g.totalTonnes);
    });
  });
});

describe('MD45-1 F7: a potential of zero or below, and a path below zero, are refused', () => {
  M45.gwpRefusals.forEach((g) => {
    it(g.name, () => {
      const set = makeGwpSet({ label: g.label, values: g.values });
      expect(set.error).toMatch(/must be positive/);
      expect(set.declared).toBe(false);
    });
  });
  it('a positive set is still declared, with no error', () => {
    const set = makeGwpSet({ label: 'AR6', values: CA.inventoryFilled.gwp });
    expect(set.error).toBeNull();
    expect(set.declared).toBe(true);
  });
  it('a path whose measures abate more than the baseline', () => {
    const g = M45.pathOverAbated;
    expect(g.refused).toBe(true);
    const p = decarbonisationPath({ baselineTonnes: g.baselineTonnes, measures: g.measures, startYear: g.startYear, endYear: g.endYear });
    expect(p.error).toMatch(/below zero/);
    expect(p.overAbatedYear).toBe(g.overAbatedYear);
  });
});

describe('MD45-1 F2: the heating value basis is LHV or HHV, in any case', () => {
  const st = stoich(EE.stoichiometry.page.fuel);
  Object.entries(E45.basisCases).forEach(([typed, meant]) => {
    it(`"${typed}" is ${meant}, on ${meant}'s number`, () => {
      const r = heater(st, 3, typed);
      expect(r.error).toBeNull();
      expect(r.basis).toBe(meant);
      expect(Math.abs(r.efficiencyPercent - EE.efficiency[`${meant}@3`].efficiencyPercent)).toBeLessThan(2e-6);
    });
  });
  E45.basisRefusals.forEach((typed) => {
    it(`refuses ${JSON.stringify(typed)}`, () => {
      expect(heater(st, 3, typed).error).toMatch(/LHV or HHV/);
    });
  });
});

describe('MD45-1 F7: a loss below zero is refused', () => {
  const st = stoich(EE.stoichiometry.page.fuel);
  E45.lossRefusals.forEach(({ name, ...over }) => {
    it(name, () => {
      const ea = excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: 3 });
      const args = {
        stoichiometry: st, excessAir: ea, ...Object.fromEntries(Object.entries(EE.heater).map(([k, v]) => [k, Number(v)])), basis: 'LHV', ...over,
      };
      expect(stackLossEfficiency(args).error).toMatch(/cannot be negative/);
    });
  });
});

describe('MD45-1 F5: a condensate target below the current return is refused', () => {
  it('refuses it', () => {
    expect(condensateReturnValue(E45.condensateBelowCurrent).error).toMatch(/below the current return/);
  });
  it('a target equal to the current is a value of zero, not refused', () => {
    const r = condensateReturnValue({ ...E45.condensateBelowCurrent, targetReturnFraction: 0.7 });
    expect(r.error).toBeNull();
    expect(r.extraCondensateTonnesPerYear).toBe(0);
  });
});

describe('MD45-1 F6: the trap tests choked flow against the critical pressure ratio', () => {
  E45.traps.forEach((g) => {
    it(g.name, () => {
      const r = steamTrapLoss(g.args);
      expect(r.error).toBeNull();
      expect(r.choked).toBe(g.choked);
      expect(rel(r.criticalPressureRatio, g.criticalPressureRatio, 1e-7)).toBe(true);
      expect(rel(r.pressureRatio, g.pressureRatio, 1e-7)).toBe(true);
      expect(rel(r.kgPerHour, g.kgPerHour, 1e-9)).toBe(true);
      expect(r.downstreamPressureBarA).toBe(g.downstreamPressureBarA);
      expect(r.chokedNote).toMatch(g.choked ? /^Choked/ : /^Subsonic/);
      if (g.args.downstreamPressureBarA === undefined) expect(r.downstreamNote).toMatch(/atmosphere/);
      else expect(r.downstreamNote).toBeNull();
    });
  });
  it('the stated atmosphere is 1.01325 bar a', () => {
    expect(ATMOSPHERE_BAR_A).toBe(1.01325);
  });
  E45.trapRefusals.forEach((g) => {
    it(`refuses ${g.name}`, () => {
      const r = steamTrapLoss({ ...E45.traps[0].args, downstreamPressureBarA: g.downstreamPressureBarA });
      expect(r.error).toBeTruthy();
    });
  });
});

describe('MD45-1: the oracle duty ledger is a function now, and the engine matches it', () => {
  it('matches the exported duty_ledger()', () => {
    const g = E45.dutyLedger;
    const st = stoich(EE.stoichiometry.page.fuel);
    const r = excessAirSaving({
      current: heater(st, 6, 'LHV'), target: heater(st, 3, 'LHV'), minimumSafeO2Percent: 2, targetO2Percent: 3, annualFuelEnergyGJ: g.annualFuelGJ,
    });
    expect(Math.abs(r.fuelSavingFraction - g.fuelSavingFraction)).toBeLessThan(1e-7);
    expect(Math.abs(r.annualEnergySavedGJ - g.annualEnergySavedGJ)).toBeLessThan(0.05);
  });
});

const CONTRAST = /\b\w+, not (a |an |the )?\w+/i;
const clean = (t) => !/[\u2014\u2013]/.test(t) && !CONTRAST.test(t);

describe('MD45-1: no string in either engine breaks the owner copy rule', () => {
  it('sweeps every string literal and template', () => {
    const require = createRequire(__filename);
    const { parse } = require('@babel/parser');
    const bad = [];
    ['carbonAbatement.js', 'energyEfficiency.js'].forEach((f) => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'engines', 'downstream', f), 'utf8');
      const walk = (n) => {
        if (!n || typeof n.type !== 'string') return;
        const text = n.type === 'StringLiteral' ? n.value
          : n.type === 'TemplateLiteral' ? n.quasis.map((q) => q.value.cooked).join('X') : null;
        if (text !== null && !clean(text)) bad.push(`${f}:${n.loc.start.line} ${text}`);
        Object.keys(n).forEach((k) => {
          if (k === 'loc' || k.endsWith('Comments')) return;
          const v = n[k];
          if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v);
        });
      };
      walk(parse(src, { sourceType: 'module' }).program);
    });
    expect(bad).toEqual([]);
  });
});

describe('MD45-1 F8: a refused combustion is a blocked line, never a missing one', () => {
  const g = M45.inventoryFlareRefused;
  const gwpSet = makeGwpSet({ label: 'IPCC AR6 GWP100 (fossil CH4)', values: CA.inventoryFilled.gwp });
  const others = CA.inventoryFilled.lines.filter((l) => !l.label.startsWith('Flaring')).map((l) => factorLine(l, gwpSet));
  const refused = combustionCo2FromCarbon({ fuelKmolPerYear: 45000, carbonPerKmolFuel: 1.4, destructionEfficiencyFraction: '' });
  it('the refused flare, dropped as the page dropped it, left the rest reportable', () => {
    const inv = buildInventory({ lines: others, gwpSet });
    expect(inv.reportable).toBe(g.refusedDropped.reportable);
    expect(inv.reportable).toBe(true);
  });
  it('through atomBalanceLines it is blocked with the refusal, and the inventory is not reportable', () => {
    const lines = atomBalanceLines({ label: 'Flaring', combustion: refused, gwpSet });
    expect(lines).toHaveLength(1);
    const inv = buildInventory({ lines: [...others, ...lines], gwpSet });
    expect(inv.reportable).toBe(g.refusedAsLine.reportable);
    expect(inv.reportable).toBe(false);
    expect(inv.blockedLines.map((b) => b.label)).toEqual(g.refusedAsLine.blocked.map((b) => b.label));
    expect(inv.blockedLines[0].reason).toBe(refused.error);
    expect(rel(inv.totalTonnes, g.refusedAsLine.totalTonnes, 1e-9)).toBe(true);
  });
  it('a computed flare becomes its CO2 and methane lines at the ledger\'s tonnes', () => {
    const flare = combustionCo2FromCarbon(CA.combustion.flare98);
    const lines = atomBalanceLines({ label: 'Flaring', combustion: flare, gwpSet });
    expect(lines.map((l) => l.label)).toEqual(['Flaring (CO2)', 'Flaring (unburned CH4)']);
    const inv = buildInventory({ lines: [...others, ...lines], gwpSet });
    expect(rel(inv.totalTonnes, CA.inventoryFilled.totalTonnes, 1e-9)).toBe(true);
    expect(inv.reportable).toBe(true);
  });
  it('a source left out of the boundary on purpose adds nothing', () => {
    expect(atomBalanceLines({ label: 'Flaring', combustion: refused, gwpSet, excluded: true })).toEqual([]);
  });
});

describe('MD45-1 F9 and one source of molar masses', () => {
  it('the stack oxygen refusal states the bound the test applies', () => {
    const st = stoich(EE.stoichiometry.page.fuel);
    const r = excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: O2_MOLE_FRACTION_DRY_AIR * 100 });
    expect(r.error).toContain('below 20.946 percent');
    expect(r.error).not.toMatch(/20\.95\b/);
    expect(excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: 20.9 }).error).toBeNull();
  });
  it('the flue gas products are the oracle\'s built molar masses, and CO2 is the carbon engine\'s', () => {
    expect(PRODUCT_MOLAR_MASS.CO2).toBe(MW_CO2);
    ['CO2', 'H2O', 'SO2', 'N2'].forEach((k) => expect(rel(PRODUCT_MOLAR_MASS[k], EE.molarMasses[k], 1e-12)).toBe(true));
    expect(FUEL_REFERENCE.find((r) => r.code === 'CO2').molarMassKgKmol).toBe(MW_CO2);
  });
  it('the capital-life refusal says what is true: it overstates a capital measure', () => {
    const r = abatementCost({ label: 'X', capitalCost: 1000, tonnesAbatedPerYear: 10, discountRate: 0.1 });
    expect(r.error).toMatch(/overstates the cost per tonne/);
    expect(r.error).not.toMatch(/every measure/);
  });
});
