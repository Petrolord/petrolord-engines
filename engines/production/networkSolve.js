/**
 * Pressure-driven network solver for a gathering system
 * (Production Operations P11).
 *
 * THE QUESTION THIS EXISTS TO ANSWER. Every single-well studio in this
 * platform solves one well against a wellhead pressure it was TOLD.
 * In a real gathering system nobody tells it: the header pressure is
 * whatever the trunk line needs to carry the total, and the total is
 * the sum of what the wells make at that header pressure. The wells set
 * the pressure that holds the wells back. They fight each other, and no
 * amount of single-well analysis will show it.
 *
 * FORMULATION. Unknowns are the PRESSURES at every well and junction
 * node; the delivery point is a fixed-pressure boundary. One equation
 * per unknown: mass balance at that node. Square system, solved by
 * Newton with a numerical Jacobian and a backtracking line search on
 * the residual norm.
 *
 * Node kinds:
 *   well      injects q(p) -- more when the header is lower. Its
 *             pressure is unknown.
 *   junction  a header, a manifold, a tee. Injects nothing; everything
 *             that arrives leaves. Pressure unknown.
 *   sink      the separator or the delivery point. Pressure FIXED; it
 *             takes whatever arrives.
 *
 * THE BRANCH RELATIONS ARE CALLBACKS, and that is the whole point of
 * putting this module in the engine package: the topology, the Newton
 * solve and the conservation laws have nothing to do with petroleum,
 * and can therefore be checked EXACTLY. Give the solver linear
 * resistances and its answer must equal the linear-algebra solution of
 * a weighted graph Laplacian to twelve figures -- not a physical
 * tolerance anyone chose, just what double precision and a central
 * difference leave behind. The consumer supplies the real relations: a validated
 * two-phase traverse for a pipe, an IPR met against a VLP for a well.
 *
 * MASS IS THE CURRENCY. Every flow in here is a mass rate, lb/d.
 * Surface volumes do not add across pressures and mixing two of them is
 * a mistake that hides for a long time; mass adds everywhere and always.
 * The component split rides along separately (see propagateStreams) and
 * is recovered at the end.
 *
 * Signs: a branch flow is positive from `from` to `to`. A well inflow
 * is positive INTO the network. At convergence, the net at every
 * unknown node is zero.
 */

/**
 * Newton's stopping tolerance. RELATIVE and dimensionless, NOT a mass.
 *
 * THE TARGET IS `tolerance * scale`. `scale` is the largest mass rate
 * any single well in the network can make against the delivery
 * pressure, in lb/d, and it is never taken below 1. The worst nodal
 * imbalance, which is a mass in lb/d, is compared against that product
 * and not against the tolerance itself. So the same 1e-6 asks for an
 * imbalance under about a pound a day on a system moving a million
 * pounds a day, and under about a thousandth of a pound on one moving a
 * thousand: the point of a relative tolerance is that it means the same
 * thing on both.
 *
 * The caller supplies the tolerance and never sees the scale, which is
 * why the name has to say what the number is. Read as lb/d it is a
 * false statement about the units.
 */
export const DEFAULT_TOLERANCE_RELATIVE = 1e-6;
export const DEFAULT_MAX_ITER = 200;

/** Pressure floor. Nothing in a gathering system is below atmospheric. */
export const MIN_PRESSURE_PSIA = 14.7;

export const NODE_KINDS = ['well', 'junction', 'sink'];

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

/**
 * Validate and index a network.
 *
 * Every failure here is a REFUSAL with a reason, never a repair. A
 * network with a well that cannot reach a delivery point is not a
 * network with a small problem; it is a drawing mistake, and solving it
 * anyway would produce a confident answer about a system that does not
 * exist.
 *
 * returns { ok, error } or { ok:true, nodes, branches, nodeById,
 *   unknownIds, sinkIds, adjacency }
 */
