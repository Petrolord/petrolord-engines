// Production P8 wellhead-limit engine gates: the erosional velocity,
// the Gilbert-family coefficient fit, and the hydrate screening,
// against closed forms, refusals, and the independent stdlib oracle
// (tools/validation/production/oracle_choke.py).
//
// The oracle works in SI and factors the least squares by Gram-Schmidt
// QR where this module forms the normal equations, so agreement is two
// routes meeting rather than code echoing itself.
//
// The choke physics itself is NOT gated here, because it is not here:
// the Gilbert family and the single-phase gas choke are the Suite's
// already-validated nodal layer, and rebuilding them would be the
// duplication this program has spent two phases removing.

import fs from 'fs';
import path from 'path';
import {
  EROSIONAL_C, erosionalC, erosionalVelocityFtS, pipeAreaFt2,
  mixtureVelocityFtS, erosionalCheck, erosionalRateBpd,
  fitGilbertCoefficients, HAMMERSCHMIDT, hydrateFormationTempF, hydrateScreening,
} from '../engines/production/chokePerformance';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'production', 'goldens', 'choke_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

describe('the erosional velocity limit', () => {
  test('C is an input, and the published values are offered and labelled', () => {
    // RP 14E is explicit that its own values are conservative and
    // allows higher where the fluid is clean and corrosion controlled,
    // so baking 100 into the equation would be wrong.
    expect(erosionalC('continuous').c).toBe(100);
    expect(erosionalC('intermittent').c).toBe(125);
    expect(erosionalC('cleanInhibited').c).toBeGreaterThan(125);
    expect(erosionalC('nonsense').c).toBe(100);
    expect(EROSIONAL_C).toHaveLength(3);
    EROSIONAL_C.forEach((x) => expect(x.label).toBeTruthy());
  });

  test('velocity goes as C over the square root of density, against the SI oracle', () => {
    G.erosional.forEach((row) => {
      const v = erosionalVelocityFtS({
        mixtureDensityLbFt3: row.rhoLbFt3, cFactor: row.cFactor,
      });
      expect(rel(v, row.erosionalFtS)).toBeLessThan(1e-9);
      expect(rel(erosionalRateBpd({
        idIn: 2.441, mixtureDensityLbFt3: row.rhoLbFt3, cFactor: row.cFactor,
      }), row.maxRateBpd_2441)).toBeLessThan(1e-6);
    });
    // a denser fluid erodes at a lower velocity, and doubling C doubles it
    const light = erosionalVelocityFtS({ mixtureDensityLbFt3: 5, cFactor: 100 });
    const heavy = erosionalVelocityFtS({ mixtureDensityLbFt3: 62.4, cFactor: 100 });
    expect(heavy).toBeLessThan(light);
    expect(rel(erosionalVelocityFtS({ mixtureDensityLbFt3: 45, cFactor: 200 }),
      2 * erosionalVelocityFtS({ mixtureDensityLbFt3: 45, cFactor: 100 }))).toBeLessThan(1e-12);
  });

  test('the actual velocity conversion matches the SI oracle', () => {
    expect(rel(pipeAreaFt2(2.441), G.pipeAreaFt2_2441)).toBeLessThan(1e-9);
    G.velocity.forEach((row) => {
      expect(rel(mixtureVelocityFtS({ inSituBpd: row.inSituBpd, idIn: row.idIn }),
        row.velocityFtS)).toBeLessThan(1e-6);
    });
    // velocity goes as one over area, so twice the diameter is a quarter the speed
    expect(rel(mixtureVelocityFtS({ inSituBpd: 5000, idIn: 4 }),
      mixtureVelocityFtS({ inSituBpd: 5000, idIn: 2 }) / 4)).toBeLessThan(1e-12);
  });

  test('the check reports the margin and whether the limit is passed', () => {
    const under = erosionalCheck({
      inSituBpd: 4000, idIn: 2.441, mixtureDensityLbFt3: 45, cFactor: 100,
    });
    expect(under.ok).toBe(true);
    expect(under.exceeded).toBe(false);
    expect(under.marginPct).toBeGreaterThan(0);
    const over = erosionalCheck({
      inSituBpd: 12000, idIn: 2.441, mixtureDensityLbFt3: 45, cFactor: 100,
    });
    expect(over.exceeded).toBe(true);
    expect(over.marginPct).toBeLessThan(0);
    // and the rate at exactly the limit sits on the boundary
    const limitBpd = erosionalRateBpd({ idIn: 2.441, mixtureDensityLbFt3: 45, cFactor: 100 });
    const at = erosionalCheck({
      inSituBpd: limitBpd, idIn: 2.441, mixtureDensityLbFt3: 45, cFactor: 100,
    });
    expect(rel(at.ratio, 1)).toBeLessThan(1e-9);
  });

  test('nonsense inputs are refused rather than given a velocity', () => {
    expect(erosionalCheck({ inSituBpd: 1000, idIn: 2.441, mixtureDensityLbFt3: 0 }).ok)
      .toBe(false);
    expect(erosionalVelocityFtS({ mixtureDensityLbFt3: -1, cFactor: 100 })).toBeNaN();
    expect(erosionalVelocityFtS({ mixtureDensityLbFt3: 45, cFactor: 0 })).toBeNaN();
  });
});

