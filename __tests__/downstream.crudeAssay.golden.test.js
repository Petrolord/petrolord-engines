/**
 * Crude assay against an independent oracle (MD1-0).
 *
 * The golden is written by tools/validation/downstream/oracle_crudeassay.py,
 * which works in CARGOES (barrels and pounds, never fractions), inverts the
 * Refutas index by bisection, takes cut yields as a segment-overlap sum and
 * finds T50 by bisection. Every assertion calls the engine.
 */
import fs from 'fs';
import path from 'path';
import {
  blendCrudes, cutYields, volumePercentAt, temperatureAtVolumePercent,
  blendDistillationCurves, watsonK, netbackValue, sgFromApi, apiFromSg,
  CII_BANDS, viscosityBlendIndex, screenBlendStability,
} from '../engines/downstream/crudeAssay.js';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'downstream', 'goldens', 'crudeassay_cases.json'),
  'utf8',
));

const rel = (a, b, tol = 1e-10) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

describe('the golden, and what it honestly is', () => {
  it('was written by the oracle and says the crudes are illustrative', () => {
    expect(G.provenance.oracle).toBe('tools/validation/downstream/oracle_crudeassay.py');
    expect(G.provenance.published).toMatch(/illustrative/);
  });

  it('can discriminate: all three CII bands, a truncated curve and an off-grid T50', () => {
    const bands = G.blends.filter((b) => 'stable' in b).map((b) => b.stable);
    expect(bands).toEqual(expect.arrayContaining([true, null, false]));
    expect(G.curves.some((c) => c.unknownCount > 0)).toBe(true);
    expect(Math.abs(G.blendedDefault.appGridT50F - G.blendedDefault.t50F)).toBeGreaterThan(50);
  });
});

describe('held definitions: PINNED against literals, not validated', () => {
  it('API and specific gravity', () => {
    expect(sgFromApi(10)).toBe(1);
    expect(sgFromApi(0)).toBeCloseTo(141.5 / 131.5, 15);
    expect(apiFromSg(1)).toBeCloseTo(10, 12);
  });
  it('Refutas pair', () => {
    expect(G.provenance.heldConstants.refutasA).toBe(14.534);
    expect(G.provenance.heldConstants.refutasB).toBe(10.975);
    expect(viscosityBlendIndex(Math.E - 0.8)).toBeCloseTo(10.975, 10);
    expect(viscosityBlendIndex(Math.exp(Math.E) - 0.8)).toBeCloseTo(25.509, 10);
  });
  it('Watson K in degrees Rankine', () => {
    expect(watsonK({ meanBoilingPointF: 1000 - 459.67, sg: 1 })).toBeCloseTo(10, 12);
  });
  it('CII bands', () => {
    expect(CII_BANDS).toEqual({ STABLE: 0.7, UNSTABLE: 0.9 });
    expect(G.provenance.heldConstants.ciiStable).toBe(0.7);
    expect(G.provenance.heldConstants.ciiUnstable).toBe(0.9);
  });
});

describe.each(G.blends.map((b) => [b.name, b]))('blend: %s', (_n, gb) => {
  const out = blendCrudes(gb.components);

  it('carries the cargo fractions on both bases', () => {
    gb.volumeFractions.forEach((v, i) => expect(rel(out.fractions[i].volumeFraction, v)).toBe(true));
    gb.massFractions.forEach((m, i) => expect(rel(out.fractions[i].massFraction, m)).toBe(true));
  });

  it('reports every property as the cargo inventory gives it', () => {
    Object.entries(gb.properties).forEach(([k, v]) => {
      if (v === null) {
        expect(out.properties[k]).toBeNull();
      } else {
        expect(rel(out.properties[k], v, k === 'viscosityCSt' ? 1e-9 : 1e-11)).toBe(true);
      }
    });
  });

  if ('cii' in gb) {
    it('forms the colloidal instability index from the blended SARA, and lands in its band', () => {
      expect(out.stability.basis).toBe('cii');
      expect(rel(out.stability.cii, gb.cii)).toBe(true);
      expect(out.stability.stable).toBe(gb.stable);
    });
  }
});

describe.each(G.curves.map((c) => [c.name, c]))('curve: %s', (_n, gc) => {
  const out = cutYields({ curve: gc.curve, cuts: gc.cuts });

  it('gives each cut the segment-overlap yield, or none where the curve says nothing', () => {
    gc.rows.forEach((row, i) => {
      if (row.yieldVolPercent === null) {
        expect(out.cuts[i].yieldVolPercent).toBeNull();
      } else {
        expect(rel(out.cuts[i].yieldVolPercent, row.yieldVolPercent, 1e-12)).toBe(true);
      }
    });
    expect(out.unknownCuts).toHaveLength(gc.unknownCount);
    if (gc.unknownCount > 0) expect(out.closes).toBe(false);
  });

  it('answers volumePercentAt inside the curve and refuses outside it', () => {
    gc.probes.forEach(({ t, v }) => {
      const got = volumePercentAt(gc.curve, t);
      if (v === null) expect(got).toBeNull();
      else expect(rel(got, v, 1e-12)).toBe(true);
    });
  });
});

