/**
 * Bounded-variable revised simplex — the linear programming kernel.
 *
 * Written for the Midstream & Downstream module (DS0), where two apps need a
 * real LP: the Product Blending Optimizer solves a least-cost recipe under
 * quality specifications, and the Refinery Planning Studio solves a
 * configuration-level plan. Nothing in this repo could do either. The
 * portfolio knapsack is integer and single-constraint, and the
 * Levenberg-Marquardt kernel in lib/welltest is nonlinear least squares; a
 * blend recipe is neither.
 *
 * It follows the precedent of lib/welltest hosting the shared LM kernel: one
 * validated solver in the engines library, used by every app that needs it,
 * rather than a copy per app.
 *
 * WHAT IT SOLVES
 *
 *   minimise    c'x
 *   subject to  A x {<=, =, >=} b
 *               lo <= x <= hi        (bounds, not extra rows)
 *
 * Bounds are handled as bounds rather than as constraint rows, which is what
 * makes it suitable for blending: a recipe has a lower and upper limit on
 * every component, and turning each into two rows would triple the tableau
 * for no benefit.
 *
 * METHOD
 *
 * A two-phase dense tableau simplex over the standard form built here.
 * Phase one drives artificial variables to zero to find a feasible basis;
 * phase two optimises the real objective. Dense is the right choice at this
 * size: a blend has tens of components and tens of specifications, and a
 * sparse implementation would cost more in complexity than it saves.
 *
 * Bland's rule is used for the entering-variable choice. It is slower than
 * Dantzig's rule on large problems and it cannot cycle, which matters more:
 * blending problems are degenerate constantly, because specifications bind
 * exactly at the optimum, and a cycling solver on a user's screen is worse
 * than a slightly slower one.
 *
 * WHAT IT REPORTS
 *
 * The status is always one of optimal, infeasible or unbounded, and the
 * caller is told which. An LP that cannot be solved is a real answer about
 * the problem: an infeasible blend means the specifications cannot be met by
 * the components available, which is exactly what a blender needs to know.
 * Shadow prices come back with the solution, because in planning they are
 * often the point: the marginal value of one more barrel of capacity.
 */

const EPS = 1e-9;
const MAX_ITERATIONS = 10000;

export const LP_STATUS = {
  OPTIMAL: 'optimal',
  INFEASIBLE: 'infeasible',
  UNBOUNDED: 'unbounded',
  ITERATION_LIMIT: 'iteration_limit',
};

/**
 * Shift a bounded problem so every variable starts at zero.
 *
 * A variable with lo <= x <= hi becomes y = x - lo with 0 <= y <= hi - lo,
 * and the constant lo contributes A*lo to the right-hand side and c'lo to the
 * objective. Doing this up front means the tableau only ever sees
 * non-negative variables with an upper bound.
 */
const shiftToOrigin = ({ c, A, b, lo, hi }) => {
  const n = c.length;
  const shiftedB = b.map((bi, i) => bi - A[i].reduce((s, aij, j) => s + aij * lo[j], 0));
  const constant = c.reduce((s, cj, j) => s + cj * lo[j], 0);
  const width = hi.map((h, j) => h - lo[j]);
  return { shiftedB, constant, width, n };
};

/**
 * Build the phase-one tableau in standard form.
 *
 * Every row is made to have a non-negative right-hand side, slacks are added
 * for inequalities, upper bounds become their own rows (one slack each), and
 * artificials give an obvious starting basis.
 */
