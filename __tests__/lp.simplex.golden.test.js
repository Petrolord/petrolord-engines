/**
 * The LP kernel against an exact oracle (MD1-0).
 *
 * The golden is written by tools/validation/downstream/oracle_lp.py, which
 * solves every problem by exact rational vertex enumeration and prices every
 * row by re-solving at b +/- 1e-6 in exact arithmetic. Nothing here restates
 * the engine: every assertion calls solveLP and compares its output with a
 * number the engine had no part in producing.
 *
 * Shadow prices are held to the DEFINITION, dObjective/db_i in the problem's
 * own sense. Where the row is dual degenerate the oracle gives a left and a
 * right derivative that differ, and any value between them is correct.
 */
import fs from 'fs';
import path from 'path';
import { solveLP, LP_STATUS } from '../lib/lp/simplex.js';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'downstream', 'goldens', 'lp_cases.json'),
  'utf8',
));

const run = ({ input }) => solveLP({
  c: input.c,
  A: input.A,
  b: input.b,
  ops: input.ops,
  lo: input.lo,
  hi: input.hi.map((h) => (h === null ? Infinity : h)),
  maximize: input.maximize,
});

const TOL = 1e-7;
const close = (a, b) => Math.abs(a - b) <= TOL * Math.max(1, Math.abs(b));

describe('the golden, and what it honestly is', () => {
  it('was written by the exact oracle and says so', () => {
    expect(G.provenance.oracle).toBe('tools/validation/downstream/oracle_lp.py');
    expect(G.provenance.method).toMatch(/exact rational vertex enumeration/);
  });

  it('can discriminate: it carries optima, refusals of both kinds and binding rows with a negative rhs', () => {
    expect(G.counts.optimal).toBeGreaterThanOrEqual(40);
    expect(G.counts.infeasible).toBeGreaterThanOrEqual(5);
    expect(G.counts.unbounded).toBeGreaterThanOrEqual(3);
    // the shape that broke the dual sign: a priced row whose rhs is negative
    const negPriced = G.cases.filter((c) => c.status === 'optimal' && c.input.b.some((b, i) => b < 0
      && Math.abs(c.shadow[i].left ?? 0) > 1e-9 && Math.abs(c.shadow[i].right ?? 0) > 1e-9));
    expect(negPriced.length).toBeGreaterThanOrEqual(3);
  });
});

describe.each(G.cases.map((c) => [c.name, c]))('%s', (_name, gc) => {
  const r = run(gc);

  it('reaches the same status as the exact oracle', () => {
    expect(r.status).toBe(gc.status);
  });

  if (gc.status !== LP_STATUS.OPTIMAL) return;

  it('reaches the exact optimum', () => {
    expect(close(r.objective, gc.objective)).toBe(true);
  });

  it('returns a point that satisfies every row and bound, and costs what it says', () => {
    const { input } = gc;
    input.A.forEach((row, i) => {
      const lhs = row.reduce((s, a, j) => s + a * r.x[j], 0);
      const slack = 1e-7 * Math.max(1, Math.abs(input.b[i]));
      if (input.ops[i] === '<=') expect(lhs).toBeLessThanOrEqual(input.b[i] + slack);
      if (input.ops[i] === '>=') expect(lhs).toBeGreaterThanOrEqual(input.b[i] - slack);
      if (input.ops[i] === '=') expect(Math.abs(lhs - input.b[i])).toBeLessThanOrEqual(slack);
    });
    r.x.forEach((v, j) => {
      expect(v).toBeGreaterThanOrEqual(input.lo[j] - 1e-9);
      if (input.hi[j] !== null) expect(v).toBeLessThanOrEqual(input.hi[j] + 1e-9);
    });
    const cx = input.c.reduce((s, cj, j) => s + cj * r.x[j], 0);
    expect(close(cx, r.objective)).toBe(true);
  });

  if (gc.xUnique) {
    it('lands on the unique optimal vertex', () => {
      gc.x.forEach((v, j) => expect(close(r.x[j], v)).toBe(true));
    });
  }

  it('prices every row at dObjective/db, inside the exact one-sided derivatives', () => {
    gc.shadow.forEach(({ left, right }, i) => {
      // A row that cannot move on its own (one of two identical equalities)
      // has no derivative on either side, so it has no price to check.
      if (left === null && right === null) return;
      const p = r.shadowPrices[i];
      const lo = Math.min(left ?? right, right ?? left);
      const hi = Math.max(left ?? right, right ?? left);
      const slack = 1e-6 * Math.max(1, Math.abs(lo), Math.abs(hi));
      expect(p).toBeGreaterThanOrEqual(lo - slack);
      expect(p).toBeLessThanOrEqual(hi + slack);
    });
  });
});
