// Stimulation (D9): PKN/KGD closed forms, Nolte material balance and
// schedule, proppant pack interpolation, Cinco-Ley productivity,
// acidizing closed forms and oracle golden agreement.
import fs from 'fs';
import path from 'path';
import {
  planeStrainModulus, fracGeometry, pumpTime, pumpSchedule, proppedFrac,
  fracProductivity, noltekL, FRAC_MODELS, CFD_OPTIMUM,
} from '../engines/drilling/fracDesign.js';
import {
  hawkinsSkin, sandstoneAcid, carbonateAcid, maxMatrixRate,
} from '../engines/drilling/acidizing.js';
import { PROPPANT_CATALOG, packPermeabilityM2 } from '../engines/drilling/data/proppants.js';

const G = (name) => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', name), 'utf8'));

const DARCY = 9.869233e-13;
const KPSI = 6.894757293168e6;

function expectClose(a, b, rtol, atol = 0) {
  if (!Number.isFinite(a)) throw new Error(`non-finite value ${a} (expected ~ ${b})`);
  const tol = atol + rtol * Math.abs(b);
  if (Math.abs(a - b) > tol) {
    throw new Error(`expected ${a} ~ ${b} (rtol ${rtol}, atol ${atol})`);
  }
}

const golden = G('stim_cases.json');
const P = golden.params;

describe('frac geometry', () => {
  test('plane strain modulus and the PKN hand case', () => {
    const ep = planeStrainModulus({ ePa: 2.5e10, nu: 0.28 });
    expectClose(ep, 2.7126736e10, 1e-6);
    const g = fracGeometry({
      model: 'pkn', qiM3s: 0.053, muPaS: 0.2, xfM: 150, hfM: 30, ePrimePa: ep,
    });
    expectClose(g.wMaxM, 6.392e-3, 0, 5e-6); // oracle self-assert twin
    expectClose(g.wAvgM, (Math.PI / 5) * g.wMaxM, 1e-12);
    expectClose(g.pNetPa, (ep * g.wMaxM) / (2 * 30), 1e-12);
  });

  test('width grows as xf^(1/4) (PKN) and the KGD compliance differs', () => {
    const args = { model: 'pkn', qiM3s: 0.053, muPaS: 0.2, hfM: 30, ePrimePa: 2.7e10 };
    const w1 = fracGeometry({ ...args, xfM: 100 }).wMaxM;
    const w2 = fracGeometry({ ...args, xfM: 1600 }).wMaxM;
    expectClose(w2 / w1, 2, 1e-9); // (16)^(1/4)
    const kgd = fracGeometry({ ...args, model: 'kgd', xfM: 150 });
    expectClose(kgd.pNetPa, (2.7e10 * kgd.wMaxM) / (4 * 150), 1e-12);
    expect(FRAC_MODELS).toEqual(['pkn', 'kgd']);
    expect(() => fracGeometry({ ...args, model: 'p3d', xfM: 100 })).toThrow(/Unknown/);
  });

  test('closure passthrough gives bottomhole treating pressure', () => {
    const g = fracGeometry({
      model: 'pkn', qiM3s: 0.05, muPaS: 0.1, xfM: 100, hfM: 25,
      ePrimePa: 2.7e10, closurePa: 4e7,
    });
    expectClose(g.bhtpPa, 4e7 + g.pNetPa, 1e-12);
  });
});

describe('Nolte material balance + schedule', () => {
  const geo = { qiM3s: 0.053, hfM: 30, xfM: 150, wAvgM: 4.0e-3 };

  test('no-leakoff limit is exact', () => {
    const b = pumpTime({ ...geo, clMSqrtS: 0 });
    expect(b.etaFrac).toBe(1);
    expectClose(b.tiS, (2 * 150 * 30 * 4.0e-3) / 0.053, 1e-12);
  });

  test('material balance residual vanishes at the solution', () => {
    const b = pumpTime({ ...geo, clMSqrtS: 1e-4 });
    const leakArea = 2 * (2 * geo.xfM * geo.hfM);
    const residual = geo.qiM3s * b.tiS - b.vfM3
      - noltekL(b.etaFrac) * 1e-4 * leakArea * Math.sqrt(b.tiS);
    expectClose(residual, 0, 0, 1e-6);
    const worse = pumpTime({ ...geo, clMSqrtS: 3e-4 });
    expect(worse.etaFrac).toBeLessThan(b.etaFrac);
  });

  test('pad fraction, ramp mass closed form and end concentration', () => {
    const sch = pumpSchedule({ tiS: 3600, etaFrac: 0.4, qiM3s: 0.05, cEojKgM3: 700, nSteps: 10 });
    const eps = (1 - 0.4) / (1 + 0.4);
    expectClose(sch.padFrac, eps, 1e-12);
    expectClose(sch.massKg, (700 * 0.05 * sch.rampS) / (1 + eps), 1e-12);
    // Fine trapezoid over tau^eps agrees with the closed form.
    const n = 20000;
    let trap = 0;
    for (let i = 0; i < n; i += 1) {
      trap += (((i / n) ** eps) + (((i + 1) / n) ** eps)) / 2 / n;
    }
    expectClose(700 * 0.05 * sch.rampS * trap, sch.massKg, 1e-4);
    expectClose(sch.steps[sch.steps.length - 1].cKgM3, 700 * (0.95 ** eps), 1e-9);
  });
});

