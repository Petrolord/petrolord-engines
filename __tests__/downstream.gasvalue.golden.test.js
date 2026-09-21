/**
 * Flare gas to value and the LPG and CNG rollout against independent oracles
 * (MD4-0).
 *
 * Goldens: tools/validation/downstream/oracle_flaretovalue.py (the gas in
 * exact rationals, kg and m3; the flare by 40 CFR 98.233(n) cross-checked by
 * the rule's own W-36 densities; route, credit and comparison ledgers) and
 * oracle_lpgcng.py (DAK by bisection with Hall-Yarborough as a plausibility
 * check, the cascade as a mass ledger by false position, exact Erlang C,
 * ledgers). Every assertion calls the engine.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import {
  characteriseGas, screenRoute, routeEconomics, abatement, creditSensitivity, compareRoutes,
  ROUTE_TEMPLATES, SCF_PER_LBMOL, FLARE_MOLAR_MASS, RICHNESS_GPM,
} from '../engines/downstream/flareToValue.js';
import {
  assetFloat, lpgBlendProperties, lpgStorageSizing, vaporizerDuty, bottlingPlant,
  gasMassInVessel, cascadeFills, cngCompression, cngDispensing, conversionEconomics,
  PRESSURE_BASIS,
} from '../engines/downstream/lpgCng.js';

const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'downstream', 'goldens', f), 'utf8'));
const FV = load('flaretovalue_cases.json');
const LC = load('lpgcng_cases.json');
const rel = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

describe('the goldens, and what they honestly are', () => {
  it('were written by the oracles, with what is pinned said', () => {
    expect(FV.provenance.published).toMatch(/pinned not validated/);
    expect(LC.provenance.published).toMatch(/pinned/);
  });
  it('carry a standard molar volume the oracle derived from the gas constant', () => {
    expect(rel(SCF_PER_LBMOL, FV.provenance.derivedScfPerLbmol, 5e-5)).toBe(true);
  });
});

const gasOf = (g) => characteriseGas({ components: g.components });

describe.each(FV.gases.map((g) => [g.name, g]))('gas: %s', (_n, g) => {
  const r = gasOf(g);
  it('characterises as the rational oracle does, in kg and m3', () => {
    expect(r.error).toBeNull();
    ['inertMoleFraction', 'co2MoleFraction', 'methaneMoleFraction', 'carbonPerMol',
      'hydrocarbonCarbonPerMol', 'kgPerMscf', 'c3PlusKgPerMscf', 'rawMoleFractionSum'].forEach((k) => {
      expect(rel(r[k], g[k], 1e-7)).toBe(true);
    });
    expect(rel(r.molarMassLbLbmol, g.molarMassLbLbmol, 1e-6)).toBe(true);
    expect(rel(r.ghvBtuScf, g.ghvBtuScf, 1e-7)).toBe(true);
  });
  it('gives the liquids content, or none when a density is missing (never a partial sum)', () => {
    if (g.gpmC3Plus === null) {
      expect(r.gpmC3Plus).toBeNull();
      expect(r.richness).toBeNull();
    } else {
      expect(rel(r.gpmC3Plus, g.gpmC3Plus, 1e-6)).toBe(true);
      expect(rel(r.gpmC2Plus, g.gpmC2Plus, 1e-6)).toBe(true);
      expect(r.richness).toBe(g.richness);
    }
  });
  it('says when it scaled the analysis to one', () => {
    if (Math.abs(g.rawMoleFractionSum - 1) > 1e-6) expect(r.normalisationNote).toMatch(/scaled to one/);
    else expect(r.normalisationNote).toBeNull();
  });
});

describe.each(FV.gasRefusals.map((g) => [g.name, g]))('gas refused: %s', (_n, g) => {
  it('returns an error rather than a gas', () => {
    expect(gasOf(g).error).toBeTruthy();
  });
});

const gas = gasOf(FV.gases[0]);

describe.each(FV.flares.map((f) => [f.name, f]))('flare: %s', (_n, f) => {
  const r = abatement({
    gas, volumeMMscfd: f.volumeMMscfd, onstreamDays: f.onstreamDays,
    flareDestructionEfficiency: f.flareDestructionEfficiency,
    flareCombustionEfficiency: f.flareCombustionEfficiency,
    gwpMethane: f.gwpMethane, recoveryFraction: f.recoveryFraction,
  });
  it('emits CO2 and methane as 40 CFR 98.233(n) does', () => {
    expect(Math.abs(r.flareCo2Tonnes - f.flareCo2Tonnes)).toBeLessThan(1e-3);
    expect(Math.abs(r.flareCh4Tonnes - f.flareCh4Tonnes)).toBeLessThan(1e-3);
    expect(Math.abs(r.flareCo2eTonnes - f.flareCo2eTonnes)).toBeLessThan(1e-3);
    expect(Math.abs(r.methaneShareOfFlareCo2e - f.methaneShareOfFlareCo2e)).toBeLessThan(1e-6);
  });
  it('agrees with the rule\'s own volumetric route to its printed precision', () => {
    expect(rel(r.flareCo2Tonnes, f.subpartWCo2Tonnes, 5e-3)).toBe(true);
    expect(rel(r.flareCh4Tonnes, f.subpartWCh4Tonnes, 5e-3)).toBe(true);
  });
  it('credits only the recovered share of the flare as avoided', () => {
    expect(Math.abs(r.avoidedFlareCo2eTonnes - f.avoidedFlareCo2eTonnes)).toBeLessThan(1e-3);
  });
});

describe('the abatement', () => {
  const c = FV.counterfactual;
  const args = {
    gas, volumeMMscfd: c.volumeMMscfd, onstreamDays: c.onstreamDays,
    flareDestructionEfficiency: c.flareDestructionEfficiency, gwpMethane: c.gwpMethane,
    recoveryFraction: c.recoveryFraction, counterfactualLabel: c.counterfactualLabel,
    productCombustionTonnesCo2ePerYear: c.productCombustionTonnesCo2ePerYear,
    displacedFuelTonnesCo2ePerYear: c.displacedFuelTonnesCo2ePerYear,
  };
  it('nets the counterfactual against the recovered share, as the ledger does', () => {
    expect(Math.abs(abatement(args).netAbatementTonnesCo2ePerYear - c.netAbatementTonnesCo2ePerYear)).toBeLessThan(1e-3);
  });
  it('no longer counts every unburned carbon as methane (main said 1,745 t)', () => {
    const r = abatement(args);
    expect(FV.mainBefore.flareCh4Tonnes).toBeGreaterThan(1.6 * r.flareCh4Tonnes);
    expect(r.basis).toMatch(/98\.233\(n\)/);
  });
  it('names the combustion efficiency it stood in for', () => {
    expect(abatement(args).combustionEfficiencyNote).toMatch(/stands in/);
    expect(abatement({ ...args, flareCombustionEfficiency: 0.965 }).combustionEfficiencyNote).toBeNull();
  });
  it('gives no abatement without a recovery, and says why', () => {
    const r = abatement({ ...args, recoveryFraction: undefined });
    expect(r.netAbatementTonnesCo2ePerYear).toBeNull();
    expect(r.blockedBy).toMatch(/recovery fraction/);
    expect(abatement({ ...args, recoveryFraction: 1.2 }).netAbatementTonnesCo2ePerYear).toBeNull();
  });
  it('refuses a combustion efficiency above the destruction efficiency', () => {
    expect(abatement({ ...args, flareCombustionEfficiency: 0.99 }).error).toMatch(/combustion efficiency/);
  });
  it('reads a blank on-stream figure as missing, and an omitted one as the stated 350', () => {
    expect(abatement({ ...args, onstreamDays: '' }).error).toMatch(/On-stream days/);
    expect(abatement({ ...args, onstreamDays: 400 }).error).toMatch(/On-stream days/);
    const { onstreamDays, ...rest } = args; // eslint-disable-line no-unused-vars
    expect(abatement(rest).scfPerYear).toBe(3.5e9);
  });
});

const econArgs = (r) => ({
  route: ROUTE_TEMPLATES.find((t) => t.id === r.routeId), gas,
  volumeMMscfd: r.volumeMMscfd, onstreamDays: r.onstreamDays,
  productUnitPerMscf: r.productUnitPerMscf, recoveryFraction: r.recoveryFraction,
  pricePerProductUnit: r.pricePerProductUnit, referenceCapitalCost: r.referenceCapitalCost,
  referenceCapacityMMscfd: r.referenceCapacityMMscfd, fixedOpexPerYear: r.fixedOpexPerYear,
  variableOpexPerMscf: r.variableOpexPerMscf,
});

describe.each(FV.routes.map((r) => [r.routeId, r]))('route economics: %s', (_n, g) => {
  const r = routeEconomics(econArgs(g));
  it('closes the year as the ledger does', () => {
    expect(r.error).toBeNull();
    ['mscfPerYear', 'productPerYear', 'revenuePerYear', 'operatingCostPerYear', 'grossMarginPerYear'].forEach((k) => {
      expect(Math.abs(r[k] - g[k])).toBeLessThan(0.01);
    });
    expect(Math.abs(r.valuePerMscf - g.valuePerMscf)).toBeLessThan(1e-6);
    expect(Math.abs(r.capitalCost - g.capitalCost)).toBeLessThan(0.01);
  });
  it('knows the most product the gas can make', () => {
    expect(rel(r.yieldCeilingPerMscf, g.yieldCeilingPerMscf, 1e-7)).toBe(true);
  });
});

describe('a yield the gas cannot supply', () => {
  it('refuses the page\'s old LPG default: 0.02 t/Mscf from a gas holding 0.0056', () => {
    const g = FV.yieldAboveCeiling;
    const r = routeEconomics({ ...econArgs(FV.routes.find((x) => x.routeId === 'lpg_extraction')), productUnitPerMscf: g.productUnitPerMscf });
    expect(r.error).toMatch(/more than the/);
    expect(rel(r.yieldCeilingPerMscf, g.yieldCeilingPerMscf, 1e-7)).toBe(true);
  });
  it('refuses a zero or negative yield, and names a blank cost it takes as zero', () => {
    const base = econArgs(FV.routes[0]);
    expect(routeEconomics({ ...base, productUnitPerMscf: 0 }).error).toMatch(/positive product yield/);
    expect(routeEconomics({ ...base, fixedOpexPerYear: '' }).assumedZero).toEqual(['fixed operating cost']);
    expect(routeEconomics({ ...base, onstreamDays: '' }).error).toMatch(/On-stream days/);
  });
});

describe.each(FV.credits.map((c) => [c.name, c]))('credits: %s', (_n, c) => {
  const r = creditSensitivity({
    netAbatementTonnesCo2ePerYear: c.t, creditPrices: c.prices,
    grossMarginPerYear: c.margin, hurdleMarginPerYear: c.hurdle,
  });
  it('finds the breakeven in closed form and the lowest tested price that clears', () => {
    if (c.breakevenCreditPrice === null) expect(r.breakevenCreditPrice).toBeNull();
    else expect(Math.abs(r.breakevenCreditPrice - c.breakevenCreditPrice)).toBeLessThan(1e-6);
    expect(r.lowestTestedClearingPrice).toBe(c.lowestTestedClearingPrice);
    expect(r.standsAloneWithoutCredits).toBe(c.standsAloneWithoutCredits);
    r.points.forEach((p, i) => expect(p.clearsHurdle).toBe(c.points[i].clearsHurdle));
  });
});

describe('credit refusals', () => {
  it('sells no credits from a project that adds emissions', () => {
    expect(creditSensitivity({ netAbatementTonnesCo2ePerYear: -5000, creditPrices: [10], grossMarginPerYear: 1, hurdleMarginPerYear: 0 }).error)
      .toMatch(/does not abate/);
  });
  it('gives no verdict without a margin, rather than "does not clear"', () => {
    const r = creditSensitivity({ netAbatementTonnesCo2ePerYear: 1000, creditPrices: [10], grossMarginPerYear: null, hurdleMarginPerYear: 5 });
    expect(r.verdict).toMatch(/cannot be said/);
    expect(creditSensitivity({ netAbatementTonnesCo2ePerYear: 1000, creditPrices: [10], grossMarginPerYear: 5, hurdleMarginPerYear: '' }).standsAloneWithoutCredits)
      .toBeNull();
  });
});

describe('the bid comparison at the page defaults (every limit unset)', () => {
  const screenings = ROUTE_TEMPLATES.map((route) => screenRoute({ route, gas, volumeMMscfd: 10 }));
  const economics = FV.routes.map((r) => routeEconomics(econArgs(r)));
  it('crowns no route that nobody screened, and names the provisional leader', () => {
    const c = compareRoutes({ screenings, economics });
    expect(screenings.every((s) => s.verdict === 'not fully screened')).toBe(true);
    const lead = FV.routes.reduce((a, b) => (b.valuePerMscf > a.valuePerMscf ? b : a));
    expect(c.bestByValuePerMscf).toBeNull();
    expect(c.leaderNotFullyScreened).toBe(lead.routeId);
    expect(c.rankingNote).toMatch(/No route passes screening/);
  });
  it('ranks among routes that pass once their limits are set', () => {
    const set = (id) => ({
      ...ROUTE_TEMPLATES.find((t) => t.id === id),
      requirements: ROUTE_TEMPLATES.find((t) => t.id === id).requirements.map((q) => ({ ...q, limit: q.direction === 'min' ? 0 : 1 })),
    });
    const passing = [screenRoute({ route: set('mini_lng'), gas, volumeMMscfd: 10 }), ...screenings.filter((s) => s.routeId !== 'mini_lng')];
    expect(compareRoutes({ screenings: passing, economics }).bestByValuePerMscf).toBe('mini_lng');
  });
});

// ---------------------------------------------------------------------------
// LPG and CNG
// ---------------------------------------------------------------------------

describe.each(LC.blends.map((b) => [b.name, b]))('blend: %s', (_n, g) => {
  it('mixes density on volume, latent heat on mass and molar mass on moles', () => {
    const r = lpgBlendProperties({ components: g.components });
    expect(rel(r.densityKgM3, g.densityKgM3, 1e-9)).toBe(true);
    expect(rel(r.latentHeatKJkg, g.latentHeatKJkg, 1e-8)).toBe(true);
    expect(rel(r.molarMassKgKmol, g.molarMassKgKmol, 1e-8)).toBe(true);
    r.massFractions.forEach((m, i) => expect(Math.abs(m.massFraction - g.massFractions[i])).toBeLessThan(1e-6));
  });
});

describe('blend refusals', () => {
  it('refuses a blank or negative volume fraction', () => {
    const c = LC.blends[0].components;
    expect(lpgBlendProperties({ components: [{ ...c[0], volumeFraction: '' }, c[1]] }).error).toMatch(/Every component needs a volume fraction/);
    expect(lpgBlendProperties({ components: [{ ...c[0], volumeFraction: -0.1 }, c[1]] }).error).toMatch(/negative/);
  });
});

describe.each(LC.storage.map((s) => [s.name, s]))('storage: %s', (_n, g) => {
  const r = lpgStorageSizing(g);
  it('holds and reorders as the ledger does, on the stated basis', () => {
    expect(r.fillRatioBasis).toBe(g.fillRatioBasis);
    expect(Math.abs(r.usableTonnes - g.usableTonnes)).toBeLessThan(1e-4);
    expect(Math.abs(r.usableM3 - g.usableM3)).toBeLessThan(1e-4);
    expect(Math.abs(r.coverDays - g.coverDays)).toBeLessThan(1e-3);
    expect(Math.abs(r.reorderAtTonnes - g.reorderAtTonnes)).toBeLessThan(1e-4);
    expect(Math.abs(r.ullageAtReorderTonnes - g.ullageAtReorderTonnes)).toBeLessThan(1e-4);
    expect(r.deliveryFitsUllage).toBe(g.deliveryFitsUllage);
  });
});

describe('storage refusals', () => {
  const g = LC.storage[0];
  it('gives no reorder point with a blank lead time, rather than an empty vessel', () => {
    const r = lpgStorageSizing({ ...g, leadTimeDays: '' });
    expect(r.reorderAtTonnes).toBeNull();
    expect(r.missingInputs).toContain('lead time');
    expect(r.deliveryFitsUllage).toBeNull();
    expect(lpgStorageSizing({ ...g, safetyDays: null }).missingInputs).toContain('safety stock');
  });
  it('refuses the fill limit left out, and an unknown basis', () => {
    expect(lpgStorageSizing({ ...g, maxFillRatio: '' }).error).toMatch(/not defaulted/);
    expect(lpgStorageSizing({ ...g, fillRatioBasis: 'weight' }).error).toMatch(/Unknown fill ratio basis/);
  });
});

describe('the vaporizer', () => {
  const g = LC.vaporizer;
  it('sums three positive terms, as the ledger does', () => {
    const r = vaporizerDuty(g);
    r.terms.forEach((t, i) => expect(Math.abs(t.kW - g.termsKW[i])).toBeLessThan(1e-5));
    expect(Math.abs(r.dutyKW - g.dutyKW)).toBeLessThan(1e-5);
    expect(Math.abs(r.designDutyKW - g.designDutyKW)).toBeLessThan(1e-5);
  });
  it('refuses the page\'s old default: a liquid entering above its boiling point (main cut the duty to 50.3 kW)', () => {
    expect(LC.vaporizerBefore.mainDutyKW).toBeLessThan(LC.vaporizerBefore.latentAloneKW);
    expect(vaporizerDuty({ ...g, inletTempC: 25, boilingPointC: -0.5, outletTempC: 15 }).error).toMatch(/above the boiling point/);
    expect(vaporizerDuty({ ...g, outletTempC: 5 }).error).toMatch(/would condense/);
  });
});

describe.each(LC.bottling.map((b) => [b.name, b]))('bottling: %s', (_n, g) => {
  const r = bottlingPlant(g);
  it('queues on the positions wholly working, as the exact Erlang C does', () => {
    expect(r.queuePositions).toBe(g.queuePositions);
    expect(rel(r.queue.utilisation, g.utilisation, 1e-10)).toBe(true);
    expect(rel(r.queue.probabilityOfWaiting, g.probabilityOfWaiting, 1e-10)).toBe(true);
    expect(rel(r.queue.averageWaitMinutes, g.averageWaitMinutes, 1e-10)).toBe(true);
    expect(Math.abs(r.throughputCapacityPerDay - g.throughputCapacityPerDay)).toBeLessThan(0.01);
  });
});

describe('bottling refusals', () => {
  it('refuses fewer than one working position and a blank availability', () => {
    const g = LC.bottling[0];
    expect(bottlingPlant({ ...g, positions: 1, availabilityFraction: 0.5 }).error).toMatch(/fewer than one/);
    expect(bottlingPlant({ ...g, availabilityFraction: '' }).error).toBeTruthy();
  });
});

describe.each(LC.dispensing.map((d) => [d.name, d]))('dispensing: %s', (_n, g) => {
  it('queues as the exact Erlang C does, and passes a refusal up', () => {
    const r = cngDispensing(g);
    expect(rel(r.queue.probabilityOfWaiting, g.probabilityOfWaiting, 1e-10)).toBe(true);
    expect(rel(r.queue.averageWaitMinutes, g.averageWaitMinutes, 1e-10)).toBe(true);
    expect(cngDispensing({ ...g, dispensers: 2.5 }).error).toMatch(/whole number/);
  });
});

describe.each(LC.floats.map((f) => [f.name, f]))('float: %s', (_n, g) => {
  const stages = g.stageDays.map((d, i) => ({ label: `S${i}`, days: d }));
  it("sizes the fleet by Little's law as the ledger does", () => {
    const r = assetFloat({ unitsPerDay: g.unitsPerDay, cycleStages: stages, sparesFraction: g.sparesFraction });
    expect(rel(r.cycleDays, g.cycleDays, 1e-9)).toBe(true);
    expect(rel(r.inCirculation, g.inCirculation, 1e-9)).toBe(true);
    expect(r.fleetRequired).toBe(g.fleetRequired);
  });
  it('refuses a stage with no duration rather than sizing the fleet without it', () => {
    const r = assetFloat({ unitsPerDay: g.unitsPerDay, cycleStages: [{ ...stages[0], days: '' }, ...stages.slice(1)] });
    expect(r.error).toMatch(/No duration for S0/);
  });
});

describe.each(LC.vessels.map((v) => [`${v.volumeM3} m3 at ${v.pressureBar} bar(a)`, v]))('vessel: %s', (_n, g) => {
  it('holds the gas DAK by bisection says, in bar absolute', () => {
    const r = gasMassInVessel(g);
    expect(Math.abs(r.z - g.z)).toBeLessThan(1e-6);
    expect(rel(r.massKg, g.massKg, 1e-6)).toBe(true);
    expect(rel(r.idealMassKg, g.idealMassKg, 1e-6)).toBe(true);
    expect(r.pressureBasis).toBe(PRESSURE_BASIS);
    expect(PRESSURE_BASIS).toMatch(/absolute/);
  });
});

describe('vessel refusals', () => {
  it('refuses a blank gas gravity rather than reading 0.6', () => {
    expect(gasMassInVessel({ ...LC.vessels[0], gasSg: '' }).error).toMatch(/specific gravity/);
  });
});

describe.each(LC.cascades.map((c) => [c.name, c]))('cascade: %s', (_n, g) => {
  const r = cascadeFills(g);
  it('fills as many vehicles as the equalisation ledger does', () => {
    expect(r.error).toBeNull();
    expect(r.fillsBeforeRecharge).toBe(g.fillsBeforeRecharge);
    expect(Math.abs(r.kgPerFill - g.kgPerFill)).toBeLessThan(1e-4);
  });
  it('conserves the gas: stored is delivered plus what is left in the banks', () => {
    expect(Math.abs(r.storedKg - g.storedKg)).toBeLessThan(1e-3);
    expect(Math.abs(r.leftInBanksKg - g.leftInBanksKg)).toBeLessThan(2e-3);
    expect(Math.abs(r.storedKg - r.deliveredKg - r.leftInBanksKg)).toBeLessThan(2e-3);
  });
  it('leaves the banks where the ledger leaves them', () => {
    r.banksAfter.forEach((b, i) => expect(Math.abs(b.endBar - g.endBar[i])).toBeLessThan(1e-3));
    if (g.nextVehicleReachesBar === null) expect(r.nextVehicleReachesBar).toBeNull();
    else expect(Math.abs(r.nextVehicleReachesBar - g.nextVehicleReachesBar)).toBeLessThan(1e-3);
  });
});

describe('the cascade at the page defaults', () => {
  it('is three times the fills main reported', () => {
    const r = cascadeFills(LC.cascades[0]);
    expect(r.fillsBeforeRecharge).toBeGreaterThan(3 * LC.cascadeMainBefore.fillsBeforeRecharge);
  });
  it('refuses a blank temperature or gravity', () => {
    expect(cascadeFills({ ...LC.cascades[0], temperatureC: '' }).error).toMatch(/temperature/);
    expect(cascadeFills({ ...LC.cascades[0], gasSg: null }).error).toMatch(/specific gravity/);
  });
});

describe('the compression unit bridge', () => {
  it('turns kg/h into MMscfd through the molar mass and 379.49 scf/lbmol, in bar absolute', () => {
    const g = LC.compression;
    const r = cngCompression({ ...g, suctionTempC: 30 });
    expect(rel(r.qMMscfd, g.qMMscfd, 1e-6)).toBe(true);
    expect(r.pressureBasis).toMatch(/absolute/);
  });
});

describe.each(LC.conversion.map((c) => [c.name, c]))('conversion: %s', (_n, g) => {
  const args = {
    annualDistanceKm: 40000,
    baseFuel: { consumptionPer100Km: 12, pricePerUnit: 950, energyPerUnitMJ: 32 },
    newFuel: { pricePerUnit: 500, energyPerUnitMJ: 48, efficiencyRatio: g.efficiencyRatio },
    conversionCost: 900000, annualExtraMaintenance: 40000,
  };
  it('derives the consumption and the payback as the ledger does', () => {
    const r = conversionEconomics(args);
    expect(rel(r.newFuelConsumptionPer100Km, g.newFuelConsumptionPer100Km, 1e-7)).toBe(true);
    expect(Math.abs(r.annualSaving - g.annualSaving)).toBeLessThan(0.01);
    expect(Math.abs(r.simplePaybackYears - g.simplePaybackYears)).toBeLessThan(1e-6);
  });
  it('refuses to derive without an efficiency ratio (it was taken as 1)', () => {
    expect(conversionEconomics({ ...args, newFuel: { ...args.newFuel, efficiencyRatio: '' } }).error).toMatch(/efficiency ratio/);
    const { efficiencyRatio, ...nf } = args.newFuel; // eslint-disable-line no-unused-vars
    expect(conversionEconomics({ ...args, newFuel: nf }).error).toMatch(/efficiency ratio/);
  });
});

// ---------------------------------------------------------------------------
// MD45-1: what the gasvalue course foundations found
// ---------------------------------------------------------------------------

describe('MD45-1 F-R4: the flare molar masses and the richness edges are exported', () => {
  it('weighs the flare at the molar masses the oracle pins, which are the IUPAC 2024 ones', () => {
    expect(FLARE_MOLAR_MASS.CO2).toBe(FV.constants.flareMolarMass.CO2);
    expect(FLARE_MOLAR_MASS.CH4).toBe(FV.constants.flareMolarMass.CH4);
    expect(rel(FLARE_MOLAR_MASS.CO2, FV.constants.flareMolarMassFromIupac2024.CO2, 1e-12)).toBe(true);
    expect(rel(FLARE_MOLAR_MASS.CH4, FV.constants.flareMolarMassFromIupac2024.CH4, 1e-12)).toBe(true);
  });
  it('an all-CO2 and an all-methane flare give the exported molar masses back', () => {
    // A million lb-mol of CO2 passes through; half a million of methane escapes.
    const days = 1;
    const volume = SCF_PER_LBMOL; // MMscfd, so a million lb-mol a day
    const co2 = characteriseGas({ components: [{ code: 'CO2', moleFraction: 1, c: 1, molarMassLbLbmol: 44.01, ghvBtuScf: 0, liquidDensityLbGal: null, recoverableAsNgl: false, inert: true }] });
    const ch4 = characteriseGas({ components: [{ code: 'C1', moleFraction: 1, c: 1, molarMassLbLbmol: 16.043, ghvBtuScf: 1010, liquidDensityLbGal: null, recoverableAsNgl: false }] });
    const a = abatement({ gas: co2, volumeMMscfd: volume, onstreamDays: days, flareDestructionEfficiency: 1, recoveryFraction: 1 });
    const b = abatement({ gas: ch4, volumeMMscfd: volume, onstreamDays: days, flareDestructionEfficiency: 0.5, flareCombustionEfficiency: 0.5, recoveryFraction: 1 });
    const lbToT = 1 / 2.20462262 / 1000;
    expect(rel(a.flareCo2Tonnes, 1e6 * FV.constants.flareMolarMass.CO2 * lbToT, 1e-7)).toBe(true);
    expect(rel(b.flareCh4Tonnes, 0.5e6 * FV.constants.flareMolarMass.CH4 * lbToT, 1e-7)).toBe(true);
  });
  it('the richness bands are the oracle\'s edges', () => {
    expect(RICHNESS_GPM).toEqual(FV.constants.richnessGpm);
  });
  it('names each gas by the oracle\'s edges across a propane sweep', () => {
    const word = (g) => (g >= FV.constants.richnessGpm.rich ? 'rich' : g >= FV.constants.richnessGpm.moderate ? 'moderate' : 'lean');
    const c1 = FV.gases[0].components.find((c) => c.code === 'C1');
    const c3 = FV.gases[0].components.find((c) => c.code === 'C3');
    const seen = new Set();
    for (let i = 0; i <= 200; i += 1) {
      const x = i * 0.0005;
      const comps = [{ ...c1, moleFraction: 1 - x }, { ...c3, moleFraction: x }];
      const r = characteriseGas({ components: comps });
      expect(r.richness).toBe(word(r.gpmC3Plus));
      seen.add(r.richness);
    }
    expect([...seen].sort()).toEqual(['lean', 'moderate', 'rich']);
  });
});

// The owner copy rule: no em or en dash, no "X, not Y" contrastive.
const CONTRAST = /\b\w+, not (a |an |the )?\w+/i;
const clean = (t) => !/[\u2014\u2013]/.test(t) && !CONTRAST.test(t);

describe('MD45-1 F-R3: the engine notes keep the owner copy rule', () => {
  it('the heating value note on a gas missing one', () => {
    const g = characteriseGas({ components: FV.gases[0].components.map((c, i) => (i === 0 ? { ...c, ghvBtuScf: null } : c)) });
    expect(g.ghvBtuScf).toBeNull();
    expect(g.ghvNote).toMatch(/missing/);
    expect(clean(g.ghvNote)).toBe(true);
  });
  it('the blend note on a property missing', () => {
    const r = lpgBlendProperties({ components: [
      { code: 'a', volumeFraction: 0.5, liquidDensityKgM3: 508, latentHeatKJkg: 425 },
      { code: 'b', volumeFraction: 0.5, liquidDensityKgM3: 584, latentHeatKJkg: null },
    ] });
    expect(r.note).toMatch(/missing for the blend/);
    expect(clean(r.note)).toBe(true);
  });
  it('the vaporizer floor note', () => {
    const r = vaporizerDuty({ ...LC.vaporizer, boilingPointC: '' });
    expect(r.note).toMatch(/floor/);
    expect(clean(r.note)).toBe(true);
  });
  it('no string in either engine breaks it', () => {
    const require = createRequire(__filename);
    const { parse } = require('@babel/parser');
    const bad = [];
    ['flareToValue.js', 'lpgCng.js'].forEach((f) => {
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
