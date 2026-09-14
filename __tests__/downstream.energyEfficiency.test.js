/**
 * Energy and utilities efficiency (DS8).
 *
 * Combustion and pinch are both computed from first principles, so most of
 * these are identities: atoms balance, energy balances, the cascade closes,
 * an efficiency is a hundred minus its losses. The pinch case at the bottom
 * is the exception and is labelled as a literature anchor rather than an
 * identity, because its value is that the answer can be checked against a
 * published source.
 */
import {
  combustionStoichiometry, excessAirFromFlueOxygen, stackLossEfficiency,
  excessAirSaving, steamTrapLoss, condensateReturnValue, energyIntensity,
  pinchTargets, compositeCurve, priceSaving,
  FUEL_REFERENCE, FUEL_REFERENCE_NOTE, PROPERTY_REFERENCE,
  HEATING_VALUE_BASIS, O2_MOLE_FRACTION_DRY_AIR,
} from '../engines/downstream/energyEfficiency.js';

const ref = (code) => FUEL_REFERENCE.find((f) => f.code === code);
const comp = (code, moleFraction) => {
  const r = ref(code);
  return {
    ...r, moleFraction, lhvMJKmol: r.typicalLhvMJKmol, hhvMJKmol: r.typicalHhvMJKmol,
  };
};

const naturalGas = () => combustionStoichiometry({
  components: [comp('CH4', 0.9), comp('C2H6', 0.1)],
});

describe('combustion stoichiometry', () => {
  it('balances oxygen atom by atom, with no chart involved', () => {
    const st = naturalGas();
    // CH4 needs 2 O2, C2H6 needs 3.5. That is c + h/4 and nothing else.
    expect(st.o2PerKmolFuel).toBeCloseTo(0.9 * 2 + 0.1 * 3.5, 9);
    expect(st.stoichAirPerKmolFuel).toBeCloseTo(st.o2PerKmolFuel / O2_MOLE_FRACTION_DRY_AIR, 8);
  });

  it('balances carbon and hydrogen into the products', () => {
    const st = naturalGas();
    expect(st.products.co2PerKmolFuel).toBeCloseTo(0.9 * 1 + 0.1 * 2, 9);
    expect(st.products.h2oPerKmolFuel).toBeCloseTo(0.9 * 2 + 0.1 * 3, 9);
  });

  it('lands on the air-fuel ratio natural gas actually has', () => {
    // ~17 kg of air per kg of gas. This is a derived number, not a target:
    // it falls out of the atom balance and the molar masses.
    expect(naturalGas().stoichAirKgPerKgFuel).toBeGreaterThan(16);
    expect(naturalGas().stoichAirKgPerKgFuel).toBeLessThan(18);
  });

  it('carries fuel inerts through to the flue gas', () => {
    const clean = naturalGas();
    const diluted = combustionStoichiometry({
      components: [comp('CH4', 0.7), comp('C2H6', 0.1), comp('N2', 0.2)],
    });
    // Less fuel per kilomole means less oxygen, but the nitrogen still has
    // to be heated up the stack, which is the point of tracking it.
    expect(diluted.o2PerKmolFuel).toBeLessThan(clean.o2PerKmolFuel);
    expect(diluted.products.n2PerKmolFuel).toBeGreaterThan(
      diluted.stoichAirPerKmolFuel * (1 - O2_MOLE_FRACTION_DRY_AIR) - 1e-9,
    );
  });

  it('normalises a composition that does not sum to one', () => {
    const a = combustionStoichiometry({ components: [comp('CH4', 90), comp('C2H6', 10)] });
    expect(a.o2PerKmolFuel).toBeCloseTo(naturalGas().o2PerKmolFuel, 9);
  });

  it('makes a mixture heating value missing if any component lacks one', () => {
    const st = combustionStoichiometry({
      components: [comp('CH4', 0.9), { ...ref('C2H6'), moleFraction: 0.1, lhvMJKmol: null }],
    });
    expect(st.lhvMJPerKmolFuel).toBeNull();
    expect(st.heatingValueNote).toMatch(/missing, not partial/i);
  });

  it('refuses an empty or unlabelled composition', () => {
    expect(combustionStoichiometry({ components: [] }).error).toBeTruthy();
    expect(combustionStoichiometry({
      components: [{ ...ref('CH4'), moleFraction: null }],
    }).error).toMatch(/mole fraction/i);
  });
});