describe('proppant pack + productivity', () => {
  test('catalog interp: inside, clamped, flagged', () => {
    const isp = PROPPANT_CATALOG.find((r) => r.name.includes('ISP'));
    const mid = packPermeabilityM2(isp, 5 * KPSI);
    expect(mid.clamped).toBe(false);
    expect(mid.kM2 / DARCY).toBeGreaterThan(120);
    expect(mid.kM2 / DARCY).toBeLessThan(180);
    const lo = packPermeabilityM2(isp, 1 * KPSI);
    expect(lo.clamped).toBe(true);
    expectClose(lo.kM2 / DARCY, 250, 1e-9);
    for (const r of PROPPANT_CATALOG) expect(r.approx).toBe(true);
  });

  test('Cinco-Ley hand value, limit and optimum marker', () => {
    const mk = (cfd) => fracProductivity({
      kfwM3: cfd * 1e-15 * 150, kM2: 1e-15, xfM: 150, rwM: 0.108,
    });
    expectClose(mk(1.6).f, 1.3841, 0, 1e-3);
    expectClose(mk(1000).f, Math.log(2), 0.05);
    expect(mk(10).sF).toBeLessThan(mk(1).sF);
    expect(mk(1.6).cfdOptimum).toBe(CFD_OPTIMUM);
    expect(mk(0.01).warnings.length).toBeGreaterThan(0);
    expect(mk(1.6).warnings).toHaveLength(0);
  });

  test('propped width bookkeeping', () => {
    const p = proppedFrac({
      massKg: 30000, xfM: 150, hfM: 30, rhoKgM3: 3270,
      packPorosity: 0.35, kfM2: 130 * DARCY, damageFactor: 0.5,
    });
    expectClose(p.arealKgM2, 30000 / (2 * 150 * 30), 1e-12);
    expectClose(p.wpM, p.arealKgM2 / (3270 * 0.65), 1e-12);
    expectClose(p.kfwM3, 130 * DARCY * p.wpM * 0.5, 1e-12);
  });
});

describe('acidizing', () => {
  test('Hawkins closed form and guards', () => {
    expectClose(hawkinsSkin({ kOverKs: 5, rsM: 0.5, rwM: 0.1 }), 4 * Math.log(5), 1e-12);
    expect(() => hawkinsSkin({ kOverKs: 0.5, rsM: 0.5, rwM: 0.1 })).toThrow(/>= 1/);
  });

  test('sandstone removal: partial vs complete', () => {
    const partial = sandstoneAcid({
      rwM: 0.1, raM: 0.3, hM: 20, porosity: 0.2, kOverKs: 5, rsM: 0.5,
    });
    expectClose(partial.sAfter, 4 * Math.log(0.5 / 0.3), 1e-12);
    expect(partial.removed).toBe(false);
    const full = sandstoneAcid({
      rwM: 0.1, raM: 0.6, hM: 20, porosity: 0.2, kOverKs: 5, rsM: 0.5,
    });
    expect(full.sAfter).toBe(0);
    expect(full.volumeM3).toBeGreaterThan(partial.volumeM3);
  });

  test('carbonate skin negative and volume-monotone', () => {
    const a = carbonateAcid({ rwM: 0.1, hM: 20, porosity: 0.2, volumeM3: 2 });
    const b = carbonateAcid({ rwM: 0.1, hM: 20, porosity: 0.2, volumeM3: 8 });
    expect(a.skin).toBeLessThan(0);
    expect(b.skin).toBeLessThan(a.skin);
  });

  test('max matrix rate Darcy identity', () => {
    const { qM3s } = maxMatrixRate({
      kM2: 1e-15, hM: 20, pFracPa: 4e7, pResPa: 3e7, muPaS: 1e-3,
      reM: 300, rwM: 0.108, sSkin: 2,
    });
    expectClose(qM3s, (2 * Math.PI * 1e-15 * 20 * 1e7) / (1e-3 * (Math.log(300 / 0.108) + 2)), 1e-12);
  });
});

