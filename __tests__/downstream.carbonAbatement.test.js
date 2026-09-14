/**
 * Carbon footprint and abatement (DS9).
 *
 * Identities and conservation again: carbon in equals CO2 out, the scopes
 * sum to the total, the curve's steps tile the cumulative axis without gaps
 * or overlaps. The tests that matter most here are the ones about what the
 * module REFUSES to merge - computed against reportable, and abatement
 * claims against what a source actually emits.
 */
import {
  makeFactor, makeGwpSet, combustionCo2FromCarbon, emissionLine, buildInventory,
  carbonIntensity, abatementCost, abatementCurve, decarbonisationPath,
  SCOPE, MW_CO2, MW_C, MW_CH4,
} from '../engines/downstream/carbonAbatement.js';

/** A caller's own GWP set. None are shipped. */
const gwpSet = makeGwpSet({ label: 'IPCC AR5 (100-year)', values: { CH4: 28, N2O: 265 } });

const sourced = (over = {}) => makeFactor({
  id: 'grid', label: 'Grid electricity', value: 0.45, unit: 'tCO2e/MWh',
  source: 'National grid operator disclosure', version: '2026 edition', vintage: 2025, ...over,
});

describe('the factor registry', () => {
  it('records a factor rather than just its number', () => {
    const f = sourced();
    expect(f.value).toBe(0.45);
    expect(f.source).toBeTruthy();
    expect(f.version).toBeTruthy();
    expect(f.provenanceComplete).toBe(true);
  });

  it('accepts an unsourced factor but marks it', () => {
    // Refusing outright would make a first pass impossible; reporting it
    // silently would be worse. So it is recorded and flagged.
    const f = makeFactor({ label: 'Vented methane', value: 0.02, unit: 't/t', gas: 'CH4' });
    expect(f.hasValue).toBe(true);
    expect(f.provenanceComplete).toBe(false);
    expect(f.missingProvenance).toEqual(['source', 'version']);
  });

  it('distinguishes no value from no provenance', () => {
    const f = makeFactor({ label: 'X', value: null, unit: 't/t', source: 'S', version: 'v1' });
    expect(f.hasValue).toBe(false);
    expect(f.provenanceComplete).toBe(true);
  });
});

describe('the global warming potential set', () => {
  it('ships no values and carries the report it came from', () => {
    expect(gwpSet.declared).toBe(true);
    expect(gwpSet.label).toMatch(/AR5/);
    expect(gwpSet.values.CH4).toBe(28);
    expect(gwpSet.note).toMatch(/not comparable/i);
  });

  it('is undeclared without a label or without values', () => {
    expect(makeGwpSet({ values: { CH4: 28 } }).declared).toBe(false);
    expect(makeGwpSet({ label: 'AR6' }).declared).toBe(false);
  });

  it('moves a methane-heavy inventory materially between reports', () => {
    const ar4 = makeGwpSet({ label: 'AR4', values: { CH4: 25 } });
    const ar5 = makeGwpSet({ label: 'AR5', values: { CH4: 28 } });
    const f = makeFactor({ label: 'Vent', value: 1, unit: 't/t', gas: 'CH4', source: 'S', version: 'v' });
    const a = emissionLine({ label: 'Vent', activity: 1000, factor: f, gwpSet: ar4 });
    const b = emissionLine({ label: 'Vent', activity: 1000, factor: f, gwpSet: ar5 });
    // Same plant, same year, same measurements, different number. This is
    // why the set is stated on every result.
    expect(b.tCo2e / a.tCo2e).toBeCloseTo(28 / 25, 9);
  });
});