describe('fitting the Gilbert family to a well\'s own tests', () => {
  test('it recovers the coefficients it was generated from, exactly', () => {
    // The correlation is a power law in every variable, so taking logs
    // makes it linear and the fit is exact on noiseless data. If this
    // drifts, the log transform is wrong somewhere.
    const f = fitGilbertCoefficients({ points: G.fit.points });
    expect(f.ok).toBe(true);
    expect(rel(f.c, G.fit.truth.c)).toBeLessThan(1e-9);
    expect(rel(f.m, G.fit.truth.m)).toBeLessThan(1e-9);
    expect(rel(f.n, G.fit.truth.n)).toBeLessThan(1e-9);
    expect(f.rmsePct).toBeLessThan(1e-6);
    expect(f.r2).toBeCloseTo(1, 9);
  });

  test('on noisy data the normal equations and the oracle QR agree', () => {
    const f = fitGilbertCoefficients({ points: G.fitNoisy.points });
    expect(rel(f.c, G.fitNoisy.recovered.c)).toBeLessThan(1e-6);
    expect(rel(f.m, G.fitNoisy.recovered.m)).toBeLessThan(1e-6);
    expect(rel(f.n, G.fitNoisy.recovered.n)).toBeLessThan(1e-6);
    expect(f.rmsePct).toBeGreaterThan(0);
    expect(f.r2).toBeLessThan(1);
    expect(f.residuals).toHaveLength(G.fitNoisy.points.length);
  });

  test('holding the exponents fits the leading constant from a single test', () => {
    // The common field practice: keep a published set's shape and move
    // only the constant onto your own well.
    const one = [{ pwh: 700, q: 500, glr: 400, s64: 32 }];
    const f = fitGilbertCoefficients({
      points: one, mode: 'cOnly', fixed: { m: 0.546, n: 1.89 },
    });
    expect(f.ok).toBe(true);
    expect(f.m).toBe(0.546);
    expect(f.n).toBe(1.89);
    // it reproduces that test exactly
    expect(rel(f.residuals[0].predictedPwh, 700)).toBeLessThan(1e-9);
    expect(fitGilbertCoefficients({ points: one, mode: 'cOnly' }).ok).toBe(false);
  });

  test('too few tests to pin three coefficients is refused, with the way out', () => {
    const f = fitGilbertCoefficients({ points: G.fit.points.slice(0, 2) });
    expect(f.ok).toBe(false);
    expect(f.error).toMatch(/at least three/);
    expect(f.error).toMatch(/Hold the exponents/);
  });

  test('tests that do not span the variables are refused, not solved to nonsense', () => {
    // Same bean size and same gas-liquid ratio throughout: the system
    // is singular and no amount of arithmetic makes it otherwise.
    const flat = [
      { pwh: 500, q: 400, glr: 400, s64: 32 },
      { pwh: 620, q: 500, glr: 400, s64: 32 },
      { pwh: 750, q: 600, glr: 400, s64: 32 },
    ];
    const f = fitGilbertCoefficients({ points: flat });
    expect(f.ok).toBe(false);
    expect(f.error).toMatch(/vary in both/);
  });

  test('unusable rows are dropped and the rest still fit', () => {
    const withJunk = [
      ...G.fit.points,
      { pwh: 0, q: 500, glr: 400, s64: 32 },
      { pwh: 500, q: -1, glr: 400, s64: 32 },
      { pwh: 500, q: 500, glr: 400, s64: 0 },
    ];
    const f = fitGilbertCoefficients({ points: withJunk });
    expect(f.ok).toBe(true);
    expect(f.points).toHaveLength(G.fit.points.length);
    expect(rel(f.c, G.fit.truth.c)).toBeLessThan(1e-9);
  });

  test('tests whose variables move together are refused too', () => {
    // Bean size proportional to gas-liquid ratio: the two columns are
    // collinear in logs, so the fit is no more determined than if they
    // had not varied at all. Solving it anyway would produce
    // confident-looking coefficients that mean nothing.
    const proportional = [
      { pwh: 500, q: 400, glr: 300, s64: 20 },
      { pwh: 505, q: 400, glr: 600, s64: 40 },
      { pwh: 510, q: 400, glr: 900, s64: 60 },
    ];
    expect(fitGilbertCoefficients({ points: proportional }).ok).toBe(false);
  });

  test('a fit that lands outside the published family says so', () => {
    // Every published set has the bean exponent between 1.88 and 2.11
    // and the ratio exponent between 0.31 and 0.65. A fit far outside
    // that is usually thin data rather than an unusual well, and it
    // should be reported as such rather than quietly returned.
    const truth = { c: 10, m: 1.5, n: 3.5 };
    const odd = [
      [500, 300, 20], [800, 600, 32], [400, 300, 48],
      [900, 900, 40], [650, 450, 24], [700, 250, 56],
    ].map(([q, glr, s64]) => ({
      q, glr, s64, pwh: (truth.c * glr ** truth.m * q) / s64 ** truth.n,
    }));
    const f = fitGilbertCoefficients({ points: odd });
    expect(f.ok).toBe(true);
    expect(rel(f.n, truth.n)).toBeLessThan(1e-6);
    const codes = f.warnings.map((w) => w.code);
    expect(codes).toContain('exponentOutOfFamily');
    expect(codes).toContain('ratioExponentOutOfFamily');
  });

  test('a fit that misses the tests badly says that too', () => {
    const scattered = G.fit.points.map((p, i) => ({
      ...p, pwh: p.pwh * (i % 2 === 0 ? 1.6 : 0.55),
    }));
    const f = fitGilbertCoefficients({ points: scattered });
    expect(f.ok).toBe(true);
    expect(f.rmsePct).toBeGreaterThan(15);
    expect(f.warnings.map((w) => w.code)).toContain('poorFit');
  });
});

