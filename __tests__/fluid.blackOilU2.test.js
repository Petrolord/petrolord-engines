/**
 * Fluid Systems Studio upgrade, Step 2: gates of the four additions to the
 * black-oil library, each against a published source.
 *
 *  1. Gas z-factor against readings of the Standing-Katz chart
 *     (test-data/fluid/standingKatzChart.json, which names its source), and
 *     against a chart reading printed in Ahmed, Reservoir Engineering
 *     Handbook, Example 2-5.
 *  2. The Vasquez-Beggs reference separator gas gravity against the six
 *     oils of Ahmed, Examples 2-18 and 2-19.
 *  3. The brine formation volume factor ratio against Figures 6 and 7 of
 *     Numbere, Brigham and Standing (1977), read from the report scan.
 *
 * Every gate calls the shipped function. Each has a negative control: the
 * form it replaced, or the formula with one term wrong, fails the same
 * assertion.
 */
import fs from 'fs';
import path from 'path';
import {
  hallYarboroughZ, dranchukAbouKassemZ, suttonPseudoCriticals,
  gasZDetail, gasZFactor, GAS_Z_METHODS, DEFAULT_GAS_Z_METHOD,
  vasquezBeggsReferenceGasGravity, vasquezBeggsRs, VASQUEZ_BEGGS_REFERENCE_SEPARATOR_PSIA,
  brineFvfRatio, brineBw, mccainBw, BRINE_FVF_RANGE,
} from '../engines/fluid/blackOil';

const chart = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'fluid', 'standingKatzChart.json'), 'utf8'));
const POINTS = chart.points.map(([tpr, ppr, z]) => ({ tpr, ppr, z }));

/** Largest relative departure of a z function from the chart over a set of readings. */
const worst = (fn, pts) => pts.reduce((w, p) => Math.max(w, Math.abs(fn(p.ppr, p.tpr) - p.z) / p.z), 0);
const inWindow = (m) => POINTS.filter((p) => p.tpr >= m.chartTpr[0] && p.tpr <= m.chartTpr[1] && p.ppr >= m.chartPpr[0] - 0.01 && p.ppr <= m.chartPpr[1] + 0.01);

/** Papay's explicit form, the z the Fluid Systems Studio table used before this step. */
const papay = (ppr, tpr) => 1 - (3.52 * ppr) / 10 ** (0.9813 * tpr) + (0.274 * ppr * ppr) / 10 ** (0.8157 * tpr);

describe('the Standing-Katz readings file', () => {
  it('covers sixteen isotherms from Tpr 1.05 to 3.0 and ppr 0.2 to 15, and names its source', () => {
    expect(new Set(POINTS.map((p) => p.tpr)).size).toBe(16);
    expect(Math.min(...POINTS.map((p) => p.ppr))).toBeLessThan(0.21);
    expect(Math.max(...POINTS.map((p) => p.ppr))).toBeGreaterThan(15);
    expect(POINTS.length).toBeGreaterThan(190);
    expect(chart.source).toMatch(/Standing.*Katz.*1942/);
    expect(chart.readings).toMatch(/zFactor/);
  });
});

