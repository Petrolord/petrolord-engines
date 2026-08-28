/**
 * Gates for the gathering-network solver (Production P11).
 *
 * The strongest gate in here needs no tolerance at all. Give the solver
 * LINEAR branch resistances and the whole network collapses to a
 * weighted graph Laplacian, whose solution is a matrix inverse. Newton
 * iteration and Gaussian elimination share no code and no reasoning,
 * so their agreeing to machine precision says the assembly, the signs
 * and the boundary handling are all right.
 *
 * The nonlinear cases are checked against an oracle that does not form
 * a Jacobian, does not solve a linear system, and does not even iterate
 * the same way: it sweeps node by node and bisects each one's own mass
 * balance. Two methods with nothing in common landing on the same
 * pressures is evidence about the physics rather than about the code.
 */
import fs from 'fs';
import path from 'path';
import {
  buildNetwork, solveNetwork, solveLinear, solveLinearNetwork, propagateStreams,
  checkConservation, diagnose, linearBranch, linearWell, MIN_PRESSURE_PSIA,
} from '../engines/production/networkSolve';
import {
  PIPE_SCHEDULE, scheduleRow, equivalentLengthFt, barlowPressurePsi,
  fittingK, roughnessOf, gradeYield,
} from '../engines/production/pipeSchedule';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'production', 'goldens', 'network_cases.json'), 'utf8',
));

// The oracle's relations, written again here rather than imported, so
// the two implementations stay genuinely separate.
const turbulent = (k) => (b, pIn, pOut) => {
  const dp = pIn - pOut;
  return Math.sign(dp) * k * Math.sqrt(Math.abs(dp));
};
const vogel = (qmax, pr) => (p) => {
  const x = Math.min(Math.max(p / pr, 0), 1);
  return Math.max(0, qmax * (1 - 0.2 * x - 0.8 * x * x));
};

const fromSpec = (spec, nodes, branches) => {
  const net = buildNetwork({ nodes, branches });
  expect(net.ok).toBe(true);
  return net;
};

describe('the linear network has a closed form, and the solver has to hit it', () => {
  const nodes = [
    { id: 'w1', kind: 'well', label: 'W-1' },
    { id: 'w2', kind: 'well', label: 'W-2' },
    { id: 'h', kind: 'junction', label: 'Header' },
    { id: 's', kind: 'sink', label: 'Separator', pressurePsia: 150 },
  ];
  const branches = [
    { id: 'b1', from: 'w1', to: 'h' },
    { id: 'b2', from: 'w2', to: 'h' },
    { id: 'b3', from: 'h', to: 's' },
  ];
  const K = { b1: 80, b2: 120, b3: 400 };
  const W = { w1: { qmax: 60000, prPsia: 900 }, w2: { qmax: 40000, prPsia: 700 } };
  const net = buildNetwork({ nodes, branches });

  const newton = solveNetwork({
    network: net,
    branchFlow: (b, pIn, pOut) => K[b.id] * (pIn - pOut),
    wellInflow: (nd, p) => linearWell(W[nd.id])(nd, p),
    tolerance: 1e-12,
  });
  const exact = solveLinearNetwork({
    network: net, conductance: (b) => K[b.id], wellSlope: (nd) => W[nd.id],
  });

  test('Newton and the matrix inverse agree to machine precision', () => {
    expect(newton.converged).toBe(true);
    expect(exact.ok).toBe(true);
    for (const id of Object.keys(exact.pressures)) {
      const rel = Math.abs(newton.pressures[id] - exact.pressures[id])
        / Math.abs(exact.pressures[id]);
      expect(rel).toBeLessThan(1e-12);
    }
  });

  test('and both agree with the independent bisection oracle', () => {
    const g = G.linear_star.pressures;
    for (const id of Object.keys(g)) {
      expect(newton.pressures[id]).toBeCloseTo(g[id], 6);
    }
  });

  test('Newton takes a handful of steps on a linear system, not a hundred', () => {
    // A linear system is where Newton is exact. Needing many iterations
    // here would mean the Jacobian is wrong, not that the problem is hard.
    expect(newton.iterations).toBeLessThanOrEqual(3);
  });

  test('mass balances at every unknown node, and what is produced is delivered', () => {
    for (const id of ['w1', 'w2', 'h']) {
      expect(Math.abs(newton.imbalance[id])).toBeLessThan(1e-6);
    }
    const c = checkConservation({
      network: net, flows: newton.flows, wellRates: newton.wellRates,
    });
    expect(c.relative).toBeLessThan(1e-12);
  });
});

