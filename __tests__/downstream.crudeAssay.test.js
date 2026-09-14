/**
 * Crude assay, blending and valuation (DS1).
 *
 * Blend arithmetic fails silently: average the wrong quantity on the wrong
 * basis and the answer looks plausible and is wrong by a few percent, which
 * on a cargo is real money. So the tests here are mostly identities and
 * hand-computable cases rather than remembered numbers, and the ones that
 * matter most check that a property is blended on ITS OWN basis.
 */
import {
  sgFromApi, apiFromSg, watsonK,
  resolveFractions, blendOnMass, blendOnVolume,
  viscosityBlendIndex, viscosityFromBlendIndex, blendViscosity,
  volumePercentAt, cutYields,
  colloidalInstabilityIndex, screenBlendStability, CII_BANDS,
  blendCrudes, netbackValue, d86ToTbp,
} from '../engines/downstream/crudeAssay.js';

describe('gravity', () => {
  it('round-trips API and specific gravity', () => {
    [10, 22.3, 35, 45.6].forEach((api) => {
      expect(apiFromSg(sgFromApi(api))).toBeCloseTo(api, 10);
    });
  });

  it('puts water at 10 API, which is the definition', () => {
    expect(sgFromApi(10)).toBeCloseTo(1, 10);
    expect(apiFromSg(1)).toBeCloseTo(10, 10);
  });

  it('computes the Watson factor on the same form the fluid package uses', () => {
    // K = Tb^(1/3)/SG, Tb in Rankine. 600F and SG 0.85:
    // (1059.67)^(1/3) / 0.85 = 10.1963.../0.85
    const k = watsonK({ meanBoilingPointF: 600, sg: 0.85 });
    expect(k).toBeCloseTo(Math.cbrt(1059.67) / 0.85, 10);
    // A paraffinic crude sits high, an aromatic one low; sanity on the scale.
    expect(k).toBeGreaterThan(11);
    expect(k).toBeLessThan(13);
  });

  it('returns null rather than a number for impossible inputs', () => {
    expect(watsonK({ meanBoilingPointF: -1000, sg: 0.85 })).toBeNull();
    expect(watsonK({ meanBoilingPointF: 600, sg: 0 })).toBeNull();
  });
});

describe('fractions', () => {
  it('derives mass fractions from volumes through the densities', () => {
    // Equal volumes of SG 1.0 and SG 0.8: masses are 1.0 and 0.8 of 1.8.
    const { volume, mass } = resolveFractions([
      { sg: 1.0, volumeFraction: 50 },
      { sg: 0.8, volumeFraction: 50 },
    ]);
    expect(volume[0]).toBeCloseTo(0.5, 12);
    expect(mass[0]).toBeCloseTo(1.0 / 1.8, 12);
    expect(mass[1]).toBeCloseTo(0.8 / 1.8, 12);
  });

  it('normalises fractions that do not sum to one', () => {
    const { volume } = resolveFractions([
      { sg: 0.9, volumeFraction: 3 },
      { sg: 0.9, volumeFraction: 1 },
    ]);
    expect(volume[0]).toBeCloseTo(0.75, 12);
    expect(volume[1]).toBeCloseTo(0.25, 12);
  });

  it('accepts mass fractions and derives the volumes', () => {
    const { volume, mass } = resolveFractions([
      { sg: 1.0, massFraction: 50 },
      { sg: 0.5, massFraction: 50 },
    ]);
    // Equal masses of a dense and a light oil: the light one occupies twice
    // the volume.
    expect(mass[0]).toBeCloseTo(0.5, 12);
    expect(volume[0]).toBeCloseTo(1 / 3, 12);
    expect(volume[1]).toBeCloseTo(2 / 3, 12);
  });

  it('blends specific gravity on volume', () => {
    const { sgBlend } = resolveFractions([
      { sg: 1.0, volumeFraction: 50 },
      { sg: 0.8, volumeFraction: 50 },
    ]);
    expect(sgBlend).toBeCloseTo(0.9, 12);
  });

  it('both fraction sets sum to one', () => {
    const { volume, mass } = resolveFractions([
      { sg: 0.95, volumeFraction: 20 },
      { sg: 0.87, volumeFraction: 30 },
      { sg: 0.80, volumeFraction: 50 },
    ]);
    expect(volume.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 12);
    expect(mass.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 12);
  });
});

