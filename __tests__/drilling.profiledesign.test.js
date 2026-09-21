// Profile-design solvers vs forward-constructed oracle goldens and
// round-trip property tests: every solver's emitted segments are
// compiled with the segment compiler and must land on the target.

import fs from 'fs';
import path from 'path';
import {
  solveSlant, solveSProfile, solveContinuousBuild,
  solveHorizontalLanding, solveNudge, solveNudgeInverse, toolfaceForTarget,
  bearingBetween, landingFromTargets,
} from '../engines/drilling/profileDesign';
import { compileSegments, attitudeAfterArc } from '../engines/drilling/segmentCompiler';

const G = (name) => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', name), 'utf8',
));

const compileTo = (segments, { azi = 0, inc = 0, mdUnit = 'm' } = {}) => {
  const { stations, path: p } = compileSegments({
    mdUnit, tieOn: { md: 0, inc, azi }, segments, subdivideMd: 5,
  });
  const last = p[p.length - 1];
  return { end: last, endStation: stations[stations.length - 1], stations };
};

describe('slant (build-hold) recovers the closed-form golden geometry', () => {
  for (const c of G('compile_buildhold.json').cases) {
    test(`${c.mdUnit}: ${c.rate} deg rate to ${c.targetInc} deg`, () => {
      const sol = solveSlant({
        target: { dN: c.endN, dE: c.endE, dTvd: c.endTvd - c.kop },
        buildRate: c.rate,
        mdUnit: c.mdUnit,
      });
      expect(sol.feasible).toBe(true);
      expect(sol.report.holdIncDeg).toBeCloseTo(c.targetInc, 6);
      expect(sol.report.holdLen).toBeCloseTo(c.holdLen, 4);
      expect(sol.report.aziDeg).toBeCloseTo(c.aziDeg, 6);
      // Round-trip: kop hold + solved segments must land on the target.
      const { end } = compileTo(
        [{ kind: 'hold', length: c.kop }, ...sol.segments],
        { azi: sol.report.aziDeg, mdUnit: c.mdUnit },
      );
      expect(end.y).toBeCloseTo(c.endN, 4);
      expect(end.x).toBeCloseTo(c.endE, 4);
      expect(end.tvd).toBeCloseTo(c.endTvd, 4);
    });
  }

  test('infeasible target inside the build circle reports the minimum rate', () => {
    const sol = solveSlant({ target: { dN: 50, dE: 0, dTvd: 100 }, buildRate: 1, mdUnit: 'm' });
    expect(sol.feasible).toBe(false);
    expect(sol.error).toMatch(/build circle/);
  });

  test('drop-side solution from an inclined tie-on', () => {
    // Tie-on at 40 deg; target nearly under the tie-on requires dropping.
    const sol = solveSlant({
      tieOn: { inc: 40, azi: 0 },
      target: { dN: 150, dE: 0, dTvd: 800 },
      buildRate: 3, mdUnit: 'm',
    });
    expect(sol.feasible).toBe(true);
    expect(sol.report.dropping).toBe(true);
    const { end } = compileTo(sol.segments, { inc: 40, azi: 0, mdUnit: 'm' });
    expect(end.y).toBeCloseTo(150, 3);
    expect(end.tvd).toBeCloseTo(800, 3);
  });
});

describe('S-profile vs the forward-constructed oracle', () => {
  for (const c of G('sprofile_cases.json').cases) {
    test(`${c.mdUnit}: theta ${c.expected.holdIncDeg} deg to final ${c.finalIncDeg} deg`, () => {
      const sol = solveSProfile({
        kopLen: c.kopLen, buildRate: c.buildRate, dropRate: c.dropRate,
        finalIncDeg: c.finalIncDeg, target: c.target, mdUnit: c.mdUnit,
      });
      expect(sol.feasible).toBe(true);
      expect(sol.report.holdIncDeg).toBeCloseTo(c.expected.holdIncDeg, 6);
      expect(sol.report.holdLen).toBeCloseTo(c.expected.holdLen, 4);
      expect(sol.report.buildLen).toBeCloseTo(c.expected.buildLen, 4);
      expect(sol.report.dropLen).toBeCloseTo(c.expected.dropLen, 4);
      const { end, endStation } = compileTo(sol.segments, { azi: sol.report.aziDeg, mdUnit: c.mdUnit });
      expect(end.y).toBeCloseTo(c.target.dN, 3);
      expect(end.x).toBeCloseTo(c.target.dE, 3);
      expect(end.tvd).toBeCloseTo(c.target.dTvd, 3);
      expect(endStation.inc).toBeCloseTo(c.finalIncDeg, 6);
    });
  }
});

