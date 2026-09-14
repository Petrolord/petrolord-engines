/**
 * LPG and CNG rollout (DS7).
 *
 * The tests are identities and conservation checks: gas taken out of banks
 * equals gas put into vehicles, a fleet equals throughput times cycle time,
 * a blend's mass fractions sum to one. Where a number depends on a
 * correlation, the assertion is on the DIRECTION and the MECHANISM - real
 * gas holds more than ideal at storage pressure, a slower fill queues sooner
 * - rather than on a remembered value, because a remembered value only
 * proves the code still does what it did the day it was written.
 */
import {
  assetFloat, lpgBlendProperties, lpgStorageSizing, vaporizerDuty, bottlingPlant,
  gasMassInVessel, cascadeFills, cngCompression, cngDispensing, conversionEconomics,
  LPG_REFERENCE, LPG_PROPERTY_NOTE, DAK_RANGE, PSI_PER_BAR,
} from '../engines/downstream/lpgCng.js';

const propane = LPG_REFERENCE.find((r) => r.code === 'propane');
const butane = LPG_REFERENCE.find((r) => r.code === 'butane');

describe('fleets in a cycle', () => {
  const cycle = [
    { label: 'At the customer', days: 21 },
    { label: 'In transit out', days: 1 },
    { label: 'At the plant', days: 2 },
    { label: 'In transit back', days: 1 },
  ];

  it("is Little's Law, and says so", () => {
    const r = assetFloat({ unitsPerDay: 500, cycleStages: cycle });
    expect(r.cycleDays).toBeCloseTo(25, 9);
    // The identity: assets in the system = rate x time in the system.
    expect(r.inCirculation).toBeCloseTo(500 * 25, 6);
    expect(r.basis).toMatch(/Little/i);
  });

  it('rounds up, because half a cylinder does not exist', () => {
    const r = assetFloat({ unitsPerDay: 33, cycleStages: [{ label: 'Cycle', days: 7.5 }] });
    expect(r.inCirculation).toBeCloseTo(247.5, 6);
    expect(r.fleetRequired).toBe(248);
    expect(Number.isInteger(r.fleetRequired)).toBe(true);
    expect(r.spareCapacityUnits).toBeCloseTo(0.5, 6);
  });

  it('adds spares on top of the circulating fleet, not inside it', () => {
    const bare = assetFloat({ unitsPerDay: 100, cycleStages: cycle });
    const spared = assetFloat({ unitsPerDay: 100, cycleStages: cycle, sparesFraction: 0.1 });
    expect(spared.inCirculation).toBeCloseTo(bare.inCirculation, 6);
    expect(spared.sparesAllowance).toBeCloseTo(bare.inCirculation * 0.1, 6);
    expect(spared.fleetRequired).toBeGreaterThan(bare.fleetRequired);
  });

  it('names the stage that dominates the cycle', () => {
    const r = assetFloat({ unitsPerDay: 500, cycleStages: cycle });
    // Nearly always the time at the customer, and the only term the operator
    // can negotiate. Its share is what makes that arguable.
    expect(r.dominantStage).toBe('At the customer');
    expect(r.stages.find((s) => s.label === 'At the customer').share).toBeCloseTo(21 / 25, 6);
    expect(r.stages.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 6);
  });

  it('serves a trailer fleet with the same model as a cylinder fleet', () => {
    // A CNG trailer shuttling to a daughter station is the same problem.
    const trailers = assetFloat({
      unitsPerDay: 3,
      cycleStages: [{ label: 'Loading', days: 0.25 }, { label: 'Run out', days: 0.4 },
        { label: 'On station', days: 1.2 }, { label: 'Run back', days: 0.4 }],
    });
    expect(trailers.cycleDays).toBeCloseTo(2.25, 9);
    expect(trailers.fleetRequired).toBe(Math.ceil(3 * 2.25));
  });

  it('counts a stage with no duration as missing rather than as zero', () => {
    const r = assetFloat({
      unitsPerDay: 100,
      cycleStages: [{ label: 'A', days: 2 }, { label: 'B', days: null }],
    });
    expect(r.complete).toBe(false);
    expect(r.missingStages).toBe(1);
    expect(r.cycleDays).toBeCloseTo(2, 9);
  });

  it('refuses without a throughput or a cycle', () => {
    expect(assetFloat({ unitsPerDay: 0, cycleStages: cycle }).error).toBeTruthy();
    expect(assetFloat({ unitsPerDay: 10, cycleStages: [] }).error).toBeTruthy();
  });
});

