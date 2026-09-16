// Facilities F9 compression gates against
// tools/validation/facilities/oracle_compression.py.
//
// Independent routes: polytropic head by SIMPSON INTEGRATION of the
// reversible work integral int(v dp) along the polytropic path, against
// the closed form here; discharge temperature by MARCHING the path in
// 100,000 pressure steps against the closed exponential; stage count by
// BRUTE-FORCE search; and power converted through SI watts rather than
// the 33000 ft.lbf/min horsepower packaging, so that constant is
// checked rather than repeated.
//
// This is a new app, not a rebuild: the F0-retired Compressor & Pump
// Pack was fifty lines of static HTML printing "Power: 1250 hp" as a
// literal string.

import fs from 'fs';
import path from 'path';
import {
  polytropicExponentRatio, dischargeTempR, stageCount,
  compressionStage, compressorTrain,
  actualInletCfm, machineScreen, driverFuel,
} from '../engines/facilities/compression';
import { AIR_MW, R_UNIVERSAL, toRankine } from '../engines/production/gasProperties';
import { BTU_PER_HP_HR } from '../lib/units/fieldUnits';
import {
  gasDensityLbFt3, DAK_TPR_MIN, DAK_TPR_MAX, DAK_PPR_MAX,
} from '../engines/facilities/separatorSizing';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'facilities', 'goldens', 'compression_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

describe('the polytropic exponent', () => {
  test('is NOT the isentropic one, and the difference is worth real power', () => {
    const k = 1.28;
    const eta = 0.75;
    const polyE = polytropicExponentRatio({ k, polytropicEfficiency: eta });
    const isenE = (k - 1) / k;
    // the classic error: using k where n belongs
    expect(polyE).toBeGreaterThan(isenE);
    expect(polyE / isenE).toBeCloseTo(1 / eta, 9);
    expect(Number.isNaN(polytropicExponentRatio({ k: 0.9, polytropicEfficiency: 0.75 }))).toBe(true);
  });

  test('discharge temperature rises with ratio and falls with efficiency', () => {
    const base = { tSuctionR: 560, ratio: 3, k: 1.28 };
    const good = dischargeTempR({ ...base, polytropicEfficiency: 0.82 });
    const poor = dischargeTempR({ ...base, polytropicEfficiency: 0.65 });
    expect(poor).toBeGreaterThan(good);
    const hotter = dischargeTempR({ ...base, ratio: 5, polytropicEfficiency: 0.82 });
    expect(hotter).toBeGreaterThan(good);
  });
});

describe('staging', () => {
  test('matches the brute-force search and names what governed', () => {
    G.staging.forEach((row) => {
      const r = stageCount(row);
      expect(r.error).toBeUndefined();
      expect(r.stages).toBe(row.stages);
      expect(rel(r.overallRatio, row.overallRatio)).toBeLessThan(1e-12);
      expect(['discharge temperature', 'ratio per stage', 'both equally'])
        .toContain(r.governedBy);
    });
  });

  test('THE POINT: temperature usually governs, not the ratio rule', () => {
    // a high-k gas at a modest overall ratio: the ratio rule says one
    // stage, the temperature limit says otherwise
    const r = stageCount({
      pSuctionPsia: 100, pDischargePsia: 380, tSuctionF: 110,
      k: 1.30, polytropicEfficiency: 0.72, maxDischargeF: 250,
    });
    expect(r.byRatio).toBe(1);
    expect(r.stages).toBeGreaterThan(1);
    expect(r.governedBy).toBe('discharge temperature');
  });

  test('refuses an impossible duty rather than returning a stage count', () => {
    // A limit BELOW the suction temperature is not a staging problem at all:
    // compression raises the temperature, so no count can meet it and the
    // refusal says which input is wrong. This case used to return the
    // twelve-stage-cap sentence, which sent the reader off to intercool.
    const below = stageCount({
      pSuctionPsia: 100, pDischargePsia: 200, tSuctionF: 300,
      k: 1.4, polytropicEfficiency: 0.5, maxDischargeF: 250,
    });
    expect(below.error).toMatch(/at or below the suction temperature/);
    // A limit ABOVE the suction that twelve equal stages still cannot reach
    // IS the case that sentence is for, and it still fires there.
    const capped = stageCount({
      pSuctionPsia: 100, pDischargePsia: 200, tSuctionF: 100,
      k: 1.4, polytropicEfficiency: 0.5, maxDischargeF: 110,
    });
    expect(capped.error).toMatch(/no practical stage count/);
    expect(stageCount({ pSuctionPsia: 100, pDischargePsia: 50 }).error).toBeTruthy();
  });
});