describe('excess air from the stack oxygen', () => {
  const st = naturalGas();

  it('lands where a combustion engineer expects it', () => {
    // Three percent oxygen is about fifteen percent excess air on natural
    // gas. The relation is solved here, not looked up, and it agrees.
    const r = excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: 3 });
    expect(r.excessAirPercent).toBeGreaterThan(13);
    expect(r.excessAirPercent).toBeLessThan(17);
  });

  it('reproduces the oxygen it was given, which is the real check', () => {
    [1, 2, 3, 5, 8].forEach((o2) => {
      const r = excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: o2 });
      const unburntO2 = r.excessAirFraction * st.o2PerKmolFuel;
      // Round trip: the excess air found must put exactly that oxygen back
      // into the dry flue gas it also computed.
      expect((unburntO2 / r.dryFlueGasPerKmolFuel) * 100).toBeCloseTo(o2, 6);
    });
  });

  it('gives zero excess air at zero oxygen, and rises monotonically', () => {
    expect(excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: 0 }).excessAirFraction)
      .toBeCloseTo(0, 12);
    const e = [1, 3, 6, 9].map((o) => excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: o }).excessAirFraction);
    e.slice(1).forEach((v, i) => expect(v).toBeGreaterThan(e[i]));
  });

  it('says an oxygen reading above air is not reachable', () => {
    expect(excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: 21 }).error).toBeTruthy();
    expect(excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: -1 }).error).toBeTruthy();
  });

  it('states that it cannot see carbon monoxide', () => {
    const r = excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: 3 });
    expect(r.assumption).toMatch(/carbon monoxide/i);
  });
});

describe('stack-loss efficiency', () => {
  const st = naturalGas();
  const ea = excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: 3 });
  const base = {
    stoichiometry: st, excessAir: ea, stackTempC: 200, combustionAirTempC: 25,
    flueGasCpKJkgK: 1.10, waterVapourCpKJkgK: 1.95, waterLatentHeatKJkg: 2442,
    radiationLossPercent: 1.5,
  };

  it('is a hundred minus its losses, and says where they went', () => {
    const r = stackLossEfficiency(base);
    const sum = r.losses.reduce((s, l) => s + l.percent, 0);
    expect(sum).toBeCloseTo(r.totalLossPercent, 6);
    expect(r.efficiencyPercent).toBeCloseTo(100 - sum, 6);
    // The indirect method exists to say where, so every loss is separate.
    expect(r.losses.map((l) => l.label)).toEqual(expect.arrayContaining([
      'Dry flue gas', 'Moisture from hydrogen', 'Radiation and convection',
    ]));
  });

  it('refuses the radiation loss rather than defaulting it', () => {
    const r = stackLossEfficiency({ ...base, radiationLossPercent: null });
    expect(r.error).toMatch(/radiation and convection loss is required/i);
    expect(r.error).toMatch(/published chart/i);
  });

  it('is several points lower on HHV than on LHV for the same heater', () => {
    const lhv = stackLossEfficiency({ ...base, basis: HEATING_VALUE_BASIS.LHV });
    const hhv = stackLossEfficiency({ ...base, basis: HEATING_VALUE_BASIS.HHV });
    // The single most common error in this field is quoting one as the
    // other. On natural gas the gap is close to ten points.
    expect(lhv.efficiencyPercent - hhv.efficiencyPercent).toBeGreaterThan(6);
    expect(lhv.comparisonWarning).toMatch(/LHV/);
    expect(hhv.comparisonWarning).toMatch(/HHV/);
  });

  it('treats the water differently on each basis, and explains why', () => {
    const lhv = stackLossEfficiency({ ...base, basis: HEATING_VALUE_BASIS.LHV });
    const hhv = stackLossEfficiency({ ...base, basis: HEATING_VALUE_BASIS.HHV });
    const moisture = (r) => r.losses.find((l) => l.label === 'Moisture from hydrogen').percent;
    expect(moisture(hhv)).toBeGreaterThan(moisture(lhv));
    expect(lhv.moistureBasisNote).toMatch(/never counted the latent heat/i);
    expect(hhv.moistureBasisNote).toMatch(/counted it as available/i);
  });

  it('loses more up a hotter stack and with more excess air', () => {
    const cool = stackLossEfficiency({ ...base, stackTempC: 150 });
    const hot = stackLossEfficiency({ ...base, stackTempC: 300 });
    expect(hot.efficiencyPercent).toBeLessThan(cool.efficiencyPercent);
    const lean = stackLossEfficiency({
      ...base, excessAir: excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: 1 }),
    });
    const rich = stackLossEfficiency({
      ...base, excessAir: excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: 8 }),
    });
    expect(rich.efficiencyPercent).toBeLessThan(lean.efficiencyPercent);
  });

  it('loses nothing up the stack when the stack is at the air temperature', () => {
    const r = stackLossEfficiency({ ...base, stackTempC: 25, referenceTempC: 25 });
    expect(r.losses.find((l) => l.label === 'Dry flue gas').percent).toBeCloseTo(0, 9);
    expect(r.losses.find((l) => l.label === 'Moisture from hydrogen').percent).toBeCloseTo(0, 9);
  });

  it('needs the latent heat only on the HHV basis', () => {
    expect(stackLossEfficiency({
      ...base, basis: HEATING_VALUE_BASIS.LHV, waterLatentHeatKJkg: null,
    }).error).toBeNull();
    expect(stackLossEfficiency({
      ...base, basis: HEATING_VALUE_BASIS.HHV, waterLatentHeatKJkg: null,
    }).error).toMatch(/latent heat/i);
  });
});