describe('continuous build (single 3D arc)', () => {
  test('recovers a randomly constructed arc and lands on its end point', () => {
    let count = 0;
    for (const [inc, azi, dls, tf, len] of [
      [12, 40, 3.2, 75, 640], [55, 200, 2.1, 160, 900],
      [0, 0, 4, 30, 300], [80, 350, 1.5, 285, 1200],
    ]) {
      const fwd = compileTo(
        [{ kind: 'toolfaceArc', dls, toolfaceDeg: tf, length: len }],
        { inc, azi, mdUnit: 'm' },
      );
      const sol = solveContinuousBuild({
        tieOn: { inc, azi },
        delta: { dN: fwd.end.y, dE: fwd.end.x, dTvd: fwd.end.tvd },
        mdUnit: 'm',
      });
      expect(sol.feasible).toBe(true);
      const back = compileTo(sol.segments, { inc, azi, mdUnit: 'm' });
      expect(back.end.x).toBeCloseTo(fwd.end.x, 4);
      expect(back.end.y).toBeCloseTo(fwd.end.y, 4);
      expect(back.end.tvd).toBeCloseTo(fwd.end.tvd, 4);
      count += 1;
    }
    expect(count).toBe(4);
  });

  test('collinear target degenerates to a hold', () => {
    const sol = solveContinuousBuild({
      tieOn: { inc: 30, azi: 45 },
      delta: {
        dN: 500 * Math.sin(30 * Math.PI / 180) * Math.cos(45 * Math.PI / 180),
        dE: 500 * Math.sin(30 * Math.PI / 180) * Math.sin(45 * Math.PI / 180),
        dTvd: 500 * Math.cos(30 * Math.PI / 180),
      },
      mdUnit: 'm',
    });
    expect(sol.feasible).toBe(true);
    expect(sol.segments[0].kind).toBe('hold');
  });

  test('maxDls constraint is enforced with a clear message', () => {
    const sol = solveContinuousBuild({
      tieOn: { inc: 0, azi: 0 },
      delta: { dN: 500, dE: 0, dTvd: 100 },
      mdUnit: 'm', maxDls: 1,
    });
    expect(sol.feasible).toBe(false);
    expect(sol.error).toMatch(/exceeds the maximum/);
  });
});

describe('horizontal landing (curve-hold-curve) vs the forward oracle', () => {
  for (const c of G('chc_cases.json').cases) {
    test(`${c.mdUnit}: land at ${c.landing.incDeg} deg azi ${c.landing.aziDeg}`, () => {
      const sol = solveHorizontalLanding({
        tieOn: c.tieOn, landing: c.landing,
        rate1: c.rate1, rate2: c.rate2, mdUnit: c.mdUnit,
      });
      expect(sol.feasible).toBe(true);
      expect(sol.report.arc1Len).toBeCloseTo(c.expected.arc1Len, 3);
      expect(sol.report.holdLen).toBeCloseTo(c.expected.holdLen, 3);
      expect(sol.report.arc2Len).toBeCloseTo(c.expected.arc2Len, 3);
      expect(sol.report.holdInc).toBeCloseTo(c.expected.holdInc, 4);
      const dAzi = ((sol.report.holdAzi - c.expected.holdAzi) % 360 + 540) % 360 - 180;
      expect(Math.abs(dAzi)).toBeLessThan(1e-4);
      // Round-trip: compiled segments land on the landing point with
      // the landing attitude.
      const { end, endStation } = compileTo(sol.segments, {
        inc: c.tieOn.inc, azi: c.tieOn.azi, mdUnit: c.mdUnit,
      });
      expect(end.x).toBeCloseTo(c.landing.dE, 2);
      expect(end.y).toBeCloseTo(c.landing.dN, 2);
      expect(end.tvd).toBeCloseTo(c.landing.dTvd, 2);
      expect(endStation.inc).toBeCloseTo(c.landing.incDeg, 3);
      const dLandAzi = ((endStation.azi - c.landing.aziDeg) % 360 + 540) % 360 - 180;
      expect(Math.abs(dLandAzi)).toBeLessThan(1e-3);
    });
  }
});