describe('gas z-factor against the Standing-Katz chart', () => {
  const dak = GAS_Z_METHODS.dranchuk_abou_kassem;
  const hy = GAS_Z_METHODS.hall_yarborough;

  it('Dranchuk-Abou-Kassem is within its stated 1.25 percent of every reading from Tpr 1.2 to 3.0', () => {
    const pts = inWindow(dak);
    expect(pts.length).toBeGreaterThan(160);
    const w = worst(dranchukAbouKassemZ, pts);
    expect(w).toBeLessThan(dak.chartError);
    expect(w).toBeGreaterThan(0.005); // a chart reading is not reproduced to four digits
  });

  it('Hall-Yarborough is within its stated 1.5 percent of every reading from Tpr 1.2 to 3.0', () => {
    expect(worst(hallYarboroughZ, inWindow(hy))).toBeLessThan(hy.chartError);
  });

  it('negative control: Papay, the form replaced, misses the same readings by several percent', () => {
    expect(worst(papay, inWindow(dak))).toBeGreaterThan(0.2);
    // and in the middle of the chart, where a reservoir gas sits
    const mid = POINTS.filter((p) => p.tpr >= 1.4 && p.tpr <= 2.0 && p.ppr <= 8.01);
    expect(worst(papay, mid)).toBeGreaterThan(0.05);
    expect(worst(dranchukAbouKassemZ, mid)).toBeLessThan(0.0125);
  });

  it('negative control: one constant of the eleven mistyped fails the gate', () => {
    // A1 = 0.3265 typed as 0.3625, rebuilt here from the published equation
    const A = [0, 0.3625, -1.0700, -0.5339, 0.01569, -0.05165, 0.5475, -0.7361, 0.1844, 0.1056, 0.6134, 0.7210];
    const wrong = (ppr, tpr) => {
      const c1 = A[1] + A[2] / tpr + A[3] / tpr ** 3 + A[4] / tpr ** 4 + A[5] / tpr ** 5;
      const c2 = A[6] + A[7] / tpr + A[8] / tpr ** 2;
      const c3 = A[9] * (A[7] / tpr + A[8] / tpr ** 2);
      const c4 = A[10] / tpr ** 3;
      let z = 1;
      for (let i = 0; i < 200; i += 1) {
        const r = (0.27 * ppr) / (z * tpr);
        const next = 1 + c1 * r + c2 * r * r - c3 * r ** 5 + c4 * r * r * (1 + A[11] * r * r) * Math.exp(-A[11] * r * r);
        z = 0.5 * (z + next);
      }
      return z;
    };
    expect(worst(wrong, inWindow(dak))).toBeGreaterThan(dak.chartError);
  });

  it('next to the critical isotherm both depart from the chart by the amounts their records state', () => {
    const at = (t) => POINTS.filter((p) => p.tpr === t);
    // pinned just above what is observed, so a change in either direction shows
    expect(worst(dranchukAbouKassemZ, at(1.1))).toBeGreaterThan(0.04);
    expect(worst(dranchukAbouKassemZ, at(1.1))).toBeLessThan(0.06);
    expect(worst(dranchukAbouKassemZ, at(1.05))).toBeGreaterThan(0.15);
    expect(worst(dranchukAbouKassemZ, at(1.05))).toBeLessThan(0.18);
    expect(worst(hallYarboroughZ, at(1.1))).toBeLessThan(0.12);
    expect(worst(hallYarboroughZ, at(1.05))).toBeLessThan(0.23);
    expect(dak.nearCritical).toMatch(/6 percent at Tpr 1\.10 and 18 percent at Tpr 1\.05/);
    expect(hy.nearCritical).toMatch(/12 percent at Tpr 1\.10 and 23 percent at Tpr 1\.05/);
  });

  it('Hall-Yarborough returns the first root at Tpr 1.05 (it returned z = 0.18 at ppr 4.0 and 4.5)', () => {
    // chart readings 0.534 at ppr 4.007 and 0.598 at ppr 4.507
    expect(hallYarboroughZ(4.007, 1.05)).toBeGreaterThan(0.52);
    expect(hallYarboroughZ(4.007, 1.05)).toBeLessThan(0.57);
    expect(hallYarboroughZ(4.507, 1.05)).toBeGreaterThan(0.58);
    expect(hallYarboroughZ(4.507, 1.05)).toBeLessThan(0.63);
    // the isotherm is continuous through the stretch that used to jump
    let prev = hallYarboroughZ(3.5, 1.05);
    for (let ppr = 3.6; ppr <= 5.01; ppr += 0.1) {
      const z = hallYarboroughZ(ppr, 1.05);
      expect(Math.abs(z - prev)).toBeLessThan(0.02);
      prev = z;
    }
  });

  it('Hall-Yarborough is unchanged to the last bit where its walk was already right', () => {
    // values of the function at engines main 3fa4834, before the first-root check was added
    expect(hallYarboroughZ(2.5, 1.5)).toBe(0.7924067265076263);
    expect(hallYarboroughZ(5, 2)).toBe(0.9581701151512202);
    expect(hallYarboroughZ(0.5, 1.3)).toBe(0.9176300422060452);
  });

  it('Dranchuk-Abou-Kassem is unchanged to the last bit where its walk was already right, and stays on the curve next to the critical point', () => {
    // values of the function at engines main 3fa4834
    expect(dranchukAbouKassemZ(1.5, 1.5)).toBe(0.8593143805613471);
    expect(dranchukAbouKassemZ(4, 2)).toBe(0.9426402059431057);
    expect(dranchukAbouKassemZ(0.5, 1.3)).toBe(0.9203019066583433);
    // at Tpr 1.00 to 1.02 and ppr near 1 the walk returned z = 2.8 and 35
    for (const [ppr, tpr] of [[1.037, 1.0], [1.102, 1.0], [1.141, 1.0], [1.063, 1.01], [1.089, 1.01], [1.089, 1.02]]) {
      const z = dranchukAbouKassemZ(ppr, tpr);
      expect(z).toBeGreaterThan(0.15);
      expect(z).toBeLessThan(0.3);
    }
  });

  it('the two methods stay within 25 percent of each other over the whole chart window', () => {
    for (let tpr = 1.05; tpr <= 3.001; tpr += 0.05) {
      for (let ppr = 0.2; ppr <= 15.001; ppr += 0.1) {
        const d = dranchukAbouKassemZ(ppr, tpr);
        expect(Math.abs(hallYarboroughZ(ppr, tpr) - d) / d).toBeLessThan(0.25);
      }
    }
  });

  it('reproduces the chart reading of Ahmed, Example 2-5 (ppr 4.50, Tpr 1.67, z = 0.85)', () => {
    expect(Math.abs(dranchukAbouKassemZ(4.5, 1.67) - 0.85) / 0.85).toBeLessThan(0.015);
    expect(Math.abs(hallYarboroughZ(4.5, 1.67) - 0.85) / 0.85).toBeLessThan(0.015);
  });
});