describe('what tuning the excess air is worth', () => {
  const st = naturalGas();
  const at = (o2, basis = HEATING_VALUE_BASIS.LHV) => stackLossEfficiency({
    stoichiometry: st, excessAir: excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: o2 }),
    stackTempC: 200, combustionAirTempC: 25, basis,
    flueGasCpKJkgK: 1.10, waterVapourCpKJkgK: 1.95, waterLatentHeatKJkg: 2442,
    radiationLossPercent: 1.5,
  });

  it('is the ratio of the efficiencies, not their difference', () => {
    const current = at(8);
    const target = at(3);
    const r = excessAirSaving({
      current, target, minimumSafeO2Percent: 2, targetO2Percent: 3,
    });
    // Same duty means fuel scales inversely with efficiency, so the saving
    // is the gap divided by the TARGET efficiency.
    expect(r.fuelSavingFraction).toBeCloseTo(
      1 - current.efficiencyPercent / target.efficiencyPercent, 8,
    );
    // The shortcut divides that gap by a hundred instead. Since the target
    // efficiency is below a hundred, the shortcut UNDERSTATES the saving -
    // the safer error of the two, and still an error, because it is how a
    // tuning project gets turned down on a business case that was wrong.
    const difference = (target.efficiencyPercent - current.efficiencyPercent) / 100;
    expect(r.fuelSavingFraction).toBeGreaterThan(difference);
    expect(r.fuelSavingFraction).toBeCloseTo(difference * (100 / target.efficiencyPercent), 8);
    expect(r.method).toMatch(/understates/i);
  });

  it('scales an annual energy figure by the saving', () => {
    const r = excessAirSaving({
      current: at(8), target: at(3), minimumSafeO2Percent: 2,
      targetO2Percent: 3, annualFuelEnergyGJ: 500000,
    });
    expect(r.annualEnergySavedGJ).toBeCloseTo(500000 * r.fuelSavingFraction, 3);
  });

  it('refuses to recommend a setpoint below the declared safe floor', () => {
    const r = excessAirSaving({
      current: at(8), target: at(0.5), minimumSafeO2Percent: 2, targetO2Percent: 0.5,
    });
    // Below some excess air a burner makes carbon monoxide. The app will
    // not tune a heater into that on its own judgement.
    expect(r.belowSafeFloor).toBe(true);
    expect(r.error).toMatch(/below the 2 percent declared safe/i);
  });

  it('requires the safe floor to be declared at all', () => {
    expect(excessAirSaving({
      current: at(8), target: at(3), targetO2Percent: 3,
    }).error).toMatch(/minimum safe stack oxygen is required/i);
  });

  it('refuses to compare an LHV efficiency with an HHV one', () => {
    const r = excessAirSaving({
      current: at(8, HEATING_VALUE_BASIS.LHV),
      target: at(3, HEATING_VALUE_BASIS.HHV),
      minimumSafeO2Percent: 2, targetO2Percent: 3,
    });
    expect(r.error).toMatch(/different bases/i);
  });
});