describe('a single stage', () => {
  test('head, temperature and power match the independent routes', () => {
    G.stages.forEach((row) => {
      const r = compressionStage(row);
      expect(r.error).toBeUndefined();
      // closed form vs Simpson integration of int(v dp)
      expect(rel(r.headPolyFtLbfLbm, row.headPolyFtLbfLbm)).toBeLessThan(1e-9);
      // closed exponential vs a 100,000-step march
      expect(rel(r.tDischargeF, row.tDischargeF)).toBeLessThan(1e-8);
      // the 33000 packaging vs SI watts
      expect(rel(r.gasHp, row.gasHp)).toBeLessThan(1e-9);
      expect(rel(r.massLbHr, row.massLbHr)).toBeLessThan(1e-12);
    });
  });

  test('uses an averaged Z, not the suction value alone', () => {
    const r = compressionStage({
      qMMscfd: 20, pSuctionPsia: 500, tSuctionF: 100, ratio: 3,
      gasSg: 0.65, k: 1.28,
    });
    expect(r.z1).not.toBeCloseTo(r.z2, 3); // Z really does move
    expect(r.zAvg).toBeCloseTo((r.z1 + r.z2) / 2, 12);
  });

  test('reports both idealisations so neither is quoted as the other', () => {
    const r = compressionStage({
      qMMscfd: 20, pSuctionPsia: 100, tSuctionF: 100, ratio: 3.16,
      gasSg: 0.65, k: 1.28, polytropicEfficiency: 0.75,
    });
    expect(r.headIsenFtLbfLbm).toBeLessThan(r.headPolyFtLbfLbm);
    // isentropic efficiency is always below polytropic for compression:
    // the reheat a real machine generates has to be recompressed
    expect(r.isentropicEfficiency).toBeLessThan(r.polytropicEfficiency);
    // The two power routes agree, and that is an ALGEBRAIC IDENTITY rather
    // than evidence. With e = (k-1)/(k eta_p) and kExp = (k-1)/k, e * eta_p
    // == kExp exactly, so headIsen/eta_s and headPoly/eta_p are the same
    // expression and cannot disagree for any input at all. This assertion
    // used to carry the comment "the strongest available check that neither
    // is transcribed wrong"; it could not fail. Kept, labelled as the shape
    // property it is, with the real check in the test below.
    expect(rel(r.gasHpIsentropicRoute, r.gasHp)).toBeLessThan(1e-12);
    // proved rather than asserted, on the exponents this case actually used
    const e = polytropicExponentRatio({ k: 1.28, polytropicEfficiency: 0.75 });
    expect(e * 0.75).toBeCloseTo((1.28 - 1) / 1.28, 15);
  });

  test('THE REAL CHECK: the closed form matches a quadrature of int(v dp), and a wrong exponent fails it', () => {
    // The head is the reversible work integral along the polytropic path.
    // With v = Z R T / (MW p) and T = T1 x^e where x = p/p1, the integrand in
    // x is (Z R T1 / MW) x^(e-1). Integrated here by composite Simpson,
    // against the closed form the module evaluates: same physics, different
    // mathematics, and unlike the identity above it can fail.
    const quadrature = ({ zAvg, mw, t1R, ratio, e, steps = 100000 }) => {
      const f = (x) => x ** (e - 1);
      const h = (ratio - 1) / steps;
      let total = f(1) + f(ratio);
      for (let i = 1; i < steps; i += 1) total += (i % 2 ? 4 : 2) * f(1 + i * h);
      return ((zAvg * (R_UNIVERSAL * 144)) / mw) * t1R * ((total * h) / 3);
    };
    const cases = [
      { qMMscfd: 20, pSuctionPsia: 100, tSuctionF: 100, ratio: 3.16, gasSg: 0.65, k: 1.28, polytropicEfficiency: 0.75 },
      { qMMscfd: 50, pSuctionPsia: 300, tSuctionF: 110, ratio: 2.5, gasSg: 0.7, k: 1.26, polytropicEfficiency: 0.78 },
      { qMMscfd: 5, pSuctionPsia: 60, tSuctionF: 90, ratio: 4.0, gasSg: 0.6, k: 1.3, polytropicEfficiency: 0.72 },
    ];
    let swept = 0;
    cases.forEach((c) => {
      const r = compressionStage(c);
      const e = polytropicExponentRatio({ k: c.k, polytropicEfficiency: c.polytropicEfficiency });
      const want = quadrature({
        zAvg: r.zAvg, mw: AIR_MW * c.gasSg, t1R: toRankine(c.tSuctionF), ratio: c.ratio, e,
      });
      expect(rel(r.headPolyFtLbfLbm, want)).toBeLessThan(1e-9);
      swept += 1;
    });
    // A gate that examines nothing must never report success.
    expect(swept).toBe(cases.length);
    // NEGATIVE CONTROL. Move the exponent a tenth of a percent and the
    // comparison must break; if it does not, it is comparing nothing.
    const c = cases[0];
    const r = compressionStage(c);
    const eBad = polytropicExponentRatio({ k: c.k, polytropicEfficiency: c.polytropicEfficiency }) * 1.001;
    const bad = quadrature({
      zAvg: r.zAvg, mw: AIR_MW * c.gasSg, t1R: toRankine(c.tSuctionF), ratio: c.ratio, e: eBad,
    });
    expect(rel(r.headPolyFtLbfLbm, bad)).toBeGreaterThan(1e-6);
  });

  test('warns when the discharge is hot enough that valves become the limit', () => {
    const hot = compressionStage({
      qMMscfd: 5, pSuctionPsia: 60, tSuctionF: 120, ratio: 4.5,
      gasSg: 0.6, k: 1.30, polytropicEfficiency: 0.7,
    });
    expect(hot.tDischargeF).toBeGreaterThan(300);
    expect(hot.warning).toMatch(/valves and the lube oil/);
    expect(compressionStage({ qMMscfd: 0, pSuctionPsia: 100, ratio: 3, gasSg: 0.65, k: 1.28 }).error)
      .toBeTruthy();
  });
});

