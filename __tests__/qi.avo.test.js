import {
  akiRichards, shueyTerms, fitShuey, contrastsFromAB, backgroundTrend, offTrend, chiProjection, avoClass,
} from '../engines/qi/avo';

// Known truth: interfaces with given contrasts. Shale over brine sand, and
// the same sand with gas (Vp and density down, Vs up a little).
const BRINE = { dVpVp: 0.10, dVsVs: 0.14, dRhoRho: 0.025, vsVp: 0.5 }; // Gardner: drho/rho = dVp/Vp / 4
const GAS = { dVpVp: -0.12, dVsVs: 0.05, dRhoRho: -0.03, vsVp: 0.5 };
const ANGLES = [0, 5, 10, 15, 20, 25, 30, 35, 40];

describe('AVO fits', () => {
  test('the three-term fit recovers Shuey A, B and C exactly from Aki-Richards data', () => {
    for (const c of [BRINE, GAS]) {
      const amps = ANGLES.map((a) => akiRichards(c, a));
      const f = fitShuey(ANGLES, amps, { terms: 3 });
      const t = shueyTerms(c);
      expect(f.A).toBeCloseTo(t.A, 10); expect(f.B).toBeCloseTo(t.B, 10); expect(f.C).toBeCloseTo(t.C, 10);
    }
  });
  test('negative control: a two-term fit to 40 degree data biases the gradient (about 40 percent); to 25 degrees far less', () => {
    const amps = ANGLES.map((a) => akiRichards(GAS, a));
    const t = shueyTerms(GAS);
    const wide = Math.abs(fitShuey(ANGLES, amps).B - t.B) / Math.abs(t.B);
    const near = Math.abs(fitShuey(ANGLES.slice(0, 6), amps.slice(0, 6)).B - t.B) / Math.abs(t.B);
    expect(wide).toBeGreaterThan(0.35);
    expect(near).toBeLessThan(0.15);
    expect(wide).toBeGreaterThan(2.5 * near);
  });
  test('too few live angles give no fit', () => {
    expect(fitShuey([10, 20], [0.1, NaN]).A).toBeNaN();
    expect(fitShuey([10, 20, 30], [0.1, 0.05, 0.0], { terms: 3 }).n).toBe(3);
  });
});

describe('contrasts and the fluid factor', () => {
  test('the contrasts come back from A and B (Gardner density) and the fluid factor marks gas', () => {
    for (const c of [BRINE, GAS]) {
      const t = shueyTerms(c);
      const r = contrastsFromAB(t.A, t.B, c.vsVp);
      expect(r.dVpVp).toBeCloseTo(c.dVpVp, 10);
      expect(r.dVsVs).toBeCloseTo(c.dVsVs, 10);
    }
    // on the mudrock line (Castagna: dVp/Vp = 1.16 (Vs/Vp) dVs/Vs) the fluid factor is zero
    const mud = { dVpVp: 0.0928, dVsVs: 0.16, dRhoRho: 0.0232, vsVp: 0.5 };
    const tm = shueyTerms(mud);
    expect(contrastsFromAB(tm.A, tm.B, 0.5).fluidFactor).toBeCloseTo(0, 10);
    const tg = shueyTerms(GAS);
    expect(contrastsFromAB(tg.A, tg.B, 0.5).fluidFactor).toBeLessThan(-0.1);
  });
});

describe('the I-G plane', () => {
  test('the background trend of points on B = -1.5 A is -1.5, and a gas point sits off it on the soft side', () => {
    const As = Array.from({ length: 50 }, (_, i) => -0.1 + 0.004 * i);
    const Bs = As.map((a) => -1.5 * a);
    const t = backgroundTrend(As, Bs);
    expect(t.m).toBeCloseTo(-1.5, 9);
    const g = shueyTerms(GAS);
    expect(offTrend(g.A, g.B, t.m)).toBeLessThan(0);
    expect(Math.abs(offTrend(0.04, -0.06, t.m))).toBeCloseTo(0, 12);
  });
  test('chi projection and AVO classes', () => {
    expect(chiProjection(0.1, -0.2, 0)).toBeCloseTo(0.1, 12);
    expect(chiProjection(0.1, -0.2, 90)).toBeCloseTo(-0.2, 12);
    expect(avoClass(0.05, -0.1)).toBe('I');
    expect(avoClass(0.0, -0.1)).toBe('II');
    expect(avoClass(-0.08, -0.1)).toBe('III');
    expect(avoClass(-0.08, 0.02)).toBe('IV');
    const g = shueyTerms(GAS);
    expect(avoClass(g.A, g.B)).toBe('III');
    expect(avoClass(NaN, 1)).toBeNull();
  });
});