describe('steam trap loss', () => {
  const base = {
    orificeDiameterMm: 3, upstreamPressureBarA: 11, dischargeCoefficient: 0.7,
    steamDensityKgM3: 5.6, hoursPerYear: 8760,
  };

  it('requires a discharge coefficient rather than defaulting one', () => {
    expect(steamTrapLoss({ ...base, dischargeCoefficient: null }).error)
      .toMatch(/discharge coefficient/i);
    expect(steamTrapLoss({ ...base, dischargeCoefficient: 1.5 }).error).toBeTruthy();
  });

  it('scales with the orifice area, not its diameter', () => {
    const a = steamTrapLoss({ ...base, orificeDiameterMm: 3 });
    const b = steamTrapLoss({ ...base, orificeDiameterMm: 6 });
    // Twice the hole is four times the leak.
    expect(b.kgPerHour / a.kgPerHour).toBeCloseTo(4, 6);
  });

  it('is choked, so it depends on the upstream pressure alone', () => {
    const r = steamTrapLoss(base);
    expect(r.choked).toBe(true);
    expect(r.chokedNote).toMatch(/not on what is downstream/i);
    // Doubling the pressure at fixed density raises the flow by root two.
    const hi = steamTrapLoss({ ...base, upstreamPressureBarA: 22 });
    expect(hi.kgPerHour / r.kgPerHour).toBeCloseTo(Math.SQRT2, 6);
  });

  it('converts an hourly leak into an annual tonnage', () => {
    const r = steamTrapLoss(base);
    expect(r.tonnesPerYear).toBeCloseTo((r.kgPerHour * 8760) / 1000, 3);
  });

  it('prices it and carbons it only when told how', () => {
    const bare = steamTrapLoss(base);
    expect(bare.annualCost).toBeNull();
    expect(bare.annualTonnesCo2e).toBeNull();
    expect(bare.carbonNote).toMatch(/absent rather than zero/i);
    const priced = steamTrapLoss({
      ...base, steamCostPerTonne: 25, steamEnergyMJPerTonne: 2700,
      boilerEfficiencyFraction: 0.85, emissionFactorKgCo2ePerGJ: 56,
    });
    expect(priced.annualCost).toBeCloseTo(priced.tonnesPerYear * 25, 2);
    expect(priced.annualFuelGJ).toBeCloseTo((priced.tonnesPerYear * 2700) / 1000 / 0.85, 3);
    expect(priced.annualTonnesCo2e).toBeCloseTo((priced.annualFuelGJ * 56) / 1000, 4);
  });
});

describe('condensate return', () => {
  const base = {
    steamTonnesPerHour: 20, currentReturnFraction: 0.4, targetReturnFraction: 0.7,
    condensateTempC: 90, makeupTempC: 25, boilerEfficiencyFraction: 0.85,
    fuelCostPerGJ: 8, waterCostPerTonne: 0.6, treatmentCostPerTonne: 1.2,
    emissionFactorKgCo2ePerGJ: 56, hoursPerYear: 8760,
  };

  it('counts the extra condensate the improvement actually returns', () => {
    const r = condensateReturnValue(base);
    expect(r.extraCondensateTonnesPerYear).toBeCloseTo(20 * 0.3 * 8760, 3);
  });

  it('divides the heat by the boiler efficiency to get fuel', () => {
    const r = condensateReturnValue(base);
    const heatGJ = (r.extraCondensateTonnesPerYear * 4.19 * (90 - 25)) / 1000;
    expect(r.energySavedGJPerYear).toBeCloseTo(heatGJ / 0.85, 2);
  });

  it('requires the boiler efficiency, since the fuel saved depends on it', () => {
    expect(condensateReturnValue({ ...base, boilerEfficiencyFraction: null }).error)
      .toMatch(/boiler efficiency/i);
    expect(condensateReturnValue({ ...base, boilerEfficiencyFraction: 1.4 }).error).toBeTruthy();
  });

  it('counts the treatment as well as the fuel and the water', () => {
    const r = condensateReturnValue(base);
    expect(r.complete).toBe(true);
    expect(r.components.map((c) => c.label)).toEqual(expect.arrayContaining([
      'Treatment not repeated',
    ]));
    expect(r.annualValue).toBeCloseTo(
      r.components.reduce((s, c) => s + c.amount, 0), 2,
    );
  });

  it('calls the value a floor when the treatment is not priced', () => {
    const r = condensateReturnValue({ ...base, treatmentCostPerTonne: null });
    expect(r.complete).toBe(false);
    // It is the term routinely left out of these business cases.
    expect(r.valueNote).toMatch(/usually left out/i);
  });

  it('sums to nothing when nothing changes', () => {
    const r = condensateReturnValue({ ...base, targetReturnFraction: 0.4 });
    expect(r.extraCondensateTonnesPerYear).toBeCloseTo(0, 9);
    expect(r.energySavedGJPerYear).toBeCloseTo(0, 9);
  });
});