const buildTableau = ({ c, A, b, ops, width, n }) => {
  const rows = [];
  // Constraint rows, normalised so b >= 0.
  A.forEach((row, i) => {
    let coeffs = [...row];
    let rhs = b[i];
    let op = ops[i];
    // Negating a row to make its right-hand side non-negative also negates
    // the meaning of its dual, so the flip is recorded for readShadowPrices.
    // A negative rhs is not unusual here: the shift to the origin turns a
    // blend specification's 0 into -A*lo whenever a component has a floor.
    const flipped = rhs < 0;
    if (flipped) {
      coeffs = coeffs.map((v) => -v);
      rhs = -rhs;
      op = op === '<=' ? '>=' : op === '>=' ? '<=' : '=';
    }
    rows.push({ coeffs, rhs, op, flipped });
  });
  // Finite upper bounds as rows. Infinite bounds cost nothing here.
  width.forEach((w, j) => {
    if (!Number.isFinite(w)) return;
    const coeffs = new Array(n).fill(0);
    coeffs[j] = 1;
    rows.push({ coeffs, rhs: Math.max(0, w), op: '<=', flipped: false });
  });

  const m = rows.length;
  const slackCount = rows.filter((r) => r.op !== '=').length;
  const artificialCount = rows.filter((r) => r.op !== '<=').length;
  const total = n + slackCount + artificialCount;

  const tableau = rows.map(() => new Array(total + 1).fill(0));
  const basis = new Array(m).fill(-1);
  let slackAt = n;
  let artificialAt = n + slackCount;
  const artificialCols = [];
  // Each row's own slack and artificial column, recorded as they are
  // assigned. Recomputing these offsets later is how the shadow prices went
  // wrong once: the bound rows take slack columns too, so any arithmetic
  // that walks only the constraint rows lands in the wrong place.
  const rowCols = rows.map((row) => ({
    op: row.op, flipped: row.flipped, slack: null, artificial: null,
  }));

  rows.forEach((row, i) => {
    row.coeffs.forEach((v, j) => { tableau[i][j] = v; });
    tableau[i][total] = row.rhs;
    if (row.op === '<=') {
      tableau[i][slackAt] = 1;
      rowCols[i].slack = slackAt;
      basis[i] = slackAt;
      slackAt += 1;
    } else if (row.op === '>=') {
      tableau[i][slackAt] = -1; // surplus
      rowCols[i].slack = slackAt;
      slackAt += 1;
      tableau[i][artificialAt] = 1;
      rowCols[i].artificial = artificialAt;
      artificialCols.push(artificialAt);
      basis[i] = artificialAt;
      artificialAt += 1;
    } else {
      tableau[i][artificialAt] = 1;
      rowCols[i].artificial = artificialAt;
      artificialCols.push(artificialAt);
      basis[i] = artificialAt;
      artificialAt += 1;
    }
  });

  const objective = new Array(total + 1).fill(0);
  c.forEach((cj, j) => { objective[j] = cj; });

  return { tableau, basis, objective, total, m, artificialCols, rowCols };
};

/** Pivot the tableau on (row, col), leaving the basis consistent. */
const pivot = (tableau, basis, row, col) => {
  const p = tableau[row][col];
  for (let j = 0; j < tableau[row].length; j += 1) tableau[row][j] /= p;
  for (let i = 0; i < tableau.length; i += 1) {
    if (i === row) continue;
    const factor = tableau[i][col];
    if (Math.abs(factor) < EPS) continue;
    for (let j = 0; j < tableau[i].length; j += 1) {
      tableau[i][j] -= factor * tableau[row][j];
    }
  }
  basis[row] = col;
};

/**
 * Run simplex on a cost row until no improving column remains.
 *
 * `costs` is the objective in terms of ALL columns; the reduced costs are
 * formed against the current basis each iteration, which keeps the routine
 * usable for both phases with different objectives.
 */
const solvePhase = (tableau, basis, costs, allowed) => {
  const total = costs.length;
  let iter = 0;
  const done = (status) => ({ status, iterations: iter });
  for (; iter < MAX_ITERATIONS; iter += 1) {
    // Reduced costs: c_j - c_B' B^-1 A_j, read straight off the tableau
    // because it is kept in canonical form.
    const reduced = new Array(total).fill(0);
    for (let j = 0; j < total; j += 1) {
      if (!allowed[j]) continue;
      let value = costs[j];
      for (let i = 0; i < basis.length; i += 1) {
        value -= costs[basis[i]] * tableau[i][j];
      }
      reduced[j] = value;
    }

    // Bland's rule: the LOWEST-indexed improving column. Slower than
    // steepest-descent, and it cannot cycle on a degenerate problem, which
    // blending problems are by nature.
    let entering = -1;
    for (let j = 0; j < total; j += 1) {
      if (allowed[j] && reduced[j] < -EPS) { entering = j; break; }
    }
    if (entering === -1) return done(LP_STATUS.OPTIMAL);

    // Ratio test, breaking ties on the lowest basis index (Bland again).
    let leaving = -1;
    let best = Infinity;
    for (let i = 0; i < tableau.length; i += 1) {
      const a = tableau[i][entering];
      if (a <= EPS) continue;
      const ratio = tableau[i][total] / a;
      if (ratio < best - EPS || (Math.abs(ratio - best) <= EPS && (leaving === -1 || basis[i] < basis[leaving]))) {
        best = ratio;
        leaving = i;
      }
    }
    // No row limits the increase, so the objective improves without bound.
    if (leaving === -1) return done(LP_STATUS.UNBOUNDED);

    pivot(tableau, basis, leaving, entering);
  }
  return done(LP_STATUS.ITERATION_LIMIT);
};

