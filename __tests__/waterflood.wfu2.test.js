// Waterflood Design Studio upgrade, Step 2 (WF-U2-002, Suite
// docs/upgrade/WaterfloodDesignStudio-UPGRADE.md): line drive patterns.
// Every gate calls the engine; each block carries its negative control.
//
// Source (read in full): T. Ahmed, Reservoir Engineering Handbook, 3rd ed.
// (2006), ch. 14 "Principles of Waterflooding":
//   - eq. 14-61 the mobility ratio of the areal sweep methods,
//     M = (krw at the average saturation behind the front at breakthrough /
//     muw) / (kro at Swi / muo) (Craig's basis);
//   - eq. 14-64 Willhite's regression of Craig's five-spot EA at breakthrough;
//   - eq. 14-67 and its table: Fassihi (1986) regression of the Dyes, Caudle
//     and Erickson (1954) charts, EA = 1 / (1 + A),
//     A = [a1 ln(M + a2) + a3] fw + a4 ln(M + a5) + a6, coefficients for the
//     five-spot, the direct line drive and the staggered line drive;
//   - Example 14-11 (from Craig 1971, p. 116): a five-spot with M = 0.8,
//     EA at breakthrough 0.71702, WiBT = 310,320 x 0.463 x 0.71702 =
//     103,020 bbl, breakthrough at 383 days at 269 bbl/d.
//
//   1. Example 14-11 through forecastPattern (the five-spot path and Craig's M).
//   2. The Fassihi coefficient table as printed, and its five-spot member
//      against Willhite's regression and Example 14-11.
//   3. Line drive forecasts: EA at breakthrough from Fassihi at fw = 0, the
//      sweep after breakthrough solved against the producing water cut,
//      material balance, ordering of the patterns.
import { analyzeDisplacement } from '../engines/scal/fractionalFlow.js';
import {
  forecastPattern, arealSweepAtBreakthrough, arealSweepMobilityRatio,
  FASSIHI_COEFFICIENTS, fassihiArealSweep, PATTERN_TYPES,
} from '../engines/waterflood/patternForecast.js';

// Example 14-11 relative permeability (Ahmed p. 1004; Craig 1971 p. 116)
const EX = {
  krSpec: {
    type: 'table',
    rows: [
      { Sw: 0.10, kro: 1.000, krw: 0.000 },
      { Sw: 0.30, kro: 0.373, krw: 0.070 },
      { Sw: 0.40, kro: 0.210, krw: 0.169 },
      { Sw: 0.45, kro: 0.148, krw: 0.226 },
      { Sw: 0.50, kro: 0.100, krw: 0.300 },
      { Sw: 0.55, kro: 0.061, krw: 0.376 },
      { Sw: 0.60, kro: 0.033, krw: 0.476 },
      { Sw: 0.65, kro: 0.012, krw: 0.600 },
      { Sw: 0.70, kro: 0.000, krw: 0.740 },
    ],
  },
  muW: 0.5,
  muO: 1.0,
};
const EX_PATTERN = { area_acres: 40, h_ft: 5, phi: 0.20, Bo: 1.20, Bw: 1.0, iw_bpd: 269, Sgi: 0, EV: 1, worLimit: 100, maxYears: 30, stepDays: 1 };

