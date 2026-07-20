import {
  computePeriodVoidage, computeVRRSeries, classifyVRR, summarizeVRR, sampleVRRData,
} from '../engines/waterflood/vrr.js';

const FVF = { Bo: 1.25, Bw: 1.0, Bg: 0.9, Rs: 500 };

describe('computePeriodVoidage', () => {
  it('matches the hand calculation, free gas only', () => {
    // solution gas = 500 scf/STB * 1000 STB / 1000 = 500 Mscf
    // free gas = 1000 - 500 = 500 Mscf
    // produced RB = 1000*1.25 + 100*1.0 + 500*0.9 = 1250 + 100 + 450 = 1800
    // injected RB = 1200*1.0 = 1200 -> VRR = 2/3
    const r = computePeriodVoidage({ Np: 1000, Wp: 100, Gp: 1000, Wi: 1200, Gi: 0 }, FVF);
    expect(r.freeGasProdMscf).toBeCloseTo(500, 9);
    expect(r.producedVoidage).toBeCloseTo(1800, 9);
    expect(r.injectedVoidage).toBeCloseTo(1200, 9);
    expect(r.instantaneousVRR).toBeCloseTo(2 / 3, 9);
  });

  it('floors free gas at zero when produced gas is below solution gas', () => {
    const r = computePeriodVoidage({ Np: 1000, Wp: 0, Gp: 100, Wi: 0, Gi: 0 }, FVF);
    expect(r.freeGasProdMscf).toBe(0);
    expect(r.producedVoidage).toBeCloseTo(1250, 9);
  });

  it('counts injected gas as reservoir voidage via Bg', () => {
    const r = computePeriodVoidage({ Np: 0, Wp: 0, Gp: 0, Wi: 0, Gi: 100 }, FVF);
    expect(r.injectedVoidage).toBeCloseTo(90, 9);
    expect(r.instantaneousVRR).toBeNull(); // no produced voidage
  });
});

describe('computeVRRSeries', () => {
  it('accumulates produced and injected voidage across periods', () => {
    const series = computeVRRSeries(
      [
        { Np: 1000, Wp: 100, Gp: 1000, Wi: 1200, Gi: 0 }, // 1800 / 1200
        { Np: 1000, Wp: 100, Gp: 1000, Wi: 2400, Gi: 0 }, // 1800 / 2400
      ],
      FVF,
    );
    expect(series[0].cumulativeVRR).toBeCloseTo(1200 / 1800, 9);
    expect(series[1].cumProd).toBeCloseTo(3600, 9);
    expect(series[1].cumInj).toBeCloseTo(3600, 9);
    expect(series[1].cumulativeVRR).toBeCloseTo(1, 9);
  });

  it('lets per-period FVF overrides beat the global set', () => {
    const series = computeVRRSeries(
      [{ Np: 1000, Wp: 0, Gp: 0, Wi: 0, Gi: 0, Bo: 2.0 }],
      FVF,
    );
    expect(series[0].producedVoidage).toBeCloseTo(2000, 9);
  });
});

describe('classifyVRR', () => {
  it('bands under / balanced / over and handles no data', () => {
    expect(classifyVRR(0.85).tone).toBe('warn');
    expect(classifyVRR(0.9).tone).toBe('good');   // boundary is inclusive
    expect(classifyVRR(1.0).tone).toBe('good');
    expect(classifyVRR(1.1).tone).toBe('good');   // boundary is inclusive
    expect(classifyVRR(1.15).tone).toBe('info');
    expect(classifyVRR(null).tone).toBe('neutral');
    expect(classifyVRR(NaN).tone).toBe('neutral');
  });
});

describe('summarizeVRR + sample data', () => {
  it('returns null for an empty series', () => {
    expect(summarizeVRR([])).toBeNull();
  });

  it('reproduces the documented first-month VRR of the sample dataset', () => {
    const { fvf, periods } = sampleVRRData();
    const series = computeVRRSeries(periods, fvf);
    // Hand calc for 2024-01: solution gas = 550*62000/1000 = 34100 Mscf;
    // free gas = 40000-34100 = 5900; produced = 62000*1.25 + 8000*1.02
    // + 5900*0.9 = 90970 RB; injected = 40000*1.02 = 40800 RB.
    expect(series[0].instantaneousVRR).toBeCloseTo(40800 / 90970, 6);
    const summary = summarizeVRR(series);
    expect(summary.latestInstantaneousVRR).toBeGreaterThan(series[0].instantaneousVRR);
    expect(summary.cumulativeVRR).toBeGreaterThan(0.5);
    expect(summary.cumulativeVRR).toBeLessThan(1.0);
    expect(summary.status.tone).toBe('warn'); // cumulative under-injection in the demo
  });
});