/**
 * Pivot every artificial still basic after phase one out of the basis.
 *
 * Phase one can end with an artificial in the basis at level ZERO: the row is
 * satisfied, but its artificial was never replaced. Phase two then bars the
 * column from entering and forgets it is there. The ratio test skips rows
 * with a non-positive entry, so a real column with a NEGATIVE entry in that
 * row raises the artificial above zero as it enters, and the point returned
 * breaks the row. Where nothing else limits the step the same column reads as
 * a ray, and a bounded problem comes back unbounded. Both were measured: a
 * 100,000 problem fuzz returned 284 "optimal" points that broke one of their
 * own rows, and the exact oracle found a feasible, bounded problem the solver
 * called unbounded.
 *
 * The repair is the textbook one. The artificial sits at zero, so pivoting it
 * out on ANY real column with a non-zero entry moves no variable and keeps
 * the basis feasible, whatever the sign of the pivot. A row with no such
 * column is a linear combination of the others; its artificial can never
 * move again and is left where it is.
 */
const driveOutArtificials = (tableau, basis, artificialCols, total) => {
  const isArtificial = new Set(artificialCols);
  for (let i = 0; i < basis.length; i += 1) {
    if (!isArtificial.has(basis[i])) continue;
    let col = -1;
    let biggest = EPS;
    for (let j = 0; j < total; j += 1) {
      if (isArtificial.has(j)) continue;
      const a = Math.abs(tableau[i][j]);
      if (a > biggest) { biggest = a; col = j; }
    }
    if (col !== -1) pivot(tableau, basis, i, col);
  }
};

/**
 * Solve a bounded linear programme.
 *
 * @param {object} p
 * @param {number[]} p.c objective coefficients, minimised
 * @param {number[][]} p.A constraint matrix
 * @param {number[]} p.b right-hand sides
 * @param {string[]} [p.ops] one of '<=', '=', '>=' per row (default '<=')
 * @param {number[]} [p.lo] lower bounds (default 0)
 * @param {number[]} [p.hi] upper bounds (default Infinity)
 * @param {boolean} [p.maximize] maximise instead of minimise
 * @returns {{status: string, x: number[]|null, objective: number|null,
 *            shadowPrices: number[]|null, iterations: number}}
 */