describe('the hydrate screening', () => {
  test('the Hammerschmidt form matches the oracle, and both constants are inputs', () => {
    G.hydrate.forEach((row) => {
      expect(rel(hydrateFormationTempF({ pPsia: row.pPsia }), row.formationF))
        .toBeLessThan(1e-9);
    });
    expect(HAMMERSCHMIDT.a).toBe(8.9);
    expect(HAMMERSCHMIDT.b).toBe(0.285);
    // both editable, so a user with a curve for their own gas can match it
    expect(hydrateFormationTempF({ pPsia: 800, a: 10, b: 0.285 }))
      .toBeGreaterThan(hydrateFormationTempF({ pPsia: 800 }));
    // hydrates form warmer at higher pressure, which is the whole hazard
    expect(hydrateFormationTempF({ pPsia: 3000 }))
      .toBeGreaterThan(hydrateFormationTempF({ pPsia: 300 }));
  });

  test('it is labelled a screening, and the verdict is a risk not a fact', () => {
    const cold = hydrateScreening({ pDownstreamPsia: 800, tDownstreamF: 45 });
    expect(cold.ok).toBe(true);
    expect(cold.screening).toBe(true);
    expect(cold.atRisk).toBe(true);
    expect(cold.marginF).toBeLessThan(0);
    const warm = hydrateScreening({ pDownstreamPsia: 800, tDownstreamF: 95 });
    expect(warm.atRisk).toBe(false);
    expect(warm.marginF).toBeGreaterThan(0);
    // an operator can demand a margin rather than just avoiding the line
    expect(hydrateScreening({ pDownstreamPsia: 800, tDownstreamF: 65, marginF: 10 }).atRisk)
      .toBe(true);
  });

  test('it refuses without both a pressure and a temperature', () => {
    expect(hydrateScreening({ pDownstreamPsia: 0, tDownstreamF: 60 }).ok).toBe(false);
    expect(hydrateScreening({ pDownstreamPsia: 800 }).ok).toBe(false);
  });
});

// poorFit fires on a strict inequality above 15 percent and then prints the
// RMS it fired on. At whole percent an RMS of 15.3 rendered as "15 percent"
// under a flag that never fires there, so a real warning read as a false
// alarm. One decimal narrows the collision by ten (the 0.05 above 15 still
// collides); it does not remove it, and the same rounding overstates on the
// way up. The fixture sits inside the band and clear of the residue.
describe('the fit-quality warning prints an error off its own threshold', () => {
  test('poorFit fires above 15 percent and prints above 15 percent', () => {
    // Six tests generated from a published Gilbert set and then wobbled by a
    // fixed plus and minus 19.659 percent in turn, which lands the RMS of
    // the refit at 15.3 percent.
    const wobble = 0.19659063515885072;
    const points = [
      { q: 500, glr: 400, s64: 16 }, { q: 800, glr: 600, s64: 24 },
      { q: 1200, glr: 900, s64: 32 }, { q: 1500, glr: 500, s64: 40 },
      { q: 900, glr: 1200, s64: 20 }, { q: 1100, glr: 700, s64: 28 },
    ].map((p, i) => ({
      ...p,
      pwh: ((10 * p.glr ** 0.546 * p.q) / p.s64 ** 1.89) * (1 + (i % 2 ? -wobble : wobble)),
    }));
    const f = fitGilbertCoefficients({ points });
    expect(f.ok).toBe(true);
    expect(f.rmsePct).toBeGreaterThan(15.05);
    expect(f.rmsePct).toBeLessThan(15.5);
    const w = f.warnings.find((x) => x.code === 'poorFit');
    expect(w).toBeDefined();
    expect(w.message).toMatch(/misses the tests by 15\.3 percent/);
    expect(w.message).not.toMatch(/\b15 percent\b/);
  });
});
