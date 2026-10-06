// Blind-well benchmark for the post-stack inversion (QI Q8a): the 2D
// impedance model of pylops' post-stack tutorial, five wells, each left out
// of the low-frequency model in turn (tools/validation/qi/oracle_inversion_benchmark.py).
// The engine must reproduce pylops' blind inversions, and the inversion must
// beat the low-frequency model alone at every well. Negative control: a
// reversed-polarity wavelet makes the result worse than the model alone.
import G from '../test-data/qi/goldens.inversionBenchmark.json';
import { forwardPoststack, modelBased, lowFrequencyModel } from '../engines/qi/inversion';
import { lfmTrace, blindWellScore } from '../engines/qi/lfm';

const nt = G.lnAi[0].length;
const grid = { t0Ms: 0, dtMs: G.dtMs, ns: nt };
const wells = G.wells.map((w) => ({ name: String(w), x: w, y: 0, t0Ms: 0, dtMs: G.dtMs, values: lowFrequencyModel(G.lnAi[w], G.lfmHalf) }));
const rmsPct = (m, truth) => blindWellScore(m, truth).rmsPct;

describe('post-stack inversion blind-well benchmark', () => {
  for (const b of G.blind) {
    const truth = G.lnAi[b.trace];
    const d = forwardPoststack(truth, G.wavelet);
    const m0 = lfmTrace(wells, { x: b.trace, y: 0 }, grid, { exclude: String(b.trace) });
    test(`well at trace ${b.trace}: the model and the inversion match pylops, and beat the model alone`, () => {
      for (let i = 0; i < nt; i++) expect(m0[i]).toBeCloseTo(b.m0[i], 7);
      const { m } = modelBased({ d, wavelet: G.wavelet, m0, eps: G.eps, iters: 2000 });
      let worst = 0;
      for (let i = 0; i < nt; i++) worst = Math.max(worst, Math.abs(m[i] - b.m[i]));
      expect(worst).toBeLessThan(1e-4);
      const err = rmsPct(m, truth);
      expect(err).toBeCloseTo(b.rmsPct, 2);
      expect(err).toBeLessThan(rmsPct(m0, truth));
      expect(err).toBeLessThan(16);
    });
  }
  test('the mean blind error over the five wells is under 10 percent', () => {
    const errs = G.blind.map((b) => b.rmsPct);
    expect(errs.reduce((a, v) => a + v, 0) / errs.length).toBeLessThan(10);
  });
  test('negative control: a reversed-polarity wavelet is worse than the model alone', () => {
    const flipped = G.wavelet.map((v) => -v);
    let worse = 0;
    for (const b of G.blind) {
      const truth = G.lnAi[b.trace];
      const d = forwardPoststack(truth, G.wavelet);
      const m0 = lfmTrace(wells, { x: b.trace, y: 0 }, grid, { exclude: String(b.trace) });
      const { m } = modelBased({ d, wavelet: flipped, m0, eps: G.eps, iters: 300 });
      if (rmsPct(m, truth) > rmsPct(m0, truth)) worse += 1;
    }
    expect(worse).toBe(G.blind.length);
  });
});