describe('the train', () => {
  const base = {
    qMMscfd: 20, pSuctionPsia: 100, tSuctionF: 100, pDischargePsia: 1000,
    gasSg: 0.65, k: 1.28, polytropicEfficiency: 0.75, interstageCoolToF: 110,
  };

  test('chains stages with cooling and totals the power and the duty', () => {
    const t = compressorTrain(base);
    expect(t.error).toBeUndefined();
    expect(t.stages).toHaveLength(t.stages.length);
    // pressure climbs continuously through the train
    for (let i = 1; i < t.stages.length; i += 1) {
      expect(t.stages[i].pSuctionPsia).toBeCloseTo(t.stages[i - 1].pDischargePsia, 9);
    }
    // every stage but the last is cooled back
    for (let i = 0; i < t.stages.length - 1; i += 1) {
      expect(t.stages[i].cooledToF).toBe(110);
      expect(t.stages[i + 1].tSuctionF).toBe(110);
      expect(t.stages[i].coolingBtuHr).toBeGreaterThan(0);
    }
    expect(t.stages[t.stages.length - 1].cooledToF).toBeNull();
    expect(t.totalGasHp).toBeCloseTo(
      t.stages.reduce((s, x) => s + x.gasHp, 0), 6,
    );
    expect(t.totalCoolingMMBtuHr).toBeGreaterThan(0);
  });

  test('THE POINT OF INTERCOOLING: cooling between stages saves power', () => {
    const cooled = compressorTrain({ ...base, interstageCoolToF: 100 });
    const hot = compressorTrain({ ...base, interstageCoolToF: 250 });
    expect(cooled.totalGasHp).toBeLessThan(hot.totalGasHp);
  });

  test('more stages for the same duty means less power, at the cost of coolers', () => {
    const few = compressorTrain({ ...base, maxDischargeF: 400, maxRatioPerStage: 10 });
    const many = compressorTrain({ ...base, maxDischargeF: 150 });
    expect(many.stages.length).toBeGreaterThan(few.stages.length);
    expect(many.totalGasHp).toBeLessThan(few.totalGasHp);
    expect(many.totalCoolingBtuHr).toBeGreaterThan(few.totalCoolingBtuHr);
  });
});