describe('energy intensity', () => {
  const base = {
    energyStreams: [
      { label: 'Fuel gas', energyGJ: 900000 },
      { label: 'Purchased power', energyGJ: 120000 },
      { label: 'Imported steam', energyGJ: 60000 },
    ],
    throughputTonnes: 1500000,
  };

  it('is energy in over throughput, and the shares sum to one', () => {
    const r = energyIntensity(base);
    expect(r.totalEnergyGJ).toBeCloseTo(1080000, 3);
    expect(r.intensityMJPerTonne).toBeCloseTo((1080000 * 1000) / 1500000, 4);
    expect(r.streams.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 6);
  });

  it('says plainly that it is not EII', () => {
    // EII is proprietary with its own standard-energy methodology.
    // Computing something similar and calling it EII would be wrong in a
    // way that matters commercially.
    expect(energyIntensity(base).disclaimer).toMatch(/NOT the Solomon Energy Intensity Index/i);
  });

  it('compares only against a peer figure the user supplied', () => {
    expect(energyIntensity(base).versusPeer).toBeNull();
    const r = energyIntensity({ ...base, peerIntensityMJPerTonne: 600 });
    expect(r.versusPeer).toBeCloseTo(r.intensityMJPerTonne / 600, 6);
    expect(r.gapMJPerTonne).toBeCloseTo(r.intensityMJPerTonne - 600, 4);
  });

  it('names a stream it could not count', () => {
    const r = energyIntensity({
      ...base, energyStreams: [...base.energyStreams, { label: 'Flare recovery', energyGJ: null }],
    });
    expect(r.complete).toBe(false);
    expect(r.missingStreams).toContain('Flare recovery');
  });

  it('refuses without a throughput', () => {
    expect(energyIntensity({ ...base, throughputTonnes: 0 }).error).toBeTruthy();
  });
});