describe('nudge', () => {
  test('inverse recovers a forward-constructed nudge', () => {
    const fwd = solveNudge({
      nudgeIncDeg: 12, nudgeAziDeg: 90, holdLen: 180,
      buildRate: 2.5, dropRate: 2.0, mdUnit: 'm',
    });
    expect(fwd.feasible).toBe(true);
    const inv = solveNudgeInverse({
      offset: fwd.report.offset, verticalLen: fwd.report.verticalLen,
      buildRate: 2.5, dropRate: 2.0, mdUnit: 'm',
    });
    expect(inv.feasible).toBe(true);
    expect(inv.report.nudgeIncDeg).toBeCloseTo(12, 6);
    // Compiled end point: laterally offset, vertical again.
    const { end, endStation } = compileTo(fwd.segments, { azi: 90, mdUnit: 'm' });
    expect(end.x).toBeCloseTo(fwd.report.offset, 6);
    expect(end.y).toBeCloseTo(0, 6);
    expect(end.tvd).toBeCloseTo(fwd.report.verticalLen, 6);
    expect(endStation.inc).toBeCloseTo(0, 9);
  });

  test('impossible offset is a clear infeasibility', () => {
    const inv = solveNudgeInverse({ offset: 500, verticalLen: 100, buildRate: 1, dropRate: 1, mdUnit: 'm' });
    expect(inv.feasible).toBe(false);
  });
});

describe('toolfaceForTarget inverts attitudeAfterArc', () => {
  test('round-trips across attitudes', () => {
    for (const [i1, a1, beta, tau] of [
      [25, 80, 18, 42], [60, 300, 30, 250], [5, 10, 10, 120], [90, 180, 12, 90],
    ]) {
      const end = attitudeAfterArc(i1, a1, beta * Math.PI / 180, tau);
      const inv = toolfaceForTarget({ inc: i1, azi: a1 }, { inc: end.inc, azi: end.azi });
      expect(inv.doglegDeg).toBeCloseTo(beta, 7);
      const dTau = ((inv.toolfaceDeg - tau) % 360 + 540) % 360 - 180;
      expect(Math.abs(dTau)).toBeLessThan(1e-7);
    }
  });
});

// ---------------------------------------------------------------------------
// Totality: no solver throws, none runs unbounded, and none returns geometry
// a compiler would expand into a stack-blowing station list. These are the
// guards behind the Well Design Studio "Solve" crash (RangeError: maximum
// call stack size exceeded, raised downstream on a runaway station array).
// ---------------------------------------------------------------------------

