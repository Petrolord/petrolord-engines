/**
 * FS4 gates — LBC viscosity + Weinaug-Katz IFT.
 *
 * GATE J (oracle transcription): phase viscosities and IFT on the flash
 * grids must match the Python oracle's independent transcription of the
 * SPE 109892 field-unit LBC statement and the Weinaug-Katz parachor sum.
 * GATE K (NIST anchors): dilute-gas LBC at 1 atm within honest bands of
 * measured methane/nitrogen viscosities.
 * Identity gates: Herning-Zipperer collapse, zero IFT for identical
 * phases, dense-term monotonicity in reduced density.
 */

import { mixtureFromKeys, phaseProps } from '../engines/fluid/pr78.js';
import { COMPONENTS } from '../engines/fluid/components.js';
import { KtoR, degFtoR } from '../engines/fluid/units.js';
import { flashPT } from '../engines/fluid/flash.js';
import { mixtureWithPlusFraction } from '../engines/fluid/characterization.js';
import {
  lbcViscosity, diluteComponentViscosity, diluteMixtureViscosity, weinaugKatzIFT, LBC_COEFFS,
} from '../engines/fluid/transport.js';
import goldens from '../test-data/fluid/goldens.json';
import charRef from '../test-data/fluid/characterizationReference.json';

const relErr = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);

const mixByName = (name) => {
  const charSrc = goldens.flashC7.find((f) => f.name === name);
  if (charSrc) return { mix: mixtureWithPlusFraction(charSrc.keys, charSrc.plus), z: charSrc.x };
  const src = goldens.flash.find((f) => f.name === name);
  return { mix: mixtureFromKeys(src.keys), z: src.x };
};

describe('FS4 GATE J: LBC + Weinaug-Katz vs oracle transcription', () => {
  describe.each(goldens.transport)('fluid $name', (tr) => {
    const { mix, z } = mixByName(tr.name);
    test.each(tr.states)('$tF F / $pPsia psia', (st) => {
      const tR = degFtoR(st.tF);
      const res = flashPT(mix, z, tR, st.pPsia);
      expect(res.phases).toBe(2);
      const muL = lbcViscosity(mix, res.x, tR, res.liquid);
      const muV = lbcViscosity(mix, res.y, tR, res.vapor);
      expect(relErr(muL.viscosityCp, st.muL)).toBeLessThan(1e-6);
      expect(relErr(muV.viscosityCp, st.muV)).toBeLessThan(1e-6);
      expect(muL.rhoR).toBeGreaterThan(muV.rhoR);
      const ift = weinaugKatzIFT(mix, res.x, res.y, res.liquid, res.vapor);
      expect(relErr(ift.iftDynPerCm, st.iftDynPerCm)).toBeLessThan(1e-6);
      expect(ift.iftDynPerCm).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('FS4 GATE K: NIST dilute-gas viscosity anchors', () => {
  test.each(charRef.diluteViscosity)('$key at $tK K / 1 atm', (anchor) => {
    const tR = KtoR(anchor.tK);
    const mix = mixtureFromKeys([anchor.key]);
    const props = phaseProps(mix, [1], tR, 14.696);
    const mu = lbcViscosity(mix, [1], tR, props).viscosityCp;
    expect(relErr(mu, anchor.muCp)).toBeLessThan(anchor.relTol);
  });
});

describe('FS4 identity gates: transport', () => {
  const tR = degFtoR(150);

  test('Herning-Zipperer collapses to Stiel-Thodos for a pure component', () => {
    expect(diluteMixtureViscosity(mixtureFromKeys(['C3']), [1], tR))
      .toBe(diluteComponentViscosity(COMPONENTS.C3, tR));
  });

  test('LBC coefficients are the published Lohrenz et al. values', () => {
    expect(LBC_COEFFS).toEqual([0.1023, 0.023364, 0.058533, -0.040758, 0.0093324]);
  });

  test('viscosity rises with pressure along an isotherm (denser phase)', () => {
    const mix = mixtureFromKeys(['C1']);
    const lo = lbcViscosity(mix, [1], tR, phaseProps(mix, [1], tR, 500));
    const hi = lbcViscosity(mix, [1], tR, phaseProps(mix, [1], tR, 5000));
    expect(hi.rhoR).toBeGreaterThan(lo.rhoR);
    expect(hi.viscosityCp).toBeGreaterThan(lo.viscosityCp);
  });

  test('Weinaug-Katz IFT of identical phases is exactly zero', () => {
    const mix = mixtureFromKeys(['C1', 'C3']);
    const st = phaseProps(mix, [0.5, 0.5], tR, 500);
    expect(weinaugKatzIFT(mix, [0.5, 0.5], [0.5, 0.5], st, st).iftDynPerCm).toBe(0);
  });

  test('LBC refuses a component without critical volume; IFT refuses a missing parachor', () => {
    const mix = mixtureFromKeys(['C1', 'C3b'], { C3b: { ...COMPONENTS.C3, vcFt3PerLbmol: undefined } });
    const st = phaseProps(mix, [0.5, 0.5], tR, 500);
    expect(() => lbcViscosity(mix, [0.5, 0.5], tR, st)).toThrow(/vcFt3PerLbmol/);
    const mix2 = mixtureFromKeys(['C1', 'C3c'], { C3c: { ...COMPONENTS.C3, parachor: undefined } });
    const st2 = phaseProps(mix2, [0.5, 0.5], tR, 500);
    expect(() => weinaugKatzIFT(mix2, [0.5, 0.5], [0.5, 0.5], st2, st2)).toThrow(/parachor/);
  });
});