describe('pinch targeting', () => {
  const streams = [
    { label: 'H1', supplyC: 150, targetC: 60, cpKWperK: 2.0 },
    { label: 'H2', supplyC: 90, targetC: 60, cpKWperK: 8.0 },
    { label: 'C1', supplyC: 20, targetC: 125, cpKWperK: 2.5 },
    { label: 'C2', supplyC: 25, targetC: 100, cpKWperK: 3.0 },
  ];
  const run = (dt) => pinchTargets({ streams, minimumApproachC: dt });

  it('closes the energy balance exactly, at every approach', () => {
    // Hot utility plus hot streams equals cold utility plus cold streams.
    // Nothing about the algorithm is allowed to break this.
    [0, 5, 10, 20, 30, 50].forEach((dt) => {
      const r = run(dt);
      expect(r.balanceCheck).toBeCloseTo(0, 6);
      expect(r.hotUtilityKW + r.totalHotStreamDutyKW)
        .toBeCloseTo(r.coldUtilityKW + r.totalColdStreamDutyKW, 6);
    });
  });

  it('needs more utility as the approach widens, never less', () => {
    const q = [0, 10, 20, 30, 40].map((dt) => run(dt).hotUtilityKW);
    q.slice(1).forEach((v, i) => expect(v).toBeGreaterThanOrEqual(q[i] - 1e-9));
    const c = [0, 10, 20, 30, 40].map((dt) => run(dt).coldUtilityKW);
    c.slice(1).forEach((v, i) => expect(v).toBeGreaterThanOrEqual(c[i] - 1e-9));
  });

  it('keeps the utilities a fixed distance apart, because the streams are fixed', () => {
    // Qh - Qc is the net stream imbalance and does not depend on dTmin.
    const gap = run(0).hotUtilityKW - run(0).coldUtilityKW;
    [10, 25, 40].forEach((dt) => {
      expect(run(dt).hotUtilityKW - run(dt).coldUtilityKW).toBeCloseTo(gap, 6);
    });
  });

  it('puts the pinch a full approach apart on the two sides', () => {
    const r = run(20);
    expect(r.pinchHotC - r.pinchColdC).toBeCloseTo(20, 9);
  });

  it('never lets the cascade go negative once the hot utility is added', () => {
    const r = run(20);
    r.grandComposite.forEach((p) => expect(p.heatFlowKW).toBeGreaterThan(-1e-6));
    // And it touches zero exactly once at the pinch, which is what makes it
    // the constraint.
    expect(r.grandComposite.some((p) => Math.abs(p.heatFlowKW) < 1e-6)).toBe(true);
  });

  it('LITERATURE ANCHOR: the published four-stream problem at a 20 degree approach', () => {
    // The one test here that is a remembered answer rather than an identity.
    // Its value is that it is independently checkable against the standard
    // worked example of the Problem Table Algorithm.
    const r = run(20);
    expect(r.hotUtilityKW).toBeCloseTo(107.5, 6);
    expect(r.coldUtilityKW).toBeCloseTo(40, 6);
    expect(r.pinchHotC).toBeCloseTo(90, 6);
    expect(r.pinchColdC).toBeCloseTo(70, 6);
  });

  it('reports a threshold problem as one rather than inventing a pinch', () => {
    // Far more hot than cold, spanning high temperatures: no hot utility is
    // needed at all, and there is no pinch to speak of.
    const r = pinchTargets({
      streams: [
        { label: 'H', supplyC: 200, targetC: 50, cpKWperK: 10 },
        { label: 'C', supplyC: 30, targetC: 60, cpKWperK: 1 },
      ],
      minimumApproachC: 10,
    });
    expect(r.hotUtilityKW).toBeCloseTo(0, 9);
    expect(r.thresholdProblem).toBe(true);
  });

  it('needs only cooling when there are no cold streams', () => {
    const r = pinchTargets({
      streams: [{ label: 'H', supplyC: 200, targetC: 50, cpKWperK: 4 }],
      minimumApproachC: 10,
    });
    expect(r.hotUtilityKW).toBeCloseTo(0, 9);
    expect(r.coldUtilityKW).toBeCloseTo(4 * 150, 6);
  });

  it('needs only heating when there are no hot streams', () => {
    const r = pinchTargets({
      streams: [{ label: 'C', supplyC: 20, targetC: 180, cpKWperK: 3 }],
      minimumApproachC: 10,
    });
    expect(r.hotUtilityKW).toBeCloseTo(3 * 160, 6);
    expect(r.coldUtilityKW).toBeCloseTo(0, 9);
  });

  it('says what crossing the pinch costs', () => {
    expect(run(20).crossPinchNote).toMatch(/costs twice/i);
  });

  it('refuses a stream table it cannot use', () => {
    expect(pinchTargets({ streams, minimumApproachC: null }).error).toBeTruthy();
    expect(pinchTargets({ streams, minimumApproachC: -5 }).error).toBeTruthy();
    expect(pinchTargets({
      streams: [{ label: 'X', supplyC: 100, targetC: 100, cpKWperK: 2 }], minimumApproachC: 10,
    }).error).toMatch(/nothing to target/i);
    expect(pinchTargets({
      streams: [{ label: 'X', supplyC: 100, cpKWperK: 2 }], minimumApproachC: 10,
    }).error).toMatch(/target temperature/i);
  });
});

describe('composite curves', () => {
  const streams = [
    { label: 'H1', supplyC: 150, targetC: 60, cpKWperK: 2.0 },
    { label: 'H2', supplyC: 90, targetC: 60, cpKWperK: 8.0 },
    { label: 'C1', supplyC: 20, targetC: 125, cpKWperK: 2.5 },
    { label: 'C2', supplyC: 25, targetC: 100, cpKWperK: 3.0 },
  ];

  it('total duty matches the sum of the streams on that side', () => {
    expect(compositeCurve({ streams, side: 'hot' }).totalDutyKW)
      .toBeCloseTo(2 * 90 + 8 * 30, 6);
    expect(compositeCurve({ streams, side: 'cold' }).totalDutyKW)
      .toBeCloseTo(2.5 * 105 + 3 * 75, 6);
  });

  it('agrees with the pinch calculation on the stream duties', () => {
    const r = pinchTargets({ streams, minimumApproachC: 20 });
    expect(compositeCurve({ streams, side: 'hot' }).totalDutyKW)
      .toBeCloseTo(r.totalHotStreamDutyKW, 6);
    expect(compositeCurve({ streams, side: 'cold' }).totalDutyKW)
      .toBeCloseTo(r.totalColdStreamDutyKW, 6);
  });

  it('rises monotonically in both temperature and enthalpy', () => {
    ['hot', 'cold'].forEach((side) => {
      const p = compositeCurve({ streams, side }).points;
      p.slice(1).forEach((pt, i) => {
        expect(pt.temperatureC).toBeGreaterThan(p[i].temperatureC);
        expect(pt.enthalpyKW).toBeGreaterThanOrEqual(p[i].enthalpyKW);
      });
    });
  });

  it('is empty when that side has no streams', () => {
    expect(compositeCurve({ streams: [], side: 'hot' }).points).toEqual([]);
  });
});

