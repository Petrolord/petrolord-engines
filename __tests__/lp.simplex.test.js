/**
 * LP kernel validation (Midstream & Downstream DS0).
 *
 * Two apps in the module will hand this solver decisions worth money: a
 * least-cost blend recipe and a refinery plan. So it is checked against
 * published textbook LPs whose optima are known exactly, against the
 * pathological cases that break naive simplex implementations, and against
 * the identities any correct LP solution must satisfy whatever the problem.
 *
 * Sources for the worked cases are named on each test. Where a case is
 * hand-derived rather than quoted, it says so.
 */
import { solveLP, LP_STATUS } from '../lib/lp/simplex.js';

const close = (a, b, dp = 6) => expect(a).toBeCloseTo(b, dp);

describe('published textbook cases', () => {
  it('solves the standard product-mix LP (Hillier & Lieberman, Wyndor Glass)', () => {
    // max 3x + 5y  s.t.  x <= 4, 2y <= 12, 3x + 2y <= 18
    // The known optimum is 36 at (2, 6).
    const r = solveLP({
      c: [3, 5],
      A: [[1, 0], [0, 2], [3, 2]],
      b: [4, 12, 18],
      ops: ['<=', '<=', '<='],
      maximize: true,
    });
    expect(r.status).toBe(LP_STATUS.OPTIMAL);
    close(r.objective, 36);
    close(r.x[0], 2);
    close(r.x[1], 6);
  });

  it('solves a minimisation with greater-than rows (a diet-problem shape)', () => {
    // min 2x + 3y  s.t.  x + y >= 10, x >= 3, y >= 2
    // Cheapest is to take as much of the cheaper variable as allowed:
    // x = 8, y = 2, cost 22. Hand-derived.
    const r = solveLP({
      c: [2, 3],
      A: [[1, 1], [1, 0], [0, 1]],
      b: [10, 3, 2],
      ops: ['>=', '>=', '>='],
    });
    expect(r.status).toBe(LP_STATUS.OPTIMAL);
    close(r.objective, 22);
    close(r.x[0], 8);
    close(r.x[1], 2);
  });

  it('handles equality rows', () => {
    // min x + y  s.t.  x + y = 5, x - y = 1  =>  x = 3, y = 2, cost 5.
    const r = solveLP({
      c: [1, 1],
      A: [[1, 1], [1, -1]],
      b: [5, 1],
      ops: ['=', '='],
    });
    expect(r.status).toBe(LP_STATUS.OPTIMAL);
    close(r.x[0], 3);
    close(r.x[1], 2);
    close(r.objective, 5);
  });
});

describe('bounds are bounds, not extra rows', () => {
  it('respects a lower bound above zero', () => {
    // min x  with  x >= 2 as a BOUND and one dummy row.
    const r = solveLP({
      c: [1],
      A: [[1]],
      b: [100],
      ops: ['<='],
      lo: [2],
      hi: [10],
    });
    expect(r.status).toBe(LP_STATUS.OPTIMAL);
    close(r.x[0], 2);
    close(r.objective, 2);
  });

  it('respects an upper bound when the objective pushes against it', () => {
    const r = solveLP({
      c: [1],
      A: [[1]],
      b: [100],
      ops: ['<='],
      lo: [0],
      hi: [7],
      maximize: true,
    });
    expect(r.status).toBe(LP_STATUS.OPTIMAL);
    close(r.x[0], 7);
  });

  it('reports infeasible when a lower bound exceeds its upper bound', () => {
    const r = solveLP({ c: [1], A: [[1]], b: [10], ops: ['<='], lo: [5], hi: [3] });
    expect(r.status).toBe(LP_STATUS.INFEASIBLE);
    expect(r.x).toBeNull();
  });
});

describe('the answers that are not a solution', () => {
  it('reports infeasible on contradictory constraints rather than returning a number', () => {
    // x >= 10 and x <= 5 cannot both hold. A blender needs to be told the
    // specifications cannot be met, not handed a recipe that misses them.
    const r = solveLP({
      c: [1],
      A: [[1], [1]],
      b: [10, 5],
      ops: ['>=', '<='],
      hi: [Infinity],
    });
    expect(r.status).toBe(LP_STATUS.INFEASIBLE);
    expect(r.objective).toBeNull();
  });

  it('reports unbounded when the objective can improve forever', () => {
    // max x with only x >= 0 and no upper limit.
    const r = solveLP({
      c: [1],
      A: [[0]],
      b: [0],
      ops: ['<='],
      hi: [Infinity],
      maximize: true,
    });
    expect(r.status).toBe(LP_STATUS.UNBOUNDED);
    expect(r.x).toBeNull();
  });
});

describe('degeneracy, which blending problems produce constantly', () => {
  it('terminates on a degenerate problem instead of cycling', () => {
    // Specifications binding exactly at the optimum give a degenerate vertex.
    // Bland's rule is the reason this returns at all.
    const r = solveLP({
      c: [1, 1, 1],
      A: [
        [1, 1, 0],
        [0, 1, 1],
        [1, 0, 1],
        [1, 1, 1],
      ],
      b: [1, 1, 1, 1.5],
      ops: ['<=', '<=', '<=', '<='],
      maximize: true,
    });
    expect(r.status).toBe(LP_STATUS.OPTIMAL);
    close(r.objective, 1.5);
  });

  it('solves Beale\'s cycling example, which defeats Dantzig\'s rule', () => {
    // The classic three-constraint cycling LP. Any finite answer here is
    // evidence the anti-cycling rule is doing its job.
    const r = solveLP({
      c: [0.75, -150, 0.02, -6],
      A: [
        [0.25, -60, -0.04, 9],
        [0.5, -90, -0.02, 3],
        [0, 0, 1, 0],
      ],
      b: [0, 0, 1],
      ops: ['<=', '<=', '<='],
      maximize: true,
    });
    expect(r.status).toBe(LP_STATUS.OPTIMAL);
    expect(Number.isFinite(r.objective)).toBe(true);
  });
});

