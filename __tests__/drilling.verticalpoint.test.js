// Vertical-to-target and the Point method (Well Design Studio tester
// fix 2026-09-22, Darm PlanB r2). A tester planned a vertical well to a
// target at the slot X and Y and the designer forced a build, leaving the
// well slightly deviated. Every case here compiles the solved segments
// with the segment compiler and checks where the well actually goes:
// a report that says "vertical" proves nothing on its own.

import {
  solveSlant, solveSProfile, solveContinuousBuild, solveHorizontalLanding,
  solvePoint, verticalToleranceFor, DEFAULT_VERTICAL_TOLERANCE_M,
} from '../engines/drilling/profileDesign';
import { compileSegments } from '../engines/drilling/segmentCompiler';

const compile = (segments, { inc = 0, azi = 0, mdUnit = 'm' } = {}) => {
  const { stations, path: p } = compileSegments({
    mdUnit, tieOn: { md: 0, inc, azi }, segments, subdivideMd: 5,
  });
  return { stations, end: p[p.length - 1], endStation: stations[stations.length - 1], path: p };
};

const maxInc = (stations) => stations.reduce((m, s) => (s.inc > m ? s.inc : m), 0);

// Each design method with the inputs a designer would leave in the dialog
// (kickoff, rates, final inclination), aimed at a target {dN, dE, dTvd}
// from a vertical tie-on. Append-mode methods start from a vertical end.
const METHODS = {
  'build and hold': (target, extra = {}) => solveSlant({
    target, buildRate: 3, kopLen: 300, mdUnit: 'm', ...extra,
  }),
  'S-profile': (target, extra = {}) => solveSProfile({
    target, kopLen: 300, buildRate: 3, dropRate: 2, finalIncDeg: 0, mdUnit: 'm', ...extra,
  }),
  'curve to target': (target, extra = {}) => solveContinuousBuild({
    tieOn: { inc: 0, azi: 0 }, delta: target, mdUnit: 'm', ...extra,
  }),
  'horizontal landing': (target, extra = {}) => solveHorizontalLanding({
    tieOn: { inc: 0, azi: 0 }, landing: target, rate1: 3, rate2: 3, mdUnit: 'm', ...extra,
  }),
  point: (target, extra = {}) => solvePoint({
    tieOn: { inc: 0, azi: 0 }, point: target, dls: 3, mdUnit: 'm', ...extra,
  }),
};

describe('a target at the slot X and Y gives a vertical well with every method', () => {
  for (const [name, solve] of Object.entries(METHODS)) {
    test(`${name}: exactly below`, () => {
      const sol = solve({ dN: 0, dE: 0, dTvd: 3000 });
      expect(sol.feasible).toBe(true);
      expect(sol.segments).toEqual([{ kind: 'hold', length: 3000 }]);
      expect(sol.report.profile).toBe('vertical to target');
      expect(sol.report.verticalToTarget).toBe(true);
      const { stations, end } = compile(sol.segments);
      expect(maxInc(stations)).toBe(0);
      expect(end.x).toBe(0);
      expect(end.y).toBe(0);
      expect(end.tvd).toBeCloseTo(3000, 9);
    });

    test(`${name}: 0.3 m off is inside the default 0.5 m tolerance`, () => {
      const sol = solve({ dN: 0.2, dE: -0.2236, dTvd: 3000 });
      expect(sol.feasible).toBe(true);
      expect(sol.segments).toEqual([{ kind: 'hold', length: 3000 }]);
      expect(sol.report.horizontalMiss).toBeCloseTo(Math.hypot(0.2, 0.2236), 9);
      expect(sol.report.tolerance).toBe(DEFAULT_VERTICAL_TOLERANCE_M);
      const { stations } = compile(sol.segments);
      expect(maxInc(stations)).toBe(0);
    });
  }

  test('the kickoff is not split off a vertical hold: one segment, not two', () => {
    const sol = solveSlant({ target: { dN: 0, dE: 0, dTvd: 3000 }, buildRate: 3, kopLen: 2000 });
    expect(sol.segments).toHaveLength(1);
  });

  test('no azimuth and no rate are needed for a vertical well', () => {
    // A blank build rate would otherwise be refused; straight down needs none.
    const sol = solveSlant({ target: { dN: 0, dE: 0, dTvd: 1500 }, buildRate: NaN });
    expect(sol.feasible).toBe(true);
    expect(sol.report.aziDeg).toBe(0);
  });

  test('the tolerance scales to feet: 0.3 m is 0.98 ft, inside the default 1.64 ft', () => {
    const sol = solveSlant({
      target: { dN: 0.3 / 0.3048, dE: 0, dTvd: 9000 }, buildRate: 3, kopLen: 1000, mdUnit: 'ft',
    });
    expect(sol.report.verticalToTarget).toBe(true);
    expect(sol.report.tolerance).toBeCloseTo(0.5 / 0.3048, 9);
  });

  test('a tolerance of zero keeps the 0.3 m case a (tiny) build', () => {
    const sol = solveSlant({
      target: { dN: 0.3, dE: 0, dTvd: 3000 }, buildRate: 3, kopLen: 300, verticalTolerance: 0,
    });
    expect(sol.report.verticalToTarget).toBeUndefined();
    expect(sol.segments.some((s) => s.kind === 'build')).toBe(true);
  });

  test('an unreasonable tolerance is refused by name', () => {
    expect(verticalToleranceFor(11, 'm').error).toMatch(/deviated well vertical/);
    expect(verticalToleranceFor(-1, 'm').error).toMatch(/zero or more/);
    expect(verticalToleranceFor(10, 'm').tolerance).toBe(10);
    const sol = solveSlant({ target: { dN: 0, dE: 0, dTvd: 3000 }, buildRate: 3, verticalTolerance: 50 });
    expect(sol.feasible).toBe(false);
  });

  test('a target above the tie-on is refused, not drilled upward', () => {
    const sol = solveContinuousBuild({ tieOn: { inc: 0, azi: 0 }, delta: { dN: 0, dE: 0, dTvd: -10 } });
    expect(sol.feasible).toBe(false);
    expect(sol.error).toMatch(/above the tie-on/);
  });

  test('a horizontal landing with a toe or an azimuth still lands', () => {
    const sol = solveHorizontalLanding({
      tieOn: { inc: 0, azi: 0 },
      landing: { dN: 0, dE: 0, dTvd: 3000, aziDeg: 90 },
      rate1: 3, rate2: 3,
    });
    expect(sol.report.verticalToTarget).toBeUndefined();
    expect(sol.report.landInc).toBe(90);
  });
});