describe('the topology reduces the way a network must', () => {
  const run = (nodes, branches, K) => {
    const net = buildNetwork({ nodes, branches });
    return solveNetwork({
      network: net,
      branchFlow: (b, pIn, pOut) => K[b.id] * (pIn - pOut),
      wellInflow: () => 10000,
      tolerance: 1e-12,
    });
  };

  test('two resistances in series behave as one, by the reciprocal rule', () => {
    const two = run(
      [
        { id: 'w', kind: 'well' }, { id: 'm', kind: 'junction' },
        { id: 's', kind: 'sink', pressurePsia: 100 },
      ],
      [{ id: 'a', from: 'w', to: 'm' }, { id: 'b', from: 'm', to: 's' }],
      { a: 200, b: 300 },
    );
    const kSeries = 1 / (1 / 200 + 1 / 300);
    const one = run(
      [{ id: 'w', kind: 'well' }, { id: 's', kind: 'sink', pressurePsia: 100 }],
      [{ id: 'a', from: 'w', to: 's' }],
      { a: kSeries },
    );
    expect(two.pressures.w).toBeCloseTo(one.pressures.w, 9);
  });

  test('two resistances in parallel behave as their sum', () => {
    const two = run(
      [{ id: 'w', kind: 'well' }, { id: 's', kind: 'sink', pressurePsia: 100 }],
      [{ id: 'a', from: 'w', to: 's' }, { id: 'b', from: 'w', to: 's' }],
      { a: 200, b: 300 },
    );
    const one = run(
      [{ id: 'w', kind: 'well' }, { id: 's', kind: 'sink', pressurePsia: 100 }],
      [{ id: 'a', from: 'w', to: 's' }],
      { a: 500 },
    );
    expect(two.pressures.w).toBeCloseTo(one.pressures.w, 9);
  });
});

describe('nonlinear networks against the bisection oracle', () => {
  const build = (name, nodeSpecs, branchSpecs) => {
    const spec = G[name].spec;
    const net = buildNetwork({ nodes: nodeSpecs, branches: branchSpecs });
    expect(net.ok).toBe(true);
    const wells = {};
    for (const [id, [qmax, pr]] of Object.entries(spec.wells)) wells[id] = vogel(qmax, pr);
    const res = solveNetwork({
      network: net,
      branchFlow: (b, pIn, pOut) => turbulent(spec.branches[b.id])(b, pIn, pOut),
      wellInflow: (nd, p) => wells[nd.id](p),
      tolerance: 1e-10,
    });
    return { net, res, spec };
  };

  test('a tree of turbulent branches and Vogel inflows matches the oracle', () => {
    const { net, res } = build(
      'turbulent_tree',
      [
        { id: 'w1', kind: 'well' }, { id: 'w2', kind: 'well' }, { id: 'w3', kind: 'well' },
        { id: 'h1', kind: 'junction' }, { id: 'h2', kind: 'junction' },
        { id: 's', kind: 'sink', pressurePsia: 180 },
      ],
      [
        { id: 'b1', from: 'w1', to: 'h1' }, { id: 'b2', from: 'w2', to: 'h1' },
        { id: 'b3', from: 'w3', to: 'h2' }, { id: 'b4', from: 'h1', to: 'h2' },
        { id: 'b5', from: 'h2', to: 's' },
      ],
    );
    expect(res.converged).toBe(true);
    const g = G.turbulent_tree;
    for (const id of Object.keys(g.pressures)) {
      expect(res.pressures[id]).toBeCloseTo(g.pressures[id], 5);
    }
    for (const id of Object.keys(g.flows)) {
      expect(res.flows[id]).toBeCloseTo(g.flows[id], 4);
    }
    const c = checkConservation({
      network: net, flows: res.flows, wellRates: res.wellRates,
    });
    expect(c.relative).toBeLessThan(1e-9);
  });

  test('a LOOPED network solves too, which a tree-only solver could not', () => {
    // Two parallel paths from the header to the separator. Loops are
    // what make a network a network, and they are where a solver that
    // quietly assumed a tree falls over.
    const { res } = build(
      'looped',
      [
        { id: 'w1', kind: 'well' }, { id: 'w2', kind: 'well' },
        { id: 'h', kind: 'junction' }, { id: 'm', kind: 'junction' },
        { id: 's', kind: 'sink', pressurePsia: 200 },
      ],
      [
        { id: 'b1', from: 'w1', to: 'h' }, { id: 'b2', from: 'w2', to: 'h' },
        { id: 'b3', from: 'h', to: 'm' }, { id: 'b4', from: 'h', to: 's' },
        { id: 'b5', from: 'm', to: 's' },
      ],
    );
    expect(res.converged).toBe(true);
    const g = G.looped;
    for (const id of Object.keys(g.pressures)) {
      expect(res.pressures[id]).toBeCloseTo(g.pressures[id], 5);
    }
    // Both parallel paths carry something; neither is dead.
    expect(res.flows.b4).toBeGreaterThan(0);
    expect(res.flows.b5).toBeGreaterThan(0);
  });
});

