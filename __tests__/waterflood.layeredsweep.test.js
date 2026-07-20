/**
 * Layered sweep engine: Dykstra-Parsons and Stiles.
 *
 * Goldens are hand-computed from the published formulas (Dykstra & Parsons
 * 1950; Stiles 1949; forms as in Willhite "Waterflooding" SPE Textbook Vol.3
 * and Ahmed "Reservoir Engineering Handbook" Ch.14) with the arithmetic shown
 * in comments; V recovery uses an exactly log-normal synthetic distribution
 * so the answer is known in closed form.
 */
import {
  analyzeDykstraParsons,
  analyzeLayeredSweep,
  analyzeStiles,
  dpFrontPosition,
  dykstraParsonsV,
  inverseNormal,
  normalizeLayers,
  sampleLayeredData,
} from '../engines/waterflood/layeredSweep.js';

describe('inverseNormal', () => {
  it('hits the standard anchors', () => {
    expect(inverseNormal(0.5)).toBeCloseTo(0, 8);
    expect(inverseNormal(0.841345)).toBeCloseTo(1.0, 4); // Phi(1) = 0.8413447
    expect(inverseNormal(0.977250)).toBeCloseTo(2.0, 4); // Phi(2) = 0.9772499
    expect(inverseNormal(0.158655)).toBeCloseTo(-1.0, 4);
  });

  it('is antisymmetric about 0.5 and NaN outside (0,1)', () => {
    expect(inverseNormal(0.3)).toBeCloseTo(-inverseNormal(0.7), 8);
    expect(Number.isNaN(inverseNormal(0))).toBe(true);
    expect(Number.isNaN(inverseNormal(1))).toBe(true);
  });
});

describe('dykstraParsonsV', () => {
  it('recovers sigma exactly from an exactly log-normal layer set: V = 1 - exp(-sigma)', () => {
    // Construct k_i = k50 * exp(-sigma * z_i) at the exact plotting positions
    // used by the fit, so the regression is exact: sigma = 0.8, k50 = 150.
    const sigma = 0.8;
    const k50 = 150;
    const n = 20;
    const ks = [];
    for (let i = 0; i < n; i++) {
      const p = (i + 0.5) / n; // portion with larger k
      ks.push(k50 * Math.exp(-sigma * inverseNormal(p)));
    }
    const res = dykstraParsonsV(ks);
    expect(res.sigma).toBeCloseTo(sigma, 6);
    expect(res.k50).toBeCloseTo(k50, 4);
    expect(res.V).toBeCloseTo(1 - Math.exp(-sigma), 6); // 0.550671
  });

  it('V = 0 for a homogeneous layer set and errors on degenerate input', () => {
    const res = dykstraParsonsV([100, 100, 100, 100]);
    expect(res.V).toBeCloseTo(0, 8);
    expect(dykstraParsonsV([100, 200]).error).toBeTruthy();
    expect(dykstraParsonsV([]).error).toBeTruthy();
  });
});

describe('dpFrontPosition', () => {
  it('hand values: M=2 ratio 0.5 -> (2 - sqrt(2.5))/1 = 0.41886; M=0.5 ratio 0.5 -> 0.58114', () => {
    // M=2:   disc = 4 + 0.5*(1-4) = 2.5;  x = (2 - 1.581139)/(2-1) = 0.418861
    // M=0.5: disc = 0.25 + 0.5*0.75 = 0.625; x = (0.5 - 0.790569)/(-0.5) = 0.581139
    expect(dpFrontPosition(0.5, 2)).toBeCloseTo(0.418861, 5);
    expect(dpFrontPosition(0.5, 0.5)).toBeCloseTo(0.581139, 5);
  });

  it('M -> 1 limit gives x = k ratio, and a broken layer sits at 1', () => {
    expect(dpFrontPosition(0.5, 1)).toBeCloseTo(0.5, 10);
    expect(dpFrontPosition(0.5, 1 + 1e-7)).toBeCloseTo(0.5, 4);
    expect(dpFrontPosition(1, 2)).toBe(1);
  });

  it('a favorable mobility ratio evens out the front positions', () => {
    expect(dpFrontPosition(0.5, 0.5)).toBeGreaterThan(dpFrontPosition(0.5, 1.0001));
  });
});

