// PT9d: Rw from NaCl salinity (Bateman & Konen 1977 fit to Gen-9) and
// its inverse against the oracle's analytic cases and chart anchors.

import fs from 'fs';
import path from 'path';
import { rwFromSalinity, salinityFromRw, rwArps } from '../engines/petrophysics/rw';

const analytic = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'petrophysics', 'analytic_cases.json'), 'utf8'));
const close = (a, b) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));

test('matches the oracle analytic cases at 1e-12', () => {
  expect(close(rwFromSalinity(30000, 75), analytic.rw_salinity_30000_75f.out)).toBe(true);
  expect(close(rwFromSalinity(100000, 150), analytic.rw_salinity_100000_150f.out)).toBe(true);
  expect(close(salinityFromRw(rwFromSalinity(30000, 120), 120), analytic.salinity_from_rw_roundtrip.out)).toBe(true);
});

test('sits within 10 percent of the Gen-9 chart at 75 degF and inverts exactly', () => {
  for (const [ppm, chart] of [[10000, 0.55], [30000, 0.20], [100000, 0.07]]) {
    const rw = rwFromSalinity(ppm, 75);
    expect(Math.abs(rw - chart) / chart).toBeLessThan(0.10);
    expect(Math.abs(salinityFromRw(rw, 75) - ppm) / ppm).toBeLessThan(1e-9);
  }
});

test('temperature enters through Arps only; invalid inputs are NaN', () => {
  const rw75 = rwFromSalinity(50000, 75);
  expect(close(rwFromSalinity(50000, 200), rwArps(rw75, 75, 200))).toBe(true);
  expect(Number.isNaN(rwFromSalinity(0, 75))).toBe(true);
  expect(Number.isNaN(rwFromSalinity(-5, 75))).toBe(true);
  expect(Number.isNaN(salinityFromRw(0.01, 75))).toBe(true); // below the fit floor
});

// ---------------------------------------------------------------------
// PT11a: Bateman & Konen (1977) Rwe -> Rw (chart SP-2 fit), its inverse,
// the Rmf -> Rmfe step and the whole SP chain.
// ---------------------------------------------------------------------
import {
  rweToRw, rwToRwe, rmfeFromRmf, rwFromSsp, rweToRwProblem, rwToRweProblem, rweBand, RWE_TO_RW_DOMAIN, rweFromSsp, spK,
} from '../engines/petrophysics/rw';
import { swArchie } from '../engines/petrophysics/sw';

const DATA = path.join(__dirname, '..', 'test-data', 'petrophysics');
const chart = JSON.parse(fs.readFileSync(path.join(DATA, 'chart_points.json'), 'utf8'));
const typewell = JSON.parse(fs.readFileSync(path.join(DATA, 'typewell.json'), 'utf8'));
const goldens = JSON.parse(fs.readFileSync(path.join(DATA, 'goldens.json'), 'utf8'));