describe('machine screening and fuel', () => {
  test('screens on the published criteria rather than a preference', () => {
    const small = machineScreen({
      qMMscfd: 0.5, pSuctionPsia: 400, tSuctionF: 100, gasSg: 0.65,
      overallRatio: 3, totalBrakeHp: 150,
    });
    expect(small.recommendation).toBe('reciprocating');
    expect(small.reasons.join(' ')).toMatch(/acfm/);
    const big = machineScreen({
      // a big low-pressure gathering duty: 400 MMscfd at 100 psia is
      // about 41,000 acfm, which is squarely centrifugal
      qMMscfd: 400, pSuctionPsia: 100, tSuctionF: 100, gasSg: 0.65,
      overallRatio: 2.5, totalBrakeHp: 15000,
    });
    expect(big.recommendation).toBe('centrifugal');
    expect(big.reasons.join(' ')).toMatch(/turbine/);
    const highRatio = machineScreen({
      qMMscfd: 15, pSuctionPsia: 80, tSuctionF: 100, gasSg: 0.65,
      overallRatio: 12, totalBrakeHp: 2000,
    });
    expect(highRatio.recommendation).toBe('reciprocating');
    expect(machineScreen({ qMMscfd: 0 }).error).toBeTruthy();
  });

  test('actual inlet volume falls with pressure, which is the whole screen', () => {
    const lowP = actualInletCfm({ qMMscfd: 20, pPsia: 50, tF: 100, gasSg: 0.65 });
    const highP = actualInletCfm({ qMMscfd: 20, pPsia: 800, tF: 100, gasSg: 0.65 });
    expect(lowP).toBeGreaterThan(highP * 10);
  });

  test('driver fuel comes out of the stream being compressed', () => {
    const f = driverFuel({ brakeHp: 2000, heatRateBtuHpHr: 8000, gasLhvBtuScf: 950 });
    expect(f.fuelMMscfd).toBeGreaterThan(0);
    // 2544.43 was a rounding of the Btu a horsepower-hour IS, and every
    // thermal efficiency was 1.406e-6 high on it. The constant is now derived
    // in lib/units/fieldUnits.js, so this gate can tighten from 6 to 9.
    expect(f.thermalEfficiencyPct).toBeCloseTo((BTU_PER_HP_HR / 8000) * 100, 9);
    // a better driver burns less
    const better = driverFuel({ brakeHp: 2000, heatRateBtuHpHr: 6500 });
    expect(better.fuelMMscfd).toBeLessThan(f.fuelMMscfd);
    expect(driverFuel({ brakeHp: 0 }).error).toBeTruthy();
  });
});

// Both of these name their own threshold in the sentence and then printed
// the value whole, so a discharge of 300.3 F read "discharge at 300 F:
// above about 300 F ..." and a suction volume of 499.7 acfm read "only 500
// acfm at suction: below about 500 acfm ...". Each is a real finding
// rendered as its own counter-argument. One decimal narrows the collision
// by ten; it does not remove it, and it errs upward as readily as down.
describe('the machine warnings print a value off their own threshold', () => {
  test('a discharge temperature past 300 F does not print as 300 F', () => {
    const k = 1.28;
    const polytropicEfficiency = 0.75;
    const ratio = 3;
    // the discharge temperature is a closed form in the suction one, so the
    // suction is chosen to land the discharge at 300.3 F
    const e = polytropicExponentRatio({ k, polytropicEfficiency });
    const tSuctionF = (300.3 + 459.67) / ratio ** e - 459.67;
    const s = compressionStage({
      qMMscfd: 10, pSuctionPsia: 200, tSuctionF, ratio, gasSg: 0.65, k,
      polytropicEfficiency,
    });
    expect(s.tDischargeF).toBeGreaterThan(300.05);
    expect(s.tDischargeF).toBeLessThan(300.5);
    expect(s.warning).toMatch(/discharge at 300\.3 F/);
    expect(s.warning).not.toMatch(/discharge at 300 F is/);
    // The threshold is the CALLER'S, printed rather than implied. It used to
    // be a hardcoded 300 with maxDischargeF never consulted.
    expect(s.warning).toContain('above the stated limit of 300.0 F');
    expect(compressionStage({
      qMMscfd: 10, pSuctionPsia: 200, tSuctionF, ratio, gasSg: 0.65, k,
      polytropicEfficiency, maxDischargeF: 400,
    }).warning).toBeNull();
    expect(compressionStage({
      qMMscfd: 10, pSuctionPsia: 200, tSuctionF, ratio, gasSg: 0.65, k,
      polytropicEfficiency, maxDischargeF: 250,
    }).warning).toContain('above the stated limit of 250.0 F');
  });

  test('a suction volume under 500 acfm does not print as 500 acfm', () => {
    const at = { pSuctionPsia: 200, tSuctionF: 90, gasSg: 0.65 };
    // acfm is linear in rate, so the rate for 499.7 acfm is one division
    const perMMscfd = actualInletCfm({
      qMMscfd: 1, pPsia: at.pSuctionPsia, tF: at.tSuctionF, gasSg: at.gasSg,
    });
    const m = machineScreen({
      qMMscfd: 499.7 / perMMscfd, ...at, overallRatio: 3, totalBrakeHp: 500,
    });
    expect(m.recommendation).toBe('reciprocating');
    const r = m.reasons.find((x) => x.includes('acfm at suction'));
    expect(r).toMatch(/only 499\.7 acfm/);
    expect(r).not.toMatch(/only 500 acfm/);
    expect(r).toContain('below about 500 acfm');
  });
});