export const buildNetwork = ({ nodes, branches }) => {
  const nodeList = Array.isArray(nodes) ? nodes : [];
  const branchList = Array.isArray(branches) ? branches : [];
  if (!nodeList.length) return { ok: false, error: 'A network needs at least one node.' };

  const nodeById = new Map();
  for (const n of nodeList) {
    if (!n.id) return { ok: false, error: 'Every node needs an id.' };
    if (nodeById.has(n.id)) return { ok: false, error: `Two nodes share the id "${n.id}".` };
    if (!NODE_KINDS.includes(n.kind)) {
      return { ok: false, error: `Node "${n.label || n.id}" has kind "${n.kind}", which is not one of ${NODE_KINDS.join(', ')}.` };
    }
    nodeById.set(n.id, n);
  }

  const sinks = nodeList.filter((n) => n.kind === 'sink');
  if (!sinks.length) {
    return { ok: false, error: 'A network needs a delivery point: a node with a pressure the system is flowing against.' };
  }
  for (const s of sinks) {
    if (!(s.pressurePsia > 0)) {
      return { ok: false, error: `The delivery point "${s.label || s.id}" needs a pressure. It is the boundary the whole system is solved against.` };
    }
  }
  if (!nodeList.some((n) => n.kind === 'well')) {
    return { ok: false, error: 'A network needs at least one well. Nothing else puts anything into it.' };
  }

  const branchById = new Map();
  const adjacency = new Map(nodeList.map((n) => [n.id, []]));
  for (const b of branchList) {
    if (!b.id) return { ok: false, error: 'Every branch needs an id.' };
    if (branchById.has(b.id)) return { ok: false, error: `Two branches share the id "${b.id}".` };
    if (!nodeById.has(b.from)) return { ok: false, error: `Branch "${b.label || b.id}" starts at "${b.from}", which is not a node.` };
    if (!nodeById.has(b.to)) return { ok: false, error: `Branch "${b.label || b.id}" ends at "${b.to}", which is not a node.` };
    if (b.from === b.to) return { ok: false, error: `Branch "${b.label || b.id}" starts and ends at the same node.` };
    branchById.set(b.id, b);
    adjacency.get(b.from).push({ branch: b, other: b.to, sign: 1 });
    adjacency.get(b.to).push({ branch: b, other: b.from, sign: -1 });
  }

  // Every node has to be able to reach a delivery point, or its
  // pressure is not determined by anything.
  const reachable = new Set(sinks.map((s) => s.id));
  const stack = [...reachable];
  while (stack.length) {
    const id = stack.pop();
    for (const link of adjacency.get(id)) {
      if (!reachable.has(link.other)) { reachable.add(link.other); stack.push(link.other); }
    }
  }
  const stranded = nodeList.filter((n) => !reachable.has(n.id));
  if (stranded.length) {
    const names = stranded.map((n) => n.label || n.id).join(', ');
    return {
      ok: false,
      error: `${stranded.length === 1 ? 'This node has' : 'These nodes have'} no route to a delivery point: ${names}. Nothing sets ${stranded.length === 1 ? 'its' : 'their'} pressure, so the network cannot be solved. Connect ${stranded.length === 1 ? 'it' : 'them'} or take ${stranded.length === 1 ? 'it' : 'them'} out.`,
    };
  }

  const unknownIds = nodeList.filter((n) => n.kind !== 'sink').map((n) => n.id);
  return {
    ok: true,
    nodes: nodeList,
    branches: branchList,
    nodeById,
    branchById,
    unknownIds,
    sinkIds: sinks.map((s) => s.id),
    adjacency,
  };
};

// ---------------------------------------------------------------------------
// Dense linear solve
// ---------------------------------------------------------------------------

/**
 * Gaussian elimination with partial pivoting. A gathering network is
 * tens of nodes, not thousands, so a dense solve is both fast enough
 * and far easier to be sure of than a sparse one.
 *
 * Returns null on a singular system rather than an array of infinities,
 * because a singular Jacobian is a real diagnosis -- usually a node
 * whose pressure nothing depends on.
 */
