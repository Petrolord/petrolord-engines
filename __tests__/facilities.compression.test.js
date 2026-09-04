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
    const r = stageCount({
      pSuctionPsia: 100, pDischargePsia: 200, tSuctionF: 300,
      k: 1.4, polytropicEfficiency: 0.5, maxDischargeF: 250,
    });
    expect(r.error).toMatch(/no practical stage count/);
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
    // and the two idealisations must give the SAME shaft power, because
    // the actual work is the actual work. They agree identically, which
    // is the strongest available check that neither is transcribed wrong.
    expect(rel(r.gasHpIsentropicRoute, r.gasHp)).toBeLessThan(1e-12);
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
    expect(f.thermalEfficiencyPct).toBeCloseTo((2544.43 / 8000) * 100, 6);
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
    expect(s.warning).not.toMatch(/discharge at 300 F/);
    expect(s.warning).toContain('above about 300 F');   // the threshold is untouched
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
