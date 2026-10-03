/**
 * Fluid Systems Studio upgrade, Step 2: the uncertainty of the tuned C7+
 * parameters (tuneToLab(...).uncertainty).
 *
 * No published worked example of the uncertainty of regressed EOS
 * parameters could be read, so the gate is the defining identity of a
 * linearized least-squares covariance, held against the function the tune
 * actually minimized (tuneResiduals): stepping one knob by a fraction f of
 * its standard error, the others held, raises the sum of squares by
 *   f^2 s^2 C_jj (C^-1)_jj,   s^2 = SSR / (m - n).
 * A covariance that is too wide or too narrow by a factor fails it.
 */
import fs from 'fs';
import path from 'path';
import { tuneToLab, tuneResiduals, TUNING_KNOBS, studentT975 } from '../engines/fluid/labTune.js';
import { invertMatrix } from '../lib/welltest/lmFit.js';

const lit = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'fluid', 'literature-fixtures.json'), 'utf8'));
const go = lit.separatorTests.fluids[1]; // Good Oil Well No. 4
const fluid = { keys: [...go.keys, 'C7+'], plus: go.plus, z: go.z };
const targets = {
  psat: { tF: go.resTP[0], pPsia: go.resTP[1] },
  separatorTest: {
    stagesF: [...go.stagesF, [75, 14.65]], resTF: go.resTP[0], resPPsia: go.resTP[1],
    totalGor: go.expected.totalGor, stoApi: go.expected.stoApi, bo: go.expected.boMultistage,
  },
};
const ssrOf = (tgt, tuning) => tuneResiduals(fluid, tgt, tuning).reduce((s, v) => s + v * v, 0);

describe('uncertainty of the tuned parameters: four lab targets', () => {
  let fit;
  beforeAll(() => { fit = tuneToLab(fluid, targets); });

  it('reports the regression it came from', () => {
    const u = fit.uncertainty;
    expect(u.targets).toBe(4);
    expect(u.residuals).toBe(8); // four targets and four prior pulls
    expect(u.parameters).toBe(4);
    expect(u.dof).toBe(4);
    expect(u.tValue).toBe(2.776);
    expect(u.order).toEqual(['fTc', 'fPc', 'kC1', 'sPlus']);
    expect(TUNING_KNOBS).toEqual(u.order);
    expect(u.covariance).toHaveLength(4);
    expect(u.withheld).toBeNull();
  });

  it('the residual function it exposes is the one that was minimized', () => {
    expect(ssrOf(targets, fit.tuning)).toBeCloseTo(fit.ssr, 12);
    expect(ssrOf(targets, fit.start)).toBeCloseTo(fit.ssr0, 12);
  });

  it('each interval is the value plus and minus t times the standard error, and holds the value', () => {
    for (const k of TUNING_KNOBS) {
      const r = fit.uncertainty.knobs[k];
      expect(r.value).toBe(fit.tuning[k]);
      expect(r.atBound).toBe(false);
      expect(r.standardError).toBeGreaterThan(0);
      expect(r.ci95[0]).toBeCloseTo(r.value - 2.776 * r.standardError, 12);
      expect(r.ci95[1]).toBeCloseTo(r.value + 2.776 * r.standardError, 12);
    }
  });

  it('GATE: the standard errors agree with the curvature of the minimized function', () => {
    const u = fit.uncertainty;
    const s2 = fit.ssr / u.dof;
    const inv = invertMatrix(u.covariance);
    const base = ssrOf(targets, fit.tuning);
    const f = 0.25;
    TUNING_KNOBS.forEach((k, j) => {
      const se = u.knobs[k].standardError;
      const predicted = f * f * s2 * u.covariance[j][j] * inv[j][j];
      // mean of the two sides removes the odd (third order) term
      const up = ssrOf(targets, { ...fit.tuning, [k]: fit.tuning[k] + f * se }) - base;
      const down = ssrOf(targets, { ...fit.tuning, [k]: fit.tuning[k] - f * se }) - base;
      const actual = 0.5 * (up + down);
      expect(up).toBeGreaterThan(0);
      expect(down).toBeGreaterThan(0);
      expect(Math.abs(actual - predicted) / predicted).toBeLessThan(0.1);
    });
  });

  it('negative control: a covariance twice too wide, or half as wide, fails the same identity', () => {
    const u = fit.uncertainty;
    const s2 = fit.ssr / u.dof;
    const inv = invertMatrix(u.covariance);
    const base = ssrOf(targets, fit.tuning);
    const f = 0.25;
    for (const scale of [2, 0.5]) {
      TUNING_KNOBS.forEach((k, j) => {
        const se = u.knobs[k].standardError * Math.sqrt(scale); // what a scaled covariance would report
        const predicted = f * f * s2 * u.covariance[j][j] * inv[j][j]; // the identity does not move with the scale
        const up = ssrOf(targets, { ...fit.tuning, [k]: fit.tuning[k] + f * se }) - base;
        const down = ssrOf(targets, { ...fit.tuning, [k]: fit.tuning[k] - f * se }) - base;
        expect(Math.abs(0.5 * (up + down) - predicted) / predicted).toBeGreaterThan(0.3);
      });
    }
  });
});

describe('uncertainty of the tuned parameters: what the data cannot pin', () => {
  it('one measured value leaves one degree of freedom and intervals wider than with four', () => {
    const one = tuneToLab(fluid, { psat: targets.psat });
    const u = one.uncertainty;
    expect(u.targets).toBe(1);
    expect(u.dof).toBe(1);
    expect(u.tValue).toBe(12.706);
    for (const k of TUNING_KNOBS) {
      const r = u.knobs[k];
      if (r.ci95) expect(r.ci95[1] - r.ci95[0]).toBeCloseTo(2 * 12.706 * r.standardError, 12);
    }
  });

  it('a parameter that stopped at a regression bound has no interval', () => {
    // a saturation pressure at half the measured one drives three knobs to their bounds
    const far = tuneToLab(fluid, { psat: { tF: go.resTP[0], pPsia: go.resTP[1] * 0.5 } });
    expect(far.ok).toBe(true);
    expect(far.boundsHit.length).toBeGreaterThan(0);
    for (const k of far.boundsHit) {
      const r = far.uncertainty.knobs[k];
      expect(r.atBound).toBe(true);
      expect(r.standardError).toBeNull();
      expect(r.ci95).toBeNull();
      expect(r.value === r.bounds[0] || r.value === r.bounds[1]).toBe(true);
    }
  });

  it('nothing is reported when the tuned model cannot evaluate a target', () => {
    // no saturation point exists at 30 percent of the measured pressure
    const none = tuneToLab(fluid, { psat: { tF: go.resTP[0], pPsia: go.resTP[1] * 0.3 } });
    expect(none.ok).toBe(true);
    expect(none.report[0].tuned).toBeNull();
    expect(none.uncertainty.withheld).toMatch(/cannot evaluate psat/);
    expect(none.uncertainty.covariance).toBeNull();
    for (const k of TUNING_KNOBS) {
      expect(none.uncertainty.knobs[k].standardError).toBeNull();
      expect(none.uncertainty.knobs[k].ci95).toBeNull();
    }
  });

  it('Student t quantiles: tabulated values, and the normal value beyond the table', () => {
    expect(studentT975(1)).toBe(12.706);
    expect(studentT975(4)).toBe(2.776);
    expect(studentT975(10)).toBe(2.228);
    expect(studentT975(30)).toBe(2.042);
    expect(studentT975(200)).toBe(1.96);
  });
});