describe('a target 2 m off gives a small build and reports the dogleg', () => {
  test('build and hold', () => {
    const target = { dN: 2, dE: 0, dTvd: 3000 };
    const sol = solveSlant({ target, buildRate: 3, kopLen: 300 });
    expect(sol.feasible).toBe(true);
    expect(sol.report.verticalToTarget).toBeUndefined();
    expect(sol.report.doglegDeg).toBeGreaterThan(0);
    expect(sol.report.doglegDeg).toBeLessThan(0.1);
    expect(sol.report.doglegDeg).toBeCloseTo(sol.report.holdIncDeg, 12);
    const { end } = compile(sol.segments, { azi: sol.report.aziDeg });
    expect(end.y).toBeCloseTo(2, 6);
    expect(end.tvd).toBeCloseTo(3000, 6);
  });

  test('curve to target and point report their dogleg too', () => {
    const cb = solveContinuousBuild({ tieOn: { inc: 0, azi: 0 }, delta: { dN: 0, dE: 2, dTvd: 2700 } });
    expect(cb.report.doglegDeg).toBeGreaterThan(0);
    expect(cb.report.doglegDeg).toBeLessThan(0.2);
    const pt = solvePoint({ tieOn: { inc: 0, azi: 0 }, point: { dN: 0, dE: 2, dTvd: 2700 }, dls: 3 });
    expect(pt.feasible).toBe(true);
    expect(pt.report.geometry).toBe('curve-hold');
    expect(pt.report.doglegDeg).toBeGreaterThan(0);
    expect(pt.report.doglegDeg).toBeLessThan(0.2);
  });
});

