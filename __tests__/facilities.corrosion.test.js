// Facilities F6 corrosion gates against
// tools/validation/facilities/oracle_corrosion.py.
//
// Independent routes: the resistance-in-series combination is checked
// against a BISECTION SOLVE of 1/CR = 1/Vr + 1/Vm rather than the
// algebraic reciprocal formed here; the reaction and fugacity terms
// are recomputed in NATURAL logs against this module's log10 form, so
// a base slip in either shows; wall shear is re-derived through the
// Darcy factor against the Fanning form here; and the inhibitor
// time-average is recomputed as an explicit hour-by-hour duty cycle
// over a year.
//
// The predecessor Suite model had no velocity term at all -- just the
// nomogram equation times a flat 0.1 oil factor and a flat 0.2 scale
// factor. The gates below hold this one to responding to velocity and
// line size, and to the inhibitor arithmetic people get wrong.

import fs from 'fs';
import path from 'path';
import {
  co2FugacityCoefficient, co2Fugacity,
  dwmReactionRate, dwmMassTransferRate, scaleFactor, phFactor,
  corrosionRate, wallShearStressPa,
  SOUR_THRESHOLD_BAR, sourServiceRegion, corrosionRegime,
  remainingLife, rateCategory, screen,
} from '../engines/facilities/corrosion';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'facilities', 'goldens', 'corrosion_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

describe('fugacity and the de Waard-Milliams terms', () => {
  test('every term matches the natural-log oracle', () => {
    G.cases.forEach((row) => {
      const f = co2Fugacity(row);
      expect(rel(f.fugacityCoefficient, row.fugacityCoefficient)).toBeLessThan(1e-9);
      expect(rel(f.fco2Bar, row.fco2Bar)).toBeLessThan(1e-9);
      expect(rel(dwmReactionRate({ tC: row.tC, fco2Bar: f.fco2Bar }), row.reactionMmYr)).toBeLessThan(1e-9);
      expect(rel(dwmMassTransferRate({
        velocityMS: row.velocityMS, diameterM: row.diameterM, fco2Bar: f.fco2Bar,
      }), row.massTransferMmYr)).toBeLessThan(1e-9);
      expect(rel(scaleFactor({ tC: row.tC, fco2Bar: f.fco2Bar }), row.scaleFactor)).toBeLessThan(1e-9);
      expect(rel(phFactor({ ph: row.ph }), row.phFactor)).toBeLessThan(1e-9);
    });
  });

  test('the fugacity coefficient falls below one and caps at 250 bar', () => {
    expect(co2FugacityCoefficient({ tC: 60, pTotalBar: 1 })).toBeCloseTo(1, 2);
    expect(co2FugacityCoefficient({ tC: 60, pTotalBar: 200 })).toBeLessThan(1);
    // capped: beyond 250 bar the coefficient stops changing
    expect(co2FugacityCoefficient({ tC: 60, pTotalBar: 300 }))
      .toBeCloseTo(co2FugacityCoefficient({ tC: 60, pTotalBar: 250 }), 12);
    expect(co2Fugacity({ pTotalBar: 0, co2MolFrac: 0.03, tC: 60 }).error).toBeTruthy();
  });

  test('the scale factor turns protective when hot, which a naive Arrhenius misses', () => {
    const f = co2Fugacity({ tC: 60, pTotalBar: 50, co2MolFrac: 0.03 }).fco2Bar;
    // cool: no protective film, factor pinned at 1
    expect(scaleFactor({ tC: 40, fco2Bar: f })).toBe(1);
    // hot: siderite protects and the factor drops below 1
    expect(scaleFactor({ tC: 120, fco2Bar: f })).toBeLessThan(1);
    // and it keeps dropping with more heat
    expect(scaleFactor({ tC: 150, fco2Bar: f })).toBeLessThan(scaleFactor({ tC: 120, fco2Bar: f }));
  });
});