describe('1. Ahmed Example 14-11 (Craig 1971 p. 116) through the engine', () => {
  const d = analyzeDisplacement(EX);
  const m = arealSweepMobilityRatio(EX, d, 'craig');
  const f = forecastPattern({ displacementSpec: EX, pattern: { ...EX_PATTERN, mobilityBasis: 'craig' } });

  it("Craig's M is 0.8 as printed (krw 0.40 at SwBT 0.563, kro 1.0 at Swi)", () => {
    // the book reads SwBT = 0.563 and krw = 0.40 off its plots; the engine's
    // Welge tangent on the linearly interpolated table lands within 1 percent
    expect(d.bl.SwAvgBt).toBeGreaterThan(0.555);
    expect(d.bl.SwAvgBt).toBeLessThan(0.571);
    expect(m.M_craig).toBeGreaterThan(0.79);
    expect(m.M_craig).toBeLessThan(0.82);
  });

  it('EA at breakthrough 0.717 (book 0.71702), WiBT 103,020 bbl and 383 days within 2 percent', () => {
    expect(arealSweepAtBreakthrough(0.8)).toBeCloseTo(0.71702, 3);
    expect(f.summary.EAbt).toBeGreaterThan(0.71702 * 0.99);
    expect(f.summary.EAbt).toBeLessThan(0.71702 * 1.01);
    expect(Math.abs(f.summary.WiBT_bbl / 103020 - 1)).toBeLessThan(0.02);
    expect(Math.abs(f.summary.breakthrough_days / 383 - 1)).toBeLessThan(0.02);
    // before breakthrough Np = Winj / Bo (the book: 103,020 / 1.2 = 85,850 STB at breakthrough)
    const bt = f.series.find((r) => r.t_days >= f.summary.breakthrough_days - 1);
    expect(Math.abs(bt.Np_stb / 85850 - 1)).toBeLessThan(0.02);
  });

  it('negative control: the endpoint M (krw at Sor) misses the printed EA at breakthrough', () => {
    const e = forecastPattern({ displacementSpec: EX, pattern: { ...EX_PATTERN, mobilityBasis: 'endpoint' } });
    expect(Math.abs(e.summary.EAbt - 0.71702)).toBeGreaterThan(0.05);
  });
});

describe('2. the Fassihi coefficient table (Ahmed eq. 14-67)', () => {
  it('holds the coefficients as printed', () => {
    expect(FASSIHI_COEFFICIENTS['five-spot']).toEqual([-0.2062, -0.0712, -0.511, 0.3048, 0.123, 0.4394]);
    expect(FASSIHI_COEFFICIENTS['direct-line']).toEqual([-0.3014, -0.1568, -0.9402, 0.3714, -0.0865, 0.8805]);
    expect(FASSIHI_COEFFICIENTS['staggered-line']).toEqual([-0.2077, -0.1059, -0.3526, 0.2608, 0.2444, 0.3158]);
    expect(PATTERN_TYPES).toEqual(['five-spot', 'direct-line', 'staggered-line']);
  });

  it('one value by hand: direct line drive, M = 2, fw = 0.5', () => {
    const A = (-0.3014 * Math.log(2 - 0.1568) - 0.9402) * 0.5 + 0.3714 * Math.log(2 - 0.0865) + 0.8805;
    expect(fassihiArealSweep('direct-line', 2, 0.5)).toBeCloseTo(1 / (1 + A), 14);
  });

  it('its five-spot member agrees with Willhite eq. 14-64 at breakthrough and with Example 14-11', () => {
    for (const M of [0.3, 0.5, 0.8, 1, 2, 4]) {
      expect(Math.abs(fassihiArealSweep('five-spot', M, 0) - arealSweepAtBreakthrough(M))).toBeLessThan(0.03);
    }
    expect(Math.abs(fassihiArealSweep('five-spot', 0.8, 0) - 0.71702)).toBeLessThan(0.015);
  });

  it('EA rises with the water cut and falls with M; staggered > five-spot > direct line at the same M', () => {
    for (const p of PATTERN_TYPES) {
      expect(fassihiArealSweep(p, 1, 0.9)).toBeGreaterThan(fassihiArealSweep(p, 1, 0.5));
      expect(fassihiArealSweep(p, 1, 0.5)).toBeGreaterThan(fassihiArealSweep(p, 1, 0));
      expect(fassihiArealSweep(p, 3, 0)).toBeLessThan(fassihiArealSweep(p, 0.5, 0));
    }
    for (const M of [0.5, 1, 2, 5]) {
      expect(fassihiArealSweep('staggered-line', M, 0)).toBeGreaterThan(fassihiArealSweep('five-spot', M, 0));
      expect(fassihiArealSweep('five-spot', M, 0)).toBeGreaterThan(fassihiArealSweep('direct-line', M, 0));
    }
    expect(fassihiArealSweep('direct-line', 1, 1)).toBeLessThanOrEqual(1);
  });
});