describe('gasZDetail: z from pressure, temperature and gas gravity', () => {
  it('uses Sutton pseudo-criticals and the 459.67 offset, and returns the reduced state', () => {
    const { ppc, tpc } = suttonPseudoCriticals(0.75);
    expect(ppc).toBeCloseTo(756.8 - 131.0 * 0.75 - 3.6 * 0.5625, 10);
    expect(tpc).toBeCloseTo(169.2 + 349.5 * 0.75 - 74.0 * 0.5625, 10);
    const d = gasZDetail(2604, 200, 0.75);
    expect(d.ppr).toBeCloseTo(2604 / ppc, 12);
    expect(d.tpr).toBeCloseTo(659.67 / tpc, 12);
    expect(d.z).toBe(dranchukAbouKassemZ(d.ppr, d.tpr));
    expect(d.method).toBe('dranchuk_abou_kassem');
    expect(DEFAULT_GAS_Z_METHOD).toBe('dranchuk_abou_kassem');
  });
  it('runs the method asked for, and the default for a name it does not know, and says which', () => {
    const hy = gasZDetail(2604, 200, 0.75, 'hall_yarborough');
    expect(hy.method).toBe('hall_yarborough');
    expect(hy.z).toBe(hallYarboroughZ(hy.ppr, hy.tpr));
    expect(hy.z).not.toBe(gasZFactor(2604, 200, 0.75));
    expect(gasZDetail(2604, 200, 0.75, 'papay').method).toBe('dranchuk_abou_kassem');
    expect(gasZDetail(2604, 200, 0.75, 'constructor').method).toBe('dranchuk_abou_kassem');
  });
  it('tends to 1 at low pressure and is exactly 1 at none', () => {
    expect(gasZFactor(14.7, 200, 0.75)).toBeGreaterThan(0.995);
    expect(gasZFactor(14.7, 200, 0.75)).toBeLessThan(1);
    expect(gasZFactor(0, 200, 0.75)).toBe(1);
    expect(gasZFactor(14.7, 200, 0.75, 'hall_yarborough')).toBeGreaterThan(0.995);
  });
});

