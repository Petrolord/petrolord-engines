// Perforation & sand control (D8): Karakas-Tariq tables and closed forms,
// productivity ratio, underbalance bands, sieve statistics, Saucier
// gravel sizing, screen selection, advisor thresholds, sanding onset and
// oracle golden agreement.
import fs from 'fs';
import path from 'path';
import {
  KT_PHASING_TABLE, KT_PHASINGS_DEG, karakasTariq, productivityRatio,
  underbalanceAdvice, UNDERBALANCE_BANDS,
} from '../engines/drilling/perforation.js';
import {
  sieveStats, saucierGravel, screenSelection, sandControlAdvisor,
  sandingOnset, cdpAlongInterval, SAUCIER_RANGE, FINES_CUTOFF_M,
} from '../engines/drilling/sandControl.js';
import { GUN_CATALOG, GUN_CONVEYANCES } from '../engines/drilling/data/perforatingGuns.js';
import { GRAVEL_CATALOG, SCREEN_GAUGES_M, SCREEN_GAUGE_THOU } from '../engines/drilling/data/sandControlCatalog.js';

const G = (name) => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', name), 'utf8'));

const IN = 0.0254;
const UM = 1e-6;
const FT_PER_M = 3.280839895;

function expectClose(a, b, rtol, atol = 0) {
  if (!Number.isFinite(a)) throw new Error(`non-finite value ${a} (expected ~ ${b})`);
  const tol = atol + rtol * Math.abs(b);
  if (Math.abs(a - b) > tol) {
    throw new Error(`expected ${a} ~ ${b} (rtol ${rtol}, atol ${atol})`);
  }
}

const golden = G('perfsand_cases.json');

describe('Karakas-Tariq skin', () => {
  test('phasing table is complete and alpha-ordered', () => {
    expect(KT_PHASINGS_DEG).toEqual([0, 45, 60, 90, 120, 180]);
    // Denser phasing spreads flow better: alpha grows toward 45 deg.
    expect(KT_PHASING_TABLE[45].alpha).toBeGreaterThan(KT_PHASING_TABLE[90].alpha);
    expect(KT_PHASING_TABLE[90].alpha).toBeGreaterThan(KT_PHASING_TABLE[180].alpha);
  });

  test('hand-computed 90 deg case (oracle self-assert twin)', () => {
    const r = karakasTariq({
      lpM: 12 * IN, rpM: 0.25 * IN, spfPerM: 4 * FT_PER_M,
      phasingDeg: 90, rwM: 4.25 * IN,
    });
    expectClose(r.sH, -1.0210, 0, 2e-3);
    expectClose(r.sV, 0.4960, 0, 2e-3);
    expectClose(r.sWb, 0.0095, 0, 5e-4);
  });

  test('0 deg phasing collapses to the lp/4 effective radius', () => {
    const r = karakasTariq({
      lpM: 12 * IN, rpM: 0.25 * IN, spfPerM: 4 * FT_PER_M,
      phasingDeg: 0, rwM: 4.25 * IN,
    });
    expectClose(r.rwPrimeM, (12 * IN) / 4, 1e-12);
  });

  test('crushed zone: zero when undamaged, grows with damage, guards', () => {
    const args = {
      lpM: 12 * IN, rpM: 0.25 * IN, spfPerM: 4 * FT_PER_M,
      phasingDeg: 90, rwM: 4.25 * IN, rcM: 0.75 * IN,
    };
    expect(karakasTariq({ ...args, kOverKc: 1 }).sCz).toBe(0);
    expect(karakasTariq({ ...args, kOverKc: 5 }).sCz).toBeGreaterThan(0);
    expect(() => karakasTariq({ ...args, rcM: 0.1 * IN, kOverKc: 5 })).toThrow(/exceed/);
    expect(() => karakasTariq({ ...args, kOverKc: 0.5 })).toThrow(/>= 1/);
  });

  test('monotonicity: longer perfs and denser shots help', () => {
    const base = karakasTariq({
      lpM: 12 * IN, rpM: 0.25 * IN, spfPerM: 4 * FT_PER_M,
      phasingDeg: 90, rwM: 4.25 * IN,
    });
    const longer = karakasTariq({
      lpM: 24 * IN, rpM: 0.25 * IN, spfPerM: 4 * FT_PER_M,
      phasingDeg: 90, rwM: 4.25 * IN,
    });
    const denser = karakasTariq({
      lpM: 12 * IN, rpM: 0.25 * IN, spfPerM: 8 * FT_PER_M,
      phasingDeg: 90, rwM: 4.25 * IN,
    });
    expect(longer.total).toBeLessThan(base.total);
    expect(denser.sV).toBeLessThan(base.sV);
  });

  test('out-of-range dimensionless groups warn, never silently', () => {
    const r = karakasTariq({
      lpM: 0.05, rpM: 0.002, spfPerM: 1, phasingDeg: 90, rwM: 0.108,
    });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(() => karakasTariq({
      lpM: 12 * IN, rpM: 0.25 * IN, spfPerM: 4 * FT_PER_M,
      phasingDeg: 72, rwM: 4.25 * IN,
    })).toThrow(/18247/);
  });
});