describe('the combined rate', () => {
  test('matches the bisection solve of the series resistance', () => {
    G.cases.forEach((row) => {
      const r = corrosionRate(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.combinedMmYr, row.combinedMmYr)).toBeLessThan(1e-6);
      expect(rel(r.uninhibitedMmYr, row.uninhibitedMmYr)).toBeLessThan(1e-6);
      expect(rel(r.rateMmYr, row.rateMmYr)).toBeLessThan(1e-6);
    });
  });

  test('the combined rate is below both contributions and names the controller', () => {
    const r = corrosionRate({
      tC: 60, pTotalBar: 50, co2MolFrac: 0.03, velocityMS: 3, diameterM: 0.15, ph: 4.5,
    });
    expect(r.combinedMmYr).toBeLessThan(r.reactionMmYr);
    expect(r.combinedMmYr).toBeLessThan(r.massTransferMmYr);
    expect(r.controlling).toBe('mass transfer');
    // slow the flow right down and kinetics take over
    const slow = corrosionRate({
      tC: 60, pTotalBar: 50, co2MolFrac: 0.03, velocityMS: 0.05, diameterM: 0.5, ph: 4.5,
    });
    expect(slow.controlling).toBe('mass transfer');
    expect(slow.rateMmYr).toBeLessThan(r.rateMmYr);
  });

  test('THE POINT: the same fluid in a bigger line corrodes less', () => {
    // the predecessor could not say this at all: it had no velocity
    // or diameter term, only flat multipliers
    const base = { tC: 60, pTotalBar: 50, co2MolFrac: 0.03, ph: 4.5, velocityMS: 3 };
    const small = corrosionRate({ ...base, diameterM: 0.1 });
    const big = corrosionRate({ ...base, diameterM: 0.4 });
    expect(big.rateMmYr).toBeLessThan(small.rateMmYr);
    // and faster flow in the same line corrodes more
    const fast = corrosionRate({ ...base, diameterM: 0.1, velocityMS: 9 });
    expect(fast.rateMmYr).toBeGreaterThan(small.rateMmYr);
  });

  test('an oil-wet line is not corroding, and that is a regime not a fudge', () => {
    const base = {
      tC: 60, pTotalBar: 50, co2MolFrac: 0.03, velocityMS: 3, diameterM: 0.15, ph: 4.5,
    };
    expect(corrosionRate({ ...base, flowRegime: 'oilWet' }).rateMmYr).toBe(0);
    const inter = corrosionRate({ ...base, flowRegime: 'intermittent', waterCutFrac: 0.3 });
    const wet = corrosionRate({ ...base, flowRegime: 'waterWet' });
    expect(inter.rateMmYr).toBeCloseTo(wet.rateMmYr * 0.3, 9);
  });

  test('no CO2 means nothing to predict, and it says so', () => {
    const r = corrosionRate({
      tC: 60, pTotalBar: 50, co2MolFrac: 0, velocityMS: 3, diameterM: 0.15, ph: 6,
    });
    expect(r.rateMmYr).toBe(0);
    expect(r.note).toMatch(/another mechanism/);
  });
});

describe('inhibitor efficiency versus availability', () => {
  test('the time-average matches an explicit annual duty cycle', () => {
    G.inhibitor.forEach((row) => {
      const r = corrosionRate({
        tC: 60, pTotalBar: 50, co2MolFrac: 0.03, velocityMS: 3, diameterM: 0.15, ph: 4.5,
        inhibitorEfficiencyPct: row.inhibitorEfficiencyPct,
        inhibitorAvailabilityPct: row.inhibitorAvailabilityPct,
      });
      // ratio to the uninhibited rate is what the duty cycle fixes
      const expectedRatio = row.rateMmYr / row.uninhibitedMmYr;
      expect(rel(r.rateMmYr / r.uninhibitedMmYr, expectedRatio)).toBeLessThan(1e-9);
    });
  });

  test('THE SURPRISE: a 95 percent inhibitor at 80 percent availability protects 76 percent', () => {
    const r = corrosionRate({
      tC: 60, pTotalBar: 50, co2MolFrac: 0.03, velocityMS: 3, diameterM: 0.15, ph: 4.5,
      inhibitorEfficiencyPct: 95, inhibitorAvailabilityPct: 80,
    });
    expect(r.effectiveInhibitionPct).toBeCloseTo(76, 0);
    expect(r.warning).toMatch(/availability, not efficiency/);
    // perfect availability gives the datasheet number
    const perfect = corrosionRate({
      tC: 60, pTotalBar: 50, co2MolFrac: 0.03, velocityMS: 3, diameterM: 0.15, ph: 4.5,
      inhibitorEfficiencyPct: 95, inhibitorAvailabilityPct: 100,
    });
    expect(perfect.effectiveInhibitionPct).toBeCloseTo(95, 6);
    expect(perfect.warning).toBeNull();
  });
});

describe('wall shear stress', () => {
  test('the Fanning form matches the Darcy re-derivation', () => {
    G.cases.forEach((row) => {
      const s = wallShearStressPa(row);
      expect(s.error).toBeUndefined();
      expect(rel(s.reynolds, row.reynolds)).toBeLessThan(1e-9);
      expect(rel(s.tauPa, row.tauPa)).toBeLessThan(1e-9);
    });
  });

  test('flags the shear that strips an inhibitor film', () => {
    const gentle = wallShearStressPa({
      velocityMS: 1, diameterM: 0.2, densityKgM3: 900, viscosityPaS: 1e-3,
    });
    expect(gentle.filmRisk).toBe('low');
    expect(gentle.warning).toBeNull();
    const harsh = wallShearStressPa({
      velocityMS: 15, diameterM: 0.1, densityKgM3: 950, viscosityPaS: 5e-4,
    });
    expect(harsh.tauPa).toBeGreaterThan(100);
    expect(harsh.filmRisk).toBe('high');
    expect(harsh.warning).toMatch(/stripped/);
    expect(wallShearStressPa({ velocityMS: 0, diameterM: 0.1 }).error).toBeTruthy();
  });
});

