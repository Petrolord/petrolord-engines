/**
 * Inversion QC at the wells against the independent oracle (QI course gate
 * E2): tools/validation/qi/oracle_qi_inversion_qc.py builds the convolutional
 * model as a dense operator, takes the scale from the exact misfit parabola,
 * low-passes by prefix sums and scores by Welford's one-pass Pearson. Every
 * assertion calls the shipped engine. The logs arrive with null for a gap, as
 * the job JSON carries them.
 */
import G from '../test-data/qi/goldens.inversionQc.json';
import { waveletScale, blindWellTable, halfWindowFor, lowPassFinite } from '../engines/qi/inversionQc';

const close = (a, b, tol) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(b)));
const same = (a, b, tol) => {
  if (b === null) { expect(Number.isFinite(a) ? a : null).toBeNull(); return; }
  close(a, b, tol);
};

test('halfWindowFor: halves round up, never below one', () => {
  expect(G.halfWindow.length).toBeGreaterThan(3);
  for (const h of G.halfWindow) expect(halfWindowFor(h.hz, h.dtMs)).toBe(h.half);
});

test('lowPassFinite: the moving mean over the finite samples, gaps left alone', () => {
  for (const c of G.lowPass) {
    const out = lowPassFinite(c.values, c.half);
    expect(out).toHaveLength(c.out.length);
    out.forEach((v, i) => same(v, c.out[i], 1e-13));
  }
});

describe('waveletScale', () => {
  test('the scale and the sample count match the oracle', () => {
    const r = waveletScale(G.waveletScale.pairs, G.wavelet);
    expect(r.samples).toBe(G.waveletScale.expect.samples);
    close(r.scale, G.waveletScale.expect.scale, 1e-11);
  });
  test('no live overlap refuses', () => {
    expect(() => waveletScale([G.waveletScale.refuse.pair], G.wavelet)).toThrow(/too little seismic/);
  });
});

describe('blindWellTable with injected estimates', () => {
  for (const c of G.blind) {
    test(`${c.absolute ? 'absolute' : 'relative'} truth at ${c.truthHz} Hz${c.lowCutHz ? `, low cut ${c.lowCutHz} Hz` : ''}`, () => {
      const calls = [];
      const invert = (trace, il, xl, exclude) => {
        const k = c.wells.findIndex((w) => w.il === il && w.xl === xl);
        calls.push([k, exclude]);
        return exclude ? c.blind[k] : c.withWell[k];
      };
      const rows = blindWellTable({ invert, wells: c.wells, traces: c.wells.map(() => null), dtMs: c.dtMs, truthHz: c.truthHz, absolute: c.absolute, ...(c.lowCutHz ? { lowCutHz: c.lowCutHz } : {}) });
      expect(calls).toEqual(c.wells.flatMap((w, k) => [[k, w.name], [k, undefined]]));
      rows.forEach((r, k) => {
        const e = c.expect[k];
        expect(r.name).toBe(e.name);
        for (const which of ['blind', 'withWell']) {
          expect(r[which].n).toBe(e[which].n);
          same(r[which].corr, e[which].corr, 1e-12);
          if (c.absolute) same(r[which].rmsPct, e[which].rmsPct, 1e-11);
          else expect(r[which].rmsPct).toBeNull();
        }
      });
    });
  }
});