describe('productivity ratio + underbalance', () => {
  test('zero skin is the openhole ideal; positive skin degrades', () => {
    expectClose(productivityRatio({ reM: 300, rwM: 0.108, sTotal: 0 }).ratio, 1, 1e-12);
    expect(productivityRatio({ reM: 300, rwM: 0.108, sTotal: 5 }).ratio).toBeLessThan(1);
    expect(() => productivityRatio({ reM: 300, rwM: 0.108, sTotal: -20 })).toThrow(/undefined/);
  });

  test('bands are ranges with provenance and step monotonically', () => {
    const hi = underbalanceAdvice({ kMd: 500, fluid: 'oil' });
    const lo = underbalanceAdvice({ kMd: 1, fluid: 'oil' });
    expect(hi.maxPa).toBeLessThan(lo.minPa + 1e-9 + lo.maxPa); // bands overlap-free ordering
    expect(hi.minPsi).toBeLessThan(lo.minPsi);
    expect(hi.approx).toBe(true);
    expect(hi.provenance).toMatch(/L15/);
    expect(UNDERBALANCE_BANDS).toHaveLength(3);
    expect(underbalanceAdvice({ kMd: 50, fluid: 'gas' }).minPsi)
      .toBeGreaterThan(underbalanceAdvice({ kMd: 50, fluid: 'oil' }).minPsi);
  });
});

describe('sieve statistics', () => {
  test('log-linear synthetic PSD gives exact percentiles', () => {
    const points = [];
    for (let c = 0; c <= 100; c += 10) {
      points.push({ sizeM: 1000 * UM * 10 ** (-2 * (c / 100)), cumRetainedPct: c });
    }
    const s = sieveStats(points);
    expectClose(s.d50M, 100 * UM, 1e-9);
    expectClose(s.d10M, 1000 * UM * 10 ** -0.2, 1e-9);
    expectClose(s.uniformity, 10, 1e-9);
  });

  test('guards: point count, ranges, monotonicity', () => {
    expect(() => sieveStats([{ sizeM: 1, cumRetainedPct: 1 }])).toThrow(/4 points/);
    expect(() => sieveStats([
      { sizeM: 100 * UM, cumRetainedPct: 10 },
      { sizeM: 200 * UM, cumRetainedPct: 40 }, // coarser while more retained
      { sizeM: 50 * UM, cumRetainedPct: 70 },
      { sizeM: 20 * UM, cumRetainedPct: 90 },
    ])).toThrow(/monotone/);
  });

  test('fines cutoff is the 44 micron convention', () => {
    expectClose(FINES_CUTOFF_M, 44e-6, 1e-12);
  });
});

describe('gravel + screens + advisor', () => {
  test('Saucier band and the catalog match the published spot case', () => {
    expect(SAUCIER_RANGE).toEqual([5, 6]);
    const r = saucierGravel({ d50M: 120 * UM });
    expectClose(r.bandMinM, 600 * UM, 1e-12);
    expectClose(r.bandMaxM, 720 * UM, 1e-12);
    expect(r.matches.map((m) => m.mesh)).toContain('20/40');
  });

  test('gravel-pack gauge sits below the smallest gravel grain', () => {
    const g2040 = GRAVEL_CATALOG.find((g) => g.mesh === '20/40');
    const s = screenSelection({ mode: 'gravel-pack', gravel: g2040 });
    expectClose(s.gaugeM, 16 * 25.4e-6, 1e-12);
    expect(s.gaugeM).toBeLessThan(g2040.minM);
  });

  test('standalone screen uses the D10 window', () => {
    const s = screenSelection({ mode: 'standalone', stats: { d10M: 300 * UM } });
    expectClose(s.slotMinM, 300 * UM, 1e-12);
    expectClose(s.slotMaxM, 600 * UM, 1e-12);
  });

  test('advisor walks the threshold ladder in order', () => {
    expect(sandControlAdvisor({ uniformity: 2, finesPct: 1 }).indication).toMatch(/wire-wrap/);
    expect(sandControlAdvisor({ uniformity: 4, finesPct: 4 }).indication).toMatch(/premium/);
    expect(sandControlAdvisor({ uniformity: 4, finesPct: 9 }).indication).toBe('gravel pack');
    expect(sandControlAdvisor({ uniformity: 8, finesPct: 15 }).indication).toMatch(/frac-pack/);
    expect(sandControlAdvisor({ uniformity: null, finesPct: null }).indication).toMatch(/insufficient/);
  });

  test('catalogs are ordered and marked approx', () => {
    for (const g of GRAVEL_CATALOG) {
      expect(g.minM).toBeLessThan(g.maxM);
      expect(g.approx).toBe(true);
    }
    expect(SCREEN_GAUGES_M).toHaveLength(SCREEN_GAUGE_THOU.length);
    for (const gun of GUN_CATALOG) {
      expect(GUN_CONVEYANCES).toContain(gun.conveyance);
      expect(gun.approx).toBe(true);
      expect([0, 45, 60, 90, 120, 180]).toContain(gun.phasingDeg);
    }
  });
});