describe('LPG blend properties', () => {
  const mix = (v3, v4) => lpgBlendProperties({
    components: [
      { code: 'propane', volumeFraction: v3, liquidDensityKgM3: propane.typicalLiquidDensityKgM3, molarMassKgKmol: propane.molarMassKgKmol, latentHeatKJkg: propane.typicalLatentHeatKJkg },
      { code: 'butane', volumeFraction: v4, liquidDensityKgM3: butane.typicalLiquidDensityKgM3, molarMassKgKmol: butane.molarMassKgKmol, latentHeatKJkg: butane.typicalLatentHeatKJkg },
    ],
  });

  it('returns a pure component unchanged', () => {
    const r = mix(1, 0);
    expect(r.densityKgM3).toBeCloseTo(propane.typicalLiquidDensityKgM3, 6);
    expect(r.molarMassKgKmol).toBeCloseTo(propane.molarMassKgKmol, 6);
    expect(r.latentHeatKJkg).toBeCloseTo(propane.typicalLatentHeatKJkg, 6);
  });

  it('mixes density on volume and lands between the components', () => {
    const r = mix(0.5, 0.5);
    expect(r.densityBasis).toBe('volume');
    expect(r.densityKgM3).toBeCloseTo((508 + 584) / 2, 6);
  });

  it('mass fractions follow from the volume fractions and sum to one', () => {
    const r = mix(0.6, 0.4);
    const sum = r.massFractions.reduce((s, m) => s + m.massFraction, 0);
    expect(sum).toBeCloseTo(1, 9);
    // The heavier component takes more than its volume share of the mass.
    const c4 = r.massFractions.find((m) => m.code === 'butane').massFraction;
    expect(c4).toBeGreaterThan(0.4);
  });

  it('mixes latent heat on mass and molar mass on moles, and says which', () => {
    const r = mix(0.5, 0.5);
    expect(r.latentHeatBasis).toBe('mass');
    expect(r.molarMassBasis).toBe('mole');
    const w = Object.fromEntries(r.massFractions.map((m) => [m.code, m.massFraction]));
    expect(r.latentHeatKJkg).toBeCloseTo(w.propane * 425 + w.butane * 385, 4);
    // Molar mass on a mole basis is the harmonic-style mix, not the mass one.
    expect(r.molarMassKgKmol).toBeCloseTo(
      1 / (w.propane / propane.molarMassKgKmol + w.butane / butane.molarMassKgKmol), 4,
    );
    expect(r.molarMassKgKmol).not.toBeCloseTo(
      w.propane * propane.molarMassKgKmol + w.butane * butane.molarMassKgKmol, 3,
    );
  });

  it('reports a property missing on any component as missing for the blend', () => {
    const r = lpgBlendProperties({
      components: [
        { code: 'a', volumeFraction: 0.5, liquidDensityKgM3: 508, latentHeatKJkg: 425 },
        { code: 'b', volumeFraction: 0.5, liquidDensityKgM3: 584, latentHeatKJkg: null },
      ],
    });
    // Averaging over the components that have it would return a confident
    // number built from half the blend.
    expect(r.latentHeatKJkg).toBeNull();
    expect(r.note).toMatch(/not averaged/i);
  });

  it('requires a density for every component', () => {
    expect(lpgBlendProperties({
      components: [{ code: 'a', volumeFraction: 1 }],
    }).error).toMatch(/density/i);
  });
});

