/**
 * Pattern forecast engine: five-spot areal sweep correlations + composite
 * rate-time forecast.
 *
 * Areal-sweep goldens are the published five-spot correlations with their
 * quoted anchors:
 *   EAbt = 0.54602036 + 0.03170817/M + 0.30222997 e^(-M) - 0.00509693 M
 *   (Willhite's regression of Craig's five-spot data, as in Ahmed Ch.14;
 *    anchors quoted in the literature: EAbt -> ~1.0 at M=0.15, ~0.50 at M=10)
 *   EA = EAbt + 0.2749 ln(Wi/WiBT)   (Dyes, Caudle & Erickson 1954)
 * Forecast checks are closed-form identities of the scheme: pre-breakthrough
 * qo*Bo = iw, Np at breakthrough = WiBT, reservoir-barrel material balance.
 */
import {
  arealSweepAtBreakthrough,
  arealSweepAfterBreakthrough,
  displacementStateAtQi,
  forecastPattern,
  samplePatternData,
} from '../engines/waterflood/patternForecast.js';
import { analyzeDisplacement, sampleFractionalFlowData } from '../engines/scal/fractionalFlow.js';

const SAMPLE = sampleFractionalFlowData();
const displacementSpec = { krSpec: { type: 'corey', ...SAMPLE.params }, muW: SAMPLE.muW, muO: SAMPLE.muO };

describe('arealSweepAtBreakthrough (five-spot)', () => {
  it('hand-computed value at M=1', () => {
    // 0.54602036 + 0.03170817 + 0.30222997*e^-1 - 0.00509693
    //   = 0.54602036 + 0.03170817 + 0.11118868 - 0.00509693 = 0.68382
    expect(arealSweepAtBreakthrough(1)).toBeCloseTo(0.68382, 4);
  });

  it('published anchors: ~1.0 at M=0.15 and ~0.50 at M=10', () => {
    expect(arealSweepAtBreakthrough(0.15)).toBeCloseTo(1.0, 2);
    expect(arealSweepAtBreakthrough(10)).toBeCloseTo(0.50, 2);
  });

  it('decreases with mobility ratio and guards bad input', () => {
    expect(arealSweepAtBreakthrough(0.5)).toBeGreaterThan(arealSweepAtBreakthrough(2));
    expect(arealSweepAtBreakthrough(0)).toBeNull();
  });
});

describe('arealSweepAfterBreakthrough', () => {
  it('EA grows by 0.2749 ln(Wi/WiBT) and caps at 1', () => {
    // 0.68 + 0.2749*ln(2) = 0.68 + 0.190546 = 0.870546
    expect(arealSweepAfterBreakthrough(0.68, 2)).toBeCloseTo(0.870546, 5);
    expect(arealSweepAfterBreakthrough(0.68, 100)).toBe(1);
    expect(arealSweepAfterBreakthrough(0.68, 1)).toBeCloseTo(0.68, 10);
  });
});

describe('displacementStateAtQi', () => {
  const displacement = analyzeDisplacement(displacementSpec);

  it('is dry before breakthrough with ED = Qi/(1-Swc), and continuous at breakthrough', () => {
    const qi = displacement.bl.QiBt * 0.5;
    const pre = displacementStateAtQi(displacement, qi);
    expect(pre.fw2).toBe(0);
    expect(pre.ED).toBeCloseTo(qi / (1 - SAMPLE.params.Swc), 10);
    const atBt = displacementStateAtQi(displacement, displacement.bl.QiBt * 1.0000001);
    expect(atBt.ED).toBeCloseTo(displacement.bl.EDbt, 3);
    expect(atBt.fw2).toBeCloseTo(displacement.bl.fwf, 2);
  });

  it('ED increases and approaches EDmax with continued injection', () => {
    const early = displacementStateAtQi(displacement, displacement.bl.QiBt * 2);
    const late = displacementStateAtQi(displacement, displacement.bl.QiBt * 20);
    expect(late.ED).toBeGreaterThan(early.ED);
    expect(late.ED).toBeLessThanOrEqual(displacement.bl.EDmax + 1e-9);
  });
});

describe('forecastPattern', () => {
  const base = { displacementSpec, pattern: samplePatternData().pattern };

  it('pre-breakthrough identity: qo*Bo = iw and qw = 0', () => {
    const { series, breakthrough } = forecastPattern(base);
    const preBt = series.filter((p) => p.t_days < breakthrough.t_days - 31);
    expect(preBt.length).toBeGreaterThan(2);
    preBt.forEach((p) => {
      expect(p.qo_stbd * base.pattern.Bo).toBeCloseTo(base.pattern.iw_bpd, 6);
      expect(p.qw_stbd).toBeCloseTo(0, 6);
    });
  });

  it('Np in reservoir barrels equals injected water at breakthrough (piston growth identity)', () => {
    const { series, breakthrough } = forecastPattern(base);
    const lastPre = [...series].reverse().find((p) => p.Wi_bbl <= breakthrough.WiBT_bbl);
    expect(lastPre.Np_stb * base.pattern.Bo).toBeCloseTo(lastPre.Wi_bbl, 0);
  });

  it('reservoir-barrel material balance holds after breakthrough: qo*Bo + qw*Bw = iw', () => {
    const { series, breakthrough } = forecastPattern(base);
    const postBt = series.filter((p) => p.t_days > breakthrough.t_days + 31);
    expect(postBt.length).toBeGreaterThan(5);
    postBt.forEach((p) => {
      expect(p.qo_stbd * base.pattern.Bo + p.qw_stbd * base.pattern.Bw).toBeCloseTo(base.pattern.iw_bpd, 4);
    });
  });

  it('WOR rises after breakthrough and the run stops at the WOR limit', () => {
    const { series, summary } = forecastPattern({
      ...base,
      pattern: { ...base.pattern, worLimit: 5 },
    });
    expect(summary.stopped).toBe('wor-limit');
    expect(series[series.length - 1].WOR).toBeGreaterThanOrEqual(5);
  });

  it('recovery factor of flooded OOIP stays physical (0 < RF <= EDmax)', () => {
    const displacement = analyzeDisplacement(displacementSpec);
    const { summary } = forecastPattern(base);
    expect(summary.recoveryFactorOfFloodedOOIP).toBeGreaterThan(0);
    expect(summary.recoveryFactorOfFloodedOOIP).toBeLessThanOrEqual(displacement.bl.EDmax + 1e-6);
  });

  it('initial free gas delays the production response (fill-up)', () => {
    const withGas = forecastPattern({ ...base, pattern: { ...base.pattern, Sgi: 0.10 } });
    const first = withGas.series[0];
    expect(first.qo_stbd).toBeCloseTo(0, 6);
    expect(withGas.warnings.join(' ')).toMatch(/fill-up/);
    const noGas = forecastPattern(base);
    expect(withGas.breakthrough.t_days).toBeGreaterThan(noGas.breakthrough.t_days);
  });

  it('flags a mobility ratio outside the correlation validity range', () => {
    const { warnings } = forecastPattern({
      ...base,
      displacementSpec: { ...displacementSpec, polymerMuMult: 40 }, // M ~ 0.01
    });
    expect(warnings.join(' ')).toMatch(/validity range/);
  });

  it('guards non-positive pattern inputs', () => {
    const { series, warnings } = forecastPattern({ ...base, pattern: { ...base.pattern, h_ft: 0 } });
    expect(series).toEqual([]);
    expect(warnings.join(' ')).toMatch(/positive/);
  });
});