describe('sanding onset', () => {
  test('closed form and guards', () => {
    const { pwfCritPa } = sandingOnset({ s1Pa: 60e6, s2Pa: 45e6, ucsPa: 40e6 });
    expectClose(pwfCritPa, (3 * 60e6 - 45e6 - 40e6) / 2, 1e-12);
    expect(() => sandingOnset({ s1Pa: 1, s2Pa: 2, ucsPa: 1 })).toThrow(/S1 >= S2/);
    // Weaker rock -> lower critical flowing pressure margin.
    const weak = sandingOnset({ s1Pa: 60e6, s2Pa: 45e6, ucsPa: 20e6 });
    expect(weak.pwfCritPa).toBeGreaterThan(pwfCritPa);
  });
});

describe('oracle golden agreement', () => {
  const p = golden.params;

  test('gun skins and productivity ratios', () => {
    for (const c of golden.guns) {
      const kt = karakasTariq({
        lpM: c.inputs.lpM, rpM: c.inputs.rpM, spfPerM: c.inputs.spfPerM,
        phasingDeg: c.inputs.phasingDeg, rwM: c.inputs.rwM,
        khOverKv: c.inputs.khOverKv, rcM: c.inputs.rcM, kOverKc: c.inputs.kOverKc,
      });
      for (const k of ['sH', 'sV', 'sWb', 'sCz', 'total']) {
        expectClose(kt[k], c.expected.skin[k], 1e-9, 1e-9);
      }
      const pr = productivityRatio({ reM: p.reM, rwM: c.inputs.rwM, sTotal: kt.total });
      expectClose(pr.ratio, c.expected.pr.ratio, 1e-9);
    }
  });

  test('underbalance bands', () => {
    for (const fluid of ['oil', 'gas']) {
      const adv = underbalanceAdvice({ kMd: golden.underbalance.inputs.kMd, fluid });
      expectClose(adv.minPa, golden.underbalance[fluid].minPa, 1e-9);
      expectClose(adv.maxPa, golden.underbalance[fluid].maxPa, 1e-9);
    }
  });

  test('sieve statistics, gravel, gauge and advisor', () => {
    const s = sieveStats(golden.sieve.points);
    for (const k of ['d10M', 'd40M', 'd50M', 'd70M', 'd90M', 'd95M']) {
      expectClose(s[k], golden.sieve.expected[k], 1e-9, 1e-9);
    }
    expectClose(s.uniformity, golden.sieve.expected.uniformity, 1e-9);
    expectClose(s.finesPct, golden.sieve.expected.finesPct, 1e-9);

    const sauc = saucierGravel({ d50M: s.d50M });
    expect(sauc.matches.map((m) => m.mesh)).toEqual(golden.gravel.expected.matches);
    const gauge = screenSelection({ mode: 'gravel-pack', gravel: sauc.matches[0] });
    expectClose(gauge.gaugeM, golden.gravel.screenGaugeThou * 25.4e-6, 1e-12);
    expect(sandControlAdvisor(s).indication).toBe(golden.gravel.advisorIndication);
  });

  test('CDP sweep over the slant interval, both geometries', () => {
    const curves = {
      tvdM: golden.profile.tvdM, svPa: golden.profile.svPa,
      shmaxPa: golden.profile.shmaxPa, shminPa: golden.profile.shminPa,
      ppPa: golden.profile.ppPa, ucsPa: golden.profile.ucsPa,
    };
    for (const geometry of ['perf-tunnel', 'openhole']) {
      const res = cdpAlongInterval({
        stations: golden.stations, curves,
        topMdM: p.interval.topMdM, bottomMdM: p.interval.bottomMdM,
        geometry, boostFactor: p.boostFactor, stepMdM: p.stepMdM,
      });
      const exp = golden.sanding.cdp[geometry];
      expect(res.rows).toHaveLength(exp.rows.length);
      res.rows.forEach((row, i) => {
        expectClose(row.tvdM, exp.rows[i].tvdM, 1e-9);
        expectClose(row.pwfCritPa, exp.rows[i].pwfCritPa, 1e-9);
        expectClose(row.cdpPa, exp.rows[i].cdpPa, 1e-9);
      });
      expectClose(res.governing.cdpPa, exp.governing.cdpPa, 1e-9);
      expectClose(res.governing.mdM, exp.governing.mdM, 1e-9);
    }
    const fx = golden.sanding.fixture;
    expectClose(sandingOnset({
      s1Pa: fx.inputs.s1Pa, s2Pa: fx.inputs.s2Pa,
      ucsPa: fx.inputs.ucsPa, boostFactor: fx.inputs.boostFactor,
    }).pwfCritPa, fx.expected.pwfCritPa, 1e-9);
  });
});