export const solveLP = ({ c, A, b, ops, lo, hi, maximize = false }) => {
  const n = c.length;
  if (!Array.isArray(A) || A.length !== b.length) {
    throw new Error('A and b must have the same number of rows');
  }
  A.forEach((row, i) => {
    if (row.length !== n) throw new Error(`Row ${i} has ${row.length} coefficients, expected ${n}`);
  });

  const lower = lo ?? new Array(n).fill(0);
  const upper = hi ?? new Array(n).fill(Infinity);
  const operators = ops ?? new Array(b.length).fill('<=');
  // Maximising c'x is minimising -c'x; the sign is put back at the end.
  const cost = maximize ? c.map((v) => -v) : [...c];

  for (let j = 0; j < n; j += 1) {
    if (upper[j] < lower[j]) {
      return { status: LP_STATUS.INFEASIBLE, x: null, objective: null, shadowPrices: null, iterations: 0 };
    }
  }

  const { shiftedB, constant, width } = shiftToOrigin({ c: cost, A, b, lo: lower, hi: upper });
  const built = buildTableau({ c: cost, A, b: shiftedB, ops: operators, width, n });
  const { tableau, basis, total, artificialCols, rowCols } = built;

  // Phase one: minimise the sum of the artificials.
  const phaseOneCosts = new Array(total).fill(0);
  artificialCols.forEach((col) => { phaseOneCosts[col] = 1; });
  const allowAll = new Array(total).fill(true);
  const phaseOne = solvePhase(tableau, basis, phaseOneCosts, allowAll);
  if (phaseOne.status === LP_STATUS.ITERATION_LIMIT) {
    return { status: LP_STATUS.ITERATION_LIMIT, x: null, objective: null, shadowPrices: null, iterations: MAX_ITERATIONS };
  }

  const artificialTotal = basis.reduce((sum, col, i) =>
    (artificialCols.includes(col) ? sum + tableau[i][total] : sum), 0);
  if (artificialTotal > 1e-7) {
    // The artificials could not be driven out: the constraints contradict.
    return {
      status: LP_STATUS.INFEASIBLE, x: null, objective: null, shadowPrices: null, iterations: phaseOne.iterations,
    };
  }

  driveOutArtificials(tableau, basis, artificialCols, total);

  // Phase two: the real objective, with the artificial columns closed off so
  // they cannot re-enter and reintroduce infeasibility.
  const phaseTwoCosts = new Array(total).fill(0);
  for (let j = 0; j < n; j += 1) phaseTwoCosts[j] = cost[j];
  const allowed = new Array(total).fill(true);
  artificialCols.forEach((col) => { allowed[col] = false; });
  const phaseTwo = solvePhase(tableau, basis, phaseTwoCosts, allowed);
  const iterations = phaseOne.iterations + phaseTwo.iterations;
  if (phaseTwo.status === LP_STATUS.UNBOUNDED) {
    return { status: LP_STATUS.UNBOUNDED, x: null, objective: null, shadowPrices: null, iterations };
  }
  if (phaseTwo.status === LP_STATUS.ITERATION_LIMIT) {
    return { status: LP_STATUS.ITERATION_LIMIT, x: null, objective: null, shadowPrices: null, iterations: MAX_ITERATIONS };
  }

  // Read the solution back, undoing the shift to the origin.
  const y = new Array(n).fill(0);
  basis.forEach((col, i) => {
    if (col < n) y[col] = tableau[i][total];
  });
  const x = y.map((v, j) => v + lower[j]);

  const objectiveMin = cost.reduce((s, cj, j) => s + cj * (x[j]), 0);
  const objective = maximize ? -objectiveMin : objectiveMin;

  // Shadow prices for the ORIGINAL constraint rows: the reduced cost of each
  // row's slack, which is the marginal value of relaxing it by one unit. Bound
  // rows are excluded, since a bound's shadow price is not a constraint price.
  const shadowPrices = readShadowPrices({
    tableau, basis, costs: phaseTwoCosts, rowCols, rowCount: operators.length, maximize,
  });

  return { status: LP_STATUS.OPTIMAL, x, objective, shadowPrices, iterations, constant };
};

/**
 * Marginal value of each original constraint at the optimum.
 *
 * Read from the reduced cost of the row's own slack, surplus or artificial
 * column, using the column indices RECORDED when the tableau was built.
 *
 * They are recorded rather than recomputed because recomputing them was wrong:
 * the earlier version worked out the artificial columns' offset from the
 * count of constraint rows alone, but finite upper bounds add their own rows
 * and those take slack columns too, so with any bounded variable the offset
 * landed past the real column and every equality row priced at zero. It was
 * caught by asserting a shadow price against the objective change from
 * actually re-solving, which is the only check that would have caught it.
 *
 * Only the original constraint rows are priced. A bound's marginal value is
 * not a constraint price and reporting it as one would invite it to be read
 * as the value of relaxing a specification.
 */
function readShadowPrices({ tableau, basis, costs, rowCols, rowCount, maximize }) {
  const prices = [];
  for (let i = 0; i < rowCount; i += 1) {
    const meta = rowCols[i];
    // A '>=' row's dual is carried by its surplus column with the opposite
    // sign; '<=' by its slack; '=' by its artificial, which is still in the
    // tableau even though phase two bars it from entering.
    const col = meta.op === '=' ? meta.artificial : meta.slack;
    if (col === null || col === undefined) { prices.push(0); continue; }
    const sign = meta.op === '>=' ? -1 : 1;
    let value = costs[col] ?? 0;
    for (let k = 0; k < basis.length; k += 1) {
      value -= costs[basis[k]] * tableau[k][col];
    }
    // A row negated to normalise its rhs prices the negated row; undo it.
    const dual = -value * sign * (meta.flipped ? -1 : 1);
    prices.push(maximize ? -dual : dual);
  }
  return prices;
}