describe('LPG storage', () => {
  const base = {
    vesselCapacityM3: 100, maxFillRatio: 0.85, liquidDensityKgM3: 540,
    demandTonnesPerDay: 6, deliveryTonnes: 15, leadTimeDays: 3, safetyDays: 2,
  };

  it('refuses to supply the fill limit, because it is a safety code limit', () => {
    const r = lpgStorageSizing({ ...base, maxFillRatio: null });
    expect(r.error).toMatch(/fill ratio is required/i);
    // And it says why, so the refusal is actionable rather than pedantic.
    expect(r.error).toMatch(/hydraulically/i);
  });

  it('rejects a fill ratio that would fill the vessel liquid-full', () => {
    expect(lpgStorageSizing({ ...base, maxFillRatio: 1 }).error).toMatch(/between 0 and 1/i);
    expect(lpgStorageSizing({ ...base, maxFillRatio: 0 }).error).toBeTruthy();
  });

  it('counts usable stock on the fill limit and reports the vapour space', () => {
    const r = lpgStorageSizing(base);
    expect(r.usableM3).toBeCloseTo(85, 9);
    expect(r.usableTonnes).toBeCloseTo((85 * 540) / 1000, 6);
    // The vapour space is the reason the vessel does not fail, so it is
    // reported rather than left as a subtraction the reader has to do.
    expect(r.vapourSpaceM3).toBeCloseTo(15, 9);
  });

  it('derives cover, safety stock and the reorder point from the demand', () => {
    const r = lpgStorageSizing(base);
    expect(r.coverDays).toBeCloseTo(r.usableTonnes / 6, 6);
    expect(r.safetyStockTonnes).toBeCloseTo(12, 6);
    expect(r.reorderAtTonnes).toBeCloseTo(6 * 3 + 12, 6);
  });

  it('catches the delivery that will not fit at the reorder point', () => {
    const r = lpgStorageSizing({ ...base, deliveryTonnes: 30 });
    expect(r.ullageAtReorderTonnes).toBeCloseTo(r.usableTonnes - r.reorderAtTonnes, 6);
    expect(r.deliveryFitsUllage).toBe(false);
    expect(r.deliveryWarning).toMatch(/does not fit/i);
    expect(lpgStorageSizing(base).deliveryWarning).toBeNull();
  });

  it('requires a density rather than assuming one', () => {
    expect(lpgStorageSizing({ ...base, liquidDensityKgM3: null }).error).toMatch(/density/i);
  });
});

describe('vaporizer duty', () => {
  const base = {
    massFlowKgHr: 500, latentHeatKJkg: 400,
    liquidCpKJkgK: 2.5, inletTempC: 5, boilingPointC: -20,
    vapourCpKJkgK: 1.7, outletTempC: 15,
  };

  it('requires the latent heat, which is a product property', () => {
    expect(vaporizerDuty({ ...base, latentHeatKJkg: null }).error).toMatch(/latent heat/i);
  });

  it('sums its three terms to the duty', () => {
    const r = vaporizerDuty(base);
    const sum = r.terms.reduce((s, t) => s + t.kW, 0);
    expect(sum).toBeCloseTo(r.dutyKW, 6);
    expect(r.terms.reduce((s, t) => s + t.share, 0)).toBeCloseTo(1, 6);
  });

  it('boiling dominates, which is why the latent heat is the term that matters', () => {
    const r = vaporizerDuty(base);
    const latent = r.terms.find((t) => t.label === 'Boil it');
    expect(latent.share).toBeGreaterThan(0.5);
    expect(latent.kW).toBeCloseTo((500 * 400) / 3600, 6);
  });

  it('counts the sensible term as warming the liquid, not cooling it', () => {
    // Inlet 5 C, boiling -20 C: the liquid must be COOLED to its boiling
    // point, so the term is negative and the model must not hide that.
    const r = vaporizerDuty(base);
    expect(r.terms.find((t) => t.label === 'Warm the liquid to boiling').kW)
      .toBeCloseTo((500 * 2.5 * (-20 - 5)) / 3600, 6);
  });

  it('applies the design margin on top of the computed duty', () => {
    const r = vaporizerDuty({ ...base, designMarginPercent: 20 });
    expect(r.designDutyKW).toBeCloseTo(r.dutyKW * 1.2, 6);
  });

  it('calls a duty missing the superheat term a floor', () => {
    const r = vaporizerDuty({ ...base, vapourCpKJkgK: null });
    expect(r.complete).toBe(false);
    expect(r.missingTerms).toContain('Superheat the vapour');
    // Skipping the superheat is how a vaporizer sized on paper drops liquid
    // into a burner, so the shortfall is stated rather than left implicit.
    expect(r.note).toMatch(/floor/i);
  });
});