describe('API gravity does not blend linearly, and this is the test that proves it', () => {
  it('gives 29.38, not 30, for a 50/50 of 20 and 40 API', () => {
    // The classic error. SG(20) = 141.5/151.5 = 0.93399,
    // SG(40) = 141.5/171.5 = 0.82507, mean 0.87953, so API 29.3808.
    // The derived value is asserted first and the literal second, so a
    // mistyped literal fails on its own rather than being propped up.
    const sg20 = 141.5 / 151.5;
    const sg40 = 141.5 / 171.5;
    const expected = 141.5 / ((sg20 + sg40) / 2) - 131.5;
    const { apiBlend } = resolveFractions([
      { sg: sg20, volumeFraction: 50 },
      { sg: sg40, volumeFraction: 50 },
    ]);
    expect(apiBlend).toBeCloseTo(expected, 10);
    expect(apiBlend).toBeCloseTo(29.3808, 3);
    // Six tenths of a degree below the arithmetic mean. Small sounding, and
    // it is the difference between two crude grades on a price sheet.
    expect(apiBlend).toBeLessThan(30);
    expect(30 - apiBlend).toBeGreaterThan(0.5);
  });

  it('blendCrudes reports the same figure', () => {
    const out = blendCrudes([
      { id: 'a', name: 'Heavy', api: 20, volumeFraction: 50 },
      { id: 'b', name: 'Light', api: 40, volumeFraction: 50 },
    ]);
    expect(out.properties.api).toBeCloseTo(29.3808, 3);
    expect(out.bases.api).toMatch(/never averaged directly/);
  });
});

describe('mass-basis properties', () => {
  it('blends sulfur on mass, not volume', () => {
    // 50/50 by VOLUME of a dense 3% sulfur crude and a light 0.1% one. The
    // dense one carries more mass, so the blend is above the volumetric mean.
    const out = blendCrudes([
      { id: 'sour', api: 20, sulfurWtPct: 3.0, volumeFraction: 50 },
      { id: 'sweet', api: 40, sulfurWtPct: 0.1, volumeFraction: 50 },
    ]);
    const volumetricMean = 1.55;
    expect(out.properties.sulfurWtPct).toBeGreaterThan(volumetricMean);

    // Check it exactly against the mass fractions.
    const sgH = sgFromApi(20);
    const sgL = sgFromApi(40);
    const mH = sgH / (sgH + sgL);
    const expected = 3.0 * mH + 0.1 * (1 - mH);
    expect(out.properties.sulfurWtPct).toBeCloseTo(expected, 10);
  });

  it('blends TAN and metals on mass too', () => {
    const out = blendCrudes([
      { id: 'a', api: 20, tanMgKohG: 4, vanadiumPpm: 200, volumeFraction: 50 },
      { id: 'b', api: 40, tanMgKohG: 0.1, vanadiumPpm: 5, volumeFraction: 50 },
    ]);
    expect(out.bases.tanMgKohG).toBe('mass');
    expect(out.bases.vanadiumPpm).toBe('mass');
    const sgH = sgFromApi(20);
    const mH = sgH / (sgH + sgFromApi(40));
    expect(out.properties.tanMgKohG).toBeCloseTo(4 * mH + 0.1 * (1 - mH), 10);
  });

  it('reports null for a property no component supplied', () => {
    const out = blendCrudes([
      { id: 'a', api: 30, volumeFraction: 50 },
      { id: 'b', api: 35, volumeFraction: 50 },
    ]);
    expect(out.properties.sulfurWtPct).toBeNull();
  });

  it('helpers weight on the basis they say they do', () => {
    expect(blendOnMass([10, 20], [0.25, 0.75])).toBeCloseTo(17.5, 12);
    expect(blendOnVolume([10, 20], [0.25, 0.75])).toBeCloseTo(17.5, 12);
  });
});