describe('a blending problem, which is what this is for', () => {
  // Three components blended to 100 units, meeting a minimum octane and a
  // maximum sulfur, at least cost. Hand-set so the answer is checkable:
  // the cheap component fails octane alone, so the optimum mixes it with
  // just enough of the expensive high-octane one.
  const blend = {
    // cost per unit
    c: [30, 45, 38],
    A: [
      [1, 1, 1],          // total volume
      [88, 98, 92],       // octane (blended linearly by volume here)
      [0.5, 0.02, 0.2],   // sulfur, percent
    ],
    b: [100, 9100, 25],
    ops: ['=', '>=', '<='],
    lo: [0, 0, 0],
    hi: [100, 100, 100],
  };

  it('finds a recipe that meets every specification', () => {
    const r = solveLP(blend);
    expect(r.status).toBe(LP_STATUS.OPTIMAL);

    const volume = r.x.reduce((s, v) => s + v, 0);
    close(volume, 100, 6);

    const octane = blend.A[1].reduce((s, a, j) => s + a * r.x[j], 0);
    expect(octane).toBeGreaterThanOrEqual(9100 - 1e-6);

    const sulfur = blend.A[2].reduce((s, a, j) => s + a * r.x[j], 0);
    expect(sulfur).toBeLessThanOrEqual(25 + 1e-6);
  });

  it('costs exactly what the recipe it returned costs', () => {
    // The identity that matters: the reported objective is the recipe's own
    // cost, not a number carried separately.
    const r = solveLP(blend);
    const cost = blend.c.reduce((s, cj, j) => s + cj * r.x[j], 0);
    close(r.objective, cost, 6);
  });

  it('never returns a negative quantity of a component', () => {
    const r = solveLP(blend);
    r.x.forEach((v) => expect(v).toBeGreaterThanOrEqual(-1e-9));
  });

  it('says infeasible when the specification cannot be met by these components', () => {
    // No component reaches 99 octane, so no mixture can.
    const impossible = { ...blend, b: [100, 9900, 25] };
    expect(solveLP(impossible).status).toBe(LP_STATUS.INFEASIBLE);
  });
});

describe('shadow prices', () => {
  it('prices a binding constraint and leaves a slack one at zero', () => {
    // Wyndor again: at the optimum, rows 2 and 3 bind and row 1 does not.
    const r = solveLP({
      c: [3, 5],
      A: [[1, 0], [0, 2], [3, 2]],
      b: [4, 12, 18],
      ops: ['<=', '<=', '<='],
      maximize: true,
    });
    expect(r.status).toBe(LP_STATUS.OPTIMAL);
    // x = 2 < 4, so the first row has slack and is worth nothing at the margin.
    close(r.shadowPrices[0], 0, 6);
    // The published duals for this problem are 0, 1.5 and 1.
    close(r.shadowPrices[1], 1.5, 6);
    close(r.shadowPrices[2], 1, 6);
  });

  it('matches the objective change from relaxing a binding row by one unit', () => {
    // The definition of a shadow price, checked by actually re-solving.
    const base = {
      c: [3, 5],
      A: [[1, 0], [0, 2], [3, 2]],
      b: [4, 12, 18],
      ops: ['<=', '<=', '<='],
      maximize: true,
    };
    const r0 = solveLP(base);
    const r1 = solveLP({ ...base, b: [4, 13, 18] });
    close(r1.objective - r0.objective, r0.shadowPrices[1], 6);
  });
});

describe('input validation', () => {
  it('refuses a row whose width does not match the objective', () => {
    expect(() => solveLP({ c: [1, 2], A: [[1]], b: [1] })).toThrow(/coefficients/);
  });

  it('refuses a right-hand side that does not match the matrix', () => {
    expect(() => solveLP({ c: [1], A: [[1], [1]], b: [1] })).toThrow(/same number of rows/);
  });
});

describe('shadow prices with bounded variables, which is where they went wrong', () => {
  // The reader used to work out the artificial columns' offset from the count
  // of constraint rows. Finite upper bounds add their own rows and those take
  // slack columns too, so with any bounded variable the offset landed past
  // the real column and every EQUALITY row priced at zero. It surfaced in the
  // blending optimiser, where the total-volume row is an equality and every
  // component is bounded, and it made the marginal cost of a barrel read as
  // nothing. This pins it at the kernel.
  const problem = {
    c: [92, 84, 55],
    A: [[1, 1, 1]],
    b: [1000],
    ops: ['='],
    lo: [0, 0, 0],
    hi: [1000, 1000, 100],
  };

  it('prices an equality row when the variables are bounded', () => {
    const r = solveLP(problem);
    expect(r.status).toBe(LP_STATUS.OPTIMAL);
    expect(r.shadowPrices[0]).not.toBe(0);
  });

  it('matches the objective change from asking for one more unit', () => {
    // The definition, checked by re-solving. Nothing else would have caught
    // the offset bug.
    const base = solveLP(problem);
    const more = solveLP({ ...problem, b: [1001] });
    close(more.objective - base.objective, base.shadowPrices[0], 6);
  });

  it('still prices inequality rows correctly alongside bounds', () => {
    const mixed = solveLP({
      c: [3, 5],
      A: [[1, 0], [0, 2], [3, 2]],
      b: [4, 12, 18],
      ops: ['<=', '<=', '<='],
      hi: [100, 100],
      maximize: true,
    });
    close(mixed.shadowPrices[1], 1.5, 6);
    close(mixed.shadowPrices[2], 1, 6);
  });
});
