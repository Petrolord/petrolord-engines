// Segment compiler vs closed-form build-hold goldens and the toolface
// vector-rotation oracle. The ft-mode cases are the regression class of
// the legacy Well Planning bug (rates per 100 ft applied over metres).

import fs from 'fs';
import path from 'path';
import { compileSegments, attitudeAfterArc } from '../engines/drilling/segmentCompiler';
import { computeWellPath } from '../engines/drilling/surveyMath';

const G = (name) => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', name), 'utf8',
));

describe('build-hold vs closed form (m and ft)', () => {
  for (const c of G('compile_buildhold.json').cases) {
    test(`${c.mdUnit}: KOP ${c.kop}, ${c.rate} deg per ${c.mdUnit === 'ft' ? '100ft' : '30m'} to ${c.targetInc} deg`, () => {
      const { stations, path: p, qa } = compileSegments({
        mdUnit: c.mdUnit,
        segments: [
          { kind: 'hold', length: c.kop },
          { kind: 'build', rate: c.rate, targetInc: c.targetInc },
          { kind: 'hold', length: c.holdLen },
        ],
        tieOn: { md: 0, inc: 0, azi: c.aziDeg },
      });
      const last = stations[stations.length - 1];
      expect(last.md).toBeCloseTo(c.endMd, 6);
      expect(last.inc).toBeCloseTo(c.endInc, 9);
      const end = p[p.length - 1];
      expect(end.tvd).toBeCloseTo(c.endTvd, 4);
      expect(end.y).toBeCloseTo(c.endN, 4);
      expect(end.x).toBeCloseTo(c.endE, 4);
      expect(qa.physicalBound).toBe(true);
    });
  }

  test('ft regression: 3 deg/100ft over 1000 ft ends at exactly 30 deg, never 9.14', () => {
    const { stations } = compileSegments({
      mdUnit: 'ft',
      segments: [{ kind: 'build', rate: 3, length: 1000 }],
    });
    expect(stations[stations.length - 1].inc).toBeCloseTo(30, 9);
  });
});

describe('toolface arcs vs the vector-rotation oracle', () => {
  for (const c of G('toolface_sphere.json').cases.slice(0, 20)) {
    test(`I1 ${c.inc1.toFixed(1)}, tau ${c.toolfaceDeg.toFixed(1)}, beta ${c.betaDeg.toFixed(2)}`, () => {
      const a = attitudeAfterArc(c.inc1, c.azi1, c.betaDeg * Math.PI / 180, c.toolfaceDeg);
      expect(a.inc).toBeCloseTo(c.inc2, 7);
      const dAzi = ((a.azi - c.azi2) % 360 + 540) % 360 - 180;
      expect(Math.abs(dAzi)).toBeLessThan(1e-7);
    });
  }

  test('kick-off from vertical uses toolface-from-north', () => {
    const vertical = G('toolface_sphere.json').cases.filter((c) => c.inc1 === 0);
    expect(vertical.length).toBeGreaterThan(0);
    for (const c of vertical) {
      const a = attitudeAfterArc(0, 0, c.betaDeg * Math.PI / 180, c.toolfaceDeg);
      expect(a.inc).toBeCloseTo(c.inc2, 7);
      const dAzi = ((a.azi - c.azi2) % 360 + 540) % 360 - 180;
      expect(Math.abs(dAzi)).toBeLessThan(1e-7);
    }
  });

  test('toolfaceArc segment endpoints match attitudeAfterArc exactly', () => {
    const { stations } = compileSegments({
      mdUnit: 'm',
      tieOn: { md: 0, inc: 20, azi: 300 },
      segments: [{ kind: 'toolfaceArc', dls: 4, toolfaceDeg: 65, length: 240 }],
    });
    const beta = (4 / 30) * 240 * Math.PI / 180;
    const exp = attitudeAfterArc(20, 300, beta, 65);
    const last = stations[stations.length - 1];
    expect(last.inc).toBeCloseTo(exp.inc, 9);
    expect(last.azi).toBeCloseTo(exp.azi, 9);
  });
});