describe('viscosity', () => {
  it('round-trips through the Refutas index', () => {
    [1.5, 10, 100, 5000].forEach((nu) => {
      expect(viscosityFromBlendIndex(viscosityBlendIndex(nu))).toBeCloseTo(nu, 6);
    });
  });

  it('blends far below the linear average, which is the whole point', () => {
    // 50/50 by mass of 10 cSt and 1000 cSt. Linear would say 505; the real
    // blend is around 100, and a studio reporting 505 would size the wrong
    // pump and the wrong heater.
    const blended = blendViscosity([10, 1000], [0.5, 0.5]);
    expect(blended).toBeGreaterThan(50);
    expect(blended).toBeLessThan(200);
    expect(blended).toBeLessThan(505);
  });

  it('returns the component viscosity when there is only one component', () => {
    expect(blendViscosity([42], [1])).toBeCloseTo(42, 6);
  });

  it('is monotone: more of the viscous component gives a more viscous blend', () => {
    const a = blendViscosity([10, 1000], [0.9, 0.1]);
    const b = blendViscosity([10, 1000], [0.5, 0.5]);
    const c = blendViscosity([10, 1000], [0.1, 0.9]);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('refuses rather than guessing when a component is outside the index domain', () => {
    // ln(ln(nu + 0.8)) is undefined at or below 0.2 cSt.
    expect(viscosityBlendIndex(0.1)).toBeNull();
    expect(blendViscosity([0.1, 100], [0.5, 0.5])).toBeNull();
  });

  it('names its basis in the blend result', () => {
    const out = blendCrudes([
      { id: 'a', api: 20, viscosityCSt: 1000, volumeFraction: 50 },
      { id: 'b', api: 40, viscosityCSt: 10, volumeFraction: 50 },
    ]);
    expect(out.bases.viscosityCSt).toMatch(/Refutas index on mass fraction/);
    expect(out.properties.viscosityCSt).toBeGreaterThan(0);
  });

  it('says so rather than blending the rest when a viscosity is missing', () => {
    const out = blendCrudes([
      { id: 'a', api: 20, viscosityCSt: 1000, volumeFraction: 50 },
      { id: 'b', api: 40, volumeFraction: 50 },
    ]);
    expect(out.properties.viscosityCSt).toBeNull();
    expect(out.bases.viscosityCSt).toMatch(/not blended/);
  });
});

describe('distillation curve', () => {
  const curve = [
    { volumePercent: 0, temperatureF: 100 },
    { volumePercent: 20, temperatureF: 300 },
    { volumePercent: 50, temperatureF: 500 },
    { volumePercent: 80, temperatureF: 800 },
    { volumePercent: 100, temperatureF: 1200 },
  ];

  it('interpolates linearly between measured points', () => {
    // Halfway between 300F (20%) and 500F (50%) is 400F, so 35%.
    expect(volumePercentAt(curve, 400)).toBeCloseTo(35, 10);
  });

  it('returns the measured value at a measured point', () => {
    expect(volumePercentAt(curve, 500)).toBeCloseTo(50, 10);
  });

  it('clamps rather than extrapolating past the ends', () => {
    // Extrapolating a distillation curve past its last point invents yield.
    expect(volumePercentAt(curve, 2000)).toBe(100);
    expect(volumePercentAt(curve, 50)).toBe(0);
  });

  it('returns null for an empty curve instead of zero', () => {
    expect(volumePercentAt([], 400)).toBeNull();
  });
});

describe('cut yields', () => {
  const curve = [
    { volumePercent: 0, temperatureF: 100 },
    { volumePercent: 20, temperatureF: 300 },
    { volumePercent: 50, temperatureF: 500 },
    { volumePercent: 80, temperatureF: 800 },
    { volumePercent: 100, temperatureF: 1200 },
  ];
  const cuts = [
    { id: 'naphtha', name: 'Naphtha', fromF: null, toF: 300 },
    { id: 'kero', name: 'Kerosene', fromF: 300, toF: 500 },
    { id: 'diesel', name: 'Diesel', fromF: 500, toF: 800 },
    { id: 'resid', name: 'Residue', fromF: 800, toF: null },
  ];

  it('gives each cut the volume between its bounds', () => {
    const { cuts: rows } = cutYields({ curve, cuts });
    expect(rows[0].yieldVolPercent).toBeCloseTo(20, 10);
    expect(rows[1].yieldVolPercent).toBeCloseTo(30, 10);
    expect(rows[2].yieldVolPercent).toBeCloseTo(30, 10);
    expect(rows[3].yieldVolPercent).toBeCloseTo(20, 10);
  });

  it('closes to 100 percent on a cut set that covers the curve', () => {
    const out = cutYields({ curve, cuts });
    expect(out.totalVolPercent).toBeCloseTo(100, 8);
    expect(out.closes).toBe(true);
  });

  it('reports a cut set that does NOT cover the curve rather than normalising it away', () => {
    // Drop the residue: the total no longer closes, and the user needs to see
    // that rather than have the remaining cuts silently scaled up to 100.
    const partial = cutYields({ curve, cuts: cuts.slice(0, 3) });
    expect(partial.totalVolPercent).toBeCloseTo(80, 8);
    expect(partial.closes).toBe(false);
  });

  it('never returns a negative yield from inverted bounds', () => {
    const out = cutYields({ curve, cuts: [{ id: 'x', name: 'X', fromF: 800, toF: 300 }] });
    expect(out.cuts[0].yieldVolPercent).toBe(0);
  });
});

describe('compatibility', () => {
  it('forms the colloidal instability index from SARA', () => {
    // (saturates + asphaltenes) / (aromatics + resins)
    expect(colloidalInstabilityIndex({ saturates: 50, aromatics: 30, resins: 15, asphaltenes: 5 }))
      .toBeCloseTo(55 / 45, 10);
  });

  it('returns null when nothing is holding the asphaltenes', () => {
    expect(colloidalInstabilityIndex({ saturates: 90, aromatics: 0, resins: 0, asphaltenes: 10 })).toBeNull();
  });

  it('uses the index when every component has SARA, and says so', () => {
    const out = screenBlendStability({
      components: [
        { api: 20, sara: { saturates: 30, aromatics: 40, resins: 22, asphaltenes: 8 } },
        { api: 40, sara: { saturates: 75, aromatics: 20, resins: 5, asphaltenes: 0 } },
      ],
      massFractions: [0.5, 0.5],
    });
    expect(out.basis).toBe('cii');
    expect(out.cii).toBeGreaterThan(0);
    expect(out.blendedSara.saturates).toBeCloseTo(52.5, 10);
  });

  it('calls a saturate-heavy blend unstable and an aromatic-rich one stable', () => {
    const unstable = screenBlendStability({
      components: [{ api: 30, sara: { saturates: 80, aromatics: 8, resins: 4, asphaltenes: 8 } }],
      massFractions: [1],
    });
    expect(unstable.cii).toBeGreaterThan(CII_BANDS.UNSTABLE);
    expect(unstable.stable).toBe(false);

    const stable = screenBlendStability({
      components: [{ api: 30, sara: { saturates: 25, aromatics: 45, resins: 27, asphaltenes: 3 } }],
      massFractions: [1],
    });
    expect(stable.cii).toBeLessThan(CII_BANDS.STABLE);
    expect(stable.stable).toBe(true);
  });

  it('falls back to gravity contrast WITHOUT SARA, and labels the fallback', () => {
    // A screening result whose basis is unstated invites more confidence than
    // it has earned, so the basis is part of the answer.
    const out = screenBlendStability({
      components: [{ api: 18 }, { api: 45 }],
      massFractions: [0.5, 0.5],
    });
    expect(out.basis).toBe('api-contrast');
    expect(out.stable).toBe(false);
    expect(out.message).toMatch(/No SARA analysis supplied/);
    expect(out.message).toMatch(/Supply SARA/);
  });

  it('does not flag a narrow gravity spread on the fallback', () => {
    const out = screenBlendStability({
      components: [{ api: 30 }, { api: 34 }],
      massFractions: [0.5, 0.5],
    });
    expect(out.stable).toBe(true);
  });

  it('reaches the screen through blendCrudes', () => {
    const out = blendCrudes([
      { id: 'a', api: 18, volumeFraction: 50 },
      { id: 'b', api: 45, volumeFraction: 50 },
    ]);
    expect(out.stability.basis).toBe('api-contrast');
  });
});

describe('netback', () => {
  const cuts = [
    { id: 'naphtha', name: 'Naphtha', yieldVolPercent: 20 },
    { id: 'kero', name: 'Kerosene', yieldVolPercent: 30 },
    { id: 'diesel', name: 'Diesel', yieldVolPercent: 30 },
    { id: 'resid', name: 'Residue', yieldVolPercent: 20 },
  ];
  const prices = { naphtha: 80, kero: 95, diesel: 100, resid: 45 };

  it('values a barrel as its yields times their prices', () => {
    // 0.2(80) + 0.3(95) + 0.3(100) + 0.2(45) = 16 + 28.5 + 30 + 9 = 83.5
    const out = netbackValue({ cuts, prices });
    expect(out.grossValue).toBeCloseTo(83.5, 10);
    expect(out.netback).toBeCloseTo(83.5, 10);
    expect(out.complete).toBe(true);
  });

  it('subtracts processing, freight and losses in that order', () => {
    const out = netbackValue({
      cuts, prices, processingCostPerBbl: 4, freightPerBbl: 2, lossPercent: 1,
    });
    const afterLoss = 83.5 * 0.99;
    expect(out.lossValue).toBeCloseTo(83.5 - afterLoss, 10);
    expect(out.netback).toBeCloseTo(afterLoss - 6, 10);
  });

  it('reports the differential against a marker', () => {
    const out = netbackValue({ cuts, prices, marker: 80 });
    expect(out.marker.differential).toBeCloseTo(3.5, 10);
  });

  it('names an unpriced cut instead of valuing the barrel as if it were free', () => {
    // A missing price silently treated as zero understates the crude and
    // loses the argument with the seller for the wrong reason.
    const out = netbackValue({ cuts, prices: { ...prices, resid: undefined } });
    expect(out.complete).toBe(false);
    expect(out.unpricedCuts).toEqual(['Residue']);
    expect(out.grossValue).toBeCloseTo(74.5, 10);
  });

  it('reports every term, because the argument is always about one of them', () => {
    const out = netbackValue({ cuts, prices, processingCostPerBbl: 4, freightPerBbl: 2 });
    expect(out.rows).toHaveLength(4);
    expect(out.rows[0].valuePerBblCrude).toBeCloseTo(16, 10);
    expect(out.processingCostPerBbl).toBe(4);
    expect(out.freightPerBbl).toBe(2);
  });
});

describe('D86 to TBP, whose literature gate is ARMED', () => {
  const d86 = [
    { volumePercent: 10, temperatureF: 200 },
    { volumePercent: 50, temperatureF: 400 },
    { volumePercent: 90, temperatureF: 600 },
  ];

  it('refuses without the coefficient table rather than inventing one', () => {
    // The API Technical Data Book procedure is a published table. This
    // package does not reproduce published tables from memory, which is the
    // same rule that keeps the relief chart factors as typed inputs.
    const out = d86ToTbp(d86);
    expect(out.curve).toBeNull();
    expect(out.error).toMatch(/API Technical Data Book/);
    expect(out.error).toMatch(/enter the assay as a TBP distillation/);
  });

  it('converts when the caller supplies the table, and says the result depends on it', () => {
    // Deliberately simple stand-in coefficients: the point of the test is the
    // mechanism, not the constants, which the caller owns.
    const identity = {
      fifty: { a: 1, b: 1 },
      differences: [
        { from: 50, to: 90, a: 1, b: 1 },
        { from: 50, to: 10, a: 1, b: 1 },
      ],
    };
    const out = d86ToTbp(d86, identity);
    expect(out.error).toBeNull();
    expect(out.curve.find((p) => p.volumePercent === 50).temperatureF).toBeCloseTo(400, 10);
    expect(out.curve.find((p) => p.volumePercent === 90).temperatureF).toBeCloseTo(600, 10);
    expect(out.curve.find((p) => p.volumePercent === 10).temperatureF).toBeCloseTo(200, 10);
    expect(out.note).toMatch(/only as good as that table/);
  });

  it('needs a 50 percent point to anchor on', () => {
    const out = d86ToTbp([{ volumePercent: 10, temperatureF: 200 }], { fifty: { a: 1, b: 1 }, differences: [] });
    expect(out.error).toMatch(/50 percent point/);
  });
});

describe('the whole blend, end to end', () => {
  it('carries fractions, properties, bases and the stability screen together', () => {
    const out = blendCrudes([
      { id: 'bonny', name: 'Bonny Light', api: 35.4, sulfurWtPct: 0.15, tanMgKohG: 0.3, viscosityCSt: 5, volumeFraction: 60 },
      { id: 'escravos', name: 'Escravos', api: 33.5, sulfurWtPct: 0.18, tanMgKohG: 0.25, viscosityCSt: 7, volumeFraction: 40 },
    ]);
    expect(out.fractions).toHaveLength(2);
    expect(out.fractions[0].volumeFraction).toBeCloseTo(0.6, 12);
    // Two similar light sweet crudes: everything lands between the components.
    expect(out.properties.api).toBeGreaterThan(33.5);
    expect(out.properties.api).toBeLessThan(35.4);
    expect(out.properties.sulfurWtPct).toBeGreaterThan(0.15);
    expect(out.properties.sulfurWtPct).toBeLessThan(0.18);
    expect(out.stability.stable).toBe(true);
  });

  it('refuses an empty blend rather than returning zeroes', () => {
    expect(blendCrudes([]).error).toMatch(/No components/);
  });
});