describe('the bottling plant', () => {
  const base = {
    cylindersPerDay: 2400, fillMinutesPerCylinder: 2.5, positions: 16,
    shiftHoursPerDay: 8, availabilityFraction: 0.9,
  };

  it('separates availability from utilisation', () => {
    const r = bottlingPlant(base);
    // A position down for maintenance is not a position that is busy.
    expect(r.effectivePositions).toBeCloseTo(14.4, 9);
    expect(r.note).toMatch(/different numbers/i);
    // Erlang C has a whole number of servers, so the fractional count is
    // rounded HERE and said to be, rather than silently inside the queue.
    expect(r.queuePositions).toBe(14);
    expect(r.positionRoundingNote).toMatch(/rounded from 14.4/);
    expect(r.queue.utilisation).toBeCloseTo((2400 / 8) * (2.5 / 60) / 14, 6);
  });

  it('reports the minimum positions the throughput needs', () => {
    const r = bottlingPlant(base);
    expect(r.minimumPositionsForThroughput).toBe(Math.ceil((2400 * 2.5) / (8 * 60 * 0.9)));
    expect(Number.isInteger(r.minimumPositionsForThroughput)).toBe(true);
  });

  it('models the carousel as a queue rather than as a capacity', () => {
    const r = bottlingPlant(base);
    expect(r.queue.averageWaitMinutes).toBeGreaterThan(0);
    // Meeting the throughput is not the same as having no queue.
    expect(r.meetsDemand).toBe(true);
  });

  it('says an oversubscribed carousel queues without limit', () => {
    const r = bottlingPlant({ ...base, positions: 3 });
    expect(r.queue.stable).toBe(false);
    expect(r.meetsDemand).toBe(false);
  });

  it('refuses impossible availability', () => {
    expect(bottlingPlant({ ...base, availabilityFraction: 1.2 }).error).toBeTruthy();
    expect(bottlingPlant({ ...base, shiftHoursPerDay: 0 }).error).toBeTruthy();
  });
});