describe('the result the whole studio exists for: wells fight each other', () => {
  const specs = [[4200, 2600, 140], [2900, 2200, 95], [5100, 3000, 160]];
  const solveWith = (count) => {
    const nodes = [
      { id: 'h', kind: 'junction' }, { id: 's', kind: 'sink', pressurePsia: 180 },
    ];
    const branches = [{ id: 'trunk', from: 'h', to: 's' }];
    const K = { trunk: 410 };
    const wells = {};
    for (let i = 0; i < count; i += 1) {
      const [qmax, pr, k] = specs[i];
      nodes.push({ id: `w${i}`, kind: 'well' });
      branches.push({ id: `f${i}`, from: `w${i}`, to: 'h' });
      K[`f${i}`] = k;
      wells[`w${i}`] = vogel(qmax, pr);
    }
    const net = buildNetwork({ nodes, branches });
    const res = solveNetwork({
      network: net,
      branchFlow: (b, pIn, pOut) => turbulent(K[b.id])(b, pIn, pOut),
      wellInflow: (nd, p) => wells[nd.id](p),
      tolerance: 1e-10,
    });
    return { net, res, wells };
  };

  test('every extra well raises the header and takes rate off the others', () => {
    const one = solveWith(1);
    const two = solveWith(2);
    const three = solveWith(3);

    // The header climbs as more is pushed through the same trunk.
    expect(two.res.pressures.h).toBeGreaterThan(one.res.pressures.h);
    expect(three.res.pressures.h).toBeGreaterThan(two.res.pressures.h);

    // And every well already on it makes strictly less.
    expect(two.res.wellRates.w0).toBeLessThan(one.res.wellRates.w0);
    expect(three.res.wellRates.w0).toBeLessThan(two.res.wellRates.w0);
    expect(three.res.wellRates.w1).toBeLessThan(two.res.wellRates.w1);
  });

  test('the numbers match the oracle, which computed them the slow way', () => {
    const g = G.wells_fight;
    for (const row of g) {
      const { res } = solveWith(row.count);
      expect(res.pressures.h).toBeCloseTo(row.headerPsia, 4);
      for (const [id, q] of Object.entries(row.wellRates)) {
        expect(res.wellRates[id]).toBeCloseTo(q, 4);
      }
    }
  });

  test('the loss is real and large enough to matter', () => {
    // W-0 makes 3,522 on its own header and 3,138 sharing it with two
    // others. That eleven percent is invisible to any single-well
    // study, because every single-well study is run against a wellhead
    // pressure somebody typed in.
    const alone = solveWith(1).res.wellRates.w0;
    const shared = solveWith(3).res.wellRates.w0;
    expect(alone - shared).toBeGreaterThan(0.1 * shared * 0.9);
    expect((alone - shared) / alone).toBeGreaterThan(0.08);
  });
});