describe('the blended curve the studio draws', () => {
  const g = G.blendedDefault;
  const light = G.blends[0].components[0];
  const sour = G.blends[0].components[1];
  const lightCurve = G.curves[0].curve;
  const sourCurve = G.curves[1].curve;
  const blend = blendCrudes([light, sour]);
  const curve = blendDistillationCurves(
    [{ curve: lightCurve }, { curve: sourCurve }],
    blend.fractions.map((f) => f.volumeFraction),
  );

  it('is formed from barrels distilled at every measured temperature', () => {
    expect(curve).toHaveLength(g.curve.length);
    g.curve.forEach((p, i) => {
      expect(curve[i].temperatureF).toBe(p.temperatureF);
      expect(rel(curve[i].volumePercent, p.volumePercent, 1e-12)).toBe(true);
    });
  });

  it('puts T50 where bisection on the blend puts it, well off the grid point the app used', () => {
    const t50 = temperatureAtVolumePercent(curve, 50);
    expect(rel(t50, g.t50F, 1e-9)).toBe(true);
    expect(Math.abs(t50 - g.appGridT50F)).toBeGreaterThan(50);
  });

  it('gives Watson K at the interpolated T50', () => {
    const k = watsonK({ meanBoilingPointF: temperatureAtVolumePercent(curve, 50), sg: blend.properties.sg });
    expect(rel(k, g.watsonKAtT50, 1e-9)).toBe(true);
  });

  it('values the blend by the cargo account', () => {
    const yields = cutYields({ curve, cuts: G.curves[0].cuts });
    g.yields.forEach((y, i) => expect(rel(yields.cuts[i].yieldVolPercent, y.yieldVolPercent, 1e-12)).toBe(true));
    const nb = netbackValue({ cuts: yields.cuts, ...g.netbackInputs });
    expect(rel(nb.grossValue, g.netback.grossValue, 1e-12)).toBe(true);
    expect(rel(nb.lossValue, g.netback.lossValue, 1e-12)).toBe(true);
    expect(rel(nb.netback, g.netback.netback, 1e-12)).toBe(true);
    expect(nb.assumedZero).toEqual([]);
  });

  it('leaves out a temperature where one crude says nothing', () => {
    const truncated = G.curves[2].curve;
    const out = blendDistillationCurves([{ curve: lightCurve }, { curve: truncated }], [0.5, 0.5]);
    expect(out.map((p) => p.temperatureF)).toEqual(G.blendedWithTruncated.curve.map((p) => p.temperatureF));
    out.forEach((p, i) => expect(rel(p.volumePercent, G.blendedWithTruncated.curve[i].volumePercent, 1e-12)).toBe(true));
  });
});

describe('the inputs that used to fail open', () => {
  const [light, sour] = G.blends[0].components;

  it('does not read a blank sulfur as a sulfur-free crude', () => {
    const out = blendCrudes([light, { ...sour, sulfurWtPct: undefined }]);
    expect(out.properties.sulfurWtPct).toBeNull();
    expect(out.missing.sulfurWtPct).toEqual(['Medium sour (example)']);
    expect(out.bases.sulfurWtPct).toMatch(/not blended/);
  });

  it('refuses a crude with no gravity, a mixed basis and a negative share', () => {
    expect(blendCrudes([light, { ...sour, api: undefined }]).error).toMatch(/No API or specific gravity/);
    const { volumeFraction, ...byMass } = sour;
    expect(blendCrudes([light, { ...byMass, massFraction: 40 }]).error).toMatch(/cannot be mixed/);
    expect(blendCrudes([light, { ...sour, volumeFraction: -10 }]).error).toMatch(/zero or more/);
  });

  it('does not pass a crude with no API through the gravity-contrast screen as stable', () => {
    const out = screenBlendStability({ components: [{ api: 18 }, {}], massFractions: [0.5, 0.5] });
    expect(out.stable).toBeNull();
    expect(out.basis).toBe('none');
  });

  it('names a cost left blank rather than hiding the zero, and refuses a loss over 100 percent', () => {
    const cuts = [{ id: 'a', name: 'A', yieldVolPercent: 100 }];
    expect(netbackValue({ cuts, prices: { a: 80 } }).assumedZero).toEqual(['processing cost', 'freight', 'losses']);
    expect(netbackValue({ cuts, prices: { a: 80 }, lossPercent: 120 }).error).toMatch(/between 0 and 100/);
  });
});