describe('solvers are total: never throw, never emit runaway geometry', () => {
  const solverCalls = (v) => [
    ['slant', () => solveSlant({ target: { dN: v, dE: v, dTvd: v }, buildRate: v, mdUnit: 'ft' })],
    ['sProfile', () => solveSProfile({ kopLen: v, buildRate: v, dropRate: v, finalIncDeg: v, target: { dN: v, dE: v, dTvd: v }, mdUnit: 'ft' })],
    ['continuous', () => solveContinuousBuild({ tieOn: { inc: v, azi: v }, delta: { dN: v, dE: v, dTvd: v }, mdUnit: 'ft' })],
    ['horizontal', () => solveHorizontalLanding({ tieOn: { inc: v, azi: v }, landing: { dN: v, dE: v, dTvd: v, incDeg: 90, aziDeg: v }, rate1: v, rate2: v, mdUnit: 'ft' })],
    ['nudge', () => solveNudge({ nudgeIncDeg: v, nudgeAziDeg: v, holdLen: v, buildRate: v, dropRate: v, mdUnit: 'ft' })],
    ['nudgeInverse', () => solveNudgeInverse({ offset: v, verticalLen: v, buildRate: v, dropRate: v, mdUnit: 'ft' })],
  ];

  for (const v of [NaN, Infinity, -Infinity, undefined, null]) {
    for (const [name, call] of solverCalls(v)) {
      test(`${name} rejects ${String(v)} without throwing`, () => {
        let out;
        expect(() => { out = call(); }).not.toThrow();
        expect(out.feasible).toBe(false);
        expect(typeof out.error).toBe('string');
        expect(out.error.length).toBeGreaterThan(0);
      });
    }
  }

  test('missing target objects are refused, not dereferenced', () => {
    expect(solveSlant({ buildRate: 3, mdUnit: 'm' }).feasible).toBe(false);
    expect(solveSProfile({ buildRate: 3, dropRate: 2, mdUnit: 'm' }).feasible).toBe(false);
    expect(solveContinuousBuild({ tieOn: { inc: 0, azi: 0 }, mdUnit: 'm' }).feasible).toBe(false);
    expect(solveHorizontalLanding({ tieOn: { inc: 0, azi: 0 }, rate1: 3, rate2: 3, mdUnit: 'm' }).feasible).toBe(false);
  });

  test('every feasible solution compiles to a bounded station list', () => {
    // 20k randomised calls across both depth units; any feasible answer
    // must compile and stay far below the array size that overflows a
    // spread call (Math.max(...rows)) in the app's chart and KPI code.
    let seed = 20260828;
    const rnd = (a, b) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return a + (seed / 2147483648) * (b - a);
    };
    let checked = 0;
    for (let i = 0; i < 20000; i++) {
      const mdUnit = rnd(0, 1) < 0.5 ? 'ft' : 'm';
      const delta = { dN: rnd(-9000, 9000), dE: rnd(-9000, 9000), dTvd: rnd(-3000, 12000) };
      const calls = [
        () => solveSlant({ target: delta, buildRate: rnd(0.01, 20), mdUnit }),
        () => solveSProfile({ kopLen: rnd(0, 4000), buildRate: rnd(0.01, 20), dropRate: rnd(0.01, 20), finalIncDeg: rnd(0, 80), target: delta, mdUnit }),
        () => solveContinuousBuild({ tieOn: { inc: rnd(0, 95), azi: rnd(0, 360) }, delta, mdUnit }),
        () => solveHorizontalLanding({ tieOn: { inc: rnd(0, 95), azi: rnd(0, 360) }, landing: { ...delta, incDeg: 90, aziDeg: rnd(0, 360) }, rate1: rnd(0.01, 20), rate2: rnd(0.01, 20), mdUnit }),
        () => solveNudgeInverse({ offset: rnd(0, 3000), verticalLen: rnd(0, 6000), buildRate: rnd(0.01, 20), dropRate: rnd(0.01, 20), mdUnit }),
      ];
      const sol = calls[Math.floor(rnd(0, calls.length)) % calls.length]();
      expect(() => sol).not.toThrow();
      if (!sol.feasible) continue;
      checked += 1;
      const total = sol.segments.reduce((a, x) => a + x.length, 0);
      expect(Number.isFinite(total)).toBe(true);
      // subdivideMd 10 is what the Suite compiles with.
      expect(Math.ceil(total / 10)).toBeLessThan(50000);
    }
    expect(checked).toBeGreaterThan(1000);
  });

  test('the curve-hold-curve iteration cap is honoured and reported', () => {
    // A landing that cannot settle: the cap must return, not spin.
    const sol = solveHorizontalLanding({
      tieOn: { inc: 0, azi: 0 },
      landing: { dN: 3000, dE: 0, dTvd: 8300, incDeg: 90, aziDeg: 0 },
      rate1: 0.1, rate2: 0.1, mdUnit: 'ft', maxIter: 7,
    });
    expect(sol.feasible).toBe(false);
    expect(sol.iterations).toBe(7);
    expect(sol.error).toMatch(/did not settle in 7 passes/);
  });

  test('a converging landing reports how many passes it took', () => {
    const sol = solveHorizontalLanding({
      tieOn: { inc: 0, azi: 0 },
      landing: { dN: 2000, dE: 0, dTvd: 3000, incDeg: 90, aziDeg: 0 },
      rate1: 3, rate2: 3, mdUnit: 'm',
    });
    expect(sol.feasible).toBe(true);
    expect(sol.report.iterations).toBeGreaterThan(0);
    expect(sol.report.iterations).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// Two-target landing: heel ("Final Target") plus toe ("Align on Target").
// ---------------------------------------------------------------------------

describe('heel/toe alignment sets the landing azimuth', () => {
  test('bearingBetween is the compass bearing heel to toe', () => {
    expect(bearingBetween({ dE: 0, dN: 0 }, { dE: 0, dN: 100 })).toBeCloseTo(0, 9);
    expect(bearingBetween({ dE: 0, dN: 0 }, { dE: 100, dN: 0 })).toBeCloseTo(90, 9);
    expect(bearingBetween({ dE: 100, dN: 100 }, { dE: 0, dN: 0 })).toBeCloseTo(225, 9);
    // Vertically stacked targets have no bearing.
    expect(bearingBetween({ dE: 10, dN: 10 }, { dE: 10, dN: 10 })).toBe(null);
  });

  test('landingFromTargets returns bearing, reach and the implied inclination', () => {
    const a = landingFromTargets({ dE: 0, dN: 0, dTvd: 2000 }, { dE: 1000, dN: 0, dTvd: 2000 });
    expect(a.ok).toBe(true);
    expect(a.aziDeg).toBeCloseTo(90, 9);
    expect(a.horizontal).toBeCloseTo(1000, 9);
    expect(a.tvdRise).toBeCloseTo(0, 9);
    expect(a.incDeg).toBeCloseTo(90, 9);
    // A toe 100 deeper than the heel tilts the implied landing below 90.
    const b = landingFromTargets({ dE: 0, dN: 0, dTvd: 2000 }, { dE: 1000, dN: 0, dTvd: 2100 });
    expect(b.incDeg).toBeCloseTo(Math.atan2(1000, 100) * 180 / Math.PI, 9);
    expect(b.incDeg).toBeLessThan(90);
  });

  test('alignOn drives the landing azimuth and the compiled well lands on it', () => {
    const heel = { dN: 800, dE: 800, dTvd: 2500 };
    const toe = { dN: 800 + 900, dE: 800 + 900, dTvd: 2500 };
    const sol = solveHorizontalLanding({
      tieOn: { inc: 0, azi: 0 },
      landing: { ...heel, incDeg: 90, alignOn: toe },
      rate1: 3, rate2: 3, mdUnit: 'm',
    });
    expect(sol.feasible).toBe(true);
    expect(sol.report.landAziSource).toBe('alignOn');
    expect(sol.report.landAzi).toBeCloseTo(45, 6);
    expect(sol.report.alignment.horizontal).toBeCloseTo(Math.hypot(900, 900), 6);
    const { end, endStation } = compileTo(sol.segments, { inc: 0, azi: 0, mdUnit: 'm' });
    expect(end.x).toBeCloseTo(heel.dE, 2);
    expect(end.y).toBeCloseTo(heel.dN, 2);
    expect(end.tvd).toBeCloseTo(heel.dTvd, 2);
    expect(endStation.inc).toBeCloseTo(90, 3);
    const dAzi = ((endStation.azi - 45) % 360 + 540) % 360 - 180;
    expect(Math.abs(dAzi)).toBeLessThan(1e-3);
  });

  test('an explicit azimuth overrides the heel/toe bearing', () => {
    const heel = { dN: 800, dE: 800, dTvd: 2500 };
    const toe = { dN: 1700, dE: 1700, dTvd: 2500 };
    const sol = solveHorizontalLanding({
      tieOn: { inc: 0, azi: 0 },
      landing: { ...heel, incDeg: 90, aziDeg: 10, alignOn: toe },
      rate1: 3, rate2: 3, mdUnit: 'm',
    });
    expect(sol.feasible).toBe(true);
    expect(sol.report.landAziSource).toBe('override');
    expect(sol.report.landAzi).toBeCloseTo(10, 9);
    // The heel/toe bearing is still reported so the UI can flag the gap.
    expect(sol.report.alignment.aziDeg).toBeCloseTo(45, 6);
  });

  test('with neither azimuth nor toe the bearing falls back to the tie-on vector', () => {
    const sol = solveHorizontalLanding({
      tieOn: { inc: 0, azi: 0 },
      landing: { dN: 1000, dE: 1000, dTvd: 2500, incDeg: 90 },
      rate1: 3, rate2: 3, mdUnit: 'm',
    });
    expect(sol.feasible).toBe(true);
    expect(sol.report.landAziSource).toBe('tieOnToLanding');
    expect(sol.report.landAzi).toBeCloseTo(45, 6);
  });

  test('coincident heel and toe are refused with a readable message', () => {
    const heel = { dN: 800, dE: 800, dTvd: 2500 };
    const sol = solveHorizontalLanding({
      tieOn: { inc: 0, azi: 0 },
      landing: { ...heel, incDeg: 90, alignOn: { ...heel, dTvd: 2600 } },
      rate1: 3, rate2: 3, mdUnit: 'm',
    });
    expect(sol.feasible).toBe(false);
    expect(sol.error).toMatch(/same vertical line/);
  });
});

// ---------------------------------------------------------------------------
// Landing inclination: horizontals are not all flat. A lateral planned to
// nose up or down is an override; a lateral that must run straight from the
// heel to a toe at a different TVD takes the inclination that vector implies.
// ---------------------------------------------------------------------------

describe('landing inclination', () => {
  const heel = { dN: 1200, dE: 0, dTvd: 2500 };
  const solve = (landing) => solveHorizontalLanding({
    tieOn: { inc: 0, azi: 0 },
    landing: { ...heel, ...landing },
    rate1: 3, rate2: 3, mdUnit: 'm',
  });

  test('defaults to horizontal with no override and no toe', () => {
    const sol = solve({});
    expect(sol.feasible).toBe(true);
    expect(sol.report.landInc).toBeCloseTo(90, 9);
    expect(sol.report.landIncSource).toBe('default');
  });

  for (const inc of [88, 89, 91, 92]) {
    test(`lands at ${inc} deg when asked to nose ${inc < 90 ? 'up' : 'down'}`, () => {
      const sol = solve({ incDeg: inc });
      expect(sol.feasible).toBe(true);
      expect(sol.report.landInc).toBeCloseTo(inc, 9);
      expect(sol.report.landIncSource).toBe('override');
      // The compiled well actually arrives at that attitude.
      const { end, endStation } = compileTo(sol.segments, { inc: 0, azi: 0, mdUnit: 'm' });
      expect(endStation.inc).toBeCloseTo(inc, 3);
      expect(end.y).toBeCloseTo(heel.dN, 2);
      expect(end.tvd).toBeCloseTo(heel.dTvd, 2);
    });
  }

  test('a toe deeper than the heel noses the landing down', () => {
    // 900 m of lateral for 30 m of TVD: atan2(900, 30) = 88.09 deg.
    const sol = solve({ alignOn: { dN: 1200 + 900, dE: 0, dTvd: 2530 } });
    expect(sol.feasible).toBe(true);
    expect(sol.report.landIncSource).toBe('alignOn');
    expect(sol.report.landInc).toBeCloseTo(Math.atan2(900, 30) * 180 / Math.PI, 9);
    expect(sol.report.landInc).toBeGreaterThan(88);
    expect(sol.report.landInc).toBeLessThan(89);
    const { endStation } = compileTo(sol.segments, { inc: 0, azi: 0, mdUnit: 'm' });
    expect(endStation.inc).toBeCloseTo(sol.report.landInc, 3);
  });

  test('a toe shallower than the heel noses the landing up', () => {
    const sol = solve({ alignOn: { dN: 1200 + 900, dE: 0, dTvd: 2470 } });
    expect(sol.feasible).toBe(true);
    expect(sol.report.landInc).toBeCloseTo(Math.atan2(900, -30) * 180 / Math.PI, 9);
    expect(sol.report.landInc).toBeGreaterThan(90);
  });

  test('a toe at the heel TVD still lands horizontal', () => {
    const sol = solve({ alignOn: { dN: 1200 + 900, dE: 0, dTvd: 2500 } });
    expect(sol.feasible).toBe(true);
    expect(sol.report.landInc).toBeCloseTo(90, 9);
    expect(sol.report.landIncSource).toBe('alignOn');
  });

  test('an explicit inclination overrides the heel-to-toe angle', () => {
    const sol = solve({ incDeg: 91, alignOn: { dN: 1200 + 900, dE: 0, dTvd: 2530 } });
    expect(sol.feasible).toBe(true);
    expect(sol.report.landInc).toBeCloseTo(91, 9);
    expect(sol.report.landIncSource).toBe('override');
    // The heel-to-toe azimuth is still adopted, and still reported.
    expect(sol.report.landAziSource).toBe('alignOn');
    expect(sol.report.alignment.incDeg).toBeCloseTo(Math.atan2(900, 30) * 180 / Math.PI, 9);
  });

  test('inclination and azimuth can be overridden independently', () => {
    const sol = solve({ incDeg: 89, aziDeg: 33, alignOn: { dN: 2100, dE: 0, dTvd: 2530 } });
    expect(sol.feasible).toBe(true);
    expect(sol.report.landIncSource).toBe('override');
    expect(sol.report.landAziSource).toBe('override');
    expect(sol.report.landInc).toBeCloseTo(89, 9);
    expect(sol.report.landAzi).toBeCloseTo(33, 9);
  });

  test('an inclination outside 0 to 180 is refused', () => {
    expect(solve({ incDeg: -1 }).feasible).toBe(false);
    expect(solve({ incDeg: 181 }).error).toMatch(/between 0 and 180/);
  });

  test('a non-finite inclination falls back rather than poisoning the solve', () => {
    const sol = solve({ incDeg: NaN });
    expect(sol.feasible).toBe(true);
    expect(sol.report.landInc).toBeCloseTo(90, 9);
    expect(sol.report.landIncSource).toBe('default');
  });
});

// ---- target frame assertion (Well Design fix 2026-09-03) ----------------
describe('target frame assertion', () => {
  const { targetFrameError, MAX_TARGET_REACH_M } = require('../engines/drilling/profileDesign.js');
  const good = { dN: 300, dE: 300, dTvd: 2500 };

  test('a plain, reachable displacement passes; tagged displacements must match the solver unit and be local', () => {
    expect(targetFrameError(good, 'm')).toBeNull();
    expect(targetFrameError({ ...good, unit: 'm', frame: 'local' }, 'm')).toBeNull();
    expect(targetFrameError({ ...good, unit: 'ft' }, 'm')).toMatch(/in ft but the solver runs in m/);
    expect(targetFrameError({ ...good, frame: 'grid' }, 'm')).toMatch(/grid frame/);
  });

  test('absolute grid coordinates passed as offsets are refused as a frame mismatch, in both units', () => {
    const utm = { dN: 4_700_000, dE: 269_000, dTvd: 5000 };
    expect(targetFrameError(utm, 'm')).toMatch(/beyond any well/);
    const ftOffsets = { dN: 1000, dE: MAX_TARGET_REACH_M / 0.3048 + 10, dTvd: 0 };
    expect(targetFrameError(ftOffsets, 'ft')).toMatch(/beyond any well/);
    expect(targetFrameError({ dN: 0, dE: 0, dTvd: 40_000 }, 'm')).toBeNull(); // deep but real
  });

  test('every target solver fails loudly instead of returning degenerate geometry', () => {
    const utm = { dN: 4_700_000, dE: 269_000, dTvd: 5000 };
    expect(solveSlant({ target: utm, buildRate: 3, mdUnit: 'm' })).toMatchObject({ feasible: false, error: expect.stringMatching(/beyond any well/) });
    expect(solveSProfile({ kopLen: 300, buildRate: 3, dropRate: 2, target: utm, mdUnit: 'm' })).toMatchObject({ feasible: false, error: expect.stringMatching(/beyond any well/) });
    expect(solveContinuousBuild({ tieOn: { inc: 10, azi: 45 }, delta: utm, mdUnit: 'm' })).toMatchObject({ feasible: false, error: expect.stringMatching(/beyond any well/) });
    expect(solveHorizontalLanding({ tieOn: { inc: 0, azi: 0 }, landing: { ...utm }, rate1: 3, rate2: 3, mdUnit: 'm' })).toMatchObject({ feasible: false, error: expect.stringMatching(/beyond any well/) });
    expect(solveHorizontalLanding({ tieOn: { inc: 0, azi: 0 }, landing: { ...good, alignOn: { ...utm } }, rate1: 3, rate2: 3, mdUnit: 'm' })).toMatchObject({ feasible: false, error: expect.stringMatching(/Alignment target/) });
    // a feet target solved in metres is refused by unit before any geometry runs
    expect(solveSlant({ target: { ...good, unit: 'ft' }, buildRate: 3, mdUnit: 'm' })).toMatchObject({ feasible: false, error: expect.stringMatching(/solver runs in m/) });
  });
});