describe('streams mix by rate, not by ratio', () => {
  const nodes = [
    { id: 'w1', kind: 'well' }, { id: 'w2', kind: 'well' },
    { id: 'h', kind: 'junction' }, { id: 's', kind: 'sink', pressurePsia: 150 },
  ];
  const branches = [
    { id: 'b1', from: 'w1', to: 'h' }, { id: 'b2', from: 'w2', to: 'h' },
    { id: 'b3', from: 'h', to: 's' },
  ];
  const net = buildNetwork({ nodes, branches });
  const flows = { b1: 30000, b2: 10000, b3: 40000 };
  const wellStreams = {
    // A big dry well and a small wet one.
    w1: { qoStbd: 2700, qwStbd: 300, qgMscfd: 1600, massLbD: 30000 },
    w2: { qoStbd: 200, qwStbd: 800, qgMscfd: 90, massLbD: 10000 },
  };

  test('component rates add, exactly', () => {
    const s = propagateStreams({ network: net, flows, wellStreams });
    expect(s.ok).toBe(true);
    expect(s.branchStreams.b3.qoStbd).toBeCloseTo(2900, 9);
    expect(s.branchStreams.b3.qwStbd).toBeCloseTo(1100, 9);
    expect(s.branchStreams.b3.qgMscfd).toBeCloseTo(1690, 9);
  });

  test('and the header water cut is NOT the average of the two water cuts', () => {
    // W-1 is 10 percent water, W-2 is 80. Averaging gives 45. The truth
    // is 1100 / 4000 = 27.5, and the gap is the whole reason ratios are
    // never mixed anywhere in this module.
    const s = propagateStreams({ network: net, flows, wellStreams });
    const t = s.branchStreams.b3;
    const wct = (100 * t.qwStbd) / (t.qoStbd + t.qwStbd);
    expect(wct).toBeCloseTo(27.5, 6);
    const naiveAverage = (10 + 80) / 2;
    expect(Math.abs(wct - naiveAverage)).toBeGreaterThan(17);
  });

  test('a node that splits its stream splits it by mass', () => {
    const n2 = buildNetwork({
      nodes: [
        { id: 'w', kind: 'well' }, { id: 'j', kind: 'junction' },
        { id: 's1', kind: 'sink', pressurePsia: 100 },
        { id: 's2', kind: 'sink', pressurePsia: 100 },
      ],
      branches: [
        { id: 'a', from: 'w', to: 'j' },
        { id: 'x', from: 'j', to: 's1' }, { id: 'y', from: 'j', to: 's2' },
      ],
    });
    const s = propagateStreams({
      network: n2,
      flows: { a: 1000, x: 750, y: 250 },
      wellStreams: { w: { qoStbd: 400, qwStbd: 100, qgMscfd: 200, massLbD: 1000 } },
    });
    expect(s.branchStreams.x.qoStbd).toBeCloseTo(300, 9);
    expect(s.branchStreams.y.qoStbd).toBeCloseTo(100, 9);
    expect(s.branchStreams.x.qoStbd + s.branchStreams.y.qoStbd).toBeCloseTo(400, 9);
  });

  test('a recirculating loop is reported, not iterated on', () => {
    const n3 = buildNetwork({
      nodes: [
        { id: 'w', kind: 'well' }, { id: 'a', kind: 'junction' },
        { id: 'b', kind: 'junction' }, { id: 's', kind: 'sink', pressurePsia: 100 },
      ],
      branches: [
        { id: 'i', from: 'w', to: 'a' }, { id: 'ab', from: 'a', to: 'b' },
        { id: 'ba', from: 'b', to: 'a' }, { id: 'o', from: 'b', to: 's' },
      ],
    });
    const s = propagateStreams({
      network: n3,
      flows: { i: 100, ab: 50, ba: 50, o: 100 },
      wellStreams: { w: { qoStbd: 10, qwStbd: 0, qgMscfd: 0, massLbD: 100 } },
    });
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/recirculating/);
  });
});

describe('what the network is doing to itself', () => {
  test('the bottleneck is the branch burning pressure per unit carried, not the biggest drop', () => {
    // The trunk carries everything and so has the biggest drop; that is
    // its job and pointing at it every time would be useless. The short
    // flowline burning nearly as much to move a fraction as much is the
    // one worth changing.
    const net = buildNetwork({
      nodes: [
        { id: 'w1', kind: 'well' }, { id: 'w2', kind: 'well' },
        { id: 'h', kind: 'junction' }, { id: 's', kind: 'sink', pressurePsia: 100 },
      ],
      branches: [
        { id: 'big', from: 'w1', to: 'h', label: 'W-1 flowline' },
        { id: 'choked', from: 'w2', to: 'h', label: 'W-2 flowline' },
        { id: 'trunk', from: 'h', to: 's', label: 'Trunk' },
      ],
    });
    const pressures = { w1: 400, w2: 900, h: 300, s: 100 };
    const flows = { big: 40000, choked: 2000, trunk: 42000 };
    const d = diagnose({ network: net, pressures, flows });
    expect(d.biggestDrop.id).toBe('choked');
    expect(d.bottleneck.id).toBe('choked');

    // Now make the trunk the biggest drop and check the ranking still
    // picks the intense one rather than the large one.
    const d2 = diagnose({
      network: net,
      pressures: { w1: 400, w2: 500, h: 350, s: 100 },
      flows: { big: 40000, choked: 300, trunk: 40300 },
    });
    expect(d2.biggestDrop.id).toBe('trunk');
    expect(d2.bottleneck.id).toBe('choked');
  });

  test('backflow and dead legs are named', () => {
    const net = buildNetwork({
      nodes: [
        { id: 'w', kind: 'well' }, { id: 'h', kind: 'junction' },
        { id: 'd', kind: 'junction' }, { id: 's', kind: 'sink', pressurePsia: 100 },
      ],
      branches: [
        { id: 'a', from: 'w', to: 'h' }, { id: 'dead', from: 'h', to: 'd' },
        { id: 'back', from: 'h', to: 's' },
      ],
    });
    const d = diagnose({
      network: net,
      pressures: { w: 400, h: 300, d: 300, s: 100 },
      flows: { a: 1000, dead: 0, back: -50 },
    });
    expect(d.dead.map((r) => r.id)).toEqual(['dead']);
    expect(d.backflows.map((r) => r.id)).toEqual(['back']);
  });
});