describe('3. line drive forecasts', () => {
  const run = (patternType) => forecastPattern({ displacementSpec: EX, pattern: { ...EX_PATTERN, stepDays: 30.4375, mobilityBasis: 'craig', patternType } });

  it('the default and an explicit five-spot are the same forecast (no number moves for saved projects)', () => {
    const a = forecastPattern({ displacementSpec: EX, pattern: { ...EX_PATTERN, mobilityBasis: 'craig' } });
    const b = forecastPattern({ displacementSpec: EX, pattern: { ...EX_PATTERN, mobilityBasis: 'craig', patternType: 'five-spot' } });
    expect(b.series).toEqual(a.series);
    expect(b.summary.patternType).toBe('five-spot');
  });

  it('EA at breakthrough of a line drive is Fassihi at fw = 0 with the same M', () => {
    for (const p of ['direct-line', 'staggered-line']) {
      const f = run(p);
      expect(f.summary.patternType).toBe(p);
      expect(f.summary.EAbt).toBeCloseTo(fassihiArealSweep(p, f.summary.M, 0), 14);
      expect(f.summary.arealSweepCorrelation).toMatch(/Fassihi/);
    }
  });

  it('after breakthrough EA solves EA = Fassihi(M, fw) with fw the producing reservoir water cut of that step', () => {
    const f = run('direct-line');
    const iw = EX_PATTERN.iw_bpd;
    let checked = 0;
    for (let i = 1; i < f.series.length; i += 1) {
      const r = f.series[i];
      if (r.Wi_bbl <= f.summary.WiBT_bbl || r.EA >= 1 - 1e-9) continue;
      const qoRb = r.qo_stbd * EX_PATTERN.Bo;
      const fw = 1 - qoRb / iw;
      const target = fassihiArealSweep('direct-line', f.summary.M, fw);
      if (r.EA > f.series[i - 1].EA + 1e-12) {
        expect(Math.abs(r.EA - target)).toBeLessThan(1e-6);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('closes material balance: Np = PV EA ED (1 - Swc) / Bo, water = injection less oil in reservoir barrels', () => {
    const f = run('staggered-line');
    const s = f.summary.recoverySplit;
    expect(s.product).toBeCloseTo(s.ER, 12);
    const last = f.series[f.series.length - 1];
    expect(last.qw_stbd * EX_PATTERN.Bw + last.qo_stbd * EX_PATTERN.Bo).toBeCloseTo(EX_PATTERN.iw_bpd, 6);
  });

  it('breaks through first in the direct line drive and last in the staggered line drive', () => {
    const t = Object.fromEntries(PATTERN_TYPES.map((p) => [p, run(p).summary.breakthrough_days]));
    expect(t['direct-line']).toBeLessThan(t['five-spot']);
    expect(t['five-spot']).toBeLessThan(t['staggered-line']);
  });

  it('refuses an unknown pattern by name', () => {
    const f = forecastPattern({ displacementSpec: EX, pattern: { ...EX_PATTERN, patternType: 'nine-spot' } });
    expect(f.series).toEqual([]);
    expect(f.warnings.join(' ')).toMatch(/Unknown pattern "nine-spot"/);
  });

  it('negative control: freezing EA at breakthrough after it (no Fassihi growth) breaks the fixed-point gate', () => {
    const f = run('direct-line');
    const frozen = f.series.map((r) => ({ ...r, EA: Math.min(r.EA, f.summary.EAbt) }));
    const iw = EX_PATTERN.iw_bpd;
    const misses = frozen.filter((r) => r.Wi_bbl > f.summary.WiBT_bbl * 1.5).filter((r) => {
      const fw = 1 - (r.qo_stbd * EX_PATTERN.Bo) / iw;
      return Math.abs(r.EA - fassihiArealSweep('direct-line', f.summary.M, fw)) > 1e-3;
    });
    expect(misses.length).toBeGreaterThan(0);
  });
});