describe('oracle golden agreement', () => {
  test('geometry, balance and schedule', () => {
    const ep = planeStrainModulus({ ePa: P.ePa, nu: P.nu });
    expectClose(ep, P.ePrimePa, 1e-9);
    for (const model of ['pkn', 'kgd']) {
      const g = fracGeometry({
        model, qiM3s: P.qiM3s, muPaS: P.muPaS, xfM: P.xfM, hfM: P.hfM,
        ePrimePa: ep, closurePa: P.closurePa,
      });
      const e = golden.geometry[model];
      expectClose(g.wMaxM, e.wMaxM, 1e-9, 1e-9);
      expectClose(g.wAvgM, e.wAvgM, 1e-9, 1e-9);
      expectClose(g.pNetPa, e.pNetPa, 1e-8);
      expectClose(g.bhtpPa, e.bhtpPa, 1e-9);
    }
    const wAvg = fracGeometry({
      model: 'pkn', qiM3s: P.qiM3s, muPaS: P.muPaS, xfM: P.xfM, hfM: P.hfM, ePrimePa: ep,
    }).wAvgM;
    const b = pumpTime({ qiM3s: P.qiM3s, hfM: P.hfM, xfM: P.xfM, wAvgM: wAvg, clMSqrtS: P.clMSqrtS });
    // Oracle solves the same balance by bisection: agree to the bisection width.
    expectClose(b.tiS, golden.balance.tiS, 1e-7);
    expectClose(b.etaFrac, golden.balance.etaFrac, 1e-7);
    const sch = pumpSchedule({
      tiS: b.tiS, etaFrac: b.etaFrac, qiM3s: P.qiM3s, cEojKgM3: P.cEojKgM3, nSteps: P.nSteps,
    });
    expectClose(sch.padFrac, golden.schedule.padFrac, 1e-7);
    expectClose(sch.massKg, golden.schedule.massKg, 1e-7);
    sch.steps.forEach((s, i) => {
      expectClose(s.cKgM3, golden.schedule.steps[i].cKgM3, 1e-7);
    });
  });

  test('proppant chain, productivity and acidizing', () => {
    const row = PROPPANT_CATALOG.find((r) => r.name === P.proppant.name);
    const { kM2, clamped } = packPermeabilityM2(row, P.closurePa);
    expect(clamped).toBe(false);
    expectClose(kM2 / DARCY, golden.proppantPack.kfDarcy, 1e-8);
    const prop = proppedFrac({
      massKg: golden.schedule.massKg, xfM: P.xfM, hfM: P.hfM,
      rhoKgM3: row.rhoKgM3, packPorosity: row.packPorosity,
      kfM2: kM2, damageFactor: P.damageFactor,
    });
    expectClose(prop.wpM, golden.proppantPack.wpM, 1e-7, 1e-9);
    expectClose(prop.kfwM3 / DARCY, golden.proppantPack.kfwDarcyM, 1e-7);
    const prod = fracProductivity({
      kfwM3: prop.kfwM3, kM2: P.kMd * 9.869233e-16, xfM: P.xfM, rwM: P.rwM,
    });
    expectClose(prod.cfd, golden.productivity.cfd, 1e-7);
    expectClose(prod.sF, golden.productivity.sF, 1e-7, 1e-9);
    expectClose(prod.rwPrimeM, golden.productivity.rwPrimeM, 1e-7);

    const a = P.acid;
    const sand = sandstoneAcid({
      rwM: P.rwM, raM: a.raM, hM: a.hM, porosity: a.porosity,
      pvFactor: P.pvFactor, kOverKs: a.kOverKs, rsM: a.rsM,
    });
    expectClose(sand.volumeM3, golden.acidizing.sandstone.volumeM3, 1e-9);
    expectClose(sand.sBefore, golden.acidizing.sandstone.sBefore, 1e-9);
    expectClose(sand.sAfter, golden.acidizing.sandstone.sAfter, 1e-9, 1e-12);
    const carb = carbonateAcid({
      rwM: P.rwM, hM: a.hM, porosity: a.porosity, volumeM3: a.volumeM3, pvBt: P.pvBt,
    });
    expectClose(carb.skin, golden.acidizing.carbonate.skin, 1e-9);
    const q = maxMatrixRate({
      kM2: P.kMd * 9.869233e-16, hM: a.hM, pFracPa: P.closurePa,
      pResPa: P.pResPa, muPaS: 1e-3, reM: P.reM, rwM: P.rwM,
      sSkin: sand.sBefore,
    });
    expectClose(q.qM3s, golden.acidizing.qMaxM3s, 1e-9, 1e-9);
  });
});
