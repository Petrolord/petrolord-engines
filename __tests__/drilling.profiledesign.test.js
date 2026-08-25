// Profile-design solvers vs forward-constructed oracle goldens and
// round-trip property tests: every solver's emitted segments are
// compiled with the segment compiler and must land on the target.

import fs from 'fs';
import path from 'path';
import {
  solveSlant, solveSProfile, solveContinuousBuild,
  solveHorizontalLanding, solveNudge, solveNudgeInverse, toolfaceForTarget,
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