describe('a network that is not a network is refused, with a reason', () => {
  const sink = { id: 's', kind: 'sink', pressurePsia: 100 };
  const well = { id: 'w', kind: 'well' };

  test('a node with no route to a delivery point', () => {
    const r = buildNetwork({
      nodes: [well, sink, { id: 'orphan', kind: 'junction', label: 'Manifold B' }],
      branches: [{ id: 'a', from: 'w', to: 's' }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Manifold B/);
    expect(r.error).toMatch(/no route to a delivery point/);
  });

  test('no delivery point at all', () => {
    const r = buildNetwork({ nodes: [well], branches: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/delivery point/);
  });

  test('a delivery point with no pressure', () => {
    const r = buildNetwork({
      nodes: [well, { id: 's', kind: 'sink', label: 'Sep' }],
      branches: [{ id: 'a', from: 'w', to: 's' }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/needs a pressure/);
  });

  test('no wells', () => {
    const r = buildNetwork({ nodes: [sink, { id: 'j', kind: 'junction' }], branches: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/at least one well/);
  });

  test('duplicate ids, a self loop, and a branch to nowhere', () => {
    expect(buildNetwork({ nodes: [well, well, sink], branches: [] }).error)
      .toMatch(/share the id/);
    expect(buildNetwork({
      nodes: [well, sink], branches: [{ id: 'a', from: 'w', to: 'w' }],
    }).error).toMatch(/same node/);
    expect(buildNetwork({
      nodes: [well, sink], branches: [{ id: 'a', from: 'w', to: 'ghost' }],
    }).error).toMatch(/not a node/);
  });

  test('an unknown node kind', () => {
    const r = buildNetwork({
      nodes: [well, sink, { id: 'x', kind: 'compressor', label: 'K-1' }],
      branches: [{ id: 'a', from: 'w', to: 's' }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/K-1/);
  });

  test('a node nothing depends on is PINNED and reported, not refused', () => {
    // A well whose inflow does not depend on its own pressure, on a
    // branch whose flow does not either: nothing determines that node.
    // That is not a broken network -- it is exactly what a shut-in well
    // on a dead line looks like -- and the physical answer is that the
    // node sits where it sits and contributes nothing. Refusing the
    // whole network over it would throw away every other node's answer.
    const net = buildNetwork({
      nodes: [well, sink], branches: [{ id: 'a', from: 'w', to: 's' }],
    });
    const r = solveNetwork({
      network: net, branchFlow: () => 1000, wellInflow: () => 2000,
    });
    expect(r.ok).toBe(true);
    expect(r.pinned).toEqual(['w']);
    expect(r.warnings.join(' ')).toMatch(/shut-in well on a dead line/);
  });

  test('a live network reports nothing pinned', () => {
    const net = buildNetwork({
      nodes: [well, sink], branches: [{ id: 'a', from: 'w', to: 's' }],
    });
    const r = solveNetwork({
      network: net,
      branchFlow: (b, pIn, pOut) => 300 * (pIn - pOut),
      wellInflow: (nd, p) => linearWell({ qmax: 20000, prPsia: 800 })(nd, p),
    });
    expect(r.pinned).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test('the solver never puts a node below atmospheric', () => {
    const net = buildNetwork({
      nodes: [{ id: 'w', kind: 'well' }, { id: 's', kind: 'sink', pressurePsia: 20 }],
      branches: [{ id: 'a', from: 'w', to: 's' }],
    });
    const r = solveNetwork({
      network: net,
      branchFlow: (b, pIn, pOut) => 5000 * (pIn - pOut),
      wellInflow: (nd, p) => linearWell({ qmax: 100, prPsia: 25 })(nd, p),
    });
    expect(r.pressures.w).toBeGreaterThanOrEqual(MIN_PRESSURE_PSIA);
  });
});

describe('the dense linear solve underneath it', () => {
  test('solves a small system and refuses a singular one', () => {
    const x = solveLinear([[2, 1], [1, 3]], [5, 10]);
    expect(x[0]).toBeCloseTo(1, 12);
    expect(x[1]).toBeCloseTo(3, 12);
    expect(solveLinear([[1, 2], [2, 4]], [1, 2])).toBeNull();
  });

  test('partial pivoting handles a zero on the diagonal', () => {
    const x = solveLinear([[0, 1], [1, 0]], [2, 3]);
    expect(x[0]).toBeCloseTo(3, 12);
    expect(x[1]).toBeCloseTo(2, 12);
  });
});

describe('line pipe geometry', () => {
  test('EVERY schedule row is self-consistent: od minus two walls is the bore', () => {
    // The table carries all three even though the third is the first
    // two, because that redundancy is the only way it can catch its own
    // transcription errors.
    for (const r of PIPE_SCHEDULE) {
      expect(r.od - 2 * r.wall).toBeCloseTo(r.id, 3);
    }
    expect(PIPE_SCHEDULE.length).toBeGreaterThan(10);
  });

  test('a heavier schedule is a thicker wall and a smaller bore', () => {
    const s40 = scheduleRow(6, '40');
    const s80 = scheduleRow(6, '80');
    expect(s80.wall).toBeGreaterThan(s40.wall);
    expect(s80.id).toBeLessThan(s40.id);
    expect(s80.od).toBe(s40.od);
  });

  test('a size that is not in the table returns null rather than a nearby one', () => {
    expect(scheduleRow(5, '40')).toBeNull();
    expect(scheduleRow(6, '160')).toBeNull();
  });

  test('unknown fitting, roughness and grade ids resolve to NaN, never to a default', () => {
    expect(fittingK('elbow90LR')).toBe(0.3);
    expect(fittingK('elbow90')).toBeNaN();
    expect(roughnessOf('nonsense')).toBeNaN();
    expect(gradeYield('x55')).toBeNaN();
    expect(gradeYield('x52')).toBe(52000);
  });

  test('equivalent length is K D over f, and it refuses an unknown fitting', () => {
    const r = equivalentLengthFt({
      fittings: [{ id: 'elbow90LR', count: 4 }, { id: 'gateValve', count: 2 }],
      idIn: 6.065, frictionFactor: 0.018,
    });
    expect(r.sumK).toBeCloseTo(4 * 0.3 + 2 * 0.15, 12);
    expect(r.lengthFt).toBeCloseTo((1.5 * (6.065 / 12)) / 0.018, 9);
    // A smoother line has a lower friction factor, so the SAME fittings
    // are worth MORE feet of it. Quoting an equivalent length without a
    // friction factor hides an assumed one, usually about 0.02.
    const smooth = equivalentLengthFt({
      fittings: [{ id: 'elbow90LR', count: 4 }, { id: 'gateValve', count: 2 }],
      idIn: 6.065, frictionFactor: 0.012,
    });
    expect(smooth.lengthFt).toBeGreaterThan(r.lengthFt);
    expect(equivalentLengthFt({
      fittings: [{ id: 'reducer' }], idIn: 6, frictionFactor: 0.02,
    }).ok).toBe(false);
  });

  test('Barlow is linear in wall and yield, and inverse in diameter', () => {
    const base = barlowPressurePsi({
      odIn: 6.625, wallIn: 0.28, yieldPsi: 52000, designFactor: 0.72,
    });
    expect(base).toBeCloseTo((2 * 52000 * 0.28 * 0.72) / 6.625, 9);
    expect(barlowPressurePsi({
      odIn: 6.625, wallIn: 0.56, yieldPsi: 52000, designFactor: 0.72,
    })).toBeCloseTo(2 * base, 9);
    expect(barlowPressurePsi({
      odIn: 13.25, wallIn: 0.28, yieldPsi: 52000, designFactor: 0.72,
    })).toBeCloseTo(base / 2, 9);
    // No design factor is assumed. Leaving it out gives the bare hoop
    // stress, not somebody else's jurisdiction.
    expect(barlowPressurePsi({ odIn: 6.625, wallIn: 0.28, yieldPsi: 52000 }))
      .toBeCloseTo(base / 0.72, 9);
  });
});