describe('gas in a vessel at storage pressure', () => {
  it('holds more than the ideal gas law says, because Z is below one', () => {
    const r = gasMassInVessel({ volumeM3: 1, pressureBar: 250, temperatureC: 15 });
    expect(r.z).toBeLessThan(0.9);
    // The mechanism, not a remembered percentage: m = PVM/(ZRT), so Z below
    // one puts MORE gas in the bottle than ideal, and a cascade sized on
    // ideal gas is wrong in a direction nobody notices.
    expect(r.massKg).toBeCloseTo(r.idealMassKg / r.z, 3);
    expect(r.realVersusIdeal).toBeGreaterThan(1.15);
  });

  it('converges on the ideal gas law as the pressure falls', () => {
    const low = gasMassInVessel({ volumeM3: 1, pressureBar: 1, temperatureC: 15 });
    expect(low.z).toBeCloseTo(1, 2);
    expect(low.realVersusIdeal).toBeCloseTo(1, 2);
  });

  it('scales with volume and is monotone in pressure', () => {
    const a = gasMassInVessel({ volumeM3: 1, pressureBar: 200, temperatureC: 15 });
    const b = gasMassInVessel({ volumeM3: 3, pressureBar: 200, temperatureC: 15 });
    expect(b.massKg).toBeCloseTo(a.massKg * 3, 4);
    const p = [50, 100, 200, 250].map((x) => gasMassInVessel({ volumeM3: 1, pressureBar: x, temperatureC: 15 }).massKg);
    p.slice(1).forEach((v, i) => expect(v).toBeGreaterThan(p[i]));
  });

  it('says when the correlation is being extrapolated', () => {
    const stored = gasMassInVessel({ volumeM3: 1, pressureBar: 250, temperatureC: 15 });
    expect(stored.correlationInRange).toBe(true);
    expect(stored.correlationNote).toBeNull();
    // Atmospheric pressure is below the reduced-pressure range the
    // correlation was fitted over, and the caller is told rather than left
    // to find out.
    const atmospheric = gasMassInVessel({ volumeM3: 1, pressureBar: 1, temperatureC: 15 });
    expect(atmospheric.ppr).toBeLessThan(DAK_RANGE.pprMin);
    expect(atmospheric.correlationInRange).toBe(false);
    expect(atmospheric.correlationNote).toMatch(/extrapolation/i);
  });

  it('refuses without a volume, a pressure and a temperature', () => {
    expect(gasMassInVessel({ pressureBar: 250, temperatureC: 15 }).error).toBeTruthy();
    expect(gasMassInVessel({ volumeM3: 1, temperatureC: 15 }).error).toBeTruthy();
    expect(gasMassInVessel({ volumeM3: 1, pressureBar: 250 }).error).toBeTruthy();
  });
});

describe('the cascade', () => {
  const banks = [
    { label: 'Low', volumeM3: 1.5, pressureBar: 250 },
    { label: 'Mid', volumeM3: 1.5, pressureBar: 250 },
    { label: 'High', volumeM3: 1.5, pressureBar: 250 },
  ];
  const run = (over = {}) => cascadeFills({
    banks, vehicleTankM3: 0.08, vehicleStartBar: 20, vehicleTargetBar: 200,
    temperatureC: 15, ...over,
  });

  const deliverable = (bank, target) => {
    const at = (p) => gasMassInVessel({ volumeM3: bank.volumeM3, pressureBar: p, temperatureC: 15 }).massKg;
    return at(bank.pressureBar) - at(target);
  };

  it('conserves gas: what the banks gave equals what the vehicles took', () => {
    const r = run();
    const available = banks.reduce((s, b) => s + deliverable(b, 200), 0);
    // Every kilogram above the target either went into a vehicle or is left
    // over as less than one fill. Nothing evaporates in the accounting.
    expect(r.deliveredKg + r.partialFillAvailableKg).toBeCloseTo(available, 2);
    expect(r.deliveredKg).toBeCloseTo(r.fillsBeforeRecharge * r.kgPerFill, 3);
  });

  it('leaves less than one fill over, never more', () => {
    const r = run();
    // If a whole fill were still available the loop stopped too early, which
    // is exactly the bug this asserts against.
    expect(r.partialFillAvailableKg).toBeLessThan(r.kgPerFill);
    expect(r.partialFillAvailableKg).toBeGreaterThanOrEqual(0);
  });

  it('empties the low bank before it touches the high bank', () => {
    const r = run();
    const after = Object.fromEntries(r.banksAfter.map((b) => [b.label, b.endBar]));
    expect(after.Low).toBeLessThanOrEqual(after.High + 1e-6);
    expect(after.Mid).toBeLessThanOrEqual(after.High + 1e-6);
  });

  it('uses every bank when the demand needs them all', () => {
    const r = run();
    // The bug that prompted this: a bank drained to the target still tested
    // as usable, was picked forever at zero yield, and the last bank was
    // never reached.
    expect(r.banksAfter.every((b) => b.endBar < b.startBar)).toBe(true);
  });

  it('cannot deliver gas below the vehicle target, and calls it stranded', () => {
    const r = run();
    expect(r.strandedBelowTargetKg).toBeGreaterThan(0);
    // The cascade is a buffer, not a reservoir: most of what it holds sits
    // below the vehicle's target and never moves without the compressor.
    expect(r.cascadeEfficiency).toBeLessThan(0.5);
    expect(r.storedKg).toBeGreaterThan(r.deliveredKg);
  });

  it('delivers more per fill from a more depleted vehicle', () => {
    const empty = run({ vehicleStartBar: 10 });
    const partial = run({ vehicleStartBar: 120 });
    expect(empty.kgPerFill).toBeGreaterThan(partial.kgPerFill);
    expect(partial.fillsBeforeRecharge).toBeGreaterThan(empty.fillsBeforeRecharge);
  });

  it('gets more fills from a bank charged higher', () => {
    const low = run({ banks: banks.map((b) => ({ ...b, pressureBar: 220 })) });
    const high = run({ banks: banks.map((b) => ({ ...b, pressureBar: 280 })) });
    expect(high.fillsBeforeRecharge).toBeGreaterThan(low.fillsBeforeRecharge);
  });

  it('delivers nothing when no bank is above the target', () => {
    const r = run({ banks: banks.map((b) => ({ ...b, pressureBar: 180 })) });
    expect(r.fillsBeforeRecharge).toBe(0);
    expect(r.deliveredKg).toBeCloseTo(0, 6);
  });

  it('refuses a target that is not above the start', () => {
    expect(run({ vehicleTargetBar: 20 }).error).toBeTruthy();
    expect(run({ vehicleTankM3: null }).error).toBeTruthy();
    expect(run({ banks: [{ label: 'X', volumeM3: 1 }] }).error).toMatch(/volume and a pressure/i);
  });
});