describe('sour service and the corrosion regime', () => {
  test('below the MR0175 threshold is not sour service', () => {
    const r = sourServiceRegion({ ph2sBar: SOUR_THRESHOLD_BAR * 0.5, ph: 4 });
    expect(r.sour).toBe(false);
    expect(r.region).toBe(0);
    expect(r.note).toMatch(/0.05 psi/);
  });

  test('severity rises with H2S AND falls with pH, not on H2S alone', () => {
    // the predecessor used a single H2S threshold, which misses this
    const highPh = sourServiceRegion({ ph2sBar: 1.0, ph: 6.5 });
    const lowPh = sourServiceRegion({ ph2sBar: 1.0, ph: 3.5 });
    expect(lowPh.region).toBeGreaterThan(highPh.region);
    expect(sourServiceRegion({ ph2sBar: 20, ph: 3.5 }).region).toBe(3);
    expect(sourServiceRegion({ ph2sBar: 20, ph: 3.5 }).materialGuidance).toMatch(/Do not extrapolate/);
    expect(sourServiceRegion({ ph2sBar: -1, ph: 4 }).error).toBeTruthy();
  });

  test('the H2S to CO2 ratio decides whether the CO2 model still applies', () => {
    expect(corrosionRegime({ ph2sBar: 0.001, pco2Bar: 1.5 }).regime).toBe('carbonate');
    expect(corrosionRegime({ ph2sBar: 0.03, pco2Bar: 1.5 }).regime).toBe('mixed');
    const sour = corrosionRegime({ ph2sBar: 0.5, pco2Bar: 1.5 });
    expect(sour.regime).toBe('sulphide');
    expect(sour.note).toMatch(/no longer describes/);
  });
});

describe('integrity: allowance and remaining life', () => {
  test('remaining life follows the allowance and flags a shortfall', () => {
    const ok = remainingLife({
      rateMmYr: 0.1, corrosionAllowanceMm: 3, designLifeYears: 20,
    });
    expect(ok.remainingYears).toBeCloseTo(30, 9);
    expect(ok.meetsDesignLife).toBe(true);
    expect(ok.shortfallMm).toBe(0);
    const short = remainingLife({
      rateMmYr: 0.3, corrosionAllowanceMm: 3, designLifeYears: 20,
    });
    expect(short.meetsDesignLife).toBe(false);
    expect(short.requiredAllowanceMm).toBeCloseTo(6, 9);
    expect(short.shortfallMm).toBeCloseTo(3, 9);
  });

  test('a consumed allowance becomes an inspection question, not a design one', () => {
    const r = remainingLife({ rateMmYr: 0.2, corrosionAllowanceMm: 3, consumedMm: 3.2 });
    expect(r.error).toMatch(/fitness-for-service/);
    expect(remainingLife({ rateMmYr: 0.2, corrosionAllowanceMm: 0 }).error).toBeTruthy();
  });

  test('a zero rate gives unbounded life', () => {
    expect(remainingLife({ rateMmYr: 0, corrosionAllowanceMm: 3 }).remainingYears).toBe(Infinity);
    expect(rateCategory(0)).toBe('negligible');
    expect(rateCategory(0.05)).toBe('low');
    expect(rateCategory(2)).toBe('severe');
  });
});

describe('the whole screen', () => {
  test('assembles rate, shear, sour region, regime and life together', () => {
    const s = screen({
      tC: 80, pTotalBar: 100, co2MolFrac: 0.02, h2sMolFrac: 0.001, ph: 5,
      velocityMS: 5, diameterM: 0.25, densityKgM3: 850, viscosityPaS: 8e-4,
      inhibitorEfficiencyPct: 90, inhibitorAvailabilityPct: 95,
      corrosionAllowanceMm: 3, designLifeYears: 20,
    });
    expect(s.rate.rateMmYr).toBeGreaterThan(0);
    expect(s.shear.tauPa).toBeGreaterThan(0);
    expect(s.sour.sour).toBe(true);
    expect(s.regime.regime).toBeTruthy();
    expect(s.life.remainingYears).toBeGreaterThan(0);
    expect(['negligible', 'low', 'moderate', 'high', 'severe']).toContain(s.category);
  });
});