/* ==================================================================== *
 * FC3-0. The repair wave before the NextGen Rotating Equipment course.
 *
 * Six numbers here were confidently wrong and nine inputs returned a
 * NaN or an Infinity with no `error` key. Each test names the defective
 * input, the corrected behaviour and the boundary, and the two that
 * replace an arithmetic result carry a negative control, because a
 * comparison that cannot fail is the finding this wave opened with.
 * ==================================================================== */

describe('FC3-0: the train keeps the limit it was staged against', () => {
  const duty = {
    qMMscfd: 20, pSuctionPsia: 100, tSuctionF: 100, pDischargePsia: 400,
    gasSg: 0.65, k: 1.28, polytropicEfficiency: 0.75,
  };
  // the exact table the wave was opened on: every one of these ran hotter
  // than its own stated limit, by up to 73.3 F, on a return that read
  // governedBy: 'discharge temperature'
  const table = [
    [140, 200], [150, 220], [160, 230], [170, 240], [180, 250],
    [200, 250], [110, 300],
  ];

  test('C1: no stage runs above maxDischargeF when the intercooler sits above the suction', () => {
    let swept = 0;
    table.forEach(([interstageCoolToF, maxDischargeF]) => {
      const r = compressorTrain({ ...duty, interstageCoolToF, maxDischargeF });
      expect(r.error).toBeUndefined();
      r.stages.forEach((s) => {
        expect(s.tDischargeF).toBeLessThanOrEqual(maxDischargeF);
        // and the field that should have caught it stays quiet, because
        // it is now measured against the same number
        expect(s.warning).toBeNull();
      });
      expect(r.finalDischargeF).toBeLessThanOrEqual(maxDischargeF);
      swept += 1;
    });
    expect(swept).toBe(table.length);
  });

  test('C1 NEGATIVE CONTROL: the rule this replaces really did break the limit', () => {
    // Staging every trial stage from the SUCTION, which is what stageCount
    // used to do while compressorTrain ran the later stages from the
    // intercooler approach. Reproduced here so the gate above is measured
    // against something rather than against itself.
    const oldByTemp = ({ pSuctionPsia, pDischargePsia, tSuctionF, k: kk, polytropicEfficiency, maxDischargeF }) => {
      const overall = pDischargePsia / pSuctionPsia;
      const tSuctionR = toRankine(tSuctionF);
      for (let n = 1; n <= 12; n += 1) {
        const t = dischargeTempR({
          tSuctionR, ratio: overall ** (1 / n), k: kk, polytropicEfficiency,
        });
        if (t - 459.67 <= maxDischargeF) return n;
      }
      return null;
    };
    let broke = 0;
    table.forEach(([interstageCoolToF, maxDischargeF]) => {
      const nOld = oldByTemp({ ...duty, maxDischargeF });
      const nNew = compressorTrain({ ...duty, interstageCoolToF, maxDischargeF }).stages.length;
      // the old count is never larger, and where it is smaller the train
      // it produced ran past the limit
      expect(nOld).toBeLessThanOrEqual(nNew);
      if (nOld < nNew) {
        // march the old count by hand and show it exceeds
        const ratio = (duty.pDischargePsia / duty.pSuctionPsia) ** (1 / nOld);
        let t = duty.tSuctionF;
        let hottest = -Infinity;
        for (let i = 0; i < nOld; i += 1) {
          const tOut = dischargeTempR({
            tSuctionR: toRankine(t), ratio, k: duty.k,
            polytropicEfficiency: duty.polytropicEfficiency,
          }) - 459.67;
          hottest = Math.max(hottest, tOut);
          t = i === nOld - 1 ? tOut : interstageCoolToF;
        }
        expect(hottest).toBeGreaterThan(maxDischargeF);
        broke += 1;
      }
    });
    // if this is zero the gate above proves nothing
    expect(broke).toBeGreaterThan(0);
  });

  test('C1: the staging goldens are untouched, because none of them cools between stages', () => {
    // A train with no stated approach cools back to its own suction, so
    // the hottest inlet a trial stage can have IS the suction and the
    // repaired rule is the old rule. This is why the published staging
    // cases did not move.
    G.staging.forEach((c) => {
      const without = stageCount(c);
      const withSame = stageCount({ ...c, interstageCoolToF: c.tSuctionF });
      expect(without.stages).toBe(c.stages);
      expect(withSame.stages).toBe(c.stages);
    });
  });
});