export const solveLinear = (aIn, bIn) => {
  const n = bIn.length;
  const a = aIn.map((row, i) => [...row, bIn[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (!(Math.abs(a[pivot][col]) > 1e-14)) return null;
    if (pivot !== col) { const t = a[pivot]; a[pivot] = a[col]; a[col] = t; }
    for (let r = col + 1; r < n; r += 1) {
      const f = a[r][col] / a[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c += 1) a[r][c] -= f * a[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    let s = a[r][n];
    for (let c = r + 1; c < n; c += 1) s -= a[r][c] * x[c];
    x[r] = s / a[r][r];
  }
  return x;
};

// ---------------------------------------------------------------------------
// The solve
// ---------------------------------------------------------------------------

/**
 * Net mass into every unknown node at a given pressure vector.
 *
 * This IS the system of equations. Everything else in the solver is
 * machinery for driving it to zero.
 */
const residuals = ({ network, p, branchFlow, wellInflow }) => {
  const net = new Map(network.unknownIds.map((id) => [id, 0]));
  const flows = new Map();

  for (const b of network.branches) {
    const q = branchFlow(b, p.get(b.from), p.get(b.to));
    flows.set(b.id, q);
    if (net.has(b.from)) net.set(b.from, net.get(b.from) - q);
    if (net.has(b.to)) net.set(b.to, net.get(b.to) + q);
  }
  const inflows = new Map();
  for (const n of network.nodes) {
    if (n.kind !== 'well') continue;
    const q = wellInflow(n, p.get(n.id));
    inflows.set(n.id, q);
    net.set(n.id, net.get(n.id) + q);
  }
  return { net, flows, inflows };
};

/**
 * The pressure at which a well's own inflow relation reaches zero: its
 * shut-in pressure, found by bisection on the monotone-decreasing
 * inflow.
 *
 * It is what decides a well node whose Jacobian row has gone flat.
 * Nothing that flows depends on such a node's pressure, so the system
 * cannot place it, and it used to be left wherever the initial guess
 * put it, which is the separator pressure. A shut-in well does not sit
 * at the separator pressure. It builds to its own shut-in pressure, and
 * that is a number this function has in its hands: the inflow relation
 * it was handed. Items 65 and 70.
 *
 * Returns NaN when the relation has no zero to find, which is a real
 * outcome for a node that is not a well or for an inflow that never
 * reaches zero.
 */
export const shutInPressure = ({ node, wellInflow, fromPsia = MIN_PRESSURE_PSIA }) => {
  if (!node || node.kind !== 'well' || typeof wellInflow !== 'function') return NaN;
  const at = (x) => {
    const q = wellInflow(node, x);
    return Number.isFinite(q) ? q : NaN;
  };
  let lo = Math.max(MIN_PRESSURE_PSIA, fromPsia);
  let qLo = at(lo);
  if (!Number.isFinite(qLo)) return NaN;
  // A relation that is already at or below zero at the floor has no
  // crossing to find here. An inflow that is identically zero is the
  // clearest case: it says nothing about where the well sits, and
  // answering with the floor pressure would be inventing a number.
  if (qLo <= 0) return NaN;
  let hi = Math.max(lo * 2, lo + 100);
  let qHi = at(hi);
  for (let i = 0; i < 60 && Number.isFinite(qHi) && qHi > 0; i += 1) {
    lo = hi;
    qLo = qHi;
    hi *= 2;
    qHi = at(hi);
  }
  if (!Number.isFinite(qHi) || qHi > 0) return NaN;
  for (let i = 0; i < 200; i += 1) {
    const mid = 0.5 * (lo + hi);
    const qMid = at(mid);
    if (!Number.isFinite(qMid)) return NaN;
    if (qMid > 0) lo = mid; else hi = mid;
    if (hi - lo < Math.max(1e-9, hi * 1e-12)) break;
  }
  return 0.5 * (lo + hi);
};

/**
 * Solve the network.
 *
 * branchFlow(branch, pFrom, pTo) -> mass rate lb/d, positive from->to.
 *   Must be continuous and monotone decreasing in pTo. A pipe relation
 *   built from a characteristic curve satisfies this by construction.
 *
 * wellInflow(node, p) -> mass rate lb/d into the network, monotone
 *   DECREASING in p: a well makes less against a higher wellhead
 *   pressure. That monotonicity is what makes the system well posed,
 *   and it is exactly the physics of an inflow curve met against a
 *   tubing curve.
 *
 * tolerance is RELATIVE, not a mass: the worst nodal imbalance in lb/d
 *   is compared against `tolerance * scale`, with `scale` formed inside
 *   this function from the well relations. See
 *   DEFAULT_TOLERANCE_RELATIVE.
 *
 * `ok` is true only when the solve CONVERGED. A solve that ran out of
 * iterations, or that stopped making progress before it met its
 * tolerance, did not succeed, and it says so with `ok: false` and a
 * code. The best pressures it reached are still returned beside the
 * refusal, because they are worth looking at; they are just not an
 * answer anyone should quote.
 *
 * returns { ok, pressures, flows, wellRates, iterations, residualLbD,
 *   converged, warnings, code, error }
 */
export const solveNetwork = ({
  network, branchFlow, wellInflow,
  initialPressures, tolerance = DEFAULT_TOLERANCE_RELATIVE, maxIter = DEFAULT_MAX_ITER,
}) => {
  if (!network?.ok) {
    return {
      ok: false,
      code: 'invalidNetwork',
      error: network?.error || 'The network is not valid.',
    };
  }
  const unknowns = network.unknownIds;
  const n = unknowns.length;
  const warnings = [];

  // Start every unknown at the highest delivery pressure unless told
  // otherwise. Starting AT the boundary rather than above it means the
  // first step already knows which way is downhill.
  const sinkP = Math.max(...network.sinkIds.map((id) => network.nodeById.get(id).pressurePsia));
  const p = new Map();
  for (const node of network.nodes) {
    if (node.kind === 'sink') { p.set(node.id, node.pressurePsia); continue; }
    const given = initialPressures?.[node.id];
    if (given > 0) { p.set(node.id, given); continue; }
    // ITEM 65. Starting a well AT the separator pressure is the right
    // guess for a well that flows against it. For a well that CANNOT,
    // one already at or past its own crossing, the separator pressure is
    // the one place the inflow is flat, the Jacobian row is dead from
    // the first iteration, and the node never gets placed at all. Such a
    // well starts at its own crossing instead.
    if (node.kind === 'well') {
      const q0 = wellInflow(node, sinkP);
      if (Number.isFinite(q0) && q0 <= 0) {
        const shutIn = shutInPressure({ node, wellInflow });
        p.set(node.id, Number.isFinite(shutIn) ? shutIn : sinkP);
        continue;
      }
    }
    p.set(node.id, sinkP);
  }

  const pinned = new Set();
  // Well nodes whose row went flat and whose own inflow relation placed
  // them, which is a different thing from a node nothing could place.
  const settled = new Map();
  const evaluate = (pv) => residuals({ network, p: pv, branchFlow, wellInflow });
  // A pinned node's residual cannot be driven anywhere, because nothing
  // that flows depends on its pressure. Including it in the norm would
  // mean the solve never converged, on a network that is in fact solved.
  const normOf = (net) => Math.max(
    ...unknowns.filter((id) => !pinned.has(id) && !settled.has(id))
      .map((id) => Math.abs(net.get(id))),
    0,
  );

  let state = evaluate(p);
  let norm = normOf(state.net);
  let iterations = 0;
  // The target is formed below, from the same scale the in-loop test
  // uses. This check used to compare against the BARE tolerance, which
  // is stricter by the scale factor and therefore contradicts the
  // documentation item 47 wrote: a network that arrives already solved
  // was made to iterate anyway. N9.
  let converged = false;

  // A relative scale so the tolerance means something on a system
  // moving a million pounds a day as well as on one moving a thousand.
  // THIS is what the tolerance multiplies: the target below is the mass
  // in lb/d the worst nodal imbalance has to get under, and the caller
  // never sees it. See DEFAULT_TOLERANCE_RELATIVE.
  const scale = Math.max(
    1,
    ...network.nodes.filter((x) => x.kind === 'well').map((x) => Math.abs(wellInflow(x, sinkP))),
  );
  const target = Math.max(tolerance, tolerance * scale);
  converged = norm <= target;

  while (!converged && iterations < maxIter) {
    iterations += 1;

    // Numerical Jacobian by CENTRAL differences. Two evaluations per
    // column instead of one, which on a network of tens of nodes costs
    // nothing, and it buys two things: the truncation error goes from
    // first order to second, and -- the reason it actually matters --
    // the subtraction cancels far less, because the two evaluations
    // straddle the point instead of sitting on top of each other. On a
    // linear network that is the difference between agreeing with the
    // closed form to eight figures and to twelve.
    //
    // The step is scaled to the pressure itself so it stays meaningful
    // at 60 psia and at 3,000.
    const jac = [];
    const base = unknowns.map((id) => state.net.get(id));
    for (let i = 0; i < n; i += 1) jac.push(new Array(n).fill(0));
    for (let j = 0; j < n; j += 1) {
      const id = unknowns[j];
      const p0 = p.get(id);
      const h = Math.max(1e-3, Math.abs(p0) * 1e-5);
      p.set(id, p0 + h);
      const up = evaluate(p);
      p.set(id, Math.max(MIN_PRESSURE_PSIA, p0 - h));
      const actualH = p0 + h - p.get(id);
      const down = evaluate(p);
      p.set(id, p0);
      for (let i = 0; i < n; i += 1) {
        jac[i][j] = (up.net.get(unknowns[i]) - down.net.get(unknowns[i])) / actualH;
      }
    }

    // A node whose ROW is entirely zero is a node whose pressure changes
    // nothing that flows. That is not always a mistake: it is exactly
    // what a shut-in well on a dead flowline looks like, and the
    // physical answer there is obvious -- it sits where it sits and
    // contributes nothing either way. So such a node is PINNED at its
    // current pressure and taken out of the system, rather than
    // dragging a perfectly good network down with it. Which nodes were
    // pinned is reported, because a pinned node is a fact about the
    // answer and not an implementation detail.
    const live = [];
    for (let i = 0; i < n; i += 1) {
      const id = unknowns[i];
      const rowDead = jac[i].every((v) => Math.abs(v) < 1e-12);
      const colDead = jac.every((row) => Math.abs(row[i]) < 1e-12);
      if (rowDead && colDead) {
        // ITEM 70. A well whose row has gone flat is not undetermined:
        // its own inflow relation decides it. It is settled at the
        // pressure that relation reaches zero at, which is what a
        // shut-in well actually does, and it is NOT reported as pinned,
        // because the answer for it is a number and not a shrug.
        if (!settled.has(id) && !pinned.has(id)) {
          const node = network.nodeById.get(id);
          const shutIn = shutInPressure({ node, wellInflow });
          if (Number.isFinite(shutIn)) {
            settled.set(id, shutIn);
            p.set(id, shutIn);
          } else {
            pinned.add(id);
          }
        }
      } else {
        // ITEM 63. A node stops being pinned the moment its row stops
        // being flat. The set used to be cumulative, so a node pinned on
        // one early iteration stayed out of the norm for the rest of the
        // solve even after the network came alive around it, and the
        // convergence test was then taken over a subset nobody chose.
        pinned.delete(id);
        settled.delete(id);
        live.push(i);
      }
    }
    // ITEM 64. Every unknown flat at once is not a solved network, it is
    // a network with nothing flowing in it, and a Newton step over an
    // empty system converges instantly on nothing.
    if (live.length === 0 && n > 0) {
      return {
        ok: false,
        code: 'allNodesPinned',
        error: `Every unknown node in this network has a flat Jacobian row, so nothing that flows depends on any pressure and there is no system left to solve. That is a network with no live path from a well to a delivery point: check the branch characteristics and the well inflows before reading the pressures below.`,
        pressures: Object.fromEntries(p),
        pressureStatus: Object.fromEntries(network.nodes.map((x) => [
          x.id,
          x.kind === 'sink' ? 'boundary' : (settled.has(x.id) ? 'settledFromInflow' : 'pinned'),
        ])),
        pinned: [...pinned],
        settled: [...settled.keys()],
        iterations,
      };
    }

    let step;
    if (live.length === n) {
      step = solveLinear(jac, base.map((v) => -v));
    } else if (live.length === 0) {
      step = new Array(n).fill(0);
    } else {
      const sub = live.map((i) => live.map((j) => jac[i][j]));
      const rhs = live.map((i) => -base[i]);
      const partial = solveLinear(sub, rhs);
      if (partial) {
        step = new Array(n).fill(0);
        live.forEach((i, k) => { step[i] = partial[k]; });
      } else {
        step = null;
      }
    }

    if (!step) {
      return {
        ok: false,
        code: 'singularSystem',
        error: 'The system is singular: two or more nodes move together, so their pressures are not separately determined. That is usually a branch connected differently from the way the drawing suggests.',
        pressures: Object.fromEntries(p),
        iterations,
      };
    }

    // Backtracking line search on the residual norm. A full Newton step
    // on a network with a nearly-dead leg will happily jump a node
    // below atmospheric; halving until the residual actually improves
    // costs a few evaluations and turns a divergence into a solve.
    let lambda = 1;
    let accepted = false;
    const before = new Map(p);
    for (let k = 0; k < 30; k += 1) {
      let feasible = true;
      for (let i = 0; i < n; i += 1) {
        const next = before.get(unknowns[i]) + lambda * step[i];
        if (!(next > MIN_PRESSURE_PSIA) || !Number.isFinite(next)) { feasible = false; break; }
        p.set(unknowns[i], next);
      }
      if (feasible) {
        const trial = evaluate(p);
        const trialNorm = normOf(trial.net);
        if (Number.isFinite(trialNorm) && trialNorm < norm) {
          state = trial; norm = trialNorm; accepted = true; break;
        }
      }
      lambda /= 2;
    }
    if (!accepted) {
      for (const id of unknowns) p.set(id, before.get(id));
      warnings.push('The solve stopped making progress before it met its tolerance. The answer below is the best it reached; treat it as approximate and check the network for a leg that is barely flowing.');
      break;
    }
    converged = norm <= target;
  }

  if (!converged && !warnings.length) {
    // Both numbers unrounded. Rounding the imbalance to three decimals
    // beside the target it failed is how a message ends up reading as
    // though the two were the same number.
    warnings.push(`The solve ran ${iterations} iterations without meeting its tolerance. The worst nodal imbalance is ${norm} lb/d, against a target of ${target} lb/d.`);
  }

  // ITEM 46. A convergence taken over a subset of the unknowns is not a
  // convergence. While any node is pinned, the norm above is a maximum
  // over the nodes that were LEFT IN, and calling that converged asserts
  // something about the whole network that was never tested.
  if (pinned.size) converged = false;

  const flowsOut = Object.fromEntries(state.flows);
  const wellRatesOut = Object.fromEntries(state.inflows);
  // ITEM 45. The conservation check is cheap, it is the only thing that
  // catches a sign error in the assembly, and it was left for the caller
  // to remember. Every solve carries it now.
  const conservation = checkConservation({
    network, flows: flowsOut, wellRates: wellRatesOut,
  });

  const result = {
    ok: converged,
    converged,
    pressures: Object.fromEntries(p),
    // ITEM 71. Which of these pressures were solved for, which were
    // settled from a well's own inflow because nothing else could place
    // them, and which are boundary conditions. `pressures` stays a map
    // of numbers, because that is what its name says and what every
    // consumer indexes it as; the marking travels beside it.
    pressureStatus: Object.fromEntries(network.nodes.map((x) => {
      if (x.kind === 'sink') return [x.id, 'boundary'];
      if (pinned.has(x.id)) return [x.id, 'pinned'];
      if (settled.has(x.id)) return [x.id, 'settledFromInflow'];
      return [x.id, 'solved'];
    })),
    flows: flowsOut,
    wellRates: wellRatesOut,
    imbalance: Object.fromEntries(unknowns.map((id) => [id, state.net.get(id)])),
    residualLbD: norm,
    conservationGapLbD: conservation.gapLbD,
    conservationRelative: conservation.relative,
    conservation,
    iterations,
    pinned: [...pinned],
    settled: [...settled.keys()],
    warnings: pinned.size
      ? [...warnings, `${pinned.size === 1 ? 'One node' : `${pinned.size} nodes`} carried nothing and nothing depended on ${pinned.size === 1 ? 'its' : 'their'} pressure, so ${pinned.size === 1 ? 'it was' : 'they were'} left where ${pinned.size === 1 ? 'it sits' : 'they sit'}: ${[...pinned].join(', ')}. That is what a shut-in well on a dead line looks like.`]
      : warnings,
  };

  // A solve that did not converge did not succeed, whether it ran out of
  // iterations or stopped making progress. Returning ok true with a
  // warning beside it leaves the caller to notice, and callers do not.
  if (!converged && pinned.size) {
    result.code = 'pinnedNodes';
    result.error = `${pinned.size === 1 ? 'One node' : `${pinned.size} nodes`} could not be placed by this network and nothing that flows depends on ${pinned.size === 1 ? 'its' : 'their'} pressure: ${[...pinned].join(', ')}. The residual below was taken over the nodes that WERE placed, so it is not a statement about the whole network and this solve does not claim to have converged.`;
  } else if (!converged) {
    result.code = 'notConverged';
    result.error = `The network solve did not converge. The worst nodal imbalance is ${norm} lb/d after ${iterations} iterations, against a target of ${target} lb/d. Treat the pressures below as a starting point, not as an answer.`;
  }

  return result;
};

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

/**
 * Push each well's component split down the network along the solved
 * flow directions.
 *
 * Component rates ADD. That is the entire algorithm and it is exact:
 * a header carrying a dry well and a wet one carries the sum of both,
 * and its water cut is a consequence rather than an input. Mixing
 * RATIOS -- averaging two water cuts, or two gas-oil ratios -- is the
 * classic way to get this wrong, and it is wrong by a factor that
 * depends on how unequal the rates are.
 *
 * The propagation is a topological sweep over the flow directions the
 * solve produced. If those directions contain a cycle the network is
 * recirculating, which a gathering system does not do, and it is
 * reported rather than iterated on.
 *
 * THE SPLIT IS RECONCILED AGAINST THE FLOWS BEFORE IT IS RETURNED.
 * The component rates are carried down the network by the mass shares
 * in `flows`, but the mass they add up to comes from `wellStreams`, and
 * nothing in the arithmetic forces the two to be the same mass. If a
 * caller hands over well streams that do not weigh what the solved well
 * rates weigh, every branch gets a component split scaled by that ratio
 * and every water cut and gas-oil ratio downstream is quietly wrong.
 * So each branch's propagated mass is compared against the mass the
 * solve put on it, and a disagreement beyond `tolerance` is a refusal.
 * `tolerance` is relative, as in solveNetwork.
 *
 * returns { ok, branchStreams, nodeStreams, code, error }
 */
export const propagateStreams = ({
  network, flows, wellStreams, tolerance = DEFAULT_TOLERANCE_RELATIVE,
}) => {
  // Refused at the door, never coerced. A NaN mass that is allowed in
  // here comes back out as a NaN component rate, and every comparison
  // that could have caught it is false against a NaN.
  const streamFields = ['qoStbd', 'qwStbd', 'qgMscfd', 'massLbD'];
  for (const nd of network.nodes) {
    const s = wellStreams?.[nd.id];
    if (!s) continue;
    const bad = streamFields.filter((f) => !Number.isFinite(s[f]));
    if (bad.length) {
      return {
        ok: false,
        code: 'invalidStream',
        error: `The stream for "${nd.label || nd.id}" is missing a readable ${bad.join(', ')}. A component split needs all four of ${streamFields.join(', ')} as numbers.`,
      };
    }
  }
  for (const b of network.branches) {
    if (!Number.isFinite(flows?.[b.id])) {
      return {
        ok: false,
        code: 'invalidFlow',
        error: `Branch "${b.label || b.id}" has no readable flow, so there is no direction to carry a stream along and nothing to reconcile the stream against. Pass the flows the solve returned, one for every branch.`,
      };
    }
  }

  const zero = () => ({ qoStbd: 0, qwStbd: 0, qgMscfd: 0, massLbD: 0 });
  const add = (a, b) => ({
    qoStbd: a.qoStbd + b.qoStbd,
    qwStbd: a.qwStbd + b.qwStbd,
    qgMscfd: a.qgMscfd + b.qgMscfd,
    massLbD: a.massLbD + b.massLbD,
  });
  const scale = (s, f) => ({
    qoStbd: s.qoStbd * f, qwStbd: s.qwStbd * f, qgMscfd: s.qgMscfd * f, massLbD: s.massLbD * f,
  });

  // Directed edges as the solve found them; a branch carrying nothing
  // has no direction and is skipped rather than guessed at.
  const incoming = new Map(network.nodes.map((nd) => [nd.id, []]));
  const outgoing = new Map(network.nodes.map((nd) => [nd.id, []]));
  for (const b of network.branches) {
    const q = flows[b.id];
    if (!Number.isFinite(q) || q === 0) continue;
    const from = q > 0 ? b.from : b.to;
    const to = q > 0 ? b.to : b.from;
    outgoing.get(from).push({ branch: b, to });
    incoming.get(to).push({ branch: b, from });
  }

  const indegree = new Map(network.nodes.map((nd) => [nd.id, incoming.get(nd.id).length]));
  const queue = network.nodes.filter((nd) => indegree.get(nd.id) === 0).map((nd) => nd.id);
  const nodeStreams = new Map(network.nodes.map((nd) => [nd.id, zero()]));
  const branchStreams = new Map();
  let visited = 0;

  while (queue.length) {
    const id = queue.shift();
    visited += 1;
    const node = network.nodeById.get(id);
    let here = nodeStreams.get(id);
    if (node.kind === 'well' && wellStreams?.[id]) {
      here = add(here, wellStreams[id]);
      nodeStreams.set(id, here);
    }
    const outs = outgoing.get(id);
    const totalOut = outs.reduce((acc, o) => acc + Math.abs(flows[o.branch.id]), 0);
    for (const o of outs) {
      // A node with more than one way out splits its stream by mass,
      // which is the only split that conserves anything.
      const share = totalOut > 0 ? Math.abs(flows[o.branch.id]) / totalOut : 0;
      const s = scale(here, share);
      branchStreams.set(o.branch.id, s);
      nodeStreams.set(o.to, add(nodeStreams.get(o.to), s));
      indegree.set(o.to, indegree.get(o.to) - 1);
      if (indegree.get(o.to) === 0) queue.push(o.to);
    }
  }

  if (visited !== network.nodes.length) {
    return {
      ok: false,
      code: 'recirculating',
      error: 'The solved flow directions form a loop, so the network is recirculating. A gathering system does not do that; check for a branch connected backwards.',
    };
  }

  // Reconcile against the flows. The mass a branch carries is a fact the
  // solve already established; the split can only redistribute it.
  for (const b of network.branches) {
    const s = branchStreams.get(b.id);
    if (!s) continue;
    const carriedLbD = Math.abs(flows[b.id]);
    const splitLbD = s.massLbD;
    const denom = Math.max(Math.abs(splitLbD), carriedLbD);
    const relative = denom > 0 ? Math.abs(splitLbD - carriedLbD) / denom : 0;
    if (!(relative <= tolerance)) {
      return {
        ok: false,
        code: 'streamMassMismatch',
        error: `The component split does not weigh what the solve put on branch "${b.label || b.id}": the split carries ${splitLbD} lb/d and the flow is ${carriedLbD} lb/d, a relative difference of ${relative} against a tolerance of ${tolerance}. The well streams have to weigh what the solved well rates weigh, or every rate downstream of here is scaled by that ratio.`,
      };
    }
  }

  return {
    ok: true,
    branchStreams: Object.fromEntries(branchStreams),
    nodeStreams: Object.fromEntries(nodeStreams),
  };
};

// ---------------------------------------------------------------------------
// After the solve
// ---------------------------------------------------------------------------

/**
 * Conservation check, run on the answer rather than trusted from the
 * method.
 *
 * A solver that converged on a wrong residual function converges just
 * as smugly as one that did not, so what leaves the delivery points has
 * to equal what the wells put in. This is cheap and it is the only
 * check that catches a sign error in the assembly.
 */
export const checkConservation = ({ network, flows, wellRates }) => {
  const produced = Object.values(wellRates).reduce((a, v) => a + v, 0);
  let delivered = 0;
  for (const b of network.branches) {
    const q = flows[b.id];
    if (!Number.isFinite(q)) continue;
    if (network.nodeById.get(b.to).kind === 'sink') delivered += q;
    if (network.nodeById.get(b.from).kind === 'sink') delivered -= q;
  }
  const gap = produced - delivered;
  // ITEM 72. The relative gap was keyed on what the WELLS made, so a
  // network that produced nothing and delivered something reported a
  // relative gap of zero: the one case where the gap is everything. It
  // keys on the larger of the two now, and when both are zero there is
  // no ratio to report and it says null rather than a clean zero.
  const denominator = Math.max(Math.abs(produced), Math.abs(delivered));
  return {
    producedLbD: produced,
    deliveredLbD: delivered,
    gapLbD: gap,
    relative: denominator > 0 ? Math.abs(gap) / denominator : null,
  };
};

/**
 * What the network is doing to itself, in plain terms.
 *
 * The BOTTLENECK is the branch eating the most pressure per unit of
 * what it carries, not simply the one with the biggest drop: a trunk
 * line carrying everything is supposed to have the biggest drop, and
 * pointing at it every time would be useless. A short flowline burning
 * the same pressure to move a tenth as much is the one worth changing.
 */
export const diagnose = ({ network, pressures, flows }) => {
  const rows = network.branches.map((b) => {
    const q = flows[b.id] ?? NaN;
    const dp = pressures[b.from] - pressures[b.to];
    return {
      id: b.id,
      label: b.label || b.id,
      from: b.from,
      to: b.to,
      massLbD: q,
      dpPsi: dp,
      // Pressure burned per unit mass moved. The units are arbitrary;
      // only the ranking matters, and the ranking is what is used.
      intensity: Math.abs(q) > 1e-9 ? Math.abs(dp) / Math.abs(q) : Infinity,
      backflow: q < 0,
    };
  });
  const carrying = rows.filter((r) => Number.isFinite(r.intensity) && Math.abs(r.massLbD) > 1e-9);
  const bottleneck = carrying.length
    ? carrying.reduce((best, r) => (r.intensity > best.intensity ? r : best))
    : null;
  const biggestDrop = rows.length
    ? rows.reduce((best, r) => (Math.abs(r.dpPsi) > Math.abs(best.dpPsi) ? r : best))
    : null;
  const backflows = rows.filter((r) => r.backflow);
  const dead = rows.filter((r) => Math.abs(r.massLbD) <= 1e-9);
  return { rows, bottleneck, biggestDrop, backflows, dead };
};

// ---------------------------------------------------------------------------
// Reference relations, for testing and for a first look at a network
// ---------------------------------------------------------------------------

/**
 * A linear resistance, q = k (pIn - pOut).
 *
 * Not a model of anything real -- no pipe behaves this way -- but it
 * is the relation for which the whole network has a CLOSED FORM: mass
 * balance over linear branches is a weighted graph Laplacian, and its
 * solution is a matrix inverse. That makes it the only branch relation
 * against which this solver can be checked with no tolerance at all,
 * which is exactly why it is here.
 */
export const linearBranch = (k) => (branch, pIn, pOut) => k * (pIn - pOut);

/** A linear well: q = qmax (1 - p/pr), the simplest monotone inflow. */
export const linearWell = ({ qmax, prPsia }) => (node, p) =>
  Math.max(0, qmax * (1 - p / prPsia));

/**
 * The exact solution of a linear-resistance network, by assembling the
 * weighted Laplacian and solving it directly.
 *
 * A completely separate route to the same answer -- linear algebra
 * rather than Newton iteration -- which is what makes it worth having.
 */
export const solveLinearNetwork = ({ network, conductance, wellSlope }) => {
  const unknowns = network.unknownIds;
  const index = new Map(unknowns.map((id, i) => [id, i]));
  const n = unknowns.length;
  const a = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);

  for (const br of network.branches) {
    const k = conductance(br);
    const i = index.get(br.from);
    const j = index.get(br.to);
    // Net into `from` is -k(pFrom - pTo); into `to` is +k(pFrom - pTo).
    if (i != null) { a[i][i] -= k; if (j != null) a[i][j] += k; }
    if (j != null) { a[j][j] -= k; if (i != null) a[j][i] += k; }
    // A fixed-pressure endpoint is a CONSTANT, so it moves to the right
    // hand side. Both directions move it the same way: the equation is
    // "net in = 0", and a boundary pressure enters that net with the
    // same sign whichever end of the branch it sits on.
    if (i == null) b[j] -= k * network.nodeById.get(br.from).pressurePsia;
    if (j == null) b[i] -= k * network.nodeById.get(br.to).pressurePsia;
  }
  for (const node of network.nodes) {
    if (node.kind !== 'well') continue;
    const { qmax, prPsia } = wellSlope(node);
    const i = index.get(node.id);
    // q = qmax (1 - p/pr) = qmax - (qmax/pr) p
    a[i][i] -= qmax / prPsia;
    b[i] -= qmax;
  }
  const x = solveLinear(a, b);
  if (!x) return { ok: false, error: 'singular' };
  const pressures = {};
  for (const node of network.nodes) {
    pressures[node.id] = node.kind === 'sink'
      ? node.pressurePsia
      : x[index.get(node.id)];
  }
  return { ok: true, pressures };
};