describe('combustion CO2 from the carbon', () => {
  it('is conservation of mass, and says it needs no source document', () => {
    // 1000 kmol of methane has 1000 kmol of carbon, which leaves as 1000
    // kmol of CO2. Nothing empirical about it.
    const r = combustionCo2FromCarbon({ fuelKmolPerYear: 1000, carbonPerKmolFuel: 1 });
    expect(r.carbonKmolPerYear).toBeCloseTo(1000, 9);
    expect(r.co2Tonnes).toBeCloseTo((1000 * MW_CO2) / 1000, 6);
    expect(r.method).toMatch(/conservation of mass/i);
  });

  it('conserves carbon between the CO2 and the methane that escaped', () => {
    const r = combustionCo2FromCarbon({
      fuelKmolPerYear: 1000, carbonPerKmolFuel: 1, destructionEfficiencyFraction: 0.98,
    });
    const carbonInCo2 = (r.co2Tonnes * 1000 * MW_C) / MW_CO2;
    const carbonInCh4 = (r.ch4Tonnes * 1000 * MW_C) / MW_CH4;
    // Every carbon atom is accounted for in one product or the other.
    expect((carbonInCo2 + carbonInCh4) / MW_C).toBeCloseTo(1000, 6);
  });

  it('two percent of unburned carbon is not two percent of the impact', () => {
    const r = combustionCo2FromCarbon({
      fuelKmolPerYear: 1000, carbonPerKmolFuel: 1, destructionEfficiencyFraction: 0.98,
    });
    const co2e = r.co2Tonnes + r.ch4Tonnes * gwpSet.values.CH4;
    // The escaped methane carries far more weight per tonne, which is the
    // whole reason the destruction efficiency is an input rather than an
    // assumption.
    expect((r.ch4Tonnes * gwpSet.values.CH4) / co2e).toBeGreaterThan(0.02);
    expect(r.unburnedNote).toMatch(/counted as methane/i);
  });

  it('scales linearly with fuel and with carbon number', () => {
    const one = combustionCo2FromCarbon({ fuelKmolPerYear: 1000, carbonPerKmolFuel: 1 });
    const two = combustionCo2FromCarbon({ fuelKmolPerYear: 2000, carbonPerKmolFuel: 1 });
    const three = combustionCo2FromCarbon({ fuelKmolPerYear: 1000, carbonPerKmolFuel: 3 });
    expect(two.co2Tonnes).toBeCloseTo(one.co2Tonnes * 2, 6);
    expect(three.co2Tonnes).toBeCloseTo(one.co2Tonnes * 3, 6);
  });

  it('refuses a destruction efficiency outside its range', () => {
    expect(combustionCo2FromCarbon({
      fuelKmolPerYear: 1, carbonPerKmolFuel: 1, destructionEfficiencyFraction: 1.2,
    }).error).toBeTruthy();
    expect(combustionCo2FromCarbon({ fuelKmolPerYear: null, carbonPerKmolFuel: 1 }).error).toBeTruthy();
  });
});

describe('emission lines', () => {
  it('multiplies activity by factor by global warming potential', () => {
    const f = makeFactor({ label: 'Vent', value: 0.5, unit: 't/t', gas: 'CH4', source: 'S', version: 'v' });
    const l = emissionLine({ label: 'Venting', activity: 100, factor: f, gwpSet });
    expect(l.tonnesGas).toBeCloseTo(50, 9);
    expect(l.tCo2e).toBeCloseTo(50 * 28, 9);
  });

  it('gives CO2 a potential of one without needing it in the set', () => {
    const l = emissionLine({ label: 'Flue', activity: 100, factor: sourced(), gwpSet });
    expect(l.gwp).toBe(1);
    expect(l.tCo2e).toBeCloseTo(45, 9);
  });

  it('names WHICH thing is missing rather than just failing', () => {
    const f = sourced();
    expect(emissionLine({ label: 'A', activity: null, factor: f, gwpSet }).blockedBy)
      .toMatch(/activity/i);
    expect(emissionLine({
      label: 'B', activity: 10, factor: sourced({ value: null }), gwpSet,
    }).blockedBy).toMatch(/factor value/i);
    expect(emissionLine({
      label: 'C', activity: 10,
      factor: makeFactor({ label: 'N2O vent', value: 1, unit: 't/t', gas: 'N2O', source: 'S', version: 'v' }),
      gwpSet: makeGwpSet({ label: 'Partial', values: { CH4: 28 } }),
    }).blockedBy).toMatch(/global warming potential for N2O/i);
  });

  it('carries the factor provenance forward onto the line', () => {
    const l = emissionLine({
      label: 'Unsourced', activity: 10,
      factor: makeFactor({ label: 'X', value: 1, unit: 't/t' }), gwpSet,
    });
    expect(l.provenanceComplete).toBe(false);
    expect(l.tCo2e).toBeCloseTo(10, 9);
  });
});