describe('FC3-0: a refusal names the input that is wrong', () => {
  const stage = {
    qMMscfd: 20, pSuctionPsia: 100, tSuctionF: 100, ratio: 3, gasSg: 0.65, k: 1.28,
  };
  const train = {
    qMMscfd: 20, pSuctionPsia: 100, tSuctionF: 100, pDischargePsia: 400,
    gasSg: 0.65, k: 1.28, polytropicEfficiency: 0.75,
  };

  test('C6: a per-stage ratio limit of 1 is refused, and a negative one does not throw', () => {
    // it returned { stages: Infinity, governedBy: 'ratio per stage' } with
    // no error key, because Math.log(1) is zero
    expect(stageCount({ ...train, maxRatioPerStage: 1 }).error).toMatch(/maximum ratio per stage/);
    // and at -4 the stage loop never ran, so the return statement read
    // .tDischargeF off undefined: typing a minus sign took the whole
    // Compressor Station Designer down inside a useMemo
    expect(() => compressorTrain({ ...train, maxRatioPerStage: -4 })).not.toThrow();
    expect(compressorTrain({ ...train, maxRatioPerStage: -4 }).error).toMatch(/maximum ratio per stage/);
    // BOUNDARY: just above 1 is legal and gives a large but finite count
    const tight = stageCount({ ...train, maxRatioPerStage: 1.2 });
    expect(tight.error).toBeUndefined();
    expect(Number.isFinite(tight.stages)).toBe(true);
    expect(tight.governedBy).toBe('ratio per stage');
  });

  test('C7: four unrelated faults get four different refusals', () => {
    // all four used to return "no practical stage count keeps the discharge
    // temperature under the limit: intercool harder, or check k and the
    // suction temperature", which is right for none of them
    const errs = [
      stageCount({ ...train, polytropicEfficiency: 0 }).error,
      stageCount({ ...train, polytropicEfficiency: 1.5 }).error,
      stageCount({ ...train, tSuctionF: -600 }).error,
      stageCount({ ...train, maxDischargeF: -100 }).error,
    ];
    errs.forEach((e) => expect(typeof e).toBe('string'));
    expect(new Set(errs).size).toBe(4);
    expect(errs[0]).toMatch(/polytropic efficiency/);
    expect(errs[1]).toMatch(/polytropic efficiency/);
    expect(errs[2]).toMatch(/suction temperature is at or below absolute zero/);
    // -100 F is above absolute zero, so the honest diagnosis is that the
    // limit sits below the suction, and the sentence says so with both
    // temperatures in it rather than sending the reader to intercool
    expect(errs[3]).toMatch(/maximum discharge temperature of -100 F is at or below the suction temperature of 100 F/);
    expect(stageCount({ ...train, maxDischargeF: -600 }).error)
      .toMatch(/maximum discharge temperature is at or below absolute zero/);
    errs.forEach((e) => expect(e).not.toMatch(/intercool harder/));
    // and the sentence that is left fires on the case it is actually for,
    // carrying the evidence rather than the advice alone
    const capped = stageCount({
      ...train, interstageCoolToF: 240, maxDischargeF: 250,
    });
    expect(capped.error).toMatch(/no practical stage count/);
    expect(capped.triedStages).toBe(12);
    expect(capped.coolestReachedF).toBeGreaterThan(capped.maxDischargeF);
    expect(capped.hottestInletF).toBeCloseTo(240, 6);
  });

  test('C3: a heat rate below the first law is refused', () => {
    // 2000 reported 127.22 percent thermally efficient; 1 reported 254,443
    expect(driverFuel({ brakeHp: 1000, heatRateBtuHpHr: 2000 }).error).toMatch(/more than 100 percent/);
    expect(driverFuel({ brakeHp: 1000, heatRateBtuHpHr: 1 }).error).toMatch(/more than 100 percent/);
    // BOUNDARY: exactly one horsepower-hour per horsepower-hour is a
    // perfect driver, which is allowed and reads 100 percent
    const perfect = driverFuel({ brakeHp: 1000, heatRateBtuHpHr: BTU_PER_HP_HR });
    expect(perfect.error).toBeUndefined();
    expect(perfect.thermalEfficiencyPct).toBeCloseTo(100, 9);
    expect(driverFuel({ brakeHp: 1000, heatRateBtuHpHr: BTU_PER_HP_HR * 0.999999 }).error)
      .toMatch(/more than 100 percent/);
  });

  test('C4: a suction below absolute zero is not an inlet volume', () => {
    // it returned -275.48758058196427 acfm, and machineScreen recommended
    // a reciprocating machine because that is "below about 500 acfm"
    expect(actualInletCfm({ qMMscfd: 20, pPsia: 200, tF: -600, gasSg: 0.65 })).toBeNaN();
    const screened = machineScreen({
      qMMscfd: 20, pSuctionPsia: 200, tSuctionF: -600, gasSg: 0.65,
      overallRatio: 3, totalBrakeHp: 1000,
    });
    expect(screened.recommendation).toBeUndefined();
    expect(screened.error).toBeTruthy();
    // BOUNDARY: absolute zero itself is refused, a degree above it is a
    // correlation question rather than an arithmetic one
    expect(actualInletCfm({ qMMscfd: 20, pPsia: 200, tF: -459.67, gasSg: 0.65 })).toBeNaN();
  });

  test('B: the two efficiencies a stage handed straight to the arithmetic', () => {
    // every thermodynamic field was NaN with no error key
    expect(compressionStage({ ...stage, polytropicEfficiency: 0 }).error).toMatch(/polytropic efficiency/);
    expect(compressionStage({ ...stage, polytropicEfficiency: 1.5 }).error).toMatch(/polytropic efficiency/);
    // brakeHp was Infinity beside a full set of correct numbers
    expect(compressionStage({ ...stage, mechanicalEfficiency: 0 }).error).toMatch(/mechanical efficiency/);
    expect(compressionStage({ ...stage, mechanicalEfficiency: 1.2 }).error).toMatch(/mechanical efficiency/);
    // BOUNDARY: 1 is allowed at both, and is the ideal machine
    const ideal = compressionStage({ ...stage, polytropicEfficiency: 1, mechanicalEfficiency: 1 });
    expect(ideal.error).toBeUndefined();
    expect(ideal.brakeHp).toBeCloseTo(ideal.gasHp, 12);
    // totalCoolingBtuHr was NaN while every power in the return was correct
    expect(compressorTrain({ ...train, cpBtuLbF: NaN }).error).toMatch(/specific heat/);
  });

  test('B: the bare-number contract is NaN, never Infinity and never a number', () => {
    expect(polytropicExponentRatio({ k: 1.28, polytropicEfficiency: 0 })).toBeNaN();
    expect(polytropicExponentRatio({ k: 1, polytropicEfficiency: 0.75 })).toBeNaN();
    expect(dischargeTempR({ tSuctionR: 560, ratio: 3, k: 1, polytropicEfficiency: 0.75 })).toBeNaN();
    expect(actualInletCfm({ qMMscfd: 0, pPsia: 200, tF: 100, gasSg: 0.65 })).toBeNaN();
    expect(actualInletCfm({ qMMscfd: 20, pPsia: 0, tF: 100, gasSg: 0.65 })).toBeNaN();
  });
});