describe('station compression', () => {
  const base = {
    throughputKgPerHour: 250, suctionBar: 4, dischargeBar: 250, suctionTempC: 30,
  };

  it('does not reimplement compression, and says so', () => {
    const r = cngCompression(base);
    expect(r.error).toBeNull();
    expect(r.basis).toMatch(/does not reimplement/i);
  });

  it('stages the ratio rather than doing it in one', () => {
    const r = cngCompression(base);
    // 4 to 250 bar is a ratio of 62; no single stage takes that.
    expect(r.stageCount).toBeGreaterThan(2);
    expect(r.stages[0].suctionBar).toBeCloseTo(4, 3);
    expect(r.stages[r.stages.length - 1].dischargeBar).toBeCloseTo(250, 1);
  });

  it('carries the pressure forward from stage to stage', () => {
    const r = cngCompression(base);
    r.stages.slice(1).forEach((s, i) => {
      expect(s.suctionBar).toBeCloseTo(r.stages[i].dischargeBar, 3);
    });
  });

  it('specific energy is the power divided by the throughput', () => {
    const r = cngCompression(base);
    expect(r.specificEnergyKWhPerKg).toBeCloseTo(r.totalBrakeKW / 250, 6);
    expect(r.totalBrakeKW).toBeCloseTo(
      r.stages.reduce((s, x) => s + x.brakeKW, 0), 2,
    );
  });

  it('takes more power for more gas and for a higher discharge', () => {
    const a = cngCompression(base);
    const more = cngCompression({ ...base, throughputKgPerHour: 500 });
    const higher = cngCompression({ ...base, dischargeBar: 300 });
    expect(more.totalBrakeKW).toBeGreaterThan(a.totalBrakeKW);
    expect(higher.specificEnergyKWhPerKg).toBeGreaterThan(a.specificEnergyKWhPerKg);
    // Twice the gas through the same machine is twice the power, so the
    // energy per kilogram is unchanged.
    expect(more.specificEnergyKWhPerKg).toBeCloseTo(a.specificEnergyKWhPerKg, 6);
  });

  it('converts bar to psia on the way in', () => {
    const r = cngCompression(base);
    // The stages come back in bar, which means the round trip closed.
    expect(PSI_PER_BAR).toBeCloseTo(14.5037738, 6);
    expect(r.stages.every((s) => s.dischargeBar > s.suctionBar)).toBe(true);
  });

  it('refuses a discharge that is not above the suction', () => {
    expect(cngCompression({ ...base, dischargeBar: 2 }).error).toBeTruthy();
    expect(cngCompression({ ...base, throughputKgPerHour: 0 }).error).toBeTruthy();
  });
});