describe('Vasquez-Beggs reference separator gas gravity (Ahmed, Examples 2-18 and 2-19)', () => {
  // T degF, pb psig, psep psig, Tsep degF, API, gas gravity; then the printed gamma_gs and Rs
  const OILS = [
    { T: 250, pb: 2377, psep: 150, tsep: 60, api: 47.1, sg: 0.851, sgRef: 0.8731, rs: 779 },
    { T: 220, pb: 2620, psep: 100, tsep: 75, api: 40.7, sg: 0.855, sgRef: 0.855, rs: 733 },
    { T: 260, pb: 2051, psep: 100, tsep: 72, api: 48.6, sg: 0.911, sgRef: 0.911, rs: 702 },
    { T: 237, pb: 2884, psep: 60, tsep: 120, api: 40.5, sg: 0.898, sgRef: 0.850, rs: null },
    { T: 218, pb: 3045, psep: 200, tsep: 60, api: 44.2, sg: 0.781, sgRef: 0.814, rs: 947 },
    { T: 180, pb: 4239, psep: 85, tsep: 173, api: 27.3, sg: 0.848, sgRef: 0.834, rs: 841 },
  ];
  const ref = (o) => vasquezBeggsReferenceGasGravity(o.sg, o.api, o.tsep, o.psep + 14.7);

  it('reproduces the printed gravity of all six oils to the printed digit', () => {
    for (const o of OILS) expect(Math.abs(ref(o) - o.sgRef)).toBeLessThan(0.0006);
  });

  it('with that gravity the Rs correlation reproduces the printed Rs of five oils within 1 scf/STB', () => {
    // Oil 4 is left out: the handbook prints Rs = 820, which is what a
    // gravity of 0.890 gives; its own printed gravity (0.850) gives 783.
    for (const o of OILS.filter((x) => x.rs !== null)) {
      const p = o.pb + 14.7;
      expect(Math.abs(vasquezBeggsRs(p, p, ref(o), o.api, o.T) - o.rs)).toBeLessThan(1);
    }
    const o4 = OILS[3];
    expect(vasquezBeggsRs(o4.pb + 14.7, o4.pb + 14.7, ref(o4), o4.api, o4.T)).toBeCloseTo(782.8, 0);
  });

  it('is the gravity as given at the 100 psig reference, and when the separator is unknown', () => {
    expect(VASQUEZ_BEGGS_REFERENCE_SEPARATOR_PSIA).toBe(114.7);
    expect(vasquezBeggsReferenceGasGravity(0.75, 32, 120, 114.7)).toBe(0.75);
    expect(vasquezBeggsReferenceGasGravity(0.75, 32)).toBe(0.75);
    expect(vasquezBeggsReferenceGasGravity(0.75, 32, null, 450)).toBe(0.75);
    expect(vasquezBeggsReferenceGasGravity(0.75, 32, 120, 0)).toBe(0.75);
  });

  it('negative control: a fixed 100 psia separator at the reservoir temperature misses the printed gravities', () => {
    // the form the Fluid Systems Studio primitive used before this step
    const old = (o) => o.sg * (1 + 5.912e-5 * o.api * o.T * Math.log10(100 / 114.7));
    const misses = OILS.filter((o) => Math.abs(old(o) - o.sgRef) > 0.0006).length;
    expect(misses).toBe(6);
    // and a natural logarithm in place of the base 10 one misses the four oils off the reference pressure
    const ln = (o) => o.sg * (1 + 5.912e-5 * o.api * o.tsep * Math.log((o.psep + 14.7) / 114.7));
    expect(OILS.filter((o) => Math.abs(ln(o) - o.sgRef) > 0.0006).length).toBe(4);
  });
});

