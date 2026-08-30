import {
  hornerTime,
  agarwalEquivalentTime,
  rateStepsFromHistory,
  detectFlowPeriods,
  equivalentProducingTime,
  superposeDeltaP,
} from '../engines/welltest/superposition.js';
import { getModel, toDimensionlessGroups, modelPwd, evaluateBuildup } from '../engines/welltest/models/modelCatalog.js';

const RESERVOIR = { phi: 0.2, mu: 1, ct: 1e-5, rw: 0.3, h: 30, B: 1.2, q: 300, pi: 5000 };

describe('buildup time transforms', () => {
  test('Horner time ratio', () => {
    expect(hornerTime(24, 8)).toBeCloseTo(4, 12);
    expect(hornerTime(24, 0)).toBeNaN();
  });

  test('Agarwal equivalent time', () => {
    expect(agarwalEquivalentTime(24, 8)).toBeCloseTo(6, 12);
    expect(agarwalEquivalentTime(24, 1e9)).toBeCloseTo(24, 3); // tends to tp
    expect(agarwalEquivalentTime(0, 8)).toBeNaN();
  });
});

describe('rate history handling', () => {
  test('normalizes, sorts and dedupes steps', () => {
    const steps = rateStepsFromHistory([
      { t: 10, q: 300 },
      { t: 0, q: 500 },
      { t: 10, q: 250 }, // later entry at same time wins
      { t: 15, q: 250 }, // repeated rate collapses
      { t: 20, q: 0 },
    ]);
    expect(steps).toEqual([
      { start: 0, q: 500 },
      { start: 10, q: 250 },
      { start: 20, q: 0 },
    ]);
  });

  test('detects flow, shut-in and injection periods', () => {
    const periods = detectFlowPeriods(
      [
        { t: 0, q: 500 },
        { t: 10, q: 0 },
        { t: 20, q: -200 },
      ],
      { endTime: 30 }
    );
    expect(periods).toHaveLength(3);
    expect(periods[0]).toMatchObject({ start: 0, end: 10, type: 'flow' });
    expect(periods[1]).toMatchObject({ start: 10, end: 20, type: 'shut-in' });
    expect(periods[2]).toMatchObject({ start: 20, end: 30, type: 'injection' });
  });

  test('equivalent producing time is cumulative production over final rate', () => {
    const steps = rateStepsFromHistory([
      { t: 0, q: 500 },
      { t: 10, q: 300 },
      { t: 20, q: 0 },
    ]);
    // (500*10 + 300*10) / 300 = 26.667 hr
    expect(equivalentProducingTime(steps, 20)).toBeCloseTo(8000 / 300, 6);
    expect(equivalentProducingTime([], 20)).toBeNaN();
  });
});

describe('superposition of the constant-rate solution', () => {
  const model = getModel('homogeneous');
  const params = { k: 50, skin: 2, C: 0.005 };
  const groups = toDimensionlessGroups({ ...RESERVOIR, k: params.k });
  const dimless = { skin: params.skin, cd: params.C * groups.cdPerBblPsi };
  const pwdOfHours = (tHours) => modelPwd(model, groups.tdPerHour * tHours, dimless);
  const dpPerPdPerUnitRate = groups.dpPerPd / RESERVOIR.q;

  test('a single step reduces to the constant-rate drawdown', () => {
    const dp = superposeDeltaP({
      pwdOfHours,
      steps: [{ start: 0, q: RESERVOIR.q }],
      t: 12,
      dpPerPdPerUnitRate,
    });
    expect(dp).toBeCloseTo(groups.dpPerPd * pwdOfHours(12), 9);
  });

  test('flow-then-shut-in superposition equals the buildup evaluator exactly', () => {
    const tp = 24;
    const dt = 3;
    const dpTotal = superposeDeltaP({
      pwdOfHours,
      steps: [
        { start: 0, q: RESERVOIR.q },
        { start: tp, q: 0 },
      ],
      t: tp + dt,
      dpPerPdPerUnitRate,
    });
    const pwsFromSuperposition = RESERVOIR.pi - dpTotal;
    const [point] = evaluateBuildup({ model, params, reservoir: RESERVOIR, tp, dts: [dt] });
    expect(pwsFromSuperposition).toBeCloseTo(point.pws, 8);
  });

  test('steps at or after the evaluation time contribute nothing', () => {
    const dp = superposeDeltaP({
      pwdOfHours,
      steps: [
        { start: 0, q: 300 },
        { start: 50, q: 600 },
      ],
      t: 12,
      dpPerPdPerUnitRate,
    });
    expect(dp).toBeCloseTo(groups.dpPerPd * pwdOfHours(12), 9);
  });
});