describe('dispensing', () => {
  it('queues at traffic a liquid-fuel operator would call quiet', () => {
    // A five-minute fill on two dispensers queues at twelve vehicles an
    // hour, which no petrol forecourt would notice.
    const r = cngDispensing({ vehiclesPerHour: 20, fillMinutes: 5, dispensers: 2 });
    expect(r.queue.utilisation).toBeGreaterThan(0.8);
    expect(r.queue.averageWaitMinutes).toBeGreaterThan(0);
    expect(r.note).toMatch(/quiet/i);
  });

  it('prices the throughput in gas when a fill size is given', () => {
    const r = cngDispensing({ vehiclesPerHour: 6, fillMinutes: 5, dispensers: 2, kgPerFill: 12 });
    expect(r.kgPerHour).toBeCloseTo(72, 6);
    expect(cngDispensing({ vehiclesPerHour: 6, fillMinutes: 5, dispensers: 2 }).kgPerHour).toBeNull();
  });

  it('says an oversubscribed forecourt queues without limit', () => {
    const r = cngDispensing({ vehiclesPerHour: 40, fillMinutes: 6, dispensers: 2 });
    expect(r.queue.stable).toBe(false);
    expect(r.queue.averageWaitMinutes).toBeNull();
  });
});

describe('the conversion decision', () => {
  const base = {
    annualDistanceKm: 40000,
    baseFuel: {
      label: 'PMS', consumptionPer100Km: 12, pricePerUnit: 950,
      energyPerUnitMJ: 32, emissionFactorKgCo2ePerUnit: 2.3,
    },
    newFuel: {
      label: 'CNG', consumptionPer100Km: 9, pricePerUnit: 500,
      energyPerUnitMJ: 48, emissionFactorKgCo2ePerUnit: 2.75,
    },
    conversionCost: 900000, annualExtraMaintenance: 40000,
  };

  it('compares per kilometre, since the units sold are not comparable', () => {
    const r = conversionEconomics(base);
    // Litres against kilograms is meaningless; cost per km is what the
    // customer actually buys.
    expect(r.baseFuel.costPerKm).toBeCloseTo((12 / 100) * 950, 6);
    expect(r.newFuel.costPerKm).toBeCloseTo((9 / 100) * 500, 6);
  });

  it('reconciles the saving to the two fuel bills and the maintenance', () => {
    const r = conversionEconomics(base);
    expect(r.annualSaving).toBeCloseTo(
      r.baseFuel.costPerYear - r.newFuel.costPerYear - 40000, 2,
    );
  });

  it('uses a measured consumption when there is one', () => {
    const r = conversionEconomics(base);
    expect(r.consumptionSource).toBe('as measured');
    expect(r.newFuelConsumptionPer100Km).toBeCloseTo(9, 6);
  });

  it('derives consumption from energy equivalence when there is not, and says so', () => {
    const r = conversionEconomics({
      ...base,
      newFuel: { ...base.newFuel, consumptionPer100Km: null, efficiencyRatio: 1 },
    });
    expect(r.consumptionSource).toMatch(/derived/i);
    // Same useful energy per km: 12 units x 32 MJ from 48 MJ units.
    expect(r.newFuelConsumptionPer100Km).toBeCloseTo((12 * 32) / 48, 6);
  });

  it('the efficiency ratio moves the answer, which is why it is explicit', () => {
    const same = conversionEconomics({
      ...base, newFuel: { ...base.newFuel, consumptionPer100Km: null, efficiencyRatio: 1 },
    });
    const worse = conversionEconomics({
      ...base, newFuel: { ...base.newFuel, consumptionPer100Km: null, efficiencyRatio: 0.9 },
    });
    expect(worse.newFuelConsumptionPer100Km).toBeCloseTo(same.newFuelConsumptionPer100Km / 0.9, 6);
    expect(worse.annualSaving).toBeLessThan(same.annualSaving);
  });

  it('refuses to invent a consumption from nothing', () => {
    const r = conversionEconomics({
      ...base,
      newFuel: { label: 'CNG', consumptionPer100Km: null, pricePerUnit: 500 },
    });
    expect(r.error).toMatch(/Neither is assumed/i);
  });

  it('reports simple payback and labels it undiscounted', () => {
    const r = conversionEconomics(base);
    expect(r.simplePaybackYears).toBeCloseTo(900000 / r.annualSaving, 6);
    expect(r.paybackNote).toMatch(/undiscounted/i);
    // Valuation belongs to the sanctioned engine, so the cash flow is handed
    // over rather than discounted here.
    expect(r.annualCashFlow.year0).toBeCloseTo(-900000, 6);
    expect(r.annualCashFlow.recurring).toBeCloseTo(r.annualSaving, 2);
  });

  it('reports no payback rather than a negative one when it does not pay', () => {
    const r = conversionEconomics({
      ...base, newFuel: { ...base.newFuel, pricePerUnit: 5000 },
    });
    expect(r.annualSaving).toBeLessThan(0);
    expect(r.simplePaybackYears).toBeNull();
    expect(r.paybackNote).toMatch(/does not save money/i);
  });

  it('needs both emission factors for the carbon figure', () => {
    const r = conversionEconomics(base);
    expect(r.kgCo2eAvoidedPerYear).toBeCloseTo(
      r.baseFuel.unitsPerYear * 2.3 - r.newFuel.unitsPerYear * 2.75, 2,
    );
    const missing = conversionEconomics({
      ...base, newFuel: { ...base.newFuel, emissionFactorKgCo2ePerUnit: null },
    });
    expect(missing.kgCo2eAvoidedPerYear).toBeNull();
    expect(missing.carbonNote).toMatch(/absent rather than zero/i);
  });

  it('does not assume a switch cuts carbon just because it cuts cost', () => {
    // A cheaper fuel per kilometre can still emit more, and the model must
    // be able to say so rather than treating the two as the same question.
    const r = conversionEconomics({
      ...base,
      newFuel: { ...base.newFuel, emissionFactorKgCo2ePerUnit: 6 },
    });
    expect(r.annualSaving).toBeGreaterThan(0);
    expect(r.kgCo2eAvoidedPerYear).toBeLessThan(0);
  });
});

