/**
 * FS6 gates — compositional separator train.
 *
 * GATE (oracle): per-stage vapor/liquid split, phase compositions, gas
 * gravities, stock-tank oil density/API, GOR partition and multistage/
 * single-stage Bo must match the independent Python oracle counterpart
 * (plain-SS flashes, bisection RR) in goldens.json `separator`.
 * Identity gates: exact truths — per-component material balance across
 * all surface draws, GOR partition telescoping, explicit-stock-tank
 * equivalence, sc molar volume, and the documented degradations (no
 * stock-tank liquid; two-phase reservoir state withholds Bo).
 */

import { mixtureFromKeys } from '../engines/fluid/pr78.js';
import { mixtureWithPlusFraction } from '../engines/fluid/characterization.js';
import { degFtoR, PSC, TSC } from '../engines/fluid/units.js';
import {
  separatorTrain, materialBalanceError, normalizeStages,
  SCF_PER_LBMOL, MW_AIR, STOCK_TANK_STAGE,
} from '../engines/fluid/separator.js';
import goldens from '../test-data/fluid/goldens.json';

const relErr = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);

const buildMix = (job) => (job.plus
  ? mixtureWithPlusFraction(job.keys, job.plus)
  : mixtureFromKeys(job.keys));
const toStages = (stagesF) => stagesF.map(([tF, pPsia]) => ({ tR: degFtoR(tF), pPsia }));
const runJob = (job) => separatorTrain(
  buildMix(job), job.x, toStages(job.stagesF),
  job.resTP ? { resTR: degFtoR(job.resTP[0]), resPPsia: job.resTP[1] } : {},
);

describe('FS6 GATE: separator train vs oracle counterpart', () => {
  describe.each(goldens.separator)('$fluid / $train', (job) => {
    const res = runJob(job);

    test('stage count, phases and per-stage split', () => {
      expect(res.stages.length).toBe(job.stages.length);
      job.stages.forEach((g, i) => {
        const e = res.stages[i];
        expect(e.phases).toBe(g.phases);
        expect(Math.abs(e.vaporMoles - g.vaporMoles)).toBeLessThan(5e-7);
        expect(Math.abs(e.liquidMoles - g.liquidMoles)).toBeLessThan(5e-7);
        if (g.gasGravity != null) expect(relErr(e.gasGravity, g.gasGravity)).toBeLessThan(1e-7);
        if (g.phases === 2) {
          g.x.forEach((v, k) => expect(Math.abs(e.x[k] - v)).toBeLessThan(5e-7));
          g.y.forEach((v, k) => expect(Math.abs(e.y[k] - v)).toBeLessThan(5e-7));
        }
      });
    });

    test('stock-tank oil and GOR partition', () => {
      if (!job.stockTank) {
        expect(res.stockTank).toBeNull();
        expect(res.warnings.join(' ')).toMatch(/No stock-tank liquid/);
        return;
      }
      expect(relErr(res.stockTank.density, job.stockTank.density)).toBeLessThan(1e-7);
      expect(Math.abs(res.stockTank.api - job.stockTank.api)).toBeLessThan(1e-4);
      expect(relErr(res.totals.separatorGor, job.totals.separatorGor)).toBeLessThan(1e-6);
      expect(relErr(res.totals.stockTankGor, job.totals.stockTankGor)).toBeLessThan(1e-6);
      expect(relErr(res.totals.totalGor, job.totals.totalGor)).toBeLessThan(1e-6);
      expect(relErr(res.totals.surfaceGasGravity, job.totals.surfaceGasGravity)).toBeLessThan(1e-7);
    });

    test('Bo block', () => {
      if (!job.bo) {
        expect(res.bo).toBeNull();
        return;
      }
      expect(res.bo.reservoirPhases).toBe(job.bo.reservoirPhases);
      if (job.bo.multistage != null) {
        expect(relErr(res.bo.multistage, job.bo.multistage)).toBeLessThan(1e-7);
        expect(relErr(res.bo.singleStage, job.bo.singleStage)).toBeLessThan(1e-7);
        expect(relErr(res.bo.singleStageGor, job.bo.singleStageGor)).toBeLessThan(1e-6);
        // multistage separation keeps more liquid than a single flash
        expect(res.bo.multistage).toBeLessThan(res.bo.singleStage);
        expect(res.totals.totalGor).toBeLessThan(res.bo.singleStageGor);
      } else {
        expect(res.bo.multistage).toBeNull();
        expect(res.warnings.join(' ')).toMatch(/two-phase at reservoir/);
      }
    });

    test('identities: material balance and GOR telescoping', () => {
      expect(materialBalanceError(res, job.x)).toBeLessThan(1e-12);
      if (job.stockTank) {
        expect(Math.abs(res.totals.separatorGor + res.totals.stockTankGor - res.totals.totalGor))
          .toBeLessThan(1e-9);
      }
    });
  });
});

describe('FS6 identity gates', () => {
  const job = goldens.separator.find((j) => j.train === 'two-stage');
  const mix = mixtureWithPlusFraction(job.keys, job.plus);

  test('sc molar volume constant is R·Tsc/Psc', () => {
    expect(SCF_PER_LBMOL).toBeCloseTo((10.7316 * TSC) / PSC, 10);
    expect(MW_AIR).toBeCloseTo(28.9647, 10);
  });

  test('explicit stock-tank final stage is a no-op', () => {
    const implicit = separatorTrain(mix, job.x, toStages(job.stagesF));
    const explicit = separatorTrain(mix, job.x, [...toStages(job.stagesF), { ...STOCK_TANK_STAGE }]);
    expect(explicit.stages.length).toBe(implicit.stages.length);
    expect(explicit.totals.totalGor).toBeCloseTo(implicit.totals.totalGor, 10);
  });

  test('normalizeStages sorts high-to-low and appends the stock tank', () => {
    const train = normalizeStages([
      { tR: degFtoR(75), pPsia: 100 },
      { tR: degFtoR(90), pPsia: 500 },
      { tR: degFtoR(80), pPsia: 0 }, // dropped
    ]);
    expect(train.map((s) => s.pPsia)).toEqual([500, 100, PSC]);
    expect(train[2].tR).toBe(TSC);
  });

  test('empty stage list degrades to a single flash to stock tank', () => {
    const res = separatorTrain(mix, job.x, []);
    expect(res.stages.length).toBe(1);
    expect(res.stages[0].isStockTank).toBe(true);
    expect(res.totals.separatorGor).toBe(0);
    expect(res.totals.stockTankGor).toBeCloseTo(res.totals.totalGor, 9);
  });

  test('stage GORs sum to the totals partition', () => {
    const res = runJob(job);
    const sep = res.stages.filter((s) => !s.isStockTank)
      .reduce((s, r) => s + r.gorScfPerStb, 0);
    expect(sep).toBeCloseTo(res.totals.separatorGor, 8);
  });
});
