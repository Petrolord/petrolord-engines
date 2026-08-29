// Facilities F3 gas-conditioning gates: ideal-VLE water content
// (Magnus vs the oracle's Antoine), Kremser against a brute-force
// stage-cascade linear solve, the TEG and amine balances re-derived in
// SI, Souders-Brown contactor sizing, and the Joule-Thomson screening
// derived from the DAK z-factor -- against
// tools/validation/facilities/oracle_gasprocessing.py.
//
// Doctrine gate of this module: the predecessor app hid design choices
// inside constants (4 gal/lb, 750 Btu/gal, 15 percent BTEX). Here
// every such number is an INPUT with its customary range named, and
// these tests hold the module to computing only what is computable.

import fs from 'fs';
import path from 'path';
import {
  waterSatPsia, saturatedWaterContent,
  kremserFractionRemoved, kremserStagesFor,
  tegPackage, AMINES, amineOf, aminePackage,
  contactorDiameter, jouleThomsonFPerPsi, jtDrop,
} from '../engines/facilities/gasProcessing';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'facilities', 'goldens', 'gasprocessing_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

describe('water content', () => {
  test('Magnus meets Antoine inside their shared band', () => {
    G.water.forEach((row) => {
      const r = saturatedWaterContent(row);
      expect(r.error).toBeUndefined();
      // Two different published vapor-pressure fits (Magnus here,
      // Antoine in the oracle): they differ a few tenths of a percent
      // mid-band and about 0.6 percent at Antoine's 1 C band edge.
      expect(rel(r.lbPerMMscf, row.lbPerMMscf)).toBeLessThan(1e-2);
    });
  });

  test('drier at higher pressure, wetter when hot, honest about high pressure', () => {
    const lo = saturatedWaterContent({ pPsia: 200, tF: 100 });
    const hi = saturatedWaterContent({ pPsia: 1000, tF: 100 });
    const hot = saturatedWaterContent({ pPsia: 200, tF: 140 });
    expect(hi.lbPerMMscf).toBeLessThan(lo.lbPerMMscf);
    expect(hot.lbPerMMscf).toBeGreaterThan(lo.lbPerMMscf);
    expect(hi.warning).toBeNull();
    expect(saturatedWaterContent({ pPsia: 1500, tF: 100 }).warning).toMatch(/McKetta/);
    expect(Number.isNaN(waterSatPsia(300))).toBe(true);
    expect(saturatedWaterContent({ pPsia: 0.1, tF: 100 }).error).toBeTruthy();
  });
});

describe('Kremser', () => {
  test('the closed form reproduces the brute-force stage cascade', () => {
    G.kremser.forEach((row) => {
      const f = kremserFractionRemoved(row);
      expect(rel(f, row.fractionRemoved)).toBeLessThan(1e-9);
    });
  });

  test('stage count inverts the fraction, and impossible specs refuse', () => {
    const f = kremserFractionRemoved({ absorptionFactor: 1.4, stages: 6 });
    const n = kremserStagesFor({ absorptionFactor: 1.4, fractionRemoved: f });
    expect(n.stages).toBeCloseTo(6, 9);
    // undersized solvent: A caps the removal no matter the stages
    expect(kremserStagesFor({ absorptionFactor: 0.8, fractionRemoved: 0.9 }).error).toMatch(/circulation/);
  });
});

describe('TEG package', () => {
  test('balances match the SI re-derivation, duty split into named parts', () => {
    G.teg.forEach((row) => {
      const r = tegPackage(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.waterLbDay, row.waterLbDay)).toBeLessThan(1e-9);
      expect(rel(r.circGpm, row.circGpm)).toBeLessThan(1e-9);
      expect(rel(r.dutyBtuPerGal, row.dutyBtuPerGal)).toBeLessThan(1e-9);
      expect(rel(r.reboilerMMBtuHr, row.reboilerMMBtuHr)).toBeLessThan(1e-9);
      expect(rel(r.btexLbDay, row.btexLbDay)).toBeLessThan(1e-9);
      expect(r.sensiblePerGal + r.vaporPerGal).toBeCloseTo(r.dutyBtuPerGal, 9);
    });
  });

  test('design choices are inputs, and out-of-custom choices warn', () => {
    const base = { gasMMscfd: 50, inletLbMMscf: 60, outletLbMMscf: 7 };
    expect(tegPackage({ ...base, circulationGalPerLb: 8 }).warning).toMatch(/2 to 5/);
    expect(tegPackage({ ...base, circulationGalPerLb: 3 }).warning).toBeNull();
    expect(tegPackage({ ...base, outletLbMMscf: 70 }).error).toBeTruthy();
  });
});