describe('the inventory', () => {
  const good = () => [
    emissionLine({ label: 'Fired heaters', scope: SCOPE.ONE, activity: 200, factor: sourced({ id: 'fuel', label: 'Fuel gas', value: 2.6, unit: 't/t' }), gwpSet }),
    emissionLine({ label: 'Purchased power', scope: SCOPE.TWO, activity: 40000, factor: sourced({ value: 0.00045, unit: 'tCO2e/kWh' }), gwpSet }),
  ];

  it('totals by scope and the scopes sum to the total', () => {
    const inv = buildInventory({ lines: good(), gwpSet });
    expect(inv.totalTonnes).toBeCloseTo(inv.scope1Tonnes + inv.scope2Tonnes, 6);
    expect(inv.byScope.reduce((s, x) => s + x.tCo2e, 0)).toBeCloseTo(inv.totalTonnes, 6);
  });

  it('is reportable only when everything is sourced and the set is declared', () => {
    expect(buildInventory({ lines: good(), gwpSet }).reportable).toBe(true);
  });

  it('separates computed from reportable, which is the point', () => {
    const lines = [
      ...good(),
      emissionLine({
        label: 'Fugitives', scope: SCOPE.ONE, activity: 5,
        factor: makeFactor({ label: 'Fugitive', value: 0.3, unit: 't/t', gas: 'CH4' }), gwpSet,
      }),
    ];
    const inv = buildInventory({ lines, gwpSet });
    // The arithmetic is complete. It is still not something to file, and
    // merging those two questions is how a working number reaches a return.
    expect(inv.computed).toBe(true);
    expect(inv.reportable).toBe(false);
    expect(inv.notReportableBecause.join(' ')).toMatch(/no source or version/i);
    expect(inv.unsourcedLines[0].label).toBe('Fugitives');
    expect(inv.totalTonnes).toBeGreaterThan(0);
  });

  it('is not reportable without a declared potential set', () => {
    const inv = buildInventory({ lines: good(), gwpSet: makeGwpSet({ values: { CH4: 28 } }) });
    expect(inv.reportable).toBe(false);
    expect(inv.notReportableBecause.join(' ')).toMatch(/global warming potential set is not declared/i);
    expect(inv.gwpSetLabel).toBeNull();
  });

  it('lists a blocked line and leaves it out of the total rather than zeroing it', () => {
    const inv = buildInventory({
      lines: [...good(), emissionLine({ label: 'Flaring', activity: null, factor: sourced(), gwpSet })],
      gwpSet,
    });
    expect(inv.blockedLines).toEqual([{ label: 'Flaring', reason: 'no activity data' }]);
    expect(inv.totalTonnes).toBeCloseTo(buildInventory({ lines: good(), gwpSet }).totalTonnes, 6);
    expect(inv.reportable).toBe(false);
  });

  it('says it is not a compliance register', () => {
    expect(buildInventory({ lines: good(), gwpSet }).disclaimer)
      .toMatch(/not a regulatory compliance register/i);
  });
});

describe('carbon intensity', () => {
  const inv = () => buildInventory({
    lines: [
      emissionLine({ label: 'Heaters', scope: SCOPE.ONE, activity: 100, factor: sourced({ value: 3, unit: 't/t' }), gwpSet }),
      emissionLine({ label: 'Power', scope: SCOPE.TWO, activity: 100, factor: sourced({ value: 1, unit: 't/t' }), gwpSet }),
    ],
    gwpSet,
  });

  it('requires the boundary to be named', () => {
    const r = carbonIntensity({ inventory: inv(), denominatorValue: 1000, denominatorUnit: 'tonne' });
    // Per tonne charged and per tonne of saleable product are different
    // numbers for the same plant.
    expect(r.error).toMatch(/boundary must be named/i);
  });

  it('divides each scope by the same denominator', () => {
    const i = inv();
    const r = carbonIntensity({
      inventory: i, denominatorValue: 1000, denominatorUnit: 'tonne charged',
      boundaryLabel: 'Crude charged, Scope 1 and 2',
    });
    expect(r.scope1Intensity).toBeCloseTo(i.scope1Tonnes / 1000, 9);
    expect(r.totalIntensity).toBeCloseTo(r.scope1Intensity + r.scope2Intensity, 9);
  });

  it('states what it can be compared with', () => {
    const r = carbonIntensity({
      inventory: inv(), denominatorValue: 1000, denominatorUnit: 'tonne charged',
      boundaryLabel: 'Crude charged, Scope 1 and 2',
    });
    expect(r.comparabilityNote).toMatch(/Crude charged/);
    expect(r.comparabilityNote).toMatch(/AR5/);
  });

  it('refuses a denominator of nothing', () => {
    expect(carbonIntensity({
      inventory: inv(), denominatorValue: 0, denominatorUnit: 't', boundaryLabel: 'x',
    }).error).toBeTruthy();
  });
});