describe('FC3-0: G2, one package, one philosophy about the DAK window', () => {
  test('a state outside the correlation is refused by name, with its evidence', () => {
    // it returned z = 0.22349360002287877 and gasHp 180.88 with no error
    const cold = compressionStage({
      qMMscfd: 20, pSuctionPsia: 1000, tSuctionF: -150, ratio: 2, gasSg: 0.65, k: 1.28,
    });
    expect(cold.error).toMatch(/Tpr .* below the DAK validity range/);
    expect(cold.state).toBe('suction');
    expect(cold.tpr).toBeLessThan(1);
    expect(cold.atPsia).toBe(1000);
    expect(cold.z1).toBeUndefined();
    expect(cold.gasHp).toBeUndefined();
    // and z = 2.864603158649205 with gasHp 1790.90 at the other end
    const squeezed = compressionStage({
      qMMscfd: 20, pSuctionPsia: 24000, tSuctionF: 100, ratio: 1.5, gasSg: 0.65, k: 1.28,
    });
    expect(squeezed.error).toMatch(/Ppr .* above the DAK validity limit of 30/);
    expect(squeezed.ppr).toBeGreaterThan(30);
    // the screen used the same unchecked helper
    expect(machineScreen({
      qMMscfd: 20, pSuctionPsia: 1000, tSuctionF: -150, gasSg: 0.65,
      overallRatio: 3, totalBrakeHp: 1000,
    }).error).toMatch(/DAK validity range/);
  });

  test('the same window the rest of the package refuses on, imported rather than restated', () => {
    // separatorSizing.js declares it; this asserts the two modules refuse
    // the SAME state rather than two states that happen to look alike
    const state = { pPsia: 1000, tF: -150, gasSg: 0.65 };
    const sep = gasDensityLbFt3(state);
    expect(sep.error).toMatch(/below the DAK validity range/);
    const eng = compressionStage({
      qMMscfd: 20, pSuctionPsia: state.pPsia, tSuctionF: state.tF, ratio: 2,
      gasSg: state.gasSg, k: 1.28,
    });
    expect(eng.tpr).toBeCloseTo(sep.tpr, 12);
    expect(eng.ppr).toBeCloseTo(sep.ppr, 12);
    expect(DAK_TPR_MIN).toBe(1.0);
    expect(DAK_TPR_MAX).toBe(3.0);
    expect(DAK_PPR_MAX).toBe(30);
  });

  test('BOUNDARY: every published golden state is inside the window and still solves', () => {
    let swept = 0;
    G.stages.forEach((c) => {
      const r = compressionStage(c);
      expect(r.error).toBeUndefined();
      expect(r.zAvg).toBeGreaterThan(0);
      swept += 1;
    });
    expect(swept).toBe(G.stages.length);
  });
});