describe('the dual ledger', () => {
  it('prices money and carbon from the same energy, so they cannot disagree', () => {
    const r = priceSaving({
      energySavedGJ: 12000, fuelCostPerGJ: 8,
      emissionFactorKgCo2ePerGJ: 56, implementationCost: 250000,
    });
    expect(r.annualValue).toBeCloseTo(96000, 2);
    expect(r.annualTonnesCo2e).toBeCloseTo((12000 * 56) / 1000, 4);
    expect(r.simplePaybackYears).toBeCloseTo(250000 / 96000, 6);
  });

  it('leaves carbon absent without a factor, and value absent without a price', () => {
    const r = priceSaving({ energySavedGJ: 12000 });
    expect(r.annualTonnesCo2e).toBeNull();
    expect(r.annualValue).toBeNull();
    expect(r.carbonNote).toMatch(/absent rather than zero/i);
    expect(r.valueNote).toMatch(/energy only/i);
  });

  it('hands over an abatement cost rather than ranking it here', () => {
    const r = priceSaving({
      energySavedGJ: 12000, fuelCostPerGJ: 8,
      emissionFactorKgCo2ePerGJ: 56, implementationCost: 250000,
    });
    // A measure that pays for itself has a negative cost per tonne, which
    // is the whole left-hand side of an abatement curve. Ranking is DS9.
    expect(r.costPerTonneCo2e).toBeCloseTo((250000 - 96000) / r.annualTonnesCo2e, 4);
  });

  it('reports no payback rather than a negative one', () => {
    const r = priceSaving({ energySavedGJ: 0, fuelCostPerGJ: 8, implementationCost: 1000 });
    expect(r.simplePaybackYears).toBeNull();
  });
});

describe('the reference data', () => {
  it('separates definitional atom counts from typical heating values', () => {
    FUEL_REFERENCE.forEach((f) => {
      expect(Number.isInteger(f.c)).toBe(true);
      expect(Number.isInteger(f.h)).toBe(true);
      expect(f.molarMassKgKmol).toBeGreaterThan(0);
    });
    expect(FUEL_REFERENCE_NOTE).toMatch(/definitional/i);
    expect(FUEL_REFERENCE_NOTE).toMatch(/fuel analysis governs/i);
  });

  it('labels every property value as typical with a range', () => {
    Object.values(PROPERTY_REFERENCE).forEach((p) => {
      expect(p.typical).toBeGreaterThan(0);
      expect(p.range).toBeTruthy();
      expect(p.note).toBeTruthy();
    });
  });

  it('uses the measured oxygen content of air, not a round number', () => {
    expect(O2_MOLE_FRACTION_DRY_AIR).toBeCloseTo(0.20946, 5);
    expect(O2_MOLE_FRACTION_DRY_AIR).not.toBe(0.21);
  });
});

describe('missing stays missing', () => {
  it('does not read an empty string as a zero', () => {
    const st = naturalGas();
    expect(excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: '' }).error).toBeTruthy();
    expect(stackLossEfficiency({
      stoichiometry: st, excessAir: excessAirFromFlueOxygen({ stoichiometry: st, dryO2Percent: 3 }),
      stackTempC: 200, combustionAirTempC: 25, flueGasCpKJkgK: 1.1,
      waterVapourCpKJkgK: 1.95, radiationLossPercent: '',
    }).error).toMatch(/radiation/i);
    expect(priceSaving({ energySavedGJ: '' }).error).toBeTruthy();
  });
});