describe('PT11a Bateman-Konen', () => {
  test("gate 1: the owner's check point, T = 150 degF, Rwe = 0.050 -> Rw = 0.0564", () => {
    expect(rweToRw(0.05, 150)).toBeCloseTo(0.0564, 4);
    // A and B individually
    const a = 0.131 * 10 ** (1 / Math.log10(150 / 19.9) - 2);
    const b = 10 ** (0.0426 / Math.log10(150 / 50.8));
    expect(a).toBeCloseTo(0.0181, 4);
    expect(b).toBeCloseTo(1.232, 3);
  });

  const rawFit = (rwe, t) => {
    const a = 0.131 * 10 ** (1 / Math.log10(t / 19.9) - 2);
    const b = 10 ** (0.0426 / Math.log10(t / 50.8));
    return (rwe + a) / (b - 0.5 * rwe);
  };

  test('gate 2: chart SP-2 readings, accepted points bracketed, refuted points refused (in-band acceptance pending until read)', () => {
    const pts = chart.points;
    expect(pts.length).toBeGreaterThanOrEqual(6);
    expect(chart.chart_temp_f_range).toEqual([RWE_TO_RW_DOMAIN.chartTempFMin, RWE_TO_RW_DOMAIN.tempFMax]);
    const temps = new Set(pts.map((p) => p.temp_f));
    expect(temps.size).toBeGreaterThanOrEqual(2);
    expect(temps.has(75)).toBe(true);
    let accepted = 0;
    let refuted = 0;
    for (const p of pts) {
      // the chart's correction is upward everywhere it was read
      expect(p.rw).toBeGreaterThan(p.rwe);
      const rw = rweToRw(p.rwe, p.temp_f);
      const band = rweBand(p.temp_f);
      const inBand = p.rwe >= band.lo && p.rwe <= band.hi;
      if (inBand) {
        accepted += 1;
        expect(Number.isFinite(rw)).toBe(true);
        expect(Math.abs(rw - p.rw) / p.rw).toBeLessThanOrEqual(p.precision);
      } else {
        // outside the band the engine refuses with a reason
        expect(Number.isNaN(rw)).toBe(true);
        expect(typeof rweToRwProblem(p.rwe, p.temp_f)).toBe('string');
        if (Math.abs(rawFit(p.rwe, p.temp_f) - p.rw) / p.rw > p.precision) refuted += 1;
      }
    }
    // the readings refute the raw fit on both sides of the band (2026-09-10: 28 fresh, 3 saline)
    expect(refuted).toBeGreaterThanOrEqual(28);
    expect(pts.filter((p) => p.band === 'fresh').every((p) => rawFit(p.rwe, p.temp_f) < 0.65 * p.rw)).toBe(true);
    expect(pts.filter((p) => p.band === 'saline').every((p) => rawFit(p.rwe, p.temp_f) > 1.1 * p.rw)).toBe(true);
    if (!accepted) {
      // eslint-disable-next-line no-console
      console.warn(`PT11a chart_points.json: ${pts.length} readings, all outside the accepted band and all refused; acceptance of rweToRw INSIDE the band (Rwe ${RWE_TO_RW_DOMAIN.rweMin75F} at 75 degF .. ${RWE_TO_RW_DOMAIN.rweMax} ohm.m) is PENDING until the chart is read there.`);
    }
  });

  test('gate 3: oracle agreement at 1e-12 (forward, inverse, Rmfe) incl. the refusals it records', () => {
    expect(close(rweToRw(0.05, 150), analytic.bk_check_point_150f.out)).toBe(true);
    expect(close(rweToRw(0.10, 150), analytic.bk_band_edge_150f.out)).toBe(true);
    expect(close(rweToRw(0.02, 75), analytic.bk_band_floor_75f.out)).toBe(true);
    expect(analytic.bk_fresh_band_150f.out).toBeNull();
    expect(Number.isNaN(rweToRw(0.30, 150))).toBe(true);
    expect(analytic.bk_75f_0p3.out).toBeNull();
    expect(Number.isNaN(rweToRw(0.30, 75))).toBe(true);
    expect(close(rweToRw(rwToRwe(0.06, 200), 200), analytic.bk_inverse_roundtrip.out)).toBe(true);
    expect(close(rmfeFromRmf(0.5, 75, 150).rmfe, analytic.bk_rmfe_x085.out)).toBe(true);
    expect(close(rmfeFromRmf(0.05, 75, 150).rmfe, analytic.bk_rmfe_inverse.out)).toBe(true);
  });

  test('gate 4: inverse round trip across the accepted band at three temperatures', () => {
    for (const t of [75, 150, 250]) {
      const { lo, hi } = rweBand(t);
      for (const f of [0, 0.1, 0.3, 0.5, 0.8, 1]) {
        const x = lo + f * (hi - lo);
        expect(close(rwToRwe(rweToRw(x, t), t), x)).toBe(true);
      }
    }
    expect(rweBand(75)).toEqual({ lo: 0.02, hi: 0.1 });
    expect(close(rweBand(150).lo, 0.02 * (75 + 6.77) / (150 + 6.77))).toBe(true);
    expect(rweBand(60)).toBeNull();
  });

  test('gate 5: inside the band the correction is upward and modest; the chart says it is large and upward beyond it', () => {
    // pinned numbers at 150 degF: +12.8 percent at the check point, under 1 percent at the band edge (within 2 percent at every temperature)
    expect(rweToRw(0.05, 150) / 0.05).toBeCloseTo(1.128, 2);
    expect(Math.abs(rweToRw(0.10, 150) / 0.10 - 1)).toBeLessThan(0.01);
    for (const t of [75, 150, 300, 500]) {
      const { lo, hi } = rweBand(t);
      for (const x of [lo, (lo + hi) / 2, hi]) expect(rweToRw(x, t)).toBeGreaterThanOrEqual(x * 0.98);
    }
    // the fresh band is refused, not corrected downward: the raw fit would give 0.294 at 150 degF/0.30
    expect(Number.isNaN(rweToRw(0.30, 150))).toBe(true);
    expect(rawFit(0.30, 150)).toBeLessThan(0.30);
    // and the chart itself puts Rw = 1.0 ohm.m at Rweq 0.53 at 150 degF (an 89 percent upward correction)
    const p = chart.points.find((q) => q.rw === 1 && q.temp_f === 150);
    expect(p.rwe).toBeCloseTo(0.53, 3);
  });

  test('gate 6: refusals are NaN and the problem sentence names the limit', () => {
    const t = 150;
    const b = 10 ** (0.0426 / Math.log10(t / 50.8));
    expect(Number.isNaN(rweToRw(2 * b, t))).toBe(true);          // denominator zero (also beyond the band)
    expect(Number.isNaN(rweToRw(2 * b + 0.5, t))).toBe(true);    // denominator negative
    expect(rweToRwProblem(2 * b + 0.5, t)).toMatch(/beyond the chart/);
    expect(rweToRwProblem(0.3, t)).toMatch(/beyond the chart band.*too fresh/);
    expect(Number.isNaN(rweToRw(0.005, t))).toBe(true);          // nearer saturation than the band
    expect(rweToRwProblem(0.005, t)).toMatch(/saturation/);
    expect(Number.isNaN(rweToRw(0.05, 50.8))).toBe(true);        // T at the log's zero
    expect(Number.isNaN(rweToRw(0.05, 40))).toBe(true);
    expect(rweToRwProblem(0.05, 40)).toMatch(/50\.8/);
    expect(Number.isNaN(rweToRw(0.05, 60))).toBe(true);          // below the chart's printed range
    expect(rweToRwProblem(0.05, 60)).toMatch(/starts at 75/);
    expect(Number.isNaN(rweToRw(0.05, 500))).toBe(false);        // the printed top is inside
    expect(Number.isNaN(rweToRw(0.05, 501))).toBe(true);
    expect(rweToRwProblem(0.05, 501)).toMatch(/stops at 500/);
    expect(Number.isNaN(rweToRw(0, t))).toBe(true);
    expect(Number.isNaN(rweToRw(-0.1, t))).toBe(true);
    expect(rweToRwProblem(-0.1, t)).toMatch(/positive/);
    expect(Number.isNaN(rwToRwe(0.001, t))).toBe(true);          // inverse not positive
    expect(rwToRweProblem(0.001, t)).toMatch(/floor/);
    expect(Number.isNaN(rwToRwe(1.0, t))).toBe(true);            // inverse lands beyond the band
    expect(rwToRweProblem(1.0, t)).toMatch(/Rmfe.*beyond the chart band/);
    expect(rwToRweProblem(0.05, t)).toBeNull();
    expect(rweToRwProblem(0.05, t)).toBeNull();
    expect(RWE_TO_RW_DOMAIN.tempFMin).toBe(50.8);
    expect(RWE_TO_RW_DOMAIN.chartTempFMin).toBe(75);
    expect(RWE_TO_RW_DOMAIN.tempFMax).toBe(500);
    expect(RWE_TO_RW_DOMAIN.rweMax).toBe(0.1);
    expect(RWE_TO_RW_DOMAIN.rweMin75F).toBe(0.02);
  });

  test('gate 7: the 0.85 rule boundary at Rmf(75 degF) = 0.1, both sides pinned', () => {
    expect(rmfeFromRmf(0.1, 75, 150).rule).toBe('chart-inverse');
    expect(rmfeFromRmf(0.1000001, 75, 150).rule).toBe('x0.85');
    // the rule tests Rmf at 75 degF even when measured elsewhere
    const rmfAt150 = 0.1 * (75 + 6.77) / (150 + 6.77);
    expect(rmfeFromRmf(rmfAt150, 150, 150).rule).toBe('chart-inverse');
    expect(rmfeFromRmf(rmfAt150 * 1.01, 150, 150).rule).toBe('x0.85');
    expect(close(rmfeFromRmf(0.5, 75, 150).rmfe, 0.85 * 0.5 * (75 + 6.77) / (150 + 6.77))).toBe(true);
  });

  test('gate 8: type well direction, the corrected Rw reproduces the golden Sw and the uncorrected Rwe sits below it', () => {
    const c = analytic.sp_chain_typewell;
    const out = rwFromSsp(c.in.ssp_mv, c.in.rmf, c.in.rmf_t_f, c.in.t_f);
    expect(out.rmfeRule).toBe(c.rule);
    expect(close(out.rmfe, c.rmfe)).toBe(true);
    expect(close(out.rwe, c.rwe)).toBe(true);
    expect(close(out.rw, typewell.params.rw)).toBe(true);
    expect(close(out.k, spK(c.in.t_f))).toBe(true);
    // direction from the golden, not assumed
    const sign = Math.sign(out.rw - out.rwe);
    expect(sign).toBe(1);
    const P = typewell.params;
    const i = 30; // inside SAND_A (2010-2030 m), clean
    expect(typewell.construction.shale_fraction[i]).toBeLessThan(0.01);
    const phi = goldens.PHID[i];
    const rt = typewell.curves.RT[i];
    const swCorrected = swArchie(rt, phi, out.rw, P.a, P.m, P.n);
    const swUncorrected = swArchie(rt, phi, out.rwe, P.a, P.m, P.n);
    expect(close(swCorrected, goldens.SW_ARCHIE[i])).toBe(true);
    expect(Math.sign(swCorrected - swUncorrected)).toBe(sign);
  });

  test('gate 9: the chain runs at formation temperature and rweFromSsp is unchanged', () => {
    const t = 150;
    const { rmfe } = rmfeFromRmf(0.5, 75, t);
    expect(close(rwFromSsp(-100, 0.5, 75, t).rwe, rweFromSsp(-100, rmfe, t))).toBe(true);
    expect(close(rweFromSsp(-100, 0.5, 150), analytic.sp_quicklook.out)).toBe(true);
  });
});