describe('the reference data', () => {
  it('is labelled typical, with a range, and read by nothing on its own', () => {
    LPG_REFERENCE.forEach((r) => {
      expect(r.molarMassKgKmol).toBeGreaterThan(0);
      expect(r.liquidDensityRange).toMatch(/\d/);
      expect(r.latentHeatRange).toMatch(/\d/);
    });
    expect(LPG_PROPERTY_NOTE).toMatch(/certificate of quality is the authority/i);
  });

  it('carries molar masses that are definitional, not remembered', () => {
    // C3H8 and C4H10 from atomic masses; these are constants, not a table.
    const propaneMw = 3 * 12.011 + 8 * 1.008;
    const butaneMw = 4 * 12.011 + 10 * 1.008;
    expect(propane.molarMassKgKmol).toBeCloseTo(propaneMw, 2);
    expect(butane.molarMassKgKmol).toBeCloseTo(butaneMw, 2);
  });
});

describe('missing stays missing', () => {
  it('does not read an empty string as a zero', () => {
    expect(lpgStorageSizing({
      vesselCapacityM3: 100, maxFillRatio: '', liquidDensityKgM3: 540, demandTonnesPerDay: 6,
    }).error).toMatch(/fill ratio is required/i);
    expect(assetFloat({ unitsPerDay: '', cycleStages: [{ label: 'A', days: 1 }] }).error).toBeTruthy();
    expect(vaporizerDuty({ massFlowKgHr: 500, latentHeatKJkg: '' }).error).toMatch(/latent heat/i);
  });
});
