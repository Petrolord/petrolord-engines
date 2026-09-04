/**
 * Gates for the intervention diagnostics (Production P12).
 *
 * The slope estimator is checked against a Theil-Sen fit -- the median
 * of every pairwise slope -- which shares no machinery with least
 * squares: no means, no squares, no covariance. On an exact power law
 * both must return the exponent exactly.
 *
 * The skin uplift is checked against a full Darcy radial rate built in
 * SI, computed for each skin and divided. A much longer route through
 * real units that has to land on the same dimensionless number.
 *
 * The Chan classification is checked against histories whose
 * derivatives are ANALYTIC, which isolates the classifier from any
 * derivative implementation: if a classification is wrong here it is
 * the classification that is wrong.
 */
import fs from 'fs';
import path from 'path';
import {
  logLogSlope, chanDiagnosis, CHAN_DEFAULTS, CHAN_MECHANISMS, mechanism,
  pssDenominator, minimumSkin, skinPiMultiplier, skinFromPiRatio,
  screenTreatments, rankTreatments, TREATMENTS, VERDICT_ORDER,
} from '../engines/production/interventionDiagnostics';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'production', 'goldens', 'intervention_cases.json'),
  'utf8',
));

describe('the log-log slope', () => {
  test('is exact on a power law, and agrees with a Theil-Sen fit that shares no machinery', () => {
    const f = logLogSlope({ points: G.power_law.points });
    expect(f.ok).toBe(true);
    expect(f.slope).toBeCloseTo(G.power_law.trueSlope, 12);
    expect(f.slope).toBeCloseTo(G.power_law.theilSen.slope, 12);
    expect(f.intercept).toBeCloseTo(G.power_law.trueIntercept, 12);
    expect(f.r2).toBeCloseTo(1, 12);
  });

  test('reports the span it measured over, in log cycles', () => {
    const f = logLogSlope({ points: G.power_law.points });
    expect(f.spanDecades).toBeCloseTo(2, 9);
  });

  test('windows to a range', () => {
    const all = logLogSlope({ points: G.power_law.points });
    const late = logLogSlope({ points: G.power_law.points, fromX: 10 });
    expect(late.n).toBeLessThan(all.n);
    // Still the same power law, so still the same slope.
    expect(late.slope).toBeCloseTo(all.slope, 10);
  });

  test('refuses zero and negative values rather than dropping them silently into a log', () => {
    const r = logLogSlope({
      points: [{ x: 1, y: 1 }, { x: 2, y: 0 }, { x: 3, y: -4 }, { x: 4, y: 2 }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/at least three points/);
  });

  test('refuses a column of points at one time', () => {
    const r = logLogSlope({
      points: [{ x: 5, y: 1 }, { x: 5, y: 2 }, { x: 5, y: 3 }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/same time/);
  });

  test('r-squared falls on scatter, which is what lets the classifier refuse to read it', () => {
    const noisy = [1, 2, 4, 8, 16, 32, 64].map((x, i) => ({
      x, y: [3, 1, 9, 2, 14, 4, 20][i],
    }));
    expect(logLogSlope({ points: noisy }).r2).toBeLessThan(0.9);
  });
});

describe('the Chan reading', () => {
  const read = (name) => chanDiagnosis({ series: G.histories[name].series });

  test('channelling: the derivative climbs distinctly faster than proportionally', () => {
    const d = read('channelling');
    expect(d.mechanism.id).toBe('channelling');
    expect(d.mechanism.treatable).toBe(true);
    expect(d.derivativeSlope).toBeCloseTo(G.histories.channelling.lateDerivativeSlope, 6);
    expect(d.confidence).toBe('high');
  });

  test('coning: the derivative falls, and that sign is the firm end of the reading', () => {
    const d = read('coning');
    expect(d.mechanism.id).toBe('coning');
    expect(d.mechanism.treatable).toBe(false);
    expect(d.derivativeSlope).toBeLessThan(0);
    expect(d.notes.join(' ')).toMatch(/cone .* reached the perforations/);
  });

  test('displacement: a proportional climb is NOT channelling', () => {
    // The case that shaped the thresholds. For any power law the ratio
    // and its derivative have the SAME log-log slope, because
    // d(a t^m)/d(ln t) = m a t^m. So the two pictures cannot be told
    // apart by comparing their slopes to each other, and an earlier
    // version of this classifier -- which called anything with a rising
    // derivative channelling -- read ordinary displacement as a
    // treatable water path. Only the STEEPNESS separates them.
    const d = read('displacement');
    expect(d.derivativeSlope).toBeCloseTo(1, 6);
    expect(d.mechanism.id).toBe('displacement');
    expect(d.mechanism.treatable).toBe(false);
  });

  test('a flat ratio is NOT coning: nothing happening is its own finding', () => {
    const d = read('flat');
    expect(d.mechanism.id).not.toBe('coning');
    expect(d.notes.join(' ')).toMatch(/Nothing is changing/);
    expect(d.notes.join(' ')).toMatch(/a finding, not a failure/);
  });

  test('a reading near the channelling boundary says it is near the boundary', () => {
    const near = CHAN_DEFAULTS.channellingSlope - 0.1;
    const series = Array.from({ length: 30 }, (_, i) => {
      const t = 10 * (300 ** (i / 29));
      const wor = 0.02 * t ** near;
      return { t, ratio: wor, derivative: near * wor };
    });
    const d = chanDiagnosis({ series });
    expect(d.ambiguous).toBe(true);
    expect(d.confidence).toBe('low');
    expect(d.notes.join(' ')).toMatch(/weak part of the reading/);
  });

  test('scatter is refused rather than read', () => {
    const series = Array.from({ length: 30 }, (_, i) => {
      const t = 10 * (300 ** (i / 29));
      return { t, ratio: 2 + (i % 5), derivative: 1 + 4 * ((i * 7) % 11) / 11 };
    });
    const d = chanDiagnosis({ series });
    expect(d.mechanism.id).toBe('indeterminate');
    expect(d.notes.join(' ')).toMatch(/scatters too much|Reading a mechanism off this/);
  });

  test('too short a window is refused, because the separation happens over log time', () => {
    const series = Array.from({ length: 20 }, (_, i) => {
      const t = 100 + i; // barely a tenth of a decade
      const wor = 0.02 * t ** 1.6;
      return { t, ratio: wor, derivative: 1.6 * wor };
    });
    const d = chanDiagnosis({ series });
    expect(d.mechanism.id).toBe('indeterminate');
    expect(d.notes.join(' ')).toMatch(/log cycle/);
  });

  test('a handful of points is refused outright', () => {
    const d = chanDiagnosis({ series: [{ t: 1, ratio: 1, derivative: 1 }] });
    expect(d.ok).toBe(false);
    expect(d.error).toMatch(/needs a history/);
  });

  test('a well with almost no water has nothing to diagnose, and says so', () => {
    const series = Array.from({ length: 20 }, (_, i) => ({
      t: 10 * (100 ** (i / 19)), ratio: 0.02, derivative: 0,
    }));
    const d = chanDiagnosis({ series });
    expect(d.mechanism.id).toBe('displacement');
    expect(d.notes.join(' ')).toMatch(/no water problem here/);
  });

  test('every mechanism says whether it is treatable, because that is what decides the plan', () => {
    expect(CHAN_MECHANISMS).toHaveLength(4);
    expect(mechanism('channelling').treatable).toBe(true);
    ['coning', 'displacement', 'indeterminate'].forEach((id) => {
      expect(mechanism(id).treatable).toBe(false);
    });
    expect(mechanism('nonsense')).toBeNull();
  });
});

describe('skin and what removing it is worth', () => {
  const geom = { reFt: 2000, rwFt: 0.35 };

  test('matches the SI Darcy oracle on every case', () => {
    G.skin.forEach((c) => {
      const r = skinPiMultiplier({
        reFt: c.reFt, rwFt: c.rwFt, skinBefore: c.skinBefore, skinAfter: c.skinAfter,
      });
      expect(r.ok).toBe(true);
      expect(r.multiplier).toBeCloseTo(c.multiplier, 10);
    });
  });

  test('is exactly one when the skin does not change', () => {
    expect(skinPiMultiplier({ ...geom, skinBefore: 5, skinAfter: 5 }).multiplier).toBe(1);
    expect(skinPiMultiplier({ ...geom, skinBefore: -3, skinAfter: -3 }).multiplier).toBe(1);
  });

  test('is worth far less on a well that was never damaged', () => {
    // The point that makes or breaks a stimulation screening. Taking a
    // skin of 1 to 0 buys about an eighth; taking 12 to 0 nearly
    // triples the well. Both are "removing all the damage".
    const mild = skinPiMultiplier({ ...geom, skinBefore: 1, skinAfter: 0 });
    const bad = skinPiMultiplier({ ...geom, skinBefore: 12, skinAfter: 0 });
    expect(mild.multiplier).toBeLessThan(1.15);
    expect(bad.multiplier).toBeGreaterThan(2.5);
  });

  test('flow efficiency is the undamaged denominator over this one', () => {
    const r = skinPiMultiplier({ ...geom, skinBefore: 8, skinAfter: 0 });
    const clean = pssDenominator({ ...geom, skin: 0 });
    expect(r.flowEfficiencyBefore).toBeCloseTo(clean / pssDenominator({ ...geom, skin: 8 }), 12);
    expect(r.flowEfficiencyAfter).toBeCloseTo(1, 12);
  });

  test('the geometry has a floor, and going below it is REFUSED', () => {
    // At S = -(ln(re/rw) - 3/4) the denominator is zero and the
    // productivity index is infinite. That is the equation running out,
    // not an aggressive design, and a screening tool that quietly
    // returned a huge uplift there would be worse than useless.
    const floor = minimumSkin(geom);
    expect(floor).toBeCloseTo(G.minimumSkin.value, 10);
    expect(pssDenominator({ ...geom, skin: floor })).toBeCloseTo(0, 10);
    const r = skinPiMultiplier({ ...geom, skinBefore: 2, skinAfter: floor - 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/infinite/);
    expect(r.error).toMatch(/-3 to -5 on acid/);
    // And a starting skin below the floor is refused too.
    expect(skinPiMultiplier({ ...geom, skinBefore: floor - 1, skinAfter: 0 }).ok).toBe(false);
  });

  test('refuses a geometry that is not one', () => {
    expect(skinPiMultiplier({ reFt: 10, rwFt: 40, skinBefore: 1, skinAfter: 0 }).ok).toBe(false);
    expect(minimumSkin({ reFt: 10, rwFt: 40 })).toBeNaN();
  });

  test('the inverse recovers the skin a productivity ratio implies', () => {
    const s = 6.5;
    const r = skinPiMultiplier({ ...geom, skinBefore: s, skinAfter: 0 });
    // A well making 1/multiplier of what a clean one would.
    expect(skinFromPiRatio({ ...geom, ratio: 1 / r.multiplier })).toBeCloseTo(s, 9);
  });
});

describe('the screening, with the diagnosis in charge', () => {
  const channelling = chanDiagnosis({ series: G.histories.channelling.series });
  const coning = chanDiagnosis({ series: G.histories.coning.series });
  const find = (rows, id) => rows.find((r) => r.id === id);

  test('a water shutoff on a CHANNELLING well is a candidate', () => {
    const rows = screenTreatments({
      well: { skin: 1, wctPct: 62, flowing: true }, diagnosis: channelling,
    });
    const w = find(rows, 'waterShutoff');
    expect(w.verdict).toBe('candidate');
    expect(w.blocked).toBe(false);
    expect(w.reasons.join(' ')).toMatch(/path of its own/);
  });

  test('a water shutoff on a CONING well is BLOCKED, with the reason', () => {
    // The single most valuable thing this module does. A squeeze on a
    // coning well is money down a hole: the cone re-forms above the
    // plugged perforations.
    const rows = screenTreatments({
      well: { skin: 1, wctPct: 62, flowing: true }, diagnosis: coning,
    });
    const w = find(rows, 'waterShutoff');
    expect(w.verdict).toBe('blocked');
    expect(w.blocked).toBe(true);
    expect(w.blockReason).toMatch(/nothing to squeeze/);
    expect(w.blockReason).toMatch(/re-forms above/);
    expect(w.reasons.join(' ')).toMatch(/less drawdown/);
  });

  test('and reducing drawdown, which is useless elsewhere, becomes the candidate', () => {
    const onConing = screenTreatments({
      well: { skin: 1, wctPct: 62, flowing: true }, diagnosis: coning,
    });
    const onChannelling = screenTreatments({
      well: { skin: 1, wctPct: 62, flowing: true }, diagnosis: channelling,
    });
    expect(find(onConing, 'rateReduction').verdict).toBe('candidate');
    expect(find(onChannelling, 'rateReduction').verdict).toBe('no');
    expect(find(onChannelling, 'rateReduction').reasons.join(' '))
      .toMatch(/gives away rate without touching the water path/);
  });

  test('with NO diagnosis a shutoff is blocked rather than recommended on the water cut alone', () => {
    const rows = screenTreatments({
      well: { skin: 1, wctPct: 75, flowing: true }, diagnosis: null,
    });
    const w = find(rows, 'waterShutoff');
    expect(w.verdict).toBe('blocked');
    expect(w.blockReason).toMatch(/has not been established/);
    expect(w.blockReason).toMatch(/money down a hole/);
  });

  test('a dry well has no water problem to block or recommend', () => {
    const rows = screenTreatments({
      well: { skin: 1, wctPct: 8, flowing: true }, diagnosis: channelling,
    });
    expect(find(rows, 'waterShutoff').verdict).toBe('no');
  });

  test('stimulation is graded by how much damage there actually is', () => {
    const heavy = screenTreatments({ well: { skin: 9, wctPct: 10, flowing: true } });
    const mild = screenTreatments({ well: { skin: 1, wctPct: 10, flowing: true } });
    const stimulated = screenTreatments({ well: { skin: -2, wctPct: 10, flowing: true } });
    expect(find(heavy, 'matrixAcid').verdict).toBe('candidate');
    expect(find(mild, 'matrixAcid').verdict).toBe('marginal');
    expect(find(stimulated, 'matrixAcid').verdict).toBe('no');
    expect(find(stimulated, 'matrixAcid').reasons.join(' ')).toMatch(/already stimulated/);
  });

  test('no skin entered is "unknown", never "no"', () => {
    const rows = screenTreatments({ well: { wctPct: 10, flowing: true } });
    expect(find(rows, 'matrixAcid').verdict).toBe('unknown');
    expect(find(rows, 'matrixAcid').reasons.join(' ')).toMatch(/pressure transient test/);
  });

  test('a gas-oil ratio that is just solution gas is not a gas problem', () => {
    const solution = screenTreatments({
      well: { skin: 1, wctPct: 10, gorScfStb: 900, expectedGorScfStb: 700, flowing: true },
    });
    const breakthrough = screenTreatments({
      well: { skin: 1, wctPct: 10, gorScfStb: 4200, expectedGorScfStb: 700, flowing: true },
    });
    expect(find(solution, 'gasShutoff').verdict).toBe('no');
    expect(find(breakthrough, 'gasShutoff').verdict).toBe('consider');
    expect(find(breakthrough, 'gasShutoff').reasons.join(' '))
      .toMatch(/only the channelling case is worth squeezing/);
  });

  test('a well that is not flowing needs lift before anything else', () => {
    const rows = screenTreatments({ well: { skin: 1, wctPct: 20, flowing: false } });
    const l = find(rows, 'artificialLift');
    expect(l.verdict).toBe('candidate');
    expect(l.reasons.join(' ')).toMatch(/Artificial Lift Advisor/);
  });

  test('every treatment carries its reasons in full, never a bare score', () => {
    const rows = screenTreatments({
      well: { skin: 4, wctPct: 55, gorScfStb: 800, expectedGorScfStb: 700, flowing: true },
      diagnosis: channelling,
    });
    expect(rows).toHaveLength(TREATMENTS.length);
    rows.forEach((r) => {
      expect(r.reasons.length).toBeGreaterThan(0);
      r.reasons.forEach((x) => expect(typeof x).toBe('string'));
      expect(VERDICT_ORDER).toContain(r.verdict);
    });
  });

  test('the ranking puts what to do first, first', () => {
    const rows = rankTreatments(screenTreatments({
      well: { skin: 9, wctPct: 62, flowing: true }, diagnosis: channelling,
    }));
    expect(rows[0].verdict).toBe('candidate');
    const verdicts = rows.map((r) => VERDICT_ORDER.indexOf(r.verdict));
    verdicts.slice(1).forEach((v, i) => expect(v).toBeGreaterThanOrEqual(verdicts[i]));
  });
});

// The scatter note fires on a strict inequality below `minR2` and then
// prints the r-squared it fired on. At whole percent a fit explaining 84.57
// percent rendered as "85 percent" against a minR2 of 0.85, that is as the
// very threshold it fell short of. One decimal narrows the collision by ten
// rather than closing it, and the fixture sits inside the band and clear of
// the residual 0.05.
describe('the scatter note prints an r-squared off its own threshold', () => {
  const percentIn = (message) => Number(/([\d.]+) percent/.exec(message)[1]);
  // An irrational stride, so the wobble on the derivative never repeats and
  // the scatter is deterministic without being periodic.
  const STRIDE = 2.399963229728653;
  const series = Array.from({ length: 30 }, (_, i) => {
    const t = 10 * 300 ** (i / 29);
    const wor = 0.02 * t ** 0.8;
    return { t, ratio: wor, derivative: 0.8 * wor * (1 + 0.4 * Math.sin(i * STRIDE)) };
  });

  test('it fires below minR2 and prints below minR2', () => {
    // Read the fit off a reading that is NOT refused. Item 66 nulls
    // `derivativeR2` on the refusal branches, so the measurement has to
    // come from a threshold the fit clears; the fit itself does not
    // depend on `minR2`, so it is the same number either way.
    const measured = chanDiagnosis({ series, settings: { minR2: 0 } }).derivativeR2;
    // the whole percent a reader would set the threshold at, just above
    const minR2 = Math.round(measured * 100) / 100;
    expect(measured).toBeLessThan(minR2);
    expect((minR2 - measured) * 100).toBeLessThan(0.5);      // old print collided
    expect((minR2 - measured) * 100).toBeGreaterThan(0.05);  // clear of the residue

    const d = chanDiagnosis({ series, settings: { minR2 } });
    const note = d.notes.find((n) => n.includes('scatters too much'));
    expect(note).toBeDefined();
    expect(percentIn(note)).toBeLessThan(minR2 * 100);
    expect(note).not.toMatch(new RegExp(`\\b${minR2 * 100} percent\\b`));
  });
});

// ---------------------------------------------------------------------------
// Item 66. A refused reading must not hand back the slope it refused.
//
// The span gate and the scatter gate both decline to name a mechanism, and
// both used to return `derivativeSlope` anyway. A caller sweeping readings
// and quoting the range of the slopes then publishes a number no reading
// stands behind, and because the refused readings are the steep ones it is
// the TOP of the range that moves.
// ---------------------------------------------------------------------------
describe('a refused reading returns no slope, and always returns its span', () => {
  // A steep power law read over a tenth of a decade: the fit succeeds and
  // the slope is 1.6, and the span gate refuses it anyway.
  const shortWindow = Array.from({ length: 20 }, (_, i) => {
    const t = 100 + i;
    const wor = 0.02 * t ** 1.6;
    return { t, ratio: wor, derivative: 1.6 * wor };
  });

  // Scatter: the fit is made, and the fit quality gate refuses to read it.
  const STRIDE = 2.399963229728653;
  const scattered = Array.from({ length: 30 }, (_, i) => {
    const t = 10 * 300 ** (i / 29);
    const wor = 0.02 * t ** 0.8;
    return { t, ratio: wor, derivative: 0.8 * wor * (1 + 0.9 * Math.sin(i * STRIDE)) };
  });

  test('the span gate refuses without publishing the slope it measured', () => {
    const d = chanDiagnosis({ series: shortWindow });
    expect(d.mechanism.id).toBe('indeterminate');
    expect(d.derivativeSlope).toBeNull();
    expect(d.derivativeR2).toBeNull();
    // and the span it fired on IS reported, because that is what the
    // caller has to act on.
    expect(typeof d.spanDecades).toBe('number');
    expect(d.spanDecades).toBeLessThan(CHAN_DEFAULTS.minSpanDecades);
  });

  test('the fit-quality gate refuses without publishing the slope it measured', () => {
    const d = chanDiagnosis({ series: scattered });
    expect(d.mechanism.id).toBe('indeterminate');
    expect(d.notes.join(' ')).toMatch(/scatters too much/);
    expect(d.derivativeSlope).toBeNull();
    expect(d.derivativeR2).toBeNull();
    expect(typeof d.spanDecades).toBe('number');
  });

  test('every branch reports spanDecades, including the ones that make no fit', () => {
    const tooFew = chanDiagnosis({ series: [{ t: 1, ratio: 1, derivative: 1 }] });
    expect(tooFew.ok).toBe(false);
    expect(tooFew.code).toBe('insufficientHistory');
    expect(tooFew).toHaveProperty('spanDecades', null);
    expect(tooFew).toHaveProperty('derivativeSlope', null);
    expect(tooFew).toHaveProperty('derivativeR2', null);

    const dry = chanDiagnosis({
      series: Array.from({ length: 20 }, (_, i) => ({
        t: 10 * (100 ** (i / 19)), ratio: 0.02, derivative: 0,
      })),
    });
    expect(dry).toHaveProperty('spanDecades', null);
    expect(dry).toHaveProperty('derivativeSlope', null);

    const flat = chanDiagnosis({ series: G.histories.flat.series });
    expect(flat).toHaveProperty('spanDecades', null);

    const read = chanDiagnosis({ series: G.histories.channelling.series });
    expect(typeof read.spanDecades).toBe('number');
    expect(read.derivativeSlope).toBeCloseTo(G.histories.channelling.lateDerivativeSlope, 6);
  });

  test('the top of a swept slope range comes from a reading, not from a refusal', () => {
    // This is the defect in the shape a course hit it: sweep several
    // histories, take the range of the slopes, and the steepest number in
    // the sweep came from the one reading that had been refused.
    const sweep = [
      chanDiagnosis({ series: G.histories.channelling.series }),
      chanDiagnosis({ series: G.histories.coning.series }),
      chanDiagnosis({ series: G.histories.displacement.series }),
      chanDiagnosis({ series: shortWindow }),
      chanDiagnosis({ series: scattered }),
    ];
    const refused = sweep.filter((d) => d.mechanism.id === 'indeterminate');
    expect(refused.length).toBeGreaterThan(0);
    refused.forEach((d) => expect(d.derivativeSlope).toBeNull());

    const quotable = sweep.map((d) => d.derivativeSlope).filter((v) => v !== null);
    // The refused reading's 1.6 is the steepest thing in the sweep. It must
    // not be the number that sets the headline.
    expect(Math.max(...quotable)).toBeCloseTo(G.histories.channelling.lateDerivativeSlope, 6);
    expect(quotable).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Item 67. The zero-variance guard fired by accident.
//
// `syy` is a sum of squared floating-point deviations, so over a genuinely
// constant y it lands on EXACT zero only by luck. Whether the rounding
// cancels depends on the sample count and the value together, which is why
// the guard fired on the small tidy cases and stopped firing on the real
// ones.
// ---------------------------------------------------------------------------
describe('the zero-variance guard asks about scale, not about exact zero', () => {
  const constantAt = (value, n) => Array.from({ length: n }, (_, i) => ({
    x: 10 * 300 ** (i / (n - 1)), y: value,
  }));

  test('four points identical at 5 return the intended r-squared of 1', () => {
    // The case the old guard got right, and the reason the defect hid.
    expect(logLogSlope({ points: constantAt(5, 4) }).r2).toBe(1);
  });

  test('twenty points identical at 5 return 1 too, where the old guard returned 1e-31', () => {
    const r = logLogSlope({ points: constantAt(5, 20) });
    expect(r.ok).toBe(true);
    expect(r.r2).toBe(1);
    expect(r.r2).toBeGreaterThan(1e-6);
  });

  test('a constant derivative is read as displacement, not refused as noise', () => {
    // A ratio rising logarithmically has a CONSTANT derivative, which is a
    // real history and not a scatter. The old guard scored its fit at
    // 1.5e-31 and the classifier threw it out as noise.
    const series = Array.from({ length: 20 }, (_, i) => {
      const t = 10 * 300 ** (i / 19);
      return { t, ratio: 0.5 + 5 * Math.log(t / 10), derivative: 5 };
    });
    const d = chanDiagnosis({ series });
    expect(d.derivativeR2).toBe(1);
    expect(d.mechanism.id).toBe('displacement');
    expect(d.notes.join(' ')).not.toMatch(/scatters too much/);
  });

  test('genuine scatter is still refused: the guard did not become a rubber stamp', () => {
    const noisy = [1, 2, 4, 8, 16, 32, 64].map((x, i) => ({
      x, y: [3, 1, 9, 2, 14, 4, 20][i],
    }));
    expect(logLogSlope({ points: noisy }).r2).toBeLessThan(0.9);
  });
});

// ---------------------------------------------------------------------------
// Item 68. The refusal compared a number against itself.
// ---------------------------------------------------------------------------
describe('the skin-floor refusal names both quantities and separates them', () => {
  const geom = { reFt: 2000, rwFt: 0.35 };

  test('a starting skin below the floor prints both numbers, and they differ', () => {
    // floor is -7.900724584040761. At one decimal a requested -7.95 and
    // the floor both printed "-7.9", so the sentence read "a skin of -7.9
    // is below the -7.9 this geometry allows".
    const r = skinPiMultiplier({ ...geom, skinBefore: -7.95, skinAfter: 0 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('skinBeforeBelowFloor');
    expect(r.error).toMatch(/skin before treatment is -7\.950/);
    expect(r.error).toMatch(/most negative skin this geometry allows is -7\.901/);
    expect(r.error).not.toMatch(/is below the -7\.9 this geometry allows/);
    expect(r.error).not.toMatch(/-7\.9 /);
  });

  test('a target skin below the floor does the same, and keeps the advice', () => {
    const r = skinPiMultiplier({ ...geom, skinBefore: 2, skinAfter: -7.95 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('skinAfterBelowFloor');
    expect(r.error).toMatch(/Taking the skin to -7\.950/);
    expect(r.error).toMatch(/most negative skin this geometry allows, which is -7\.901/);
    expect(r.error).toMatch(/-3 to -5 on acid/);
    expect(r.error).not.toMatch(/would put it below the -7\.9 this/);
  });

  test('the printed floor is the number minimumSkin returns, to three decimals', () => {
    const floor = minimumSkin(geom);
    const r = skinPiMultiplier({ ...geom, skinBefore: floor - 0.05, skinAfter: 0 });
    expect(r.error).toContain(floor.toFixed(3));
  });

  test('a geometry that is not one is refused with a code', () => {
    const r = skinPiMultiplier({ reFt: 10, rwFt: 40, skinBefore: 1, skinAfter: 0 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('invalidGeometry');
  });
});

// ---------------------------------------------------------------------------
// Item 69. Displacement was called flat.
//
// "Water cut is 75 percent and the derivative is flat" was printed on a
// reading whose derivative slope was 1.25 at a fit quality of 0.995. It
// contradicted `chanDiagnosis` in the same file, and it is one of the two
// sentences a planner pastes into a recommendation.
// ---------------------------------------------------------------------------
describe('every water reason quotes the number it describes', () => {
  const find = (rows, id) => rows.find((r) => r.id === id);
  const water = (diagnosis, wctPct = 75) => find(screenTreatments({
    well: { skin: 1, wctPct, flowing: true }, diagnosis,
  }), 'waterShutoff').reasons.join(' ');

  test('a displacement reading is NOT called flat', () => {
    const d = chanDiagnosis({ series: G.histories.displacement.series });
    expect(d.mechanism.id).toBe('displacement');
    expect(d.derivativeSlope).toBeCloseTo(1, 6);
    const said = water(d);
    expect(said).toMatch(/climbing at about a proportional rate/);
    expect(said).not.toMatch(/the derivative is flat/);
    expect(said).not.toMatch(/\bflat\b/);
  });

  test('and it quotes the slope that made it a displacement reading', () => {
    const d = chanDiagnosis({ series: G.histories.displacement.series });
    const said = water(d);
    expect(said).toContain(`at a slope of ${d.derivativeSlope.toFixed(2)}`);
    expect(said).toMatch(/at a slope of 1\.00/);
  });

  test('the coning sentence quotes its falling slope', () => {
    const d = chanDiagnosis({ series: G.histories.coning.series });
    const said = water(d);
    expect(said).toMatch(/the derivative is falling, at a slope of -0\.54/);
    expect(said).toContain(`at a slope of ${d.derivativeSlope.toFixed(2)}`);
  });

  test('the channelling sentence quotes its climbing slope', () => {
    const d = chanDiagnosis({ series: G.histories.channelling.series });
    const said = water(d, 62);
    expect(said).toMatch(/at a slope of 1\.60/);
    expect(said).toMatch(/path of its own/);
  });

  test('a reading with no readable slope says the shape and quotes no number', () => {
    // The derivative has turned negative, so it cannot be read on a
    // log-log plot: item 66 nulls the slope, and the sentence must not
    // print "at a slope of NaN" or invent one.
    const series = Array.from({ length: 20 }, (_, i) => {
      const t = 10 * 300 ** (i / 19);
      return { t, ratio: 3 - 0.2 * Math.log(t / 10), derivative: -0.2 };
    });
    const d = chanDiagnosis({ series });
    expect(d.mechanism.id).toBe('coning');
    expect(d.derivativeSlope).toBeNull();
    const said = water(d, 62);
    expect(said).toMatch(/the derivative is falling, which is the coning signature/);
    expect(said).not.toMatch(/at a slope of/);
    expect(said).not.toMatch(/NaN|null|undefined/);
  });
});
