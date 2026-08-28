/**
 * FS4 gates — C7+ single-pseudo characterization.
 *
 * GATE F (oracle transcription): every correlation output on the MW/SG
 * grid must match the Python oracle's independent second transcription
 * of Søreide / Kesler-Lee / Lee-Kesler / Edmister / Jhaveri-Youngren /
 * LBC-Vc / Firoozabadi / Chueh-Prausnitz in goldens.json.
 * GATE G (n-alkane recovery): running Kesler-Lee on a pure n-alkane's
 * NIST boiling point + GPSA specific gravity must land within honest
 * correlation-accuracy bands of the FS1 library constants.
 * GATE H (characterized flash): flashPT on mixtures whose pseudo was
 * built by each side's own transcription must agree with the plain-SS
 * oracle flash grid.
 */

import { COMPONENTS, PLUS_FRACTION_KEY } from '../engines/fluid/components.js';
import { KtoR, degFtoR } from '../engines/fluid/units.js';
import { flashPT } from '../engines/fluid/flash.js';
import {
  soreideTbR, keslerLeeTcR, keslerLeePcPsia, leeKeslerOmega, edmisterOmega,
  jhaveriYoungrenShift, lbcVcC7PlusFt3, firoozabadiParachor, chuehPrausnitzBip,
  characterizePlusFraction, mixtureWithPlusFraction,
} from '../engines/fluid/characterization.js';
import goldens from '../test-data/fluid/goldens.json';
import nist from '../test-data/fluid/nistVaporPressure.json';
import charRef from '../test-data/fluid/characterizationReference.json';

const relErr = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);

describe('FS4 GATE F: characterization vs oracle transcription', () => {
  test.each(goldens.characterization)('mw=$mw sg=$sg', (row) => {
    const input = { mw: row.mw, sg: row.sg };
    if (row.tbInput !== undefined) input.tbR = row.tbInput;
    const ch = characterizePlusFraction(input);
    expect(relErr(ch.meta.tbR, row.tbR)).toBeLessThan(1e-12);
    expect(relErr(ch.comp.tcR, row.tcR)).toBeLessThan(1e-12);
    expect(relErr(ch.comp.pcPsia, row.pcPsia)).toBeLessThan(1e-12);
    expect(relErr(ch.comp.omega, row.omega)).toBeLessThan(1e-12);
    expect(relErr(
      edmisterOmega(ch.meta.tbR, ch.comp.tcR, ch.comp.pcPsia),
      row.omegaEdmister,
    )).toBeLessThan(1e-12);
    expect(relErr(ch.comp.vcFt3PerLbmol, row.vcFt3PerLbmol)).toBeLessThan(1e-12);
    expect(relErr(ch.comp.parachor, row.parachor)).toBeLessThan(1e-12);
    expect(relErr(ch.comp.shift, row.shift)).toBeLessThan(1e-12);
    expect(relErr(ch.bip.C1, row.bipC1)).toBeLessThan(1e-12);
  });

  test('measured Tb wins over Søreide', () => {
    const ch = characterizePlusFraction({ mw: 150, sg: 0.8, tbR: 1000 });
    expect(ch.meta.tbR).toBe(1000);
    expect(ch.meta.tbSource).toBe('measured');
  });
});

describe('FS4 GATE G: pure n-alkane recovery (NIST Tb + GPSA SG)', () => {
  test.each(charRef.alkaneRecovery)('$key', (anchor) => {
    const lib = COMPONENTS[anchor.key];
    const tbR = KtoR(nist.points.find((p) => p.key === anchor.key).tK);
    const tc = keslerLeeTcR(tbR, anchor.sg);
    const pc = keslerLeePcPsia(tbR, anchor.sg);
    expect(relErr(tc, lib.tcR)).toBeLessThan(anchor.tcRelTol);
    expect(relErr(pc, lib.pcPsia)).toBeLessThan(anchor.pcRelTol);
    expect(Math.abs(leeKeslerOmega(tbR, tc, pc, anchor.sg) - lib.omega))
      .toBeLessThan(anchor.omegaAbsTol);
  });

  test.each(charRef.soreideSmoke)('Søreide edge smoke: $key', (smoke) => {
    const tbR = KtoR(nist.points.find((p) => p.key === smoke.key).tK);
    expect(relErr(soreideTbR(COMPONENTS[smoke.key].mw, smoke.sg), tbR))
      .toBeLessThan(smoke.relTol);
  });
});

describe('FS4 identity gates: correlation set', () => {
  test('Chueh-Prausnitz vanishes for identical critical volumes and grows with asymmetry', () => {
    expect(chuehPrausnitzBip(4, 4)).toBe(0);
    const k12 = chuehPrausnitzBip(1.58, 8);
    const k13 = chuehPrausnitzBip(1.58, 16);
    expect(k12).toBeGreaterThan(0);
    expect(k13).toBeGreaterThan(k12);
  });

  test('Jhaveri-Youngren shift is negative for light paraffins, positive for heavy', () => {
    expect(jhaveriYoungrenShift(80)).toBeLessThan(0.02);
    expect(jhaveriYoungrenShift(250)).toBeGreaterThan(0.1);
    expect(() => jhaveriYoungrenShift(150, 'olefin')).toThrow();
  });

  test('parachor and Vc correlations are increasing in MW over the C7+ range', () => {
    expect(firoozabadiParachor(200)).toBeGreaterThan(firoozabadiParachor(120));
    expect(lbcVcC7PlusFt3(200, 0.84)).toBeGreaterThan(lbcVcC7PlusFt3(120, 0.84));
  });

  test('characterization rejects nonsense input', () => {
    expect(() => characterizePlusFraction({ mw: -10, sg: 0.8 })).toThrow();
    expect(() => characterizePlusFraction({ mw: 150, sg: 0 })).toThrow();
  });
});

describe('FS4 GATE H: characterized-fluid flash vs plain-SS oracle', () => {
  describe.each(goldens.flashC7)('fluid $name', ({ keys, plus, x: z, states }) => {
    const mix = mixtureWithPlusFraction(keys, plus);

    test('pseudo lands last with full properties', () => {
      const last = mix.comps[mix.comps.length - 1];
      expect(last.key).toBe(PLUS_FRACTION_KEY);
      expect(last.vcFt3PerLbmol).toBeGreaterThan(0);
      expect(last.parachor).toBeGreaterThan(0);
    });

    test.each(states)('$tF F / $pPsia psia', (st) => {
      const res = flashPT(mix, z, degFtoR(st.tF), st.pPsia);
      expect(res.phases).toBe(st.phases);
      if (st.phases !== 2) return;
      expect(Math.abs(res.beta - st.beta)).toBeLessThan(1e-8);
      res.x.forEach((v, i) => expect(Math.abs(v - st.x[i])).toBeLessThan(1e-8));
      res.y.forEach((v, i) => expect(Math.abs(v - st.y[i])).toBeLessThan(1e-8));
      expect(relErr(res.liquid.density, st.rhoL)).toBeLessThan(1e-7);
      expect(relErr(res.vapor.density, st.rhoV)).toBeLessThan(1e-7);
    });
  });
});