describe('abatement cost', () => {
  it('annualises capital rather than comparing it to a recurring saving', () => {
    const r = abatementCost({
      label: 'Heat integration', capitalCost: 1000000, annualSavings: 200000,
      tonnesAbatedPerYear: 4000, lifeYears: 10, discountRate: 0.1,
    });
    // Capital recovery factor at 10% over 10 years.
    const crf = (0.1 * 1.1 ** 10) / (1.1 ** 10 - 1);
    expect(r.capitalRecoveryFactor).toBeCloseTo(crf, 8);
    expect(r.annualisedCapital).toBeCloseTo(1000000 * crf, 4);
    expect(r.netAnnualCost).toBeCloseTo(1000000 * crf - 200000, 4);
  });

  it('is straight-line at a zero discount rate', () => {
    const r = abatementCost({
      label: 'X', capitalCost: 1000, tonnesAbatedPerYear: 1, lifeYears: 10, discountRate: 0,
    });
    expect(r.capitalRecoveryFactor).toBeCloseTo(0.1, 9);
    expect(r.annualisedCapital).toBeCloseTo(100, 6);
  });

  it('gives a negative cost per tonne to a measure that pays for itself', () => {
    const r = abatementCost({
      label: 'Tune the heaters', capitalCost: 20000, annualSavings: 150000,
      tonnesAbatedPerYear: 900, lifeYears: 5, discountRate: 0.1,
    });
    // The left-hand side of the curve, and the measures nobody has done.
    expect(r.paysForItself).toBe(true);
    expect(r.costPerTonne).toBeLessThan(0);
  });

  it('refuses a capital cost with no life to spread it over', () => {
    const r = abatementCost({ label: 'Y', capitalCost: 500000, tonnesAbatedPerYear: 100 });
    expect(r.error).toMatch(/needs a life/i);
    expect(r.error).toMatch(/look expensive/i);
  });

  it('needs an abatement figure', () => {
    expect(abatementCost({ label: 'Z', tonnesAbatedPerYear: null }).error).toBeTruthy();
  });
});

describe('the abatement curve', () => {
  const m = (label, cost, tonnes, actsOn = []) => abatementCost({
    label, annualCost: cost, tonnesAbatedPerYear: tonnes, actsOn,
  });

  it('sorts cheapest first and the steps tile the axis exactly', () => {
    const c = abatementCurve({
      measures: [m('C', 300, 100, ['s3']), m('A', -50, 200, ['s1']), m('B', 100, 150, ['s2'])],
    });
    expect(c.steps.map((s) => s.label)).toEqual(['A', 'B', 'C']);
    // No gaps and no overlaps: each step starts where the last ended.
    c.steps.slice(1).forEach((s, i) => {
      expect(s.cumulativeStartTonnes).toBeCloseTo(c.steps[i].cumulativeEndTonnes, 6);
    });
    expect(c.steps[0].cumulativeStartTonnes).toBeCloseTo(0, 9);
    expect(c.steps[c.steps.length - 1].cumulativeEndTonnes)
      .toBeCloseTo(c.totalAbatementTonnes, 6);
  });

  it('puts the measures that pay for themselves on the left', () => {
    const c = abatementCurve({
      measures: [m('Costly', 500, 100, ['s2']), m('Pays', -200, 300, ['s1'])],
    });
    expect(c.steps[0].label).toBe('Pays');
    expect(c.paysForItselfTonnes).toBeCloseTo(300, 6);
    expect(c.paysForItselfMeasures).toEqual(['Pays']);
  });

  it('flags measures that act on the same source as NOT additive', () => {
    // Insulating a line and then shutting it down do not abate twice, and
    // the usual spreadsheet adds them anyway.
    const c = abatementCurve({
      measures: [m('Insulate', 100, 200, ['line-7']), m('Shut down', -50, 500, ['line-7'])],
    });
    expect(c.additive).toBe(false);
    expect(c.interactions).toEqual([
      { sourceId: 'line-7', measures: expect.arrayContaining(['Insulate', 'Shut down']) },
    ]);
    expect(c.interactionNote).toMatch(/upper bound/i);
    expect(c.interactionNote).toMatch(/engineering judgement/i);
  });

  it('is additive when nothing overlaps', () => {
    const c = abatementCurve({ measures: [m('A', 1, 10, ['s1']), m('B', 2, 20, ['s2'])] });
    expect(c.additive).toBe(true);
    expect(c.interactionNote).toBeNull();
  });

  it('catches claims that exceed what the source emits', () => {
    const c = abatementCurve({
      measures: [m('A', 1, 600, ['flare']), m('B', 2, 700, ['flare'])],
      sourceEmissions: { flare: 1000 },
    });
    expect(c.overClaims).toHaveLength(1);
    expect(c.overClaims[0]).toMatchObject({
      sourceId: 'flare', claimedTonnes: 1300, emittedTonnes: 1000,
    });
  });

  it('does not resolve the overlap on its own', () => {
    // Resolving it needs a judgement about sequencing that a solver would
    // only guess at, so the curve reports and does not adjust.
    const c = abatementCurve({
      measures: [m('A', 1, 600, ['flare']), m('B', 2, 700, ['flare'])],
      sourceEmissions: { flare: 1000 },
    });
    expect(c.totalAbatementTonnes).toBeCloseTo(1300, 6);
  });

  it('names the residual against a target rather than closing it', () => {
    const c = abatementCurve({ measures: [m('A', 1, 400, ['s1'])], targetTonnes: 1000 });
    expect(c.meetsTarget).toBe(false);
    expect(c.residualToTargetTonnes).toBeCloseTo(600, 6);
    const met = abatementCurve({ measures: [m('A', 1, 1200, ['s1'])], targetTonnes: 1000 });
    expect(met.meetsTarget).toBe(true);
    expect(met.residualToTargetTonnes).toBeCloseTo(0, 9);
  });

  it('leaves the target comparison absent when there is no target', () => {
    const c = abatementCurve({ measures: [m('A', 1, 400, ['s1'])] });
    expect(c.meetsTarget).toBeNull();
    expect(c.residualToTargetTonnes).toBeNull();
  });

  it('averages cost per tonne over the abatement, not over the measures', () => {
    const c = abatementCurve({ measures: [m('A', 100, 100, ['s1']), m('B', 900, 900, ['s2'])] });
    expect(c.weightedAverageCostPerTonne).toBeCloseTo(1000 / 1000, 6);
  });
});