describe('FC3-0: F3, one standard base for the module', () => {
  test('the mass flow is the derived molar volume, not a rounded 379.49', () => {
    // 379.49 belongs to 14.696 psia and 519.67 degR, and actualInletCfm
    // worked from 14.7 and 520 in the same file: the same MMscfd was one
    // molar quantity as a mass and a different one as a volume.
    const derivedLbmolScf = (R_UNIVERSAL * 519.67) / 14.696;
    const c = G.stages[0];
    const r = compressionStage(c);
    const want = ((c.qMMscfd * 1e6) / derivedLbmolScf / 24) * (AIR_MW * c.gasSg);
    expect(rel(r.massLbHr, want)).toBeLessThan(1e-15);
    // NEGATIVE CONTROL: the rounding it replaces is 1.69e-5 away, which is
    // far above this tolerance, so the comparison discriminates
    const rounded = ((c.qMMscfd * 1e6) / 379.49 / 24) * (AIR_MW * c.gasSg);
    expect(rel(r.massLbHr, rounded)).toBeGreaterThan(1e-6);
    // and the inlet volume is on the SAME base: at standard conditions the
    // actual volume is the standard volume divided by the minutes in a day
    const idealZ = actualInletCfm({ qMMscfd: 1, pPsia: 14.696, tF: 60, gasSg: 0.65 });
    const zStd = compressionStage({
      qMMscfd: 1, pSuctionPsia: 14.696, tSuctionF: 60, ratio: 2, gasSg: 0.65, k: 1.28,
    }).z1;
    expect(rel(idealZ, (1e6 / 1440) * zStd)).toBeLessThan(1e-12);
  });
});
