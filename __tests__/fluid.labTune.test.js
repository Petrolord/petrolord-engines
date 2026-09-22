/**
 * ET2 lab-tune gates (CI mirror of harness CASES 24/25; the full anchor
 * sweep runs in tools/validation/fluidstudio/run-validation.mjs).
 */
import fs from 'fs';
import path from 'path';
import { tuneToLab, predictTargets, untunedKnobs } from '../engines/fluid/labTune.js';
import { TUNING_BOUNDS } from '../engines/fluid/tuning.js';

const goldens = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'fluid', 'goldens.json'), 'utf8'));

describe('tuneToLab failure modes', () => {
  it('refuses a fluid without a plus fraction', () => {
    expect(tuneToLab({ keys: ['C1', 'nC4'], z: [0.5, 0.5] }, { psat: { tF: 100, pPsia: 500 } }).ok).toBe(false);
  });
  it('refuses an empty target set', () => {
    const job = goldens.flashC7[0];
    expect(tuneToLab({ keys: job.keys, plus: job.plus, z: job.x }, {}).ok).toBe(false);
    expect(tuneToLab({ keys: job.keys, plus: job.plus, z: job.x }, { separatorTest: { stagesF: [[75, 114.65]] } }).ok).toBe(false);
  });
});

describe('untunedKnobs', () => {
  it('starts at multiplier identity with the correlation BIP and shift', () => {
    const job = goldens.flashC7[0];
    const k = untunedKnobs(job.plus);
    expect(k.fTc).toBe(1);
    expect(k.fPc).toBe(1);
    expect(k.kC1).toBeGreaterThan(0);
    expect(k.sPlus).toBeGreaterThan(0);
  });
});

describe('self-recovery: the tune recovers synthetic lab data from a known truth', () => {
  it('recovers psat/GOR/API/Bo within tight bands', () => {
    const job = goldens.flashC7[0];
    const fluid = { keys: job.keys, plus: job.plus, z: job.x };
    const truth = { fTc: 1.04, fPc: 0.88, kC1: 0.1, sPlus: 0.08 };
    const sepSpec = { stagesF: [[75, 114.65]], resTF: 200 };
    const pre = predictTargets(fluid, { psat: { tF: 200, pPsia: 5000 }, separatorTest: sepSpec }, truth);
    const targets = {
      psat: { tF: 200, pPsia: pre.psatPsia },
      separatorTest: {
        ...sepSpec, resPPsia: pre.psatPsia * 1.001, totalGor: pre.totalGor, stoApi: pre.stoApi,
      },
    };
    targets.separatorTest.bo = predictTargets(fluid, targets, truth).bo;

    const rec = tuneToLab(fluid, targets);
    expect(rec.ok).toBe(true);
    expect(rec.converged).toBe(true);
    const err = Object.fromEntries(rec.report.map((r) => [r.name, r.tunedErr]));
    expect(Math.abs(err.psat)).toBeLessThan(0.1);
    expect(Math.abs(err.totalGor)).toBeLessThan(0.5);
    expect(Math.abs(err.stoApi)).toBeLessThan(0.3);
    expect(Math.abs(err.bo)).toBeLessThan(0.5);
    // knobs stayed inside the regression box
    ['fTc', 'fPc', 'kC1', 'sPlus'].forEach((k) => {
      expect(rec.tuning[k]).toBeGreaterThanOrEqual(TUNING_BOUNDS[k][0]);
      expect(rec.tuning[k]).toBeLessThanOrEqual(TUNING_BOUNDS[k][1]);
    });
  });
});

describe('real anchor: Good Oil Well No. 4 joint tune (CASE 19 fixture data)', () => {
  it('closes the untuned Psat and API biases jointly', () => {
    const lit = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'test-data', 'fluid', 'literature-fixtures.json'), 'utf8',
    ));
    const go = lit.separatorTests.fluids[1];
    const fluid = { keys: [...go.keys, 'C7+'], plus: go.plus, z: go.z };
    const fit = tuneToLab(fluid, {
      psat: { tF: go.resTP[0], pPsia: go.resTP[1] },
      separatorTest: {
        stagesF: [...go.stagesF, [75, 14.65]], // lab stock tank ran at 75F
        resTF: go.resTP[0],
        resPPsia: go.resTP[1],
        totalGor: go.expected.totalGor,
        stoApi: go.expected.stoApi,
        bo: go.expected.boMultistage,
      },
    });
    expect(fit.ok).toBe(true);
    expect(fit.converged).toBe(true);
    const err = Object.fromEntries(fit.report.map((r) => [r.name, r.tunedErr]));
    const err0 = Object.fromEntries(fit.report.map((r) => [r.name, r.untunedErr]));
    expect(Math.abs(err.psat)).toBeLessThan(0.3); // untuned +5.9%
    expect(Math.abs(err.totalGor)).toBeLessThan(1.5);
    expect(Math.abs(err.stoApi)).toBeLessThan(2.5); // untuned ~-9 API
    expect(Math.abs(err.bo)).toBeLessThan(1.5);
    expect(Math.abs(err0.stoApi) - Math.abs(err.stoApi)).toBeGreaterThan(6);
  });
});

describe('Bo fallback at the engine Psat (two-phase at the lab reservoir conditions)', () => {
  // Good Oil Well No. 4 run away from its 220 F study temperature: the
  // untuned model is two-phase at the lab Pb, so Bo falls back to the
  // engine's own saturation pressure. That fallback used to rescan without
  // the Psat window and step only (1 + 1e-6) above a boundary bisected to
  // 0.05 psia, landing on the two-phase side and returning a null Bo at
  // 180, 200, 260 and 280 F.
  const lit = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'test-data', 'fluid', 'literature-fixtures.json'), 'utf8',
  ));
  const go = lit.separatorTests.fluids[1];
  const fluid = { keys: [...go.keys, 'C7+'], plus: go.plus, z: go.z };
  const stagesF = [...go.stagesF, [75, 14.65]];
  const labPb = go.resTP[1];

  it.each([180, 200, 220, 240, 260, 280])('returns an untuned Bo at %i F', (tF) => {
    const pred = predictTargets(fluid, {
      psat: { tF, pPsia: labPb },
      separatorTest: { stagesF, resTF: tF, resPPsia: labPb },
    }, null);
    expect(pred.psatPsia).toBeGreaterThan(labPb); // two-phase at the lab Pb
    expect(pred.bo).not.toBeNull();
    expect(pred.bo).toBeGreaterThan(1);
    // the Bo basis is the same saturation pressure the Psat row reports
    expect(pred.boBasisPsia).toBe(pred.psatPsia);
  });

  it('finds the basis with the Psat window when no Psat target is given', () => {
    const withPsat = predictTargets(fluid, {
      psat: { tF: 200, pPsia: labPb },
      separatorTest: { stagesF, resTF: 200, resPPsia: labPb },
    }, null);
    const sepOnly = predictTargets(fluid, {
      separatorTest: { stagesF, resTF: 200, resPPsia: labPb },
    }, null);
    expect(sepOnly.bo).not.toBeNull();
    expect(sepOnly.boBasisPsia).toBe(withPsat.boBasisPsia);
    expect(sepOnly.bo).toBe(withPsat.bo);
  });
});
