import G from '../test-data/qi/goldens.inversionSpread.json';
import { quantilesAcross, quantileSorted, relativeSpread, addNoise } from '../engines/qi/inversionSpread';

const nan = (v) => (v == null ? NaN : v);

describe('inversion spread', () => {
  test('quantiles match numpy (type 7), gaps left out', () => {
    const R = G.realisations.map((r) => r.map(nan));
    const Q = quantilesAcross(R, G.qs);
    G.quantiles.forEach((q, j) => q.forEach((v, i) => {
      if (v == null) expect(Q[j][i]).toBeNaN();
      else expect(Q[j][i]).toBeCloseTo(v, 12);
    }));
  });
  test('anchors: 1..9 has median 5 and 10th percentile 1.8', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(quantileSorted(s, 0.5)).toBe(5);
    expect(quantileSorted(s, 0.1)).toBeCloseTo(1.8, 12);
  });
  test('negative control: a nearest-rank quantile is not what the gate accepts', () => {
    const R = G.realisations.map((r) => r.map(nan));
    const nearest = (col, q) => col[Math.round((col.length - 1) * q)];
    let differs = 0;
    for (let i = 0; i < R[0].length; i++) {
      const col = R.map((r) => r[i]).filter(Number.isFinite).sort((a, b) => a - b);
      if (col.length && G.quantiles[0][i] != null && Math.abs(nearest(col, 0.1) - G.quantiles[0][i]) > 1e-9) differs += 1;
    }
    expect(differs).toBeGreaterThan(10);
  });
  test('relative spread and refusals', () => {
    expect(Array.from(relativeSpread([9], [10], [11]))).toEqual([0.2]);
    expect(relativeSpread([9], [0], [11])[0]).toBeNaN();
    expect(() => quantilesAcross([])).toThrow();
    expect(() => quantilesAcross([[1], [1, 2]])).toThrow(/length/);
  });
  test('seeded noise: reproducible, at the stated signal-to-noise, nulls kept', () => {
    const t = Array.from({ length: 4000 }, (_, i) => Math.sin(i / 7));
    t[3] = NaN;
    const a = addNoise(t, 4, 11); const b = addNoise(t, 4, 11);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a[3]).toBeNaN();
    let sn = 0; let ss = 0; let n = 0;
    for (let i = 0; i < t.length; i++) if (Number.isFinite(t[i])) { sn += (a[i] - t[i]) ** 2; ss += t[i] ** 2; n += 1; }
    expect(Math.sqrt(ss / n) / Math.sqrt(sn / n)).toBeGreaterThan(3.8);
    expect(Math.sqrt(ss / n) / Math.sqrt(sn / n)).toBeLessThan(4.2);
    expect(() => addNoise(t, 0, 1)).toThrow();
  });
});