describe('compiler semantics and QA', () => {
  test('turn at constant inclination holds inclination and reaches targetAzi', () => {
    const { stations } = compileSegments({
      mdUnit: 'm',
      tieOn: { md: 1000, inc: 45, azi: 80 },
      segments: [{ kind: 'turn', rate: 2, targetAzi: 170 }],
    });
    const last = stations[stations.length - 1];
    expect(last.inc).toBeCloseTo(45, 9);
    expect(last.azi).toBeCloseTo(170, 6);
    // 90 deg at 2 deg/30m -> 1350 m
    expect(last.md).toBeCloseTo(1000 + 1350, 6);
  });

  test('turning a vertical hole is a clear domain error', () => {
    expect(() => compileSegments({
      segments: [{ kind: 'turn', rate: 2, length: 300 }],
    })).toThrow(/vertical/);
  });

  test('maxDls flags an over-limit design without corrupting output', () => {
    const { qa } = compileSegments({
      mdUnit: 'm',
      maxDls: 2,
      segments: [{ kind: 'build', rate: 3, targetInc: 30 }],
    });
    expect(qa.dlsExceeded).toBe(true);
    expect(qa.worstDls).toBeCloseTo(3, 6);
    expect(qa.ok).toBe(false);
  });

  test('deviated designs pass QA (the legacy lengthSanity false-failure class)', () => {
    const { qa } = compileSegments({
      mdUnit: 'm',
      segments: [
        { kind: 'hold', length: 500 },
        { kind: 'build', rate: 3, targetInc: 60 },
        { kind: 'hold', length: 800 },
      ],
    });
    expect(qa.ok).toBe(true);
    expect(qa.physicalBound).toBe(true);
  });

  test('compiled stations recompute to the same path (self-consistency)', () => {
    const { stations, path: p } = compileSegments({
      mdUnit: 'm',
      tieOn: { md: 200, inc: 10, azi: 45 },
      segments: [
        { kind: 'buildTurn', buildRate: 2, turnRate: 1.5, length: 600 },
        { kind: 'hold', length: 300 },
      ],
      surfaceX: 5000, surfaceY: 8000, kb: 25,
    });
    const p2 = computeWellPath(stations, { surfaceX: 5000, surfaceY: 8000, kb: 25 });
    p.forEach((row, i) => {
      expect(row.x).toBeCloseTo(p2[i].x, 9);
      expect(row.y).toBeCloseTo(p2[i].y, 9);
      expect(row.tvd).toBeCloseTo(p2[i].tvd, 9);
    });
  });

  test('holds are subdivided for strip-chart density without changing the trajectory (WD3)', () => {
    const spec = {
      mdUnit: 'm',
      subdivideMd: 10,
      segments: [
        { kind: 'build', rate: 3, targetInc: 45 },
        { kind: 'hold', length: 1000 },
      ],
    };
    const { stations, table } = compileSegments(spec);
    // Every subdivided hold station carries the exact hold attitude and
    // zero dogleg, and the hold contributes 100 intervals at 10 m.
    const holdRows = table.filter((r) => r.md > 450 + 1e-9);
    expect(holdRows.length).toBe(100);
    for (const r of holdRows) {
      expect(r.inc).toBeCloseTo(45, 9);
      expect(r.dls30m).toBeCloseTo(0, 9);
    }
    // Endpoint identical to a coarse compile (the hold is exact math).
    const coarse = compileSegments({ ...spec, subdivideMd: 1e9 });
    const a = table[table.length - 1];
    const b = coarse.table[coarse.table.length - 1];
    expect(a.md).toBeCloseTo(b.md, 9);
    expect(a.tvd).toBeCloseTo(b.tvd, 9);
    expect(a.n).toBeCloseTo(b.n, 9);
    expect(a.e).toBeCloseTo(b.e, 9);
    expect(stations[stations.length - 1].inc).toBeCloseTo(45, 9);
  });
});