describe('amine package', () => {
  test('balances match the SI re-derivation', () => {
    const rows = G.amine;
    const r0 = aminePackage({ ...rows[0], amineId: 'MDEA' });
    expect(rel(r0.circGpm, rows[0].circGpm)).toBeLessThan(1e-9);
    expect(rel(r0.reboilerMMBtuHr, rows[0].reboilerMMBtuHr)).toBeLessThan(1e-9);
    const r1 = aminePackage({ ...rows[1], amineId: 'DEA' });
    expect(rel(r1.circGpm, rows[1].circGpm)).toBeLessThan(1e-9);
  });

  test('the amine table is complete and overloading warns', () => {
    expect(AMINES.map((a) => a.id)).toEqual(['MEA', 'DEA', 'MDEA']);
    expect(amineOf('MEA').maxLoading).toBeLessThan(amineOf('MDEA').maxLoading);
    const hot = aminePackage({
      gasMMscfd: 50, co2MolPct: 3, amineId: 'MEA', richLoading: 0.45,
    });
    expect(hot.warning).toMatch(/corrosion/);
    expect(aminePackage({ gasMMscfd: 50, co2MolPct: 1, co2SpecMolPct: 2 }).error).toBeTruthy();
  });
});

describe('contactor sizing', () => {
  test('Souders-Brown matches the SI oracle with z passed through', () => {
    G.contactor.forEach((row) => {
      const r = contactorDiameter(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.diameterFt, row.diameterFt)).toBeLessThan(1e-9);
      expect(rel(r.vAllowFtS, row.vAllowFtS)).toBeLessThan(1e-9);
    });
  });

  test('computes its own z when none is given', () => {
    const r = contactorDiameter({ gasMMscfd: 50, pPsia: 1000, tF: 100, gasSg: 0.65 });
    expect(r.z).toBeGreaterThan(0.7);
    expect(r.z).toBeLessThan(1);
    expect(r.diameterFt).toBeGreaterThan(0);
  });
});

describe('Joule-Thomson from the z-factor itself', () => {
  test('finite at low pressure (a virial effect, not an ideal one) and in the field band', () => {
    // JT does NOT vanish as P -> 0: z -> 1 but (dz/dT)/P tends to the
    // second-virial limit, so mu goes to a finite value. The classic
    // field rule of thumb is about 7 F per 100 psi; both ends must sit
    // in that neighborhood.
    const lowP = jouleThomsonFPerPsi({ pPsia: 20, tF: 100, gasSg: 0.65 });
    const field = jouleThomsonFPerPsi({ pPsia: 1000, tF: 100, gasSg: 0.65 });
    [lowP, field].forEach((r) => {
      expect(r.muFPerPsi).toBeGreaterThan(0); // cooling on expansion
      expect(r.muFPerPsi * 100).toBeGreaterThan(2);
      expect(r.muFPerPsi * 100).toBeLessThan(15);
    });
    // the classic rule of thumb, reproduced not assumed
    expect(field.muFPerPsi * 100).toBeGreaterThan(5);
    expect(field.muFPerPsi * 100).toBeLessThan(9);
  });

  test('a JT drop cools, more drop cools more, and bad inputs refuse', () => {
    const small = jtDrop({ p1Psia: 1000, p2Psia: 800, tF: 100, gasSg: 0.65 });
    const large = jtDrop({ p1Psia: 1000, p2Psia: 400, tF: 100, gasSg: 0.65 });
    expect(small.dropF).toBeGreaterThan(0);
    expect(large.dropF).toBeGreaterThan(small.dropF);
    expect(jtDrop({ p1Psia: 500, p2Psia: 600, tF: 100, gasSg: 0.65 }).error).toBeTruthy();
  });
});
