import {
  coreyKr, fractionalFlow, mobilityRatio, buildCurves, welgeTangent,
  recoveryProfile, analyzeFractionalFlow, sampleFractionalFlowData,
} from '../engines/scal/fractionalFlow.js';

const { params: P, muW, muO } = sampleFractionalFlowData();
// P = { Swc: 0.2, Sor: 0.2, krwMax: 0.4, kroMax: 1.0, nw: 2, no: 2 }, muW 0.5, muO 5

describe('coreyKr', () => {
  it('honors the endpoints', () => {
    const atSwc = coreyKr(P.Swc, P);
    expect(atSwc.krw).toBeCloseTo(0, 12);
    expect(atSwc.kro).toBeCloseTo(P.kroMax, 12);
    const atSorEnd = coreyKr(1 - P.Sor, P);
    expect(atSorEnd.krw).toBeCloseTo(P.krwMax, 12);
    expect(atSorEnd.kro).toBeCloseTo(0, 12);
  });

  it('matches the closed form at mid-saturation', () => {
    // Swn = (0.5-0.2)/0.6 = 0.5 -> krw = 0.4*0.25 = 0.1, kro = 1*0.25 = 0.25
    const r = coreyKr(0.5, P);
    expect(r.Swn).toBeCloseTo(0.5, 12);
    expect(r.krw).toBeCloseTo(0.1, 12);
    expect(r.kro).toBeCloseTo(0.25, 12);
  });

  it('clamps normalized saturation outside the mobile range', () => {
    expect(coreyKr(0.05, P).Swn).toBe(0);
    expect(coreyKr(0.95, P).Swn).toBe(1);
  });
});

describe('fractionalFlow', () => {
  it('is 0 at connate water and 1 at residual oil', () => {
    expect(fractionalFlow(P.Swc, P, muW, muO)).toBe(0);
    expect(fractionalFlow(1 - P.Sor, P, muW, muO)).toBe(1);
  });

  it('matches the closed form at Sw = 0.5', () => {
    // fw = 1 / (1 + (kro*muW)/(krw*muO)) = 1 / (1 + (0.25*0.5)/(0.1*5)) = 0.8
    expect(fractionalFlow(0.5, P, muW, muO)).toBeCloseTo(0.8, 12);
  });

  it('is monotone nondecreasing across the mobile range', () => {
    const curves = buildCurves(P, muW, muO);
    for (let i = 1; i < curves.length; i++) {
      expect(curves[i].fw).toBeGreaterThanOrEqual(curves[i - 1].fw - 1e-12);
    }
    expect(curves).toHaveLength(102);
  });
});

describe('mobilityRatio', () => {
  it('matches the endpoint formula', () => {
    // (krwMax/muW)/(kroMax/muO) = (0.4/0.5)/(1/5) = 4 (unfavorable)
    expect(mobilityRatio(P, muW, muO)).toBeCloseTo(4, 12);
  });
});

describe('welgeTangent', () => {
  const bl = welgeTangent(P, muW, muO);

  it('places the front saturation inside the mobile range', () => {
    expect(bl.Swf).toBeGreaterThan(P.Swc);
    expect(bl.Swf).toBeLessThan(1 - P.Sor);
  });

  it('tangency: the front slope equals the secant slope from (Swc, 0)', () => {
    expect(bl.fwPrimeF).toBeCloseTo(bl.fwf / (bl.Swf - P.Swc), 6);
  });

  it('breakthrough identities hold', () => {
    expect(bl.QiBt).toBeCloseTo(1 / bl.fwPrimeF, 12);
    expect(bl.SwAvgBt).toBeCloseTo(P.Swc + bl.QiBt, 12);
    expect(bl.SwAvgBt).toBeGreaterThan(bl.Swf); // Welge: average behind front exceeds the front
  });

  it('displacement efficiencies are ordered and EDmax is closed-form', () => {
    expect(bl.EDmax).toBeCloseTo((1 - P.Sor - P.Swc) / (1 - P.Swc), 12); // 0.75
    expect(bl.EDbt).toBeGreaterThan(0);
    expect(bl.EDbt).toBeLessThan(bl.EDmax);
  });
});

describe('recoveryProfile', () => {
  it('starts at breakthrough and recovers monotonically toward EDmax', () => {
    const bl = welgeTangent(P, muW, muO);
    const rec = recoveryProfile(P, muW, muO, bl);
    expect(rec[0].breakthrough).toBe(true);
    for (let i = 1; i < rec.length; i++) {
      expect(rec[i].Qi).toBeGreaterThan(rec[i - 1].Qi);
      expect(rec[i].ED).toBeGreaterThanOrEqual(rec[i - 1].ED - 1e-9);
    }
    const last = rec[rec.length - 1];
    expect(last.ED).toBeLessThanOrEqual(bl.EDmax + 1e-9);
    expect(last.ED).toBeGreaterThan(bl.EDbt);
  });
});

describe('analyzeFractionalFlow', () => {
  it('returns the assembled analysis', () => {
    const a = analyzeFractionalFlow(P, muW, muO);
    expect(a.curves.length).toBe(102);
    expect(a.bl.Swf).not.toBeNull();
    expect(a.recovery.length).toBeGreaterThan(10);
    expect(a.M).toBeCloseTo(4, 12);
  });
});