describe('the decarbonisation path', () => {
  const measures = [
    { label: 'Tune heaters', tonnesAbatedPerYear: 900, startYear: 2027 },
    { label: 'Heat integration', tonnesAbatedPerYear: 4000, startYear: 2029 },
  ];
  const path = () => decarbonisationPath({
    baselineTonnes: 50000, measures, startYear: 2026, endYear: 2030,
    targetByYear: { 2026: 50000, 2027: 48000, 2028: 46000, 2029: 44000, 2030: 40000 },
  });

  it('brings each measure in only from its start year', () => {
    const p = path();
    expect(p.rows.find((r) => r.year === 2026).abatedTonnes).toBeCloseTo(0, 9);
    expect(p.rows.find((r) => r.year === 2027).abatedTonnes).toBeCloseTo(900, 9);
    expect(p.rows.find((r) => r.year === 2029).abatedTonnes).toBeCloseTo(4900, 9);
    expect(p.rows.find((r) => r.year === 2028).measuresLive).toEqual(['Tune heaters']);
  });

  it('emissions are the baseline less what is abated, every year', () => {
    path().rows.forEach((r) => {
      expect(r.emissionsTonnes).toBeCloseTo(r.baselineTonnes - r.abatedTonnes, 6);
    });
  });

  it('names the gap as unabated rather than drawing a wedge', () => {
    const p = path();
    // A wedge labelled "further measures" with nothing behind it is not a
    // plan, and treating it as one is how these roadmaps stop meaning
    // anything.
    expect(p.gapNote).toMatch(/not drawn as a wedge/i);
    expect(p.rows.find((r) => r.year === 2028).unabatedGapTonnes).toBeCloseTo(50000 - 900 - 46000, 6);
  });

  it('reports the first year the plan falls short', () => {
    expect(path().firstShortfallYear).toBe(2027);
  });

  it('reports no gap when the measures get there', () => {
    const p = decarbonisationPath({
      baselineTonnes: 1000, measures: [{ label: 'Big', tonnesAbatedPerYear: 900, startYear: 2026 }],
      startYear: 2026, endYear: 2027, targetByYear: { 2026: 500, 2027: 500 },
    });
    expect(p.firstShortfallYear).toBeNull();
    expect(p.gapNote).toBeNull();
  });

  it('leaves the gap absent for a year with no target', () => {
    const p = decarbonisationPath({
      baselineTonnes: 1000, measures, startYear: 2026, endYear: 2026,
    });
    expect(p.rows[0].unabatedGapTonnes).toBeNull();
  });

  it('refuses a backwards year range', () => {
    expect(decarbonisationPath({
      baselineTonnes: 1000, startYear: 2030, endYear: 2026,
    }).error).toBeTruthy();
  });
});

describe('missing stays missing', () => {
  it('does not read an empty string as a zero', () => {
    expect(makeFactor({ label: 'X', value: '', unit: 't' }).hasValue).toBe(false);
    expect(emissionLine({ label: 'X', activity: '', factor: sourced(), gwpSet }).blockedBy)
      .toMatch(/activity/i);
    expect(combustionCo2FromCarbon({ fuelKmolPerYear: '', carbonPerKmolFuel: 1 }).error).toBeTruthy();
  });
});
