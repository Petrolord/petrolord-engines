// The IRR contract's NPV by Horner's rule (2026-10-14): the EPE Monte Carlo
// solves an IRR every iteration and the band sweep evaluates the NPV a few
// thousand times per IRR; 1,000 Ekene iterations hit the Edge Function's
// compute limit. The Horner form must give the same NPV as the plain sum at
// every rate, for year-end, mid-year and shifted exponents, and the solver's
// answers must not move.
import { makeNpvAtRate, solveIrrInBand } from '../engines/economics/irrContract.js';

const plain = (flows: number[], times: number[]) => (r: number) => flows.reduce((s, cf, k) => s + cf / Math.pow(1 + r, times[k]), 0);
const EKENE = [738681, -7895703, 4268671, 3452648, 2940200, 2410508, 1069441, 572917, 344892, 219787, 101107, -6841988];

describe('makeNpvAtRate', () => {
  const cases: Array<[string, number[]]> = [
    ['year-end from 0', EKENE.map((_, i) => i)],
    ['mid-year (-0.5)', EKENE.map((_, i) => i - 0.5)],
    ['valuation shifted (-3)', EKENE.map((_, i) => i - 3)],
    ['first year discounted (+1)', EKENE.map((_, i) => i + 1)],
  ];
  for (const [name, times] of cases) {
    it(`matches the plain sum: ${name}`, () => {
      const f = makeNpvAtRate(EKENE, times);
      const g = plain(EKENE, times);
      for (const r of [-0.95, -0.5, -0.1, 0, 0.05, 0.1, 0.2491, 0.5, 1, 3, 9.99]) {
        const scale = Math.abs(g(r)) + 1;
        expect(Math.abs(f(r) - g(r)) / scale).toBeLessThan(1e-9);
      }
    });
  }
  it('falls back to the plain sum on uneven exponents', () => {
    const times = [0, 0.3, 1.7, 2];
    const flows = [-10, 3, 5, 6];
    expect(makeNpvAtRate(flows, times)(0.1)).toBe(plain(flows, times)(0.1));
  });
  it('the Ekene roots are unchanged (multiple roots, the field case)', () => {
    const r = solveIrrInBand(EKENE, EKENE.map((_, i) => i));
    expect(r.irrStatus).toBe('multiple-roots');
    for (const root of r.irrRoots as number[]) {
      expect(Math.abs(plain(EKENE, EKENE.map((_, i) => i))(root / 100))).toBeLessThan(1e-3 * EKENE.reduce((s, c) => s + Math.abs(c), 0));
    }
  });
});