describe('analyzeDykstraParsons', () => {
  it('two-layer hand calculation at first breakthrough (M=2)', () => {
    // Layers (h=1, k=200) and (h=1, k=100), M=2. At BT of layer 1:
    //   x2 = dpFrontPosition(0.5, 2) = 0.418861
    //   coverage = (1 + 0.418861)/2 = 0.709430
    //   oil conductance of layer 2 = k*h/(x + M(1-x))
    //     = 100/(0.418861 + 2*0.581139) = 100/1.581139
    //   WOR = 200 / (100/1.581139) = 3.162278
    const { stages } = analyzeDykstraParsons({ layers: [{ h: 1, k: 200 }, { h: 1, k: 100 }], M: 2 });
    expect(stages[0].coverage).toBeCloseTo(0.709430, 5);
    expect(stages[0].WOR).toBeCloseTo(3.162278, 5);
    expect(stages[1].coverage).toBeCloseTo(1, 10);
    expect(stages[1].WOR).toBe(Infinity);
  });

  it('coverage and WOR increase stage over stage', () => {
    const { stages } = analyzeDykstraParsons({ layers: sampleLayeredData().layers, M: 2.5 });
    for (let i = 1; i < stages.length; i++) {
      expect(stages[i].coverage).toBeGreaterThan(stages[i - 1].coverage);
      expect(stages[i].WOR).toBeGreaterThan(stages[i - 1].WOR);
    }
  });

  it('favorable mobility ratio improves first-breakthrough coverage', () => {
    const layers = sampleLayeredData().layers;
    const fav = analyzeDykstraParsons({ layers, M: 0.5 }).stages[0].coverage;
    const unfav = analyzeDykstraParsons({ layers, M: 4 }).stages[0].coverage;
    expect(fav).toBeGreaterThan(unfav);
  });

  it('guards degenerate input', () => {
    expect(analyzeDykstraParsons({ layers: [{ h: 1, k: 100 }], M: 2 }).stages).toEqual([]);
    expect(analyzeDykstraParsons({ layers: sampleLayeredData().layers, M: 0 }).stages).toEqual([]);
  });
});

describe('analyzeStiles', () => {
  it('two-layer hand calculation at first breakthrough (A=1.5)', () => {
    // Layers (h=1, k=200) and (h=1, k=100). At BT of layer 1 (Stiles
    // kinematics x2 = k2/k1 = 0.5):
    //   coverage = (1 + 0.5)/2 = 0.75
    //   Ci = 200, Ct = 300 -> fws = 1.5*200/(1.5*200 + 100) = 300/400 = 0.75
    const { stages } = analyzeStiles({ layers: [{ h: 1, k: 200 }, { h: 1, k: 100 }], A: 1.5 });
    expect(stages[0].coverage).toBeCloseTo(0.75, 10);
    expect(stages[0].waterCut).toBeCloseTo(0.75, 10);
    expect(stages[1].coverage).toBeCloseTo(1, 10);
    expect(stages[1].waterCut).toBeCloseTo(1, 10);
  });

  it('coverage and water cut increase stage over stage', () => {
    const { stages } = analyzeStiles({ layers: sampleLayeredData().layers, A: 1.5 });
    for (let i = 1; i < stages.length; i++) {
      expect(stages[i].coverage).toBeGreaterThan(stages[i - 1].coverage);
      expect(stages[i].waterCut).toBeGreaterThan(stages[i - 1].waterCut);
    }
  });

  it('Stiles equals Dykstra-Parsons coverage in the M=1 limit', () => {
    const layers = sampleLayeredData().layers;
    const stiles = analyzeStiles({ layers, A: 1 }).stages.map((s) => s.coverage);
    const dp = analyzeDykstraParsons({ layers, M: 1 }).stages.map((s) => s.coverage);
    stiles.forEach((c, i) => expect(c).toBeCloseTo(dp[i], 10));
  });
});

describe('analyzeLayeredSweep orchestrator', () => {
  it('returns V, both stage tables, sorted layers, and merged warnings', () => {
    const res = analyzeLayeredSweep(sampleLayeredData());
    expect(res.V.V).toBeGreaterThan(0);
    expect(res.V.V).toBeLessThan(1);
    expect(res.dykstraParsons.length).toBe(5);
    expect(res.stiles.length).toBe(5);
    expect(res.layers[0].k).toBeGreaterThan(res.layers[4].k);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('normalizeLayers drops invalid rows and sorts by k descending', () => {
    const L = normalizeLayers([{ h: 1, k: 10 }, { h: -1, k: 50 }, { h: 2, k: 'x' }, { h: 3, k: 90 }]);
    expect(L).toEqual([{ h: 3, k: 90 }, { h: 1, k: 10 }]);
  });
});