describe('brine formation volume factor ratio (Numbere, Brigham and Standing 1977, Equation 10)', () => {
  // Readings of Figure 6 (at the saturation pressure of water) and Figure 7
  // (10,000 psia) of the report: salt weight percent, degF, psia, Bs/Bw.
  // Saturation pressures of water are steam-table values (3.3 psia at 145
  // degF, 210 psia at 387 degF); the pressure term is below 0.0005 there.
  const READINGS = [
    [25, 145, 3.3, 1.006], [25, 387, 210, 0.9615], [18, 387, 210, 0.971], [10, 387, 210, 0.983], [2, 387, 210, 0.997],
    [25, 60, 10000, 1.0118], [25, 140, 10000, 1.0157], [25, 390, 10000, 0.979], [10, 140, 10000, 1.008], [2, 150, 10000, 1.0025],
  ];
  const TOL = 0.003; // the report states a fit error of 0.2 percent; the rest is reading the figure

  it('reproduces ten readings of the two figures within 0.003', () => {
    for (const [cs, t, p, ratio] of READINGS) {
      expect(Math.abs(brineFvfRatio(p, t, cs * 10000) - ratio)).toBeLessThan(TOL);
    }
  });

  it('all concentrations cross 1 near 230 degF at low pressure, as Figure 6 shows', () => {
    for (const cs of [2, 10, 18, 25]) {
      expect(Math.abs(brineFvfRatio(20, 229, cs * 10000) - 1)).toBeLessThan(0.0005);
      expect(brineFvfRatio(20, 150, cs * 10000)).toBeGreaterThan(1);
      expect(brineFvfRatio(20, 300, cs * 10000)).toBeLessThan(1);
    }
  });

  it('is exactly 1 for fresh water, and at 60 degF and no pressure', () => {
    expect(brineFvfRatio(3000, 200, 0)).toBe(1);
    expect(brineFvfRatio(0, 60, 250000)).toBe(1);
    expect(brineFvfRatio(3000, 200, -5)).toBe(1);
  });

  it('worked value: 35,000 ppm at 2,604 psia and 200 degF raises Bw by 0.083 percent', () => {
    // 3.5 [5.1e-8 (2604) + (5.47e-6 - 1.95e-10 (2604)) (140) - (3.23e-8 - 8.5e-13 (2604)) (140)^2] = 8.32e-4
    expect(brineFvfRatio(2604, 200, 35000)).toBeCloseTo(1.000832, 6);
    expect(brineBw(2604, 200, 35000)).toBeCloseTo(mccainBw(2604, 200) * 1.000832, 6);
    expect(brineBw(2604, 200, 0)).toBe(mccainBw(2604, 200));
  });

  it('negative control: the quadratic term with the wrong sign, or left out, misses the figures', () => {
    const wrongSign = (p, t, cs) => 1 + cs * (5.1e-8 * p + (5.47e-6 - 1.95e-10 * p) * (t - 60) + (3.23e-8 - 8.5e-13 * p) * (t - 60) ** 2);
    const noQuadratic = (p, t, cs) => 1 + cs * (5.1e-8 * p + (5.47e-6 - 1.95e-10 * p) * (t - 60));
    const misses = (fn) => READINGS.filter(([cs, t, p, ratio]) => Math.abs(fn(p, t, cs) - ratio) > TOL).length;
    expect(misses(wrongSign)).toBeGreaterThanOrEqual(6);
    expect(misses(noQuadratic)).toBeGreaterThanOrEqual(6);
    // and salinity read as a fraction instead of weight percent loses the effect
    const asFraction = (p, t, cs) => brineFvfRatio(p, t, cs * 100);
    expect(misses(asFraction)).toBeGreaterThanOrEqual(7);
  });

  it('states its published window', () => {
    expect(BRINE_FVF_RANGE).toEqual({ pressure: [0, 10000], temp: [60, 400], salinity: [0, 250000] });
  });
});