describe('Point method geometry', () => {
  test('vertical end, offset point: curve at the DLS, then hold a tangent onto the point', () => {
    const point = { dN: 400, dE: 300, dTvd: 1800 };
    const sol = solvePoint({ tieOn: { inc: 0, azi: 0 }, point, dls: 3 });
    expect(sol.feasible).toBe(true);
    expect(sol.report.geometry).toBe('curve-hold');
    expect(sol.segments.map((s) => s.kind)).toEqual(['toolfaceArc', 'hold']);
    expect(sol.segments[0].dls).toBe(3);
    const { end, endStation } = compile(sol.segments);
    expect(end.y).toBeCloseTo(400, 6);
    expect(end.x).toBeCloseTo(300, 6);
    expect(end.tvd).toBeCloseTo(1800, 6);
    expect(endStation.inc).toBeCloseTo(sol.report.endInc, 6);
    // Toward the point: azimuth atan2(300, 400) = 36.87 deg.
    expect(sol.report.endAzi).toBeCloseTo(36.8699, 3);
  });

  test('deviated end, offset point (auto): curve and tangent hold in 3D', () => {
    const tieOn = { inc: 25, azi: 40 };
    const point = { dN: 150, dE: 420, dTvd: 900 };
    const sol = solvePoint({ tieOn, point, dls: 2.5 });
    expect(sol.feasible).toBe(true);
    expect(sol.report.geometry).toBe('curve-hold');
    const { end } = compile(sol.segments, tieOn);
    expect(end.y).toBeCloseTo(150, 6);
    expect(end.x).toBeCloseTo(420, 6);
    expect(end.tvd).toBeCloseTo(900, 6);
  });

  test('deviated end, point directly below it: drop to vertical and arrive vertically', () => {
    const tieOn = { inc: 12, azi: 70 };
    const point = { dN: 0, dE: 0, dTvd: 1200 };
    const sol = solvePoint({ tieOn, point, dls: 2 });
    expect(sol.feasible).toBe(true);
    expect(sol.report.geometry).toMatch(/vertical/);
    const { end, endStation } = compile(sol.segments, tieOn);
    expect(end.x).toBeCloseTo(0, 4);
    expect(end.y).toBeCloseTo(0, 4);
    expect(end.tvd).toBeCloseTo(1200, 4);
    expect(endStation.inc).toBeLessThan(0.1);
  });

  test('a point on the line where a straight drop ends: exactly a drop, then a vertical hold', () => {
    const inc0 = 10;
    const dls = 2;
    const R = 30 / (dls * Math.PI / 180);
    const i0 = inc0 * Math.PI / 180;
    // A pure drop from inc0 at azimuth 0 advances R(1 - cos i0) north
    // and R sin i0 down; hold 500 more vertically.
    const point = { dN: R * (1 - Math.cos(i0)), dE: 0, dTvd: R * Math.sin(i0) + 500 };
    const sol = solvePoint({ tieOn: { inc: inc0, azi: 0 }, point, dls, arrive: 'vertical' });
    expect(sol.feasible).toBe(true);
    expect(sol.report.geometry).toBe('drop to vertical');
    expect(sol.segments).toHaveLength(2);
    expect(sol.segments[0].kind).toBe('toolfaceArc');
    expect(sol.segments[0].length).toBeCloseTo(R * i0, 5);
    expect(sol.segments[1].kind).toBe('hold');
    expect(sol.segments[1].length).toBeCloseTo(500, 5);
    expect(sol.report.doglegDeg).toBeCloseTo(inc0, 5);
  });

  test('a nudged well dropped to a point below the slot finishes vertical within 0.1 deg', () => {
    // Nudge out: hold 300, build 2 deg/30m to 8 deg, hold 250 (still deviated).
    const nudge = [
      { kind: 'hold', length: 300 },
      { kind: 'build', rate: 2, length: 120 },
      { kind: 'hold', length: 250 },
    ];
    const nudgeAzi = 135;
    const before = compile(nudge, { azi: nudgeAzi });
    const endAtt = before.endStation;
    expect(endAtt.inc).toBeCloseTo(8, 6);
    // Point below the slot (wellhead X and Y) at 2,000 m TVD.
    const point = { dN: -before.end.y, dE: -before.end.x, dTvd: 2000 - before.end.tvd };
    const sol = solvePoint({
      tieOn: { inc: endAtt.inc, azi: endAtt.azi }, point, dls: 2, arrive: 'vertical',
    });
    expect(sol.feasible).toBe(true);
    const all = compile([...nudge, ...sol.segments], { azi: nudgeAzi });
    expect(all.endStation.inc).toBeLessThan(0.1);
    expect(all.end.x).toBeCloseTo(0, 3);
    expect(all.end.y).toBeCloseTo(0, 3);
    expect(all.end.tvd).toBeCloseTo(2000, 3);
  });

  test('vertical end with arrive=vertical and an offset point: out and back to vertical', () => {
    const sol = solvePoint({
      tieOn: { inc: 0, azi: 0 }, point: { dN: 60, dE: 0, dTvd: 1500 }, dls: 2, arrive: 'vertical',
    });
    expect(sol.feasible).toBe(true);
    const { end, endStation } = compile(sol.segments);
    expect(end.y).toBeCloseTo(60, 4);
    expect(end.tvd).toBeCloseTo(1500, 4);
    expect(endStation.inc).toBeLessThan(0.1);
  });

  test('a point it cannot reach at the DLS is refused with how far off it is', () => {
    // 3 deg/30m: R = 573 m. A point 300 m out at only 200 m below is
    // inside the turning circle.
    const sol = solvePoint({ tieOn: { inc: 0, azi: 0 }, point: { dN: 300, dE: 0, dTvd: 200 }, dls: 3 });
    expect(sol.feasible).toBe(false);
    expect(sol.error).toMatch(/inside the turning circle/);
    expect(sol.shortBy).toBeGreaterThan(0);
    expect(sol.minDls).toBeGreaterThan(3);
    // The reported minimum DLS does reach it; just below it does not.
    expect(solvePoint({ tieOn: { inc: 0, azi: 0 }, point: { dN: 300, dE: 0, dTvd: 200 }, dls: sol.minDls * 1.0001 }).feasible).toBe(true);
    expect(solvePoint({ tieOn: { inc: 0, azi: 0 }, point: { dN: 300, dE: 0, dTvd: 200 }, dls: sol.minDls * 0.999 }).feasible).toBe(false);
  });

  test('a vertical arrival it cannot make says how much deeper, and the DLS that would do', () => {
    const tieOn = { inc: 30, azi: 0 };
    const point = { dN: 0, dE: 0, dTvd: 150 };
    const sol = solvePoint({ tieOn, point, dls: 2 });
    expect(sol.feasible).toBe(false);
    expect(sol.error).toMatch(/deeper/);
    expect(sol.shortBy).toBeGreaterThan(0);
    const deeper = solvePoint({ tieOn, point: { ...point, dTvd: point.dTvd + sol.shortBy * 1.001 + 1e-6 }, dls: 2 });
    expect(deeper.feasible).toBe(true);
    if (sol.minDls != null) {
      expect(solvePoint({ tieOn, point, dls: sol.minDls * 1.001 }).feasible).toBe(true);
    }
  });

  test('Using MD: straight down, the TVD is the MD', () => {
    const sol = solvePoint({ tieOn: { inc: 0, azi: 0 }, point: { dN: 0, dE: 0, md: 2500 }, dls: 3, mode: 'md' });
    expect(sol.feasible).toBe(true);
    expect(sol.report.solvedTvd).toBeCloseTo(2500, 9);
    expect(sol.segments).toEqual([{ kind: 'hold', length: 2500 }]);
  });

  test('Using MD: the solved well has exactly that MD and lands on the N/E', () => {
    const sol = solvePoint({ tieOn: { inc: 0, azi: 0 }, point: { dN: 350, dE: -120, md: 2200 }, dls: 3, mode: 'md' });
    expect(sol.feasible).toBe(true);
    const total = sol.segments.reduce((a, s) => a + s.length, 0);
    expect(total).toBeCloseTo(2200, 5);
    const { end } = compile(sol.segments);
    expect(end.y).toBeCloseTo(350, 4);
    expect(end.x).toBeCloseTo(-120, 4);
    expect(end.tvd).toBeCloseTo(sol.report.solvedTvd, 4);
  });

  test('Using MD: too little hole for the N/E is refused with the shortfall', () => {
    const sol = solvePoint({ tieOn: { inc: 0, azi: 0 }, point: { dN: 500, dE: 0, md: 400 }, dls: 3, mode: 'md' });
    expect(sol.feasible).toBe(false);
    expect(sol.shortBy).toBeGreaterThan(0);
  });

  test('refuses garbage by name and never throws', () => {
    expect(solvePoint({}).feasible).toBe(false);
    expect(solvePoint({ point: { dN: 1, dE: 2, dTvd: NaN }, dls: 3 }).error).toMatch(/point TVD/);
    expect(solvePoint({ point: { dN: 100, dE: 0, dTvd: 900 }, dls: 0 }).error).toMatch(/DLS above zero/);
    expect(solvePoint({ point: { dN: 100, dE: 0, dTvd: 900 }, dls: 3, mode: 'x' }).feasible).toBe(false);
    expect(solvePoint({ point: { dN: 100, dE: 0, dTvd: 900 }, dls: 3, arrive: 'x' }).feasible).toBe(false);
  });

  test('randomised: every feasible Point solution lands on its point', () => {
    let seed = 20260922;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    let feasible = 0;
    for (let i = 0; i < 300; i++) {
      const tieOn = { inc: rnd() < 0.3 ? 0 : rnd() * 60, azi: rnd() * 360 };
      const point = { dN: (rnd() - 0.5) * 2000, dE: (rnd() - 0.5) * 2000, dTvd: 200 + rnd() * 2500 };
      const arrive = ['auto', 'tangent', 'vertical'][i % 3];
      const sol = solvePoint({ tieOn, point, dls: 1 + rnd() * 5, arrive });
      if (!sol.feasible) { expect(typeof sol.error).toBe('string'); continue; }
      feasible += 1;
      const { end, endStation } = compile(sol.segments, tieOn);
      expect(end.y).toBeCloseTo(point.dN, 2);
      expect(end.x).toBeCloseTo(point.dE, 2);
      expect(end.tvd).toBeCloseTo(point.dTvd, 2);
      if (arrive === 'vertical') expect(endStation.inc).toBeLessThan(0.1);
    }
    expect(feasible).toBeGreaterThan(150);
  });
});
