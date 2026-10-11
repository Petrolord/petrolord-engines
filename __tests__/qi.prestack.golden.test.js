/**
 * E1a extraction gate for engines/qi/prestack.js: every assertion calls the
 * shipped function and compares it with test-data/qi/goldens.prestack.json,
 * written by tools/validation/qi/oracle_qi_prestack.py (stdlib Python, exact
 * rationals for Dix, Newton on the ray parameter for the exact ray, Walden by
 * the atan-then-Snell route, partial stacks straight from the raw samples).
 * Negative controls: tools/validation/qi/negcontrol_e1a.sh.
 */
import G from '../test-data/qi/goldens.prestack.json';
import {
  dixInterval, layeredRms, rayTraceAngle, waldenAngle, binOffsets, angleGather, partialStack, usableAngle, velocityOnGrid,
} from '../engines/qi/prestack';

const near = (a, b, tol) => {
  if (b === null) { expect(Number.isFinite(a)).toBe(false); return; }
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
};
const sweep = (xs) => { expect(xs.length).toBeGreaterThan(0); return xs; };

describe('velocities', () => {
  test.each(sweep(G.dix).map((c) => [c.name, c]))('layered RMS and Dix on %s match the rational oracle', (_, c) => {
    const r = layeredRms(c.layers);
    r.forEach((q, k) => { near(q.t0, c.t0[k], 1e-12); near(q.vrms, c.vrms[k], 1e-9); });
    const vi = dixInterval(c.vrms, c.t0);
    c.vint.forEach((v, k) => near(vi[k], v, 1e-8));
    c.layers.forEach((l, k) => near(vi[k], l.v, 1e-8));
  });
  test('velocity on the trace grid: interpolated Vrms and the Dix velocity of each segment', () => {
    for (const c of sweep(G.velocityOnGrid)) {
      const r = velocityOnGrid(c.tMs, c.vrms, c.ns, c.dtMs, c.t0Ms);
      c.outVrms.forEach((v, k) => near(r.vrms[k], v, 1e-9));
      // a table starting at 0 ms is clamped to 1e-6 ms in the engine: 1e-9 relative at most
      c.outVint.forEach((v, k) => near(r.vint[k], v, 1e-6));
    }
  });
});

describe('incidence angle', () => {
  test('the exact ray trace (bisection in the engine) matches Newton on the ray parameter', () => {
    for (const c of sweep(G.rays)) {
      const layers = G.dix.find((d) => d.name === c.model).layers;
      near(rayTraceAngle(layers, c.target, c.offsetM), c.exactDeg, 1e-9);
    }
  });
  test('the Walden straight-ray angle matches the oracle (atan then Snell)', () => {
    for (const c of sweep(G.rays)) near(waldenAngle(c.offsetM, c.t0, c.vrms, c.vint), c.waldenDeg, 1e-10);
    for (const c of sweep(G.walden)) near(waldenAngle(c.offsetM, c.t0, c.vrms, c.vint), c.deg, 1e-10);
  });
});

describe('gathers', () => {
  test('offset bins: exact rational floor and fold', () => {
    for (const c of sweep(G.bins)) {
      const b = binOffsets(c.offsets.map((o) => (o === null ? NaN : o)), c.widthM);
      expect(Array.from(b.index)).toEqual(c.index);
      expect(b.fold).toEqual(c.fold);
      b.centres.forEach((v, k) => near(v, c.centres[k], 1e-12));
    }
  });
  const g = G.angleGather;
  const ag = angleGather({ traces: g.traces, offsets: g.offsets, vrms: g.vrms, vint: g.vint, dtMs: g.dtMs, t0Ms: g.t0Ms, edges: g.edges });
  test('angle gather: fold and bin means', () => {
    expect(ag.gather.length).toBe(g.edges.length - 1);
    g.fold.forEach((row, k) => expect(Array.from(ag.fold[k])).toEqual(row));
    g.gather.forEach((row, k) => row.forEach((v, i) => near(ag.gather[k][i], v, 1e-12)));
  });
  test('partial stacks equal the mean of the raw samples in the angle range', () => {
    for (const s of sweep(G.partialStacks)) {
      const out = partialStack(ag, s.from, s.to);
      s.stack.forEach((v, i) => near(out[i], v, 1e-12));
    }
  });
  test('usable angle at each minimum fold', () => {
    for (const u of sweep(G.usable)) {
      const out = usableAngle(ag, g.edges, u.minFold);
      u.deg.forEach((v, i) => near(out[i], v, 0));
    }
  });
});
