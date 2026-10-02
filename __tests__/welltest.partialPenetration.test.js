/**
 * Partial-penetration pseudo-skin and the skin split.
 *
 * The gate calls the engine and holds it to the independent series solution
 * in the goldens (tools/validation/welltest/oracle_partial_penetration.py:
 * uniform-flux line source in a sealed slab, pressure averaged over the open
 * interval, K0 by numerical integration). Papatzacos is an approximation for
 * an infinite-conductivity well, so the two agree to a band, not to a digit;
 * the band is tight enough that the three ways the formula is usually typed
 * wrong (kh/kv for kv/kh, no square root on the anisotropy, A and B
 * exchanged) each fall outside it. Those three are run below as the
 * negative control.
 */
import fs from 'fs';
import path from 'path';
import {
  papatzacosPseudoSkin, bronsMartingPseudoSkin, bronsMartingG, decomposeSkin, partialPenetrationSkin,
  PAPATZACOS_FORMULA, PAPATZACOS_REFERENCE, SKIN_SPLIT_FORMULA, FULL_PENETRATION_TOLERANCE,
} from '../engines/welltest/partialPenetration.js';

const goldens = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../test-data/welltest/partial-penetration-goldens.json'), 'utf8'),
);

// The band the engine is held to against the independent series.
const BAND_ABS = 0.6;
const BAND_REL = 0.1;
const inBand = (value, truth) => Math.abs(value - truth) <= BAND_ABS && Math.abs(value - truth) <= BAND_REL * Math.abs(truth);

describe('Papatzacos pseudo-skin against the independent series', () => {
  test('the goldens file carries the cases', () => {
    expect(goldens.pseudoSkin.length).toBeGreaterThanOrEqual(10);
  });

  test.each(goldens.pseudoSkin.map((r) => [r.name, r]))('%s', (_name, r) => {
    const out = papatzacosPseudoSkin(r);
    expect(out.ok).toBe(true);
    expect(inBand(out.spp, r.series)).toBe(true);
    // and the arithmetic matches the formula typed out longhand in Python
    expect(Math.abs(out.spp - r.papatzacos)).toBeLessThan(1e-11);
  });

  test('negative control: the three usual mistypings leave the band', () => {
    const wrong = {
      'kh/kv for kv/kh': (r) => papatzacosPseudoSkin({ ...r, kvkh: 1 / r.kvkh }).spp,
      'no square root on kv/kh': (r) => papatzacosPseudoSkin({ ...r, kvkh: r.kvkh * r.kvkh }).spp,
      // A and B exchanged flips the sign of the logarithm of their ratio
      'A and B exchanged': (r) => {
        const o = papatzacosPseudoSkin(r);
        return o.spp - (1 / o.hpD) * Math.log((o.A - 1) / (o.B - 1));
      },
    };
    for (const [name, fn] of Object.entries(wrong)) {
      // only cases where the mistake changes anything (anisotropic for the first two)
      const cases = goldens.pseudoSkin.filter((r) => (name === 'A and B exchanged' ? true : r.kvkh !== 1));
      const missed = cases.filter((r) => inBand(fn(r), r.series));
      expect({ name, missed: missed.map((r) => r.name) }).toEqual({ name, missed: [] });
      expect(cases.length).toBeGreaterThan(3);
    }
  });
});

describe('exact properties of the formula', () => {
  test('a fully open pay has zero pseudo-skin', () => {
    const out = papatzacosPseudoSkin({ h: 100, hp: 100, h1: 0, rw: 0.25, kvkh: 0.1 });
    expect(out).toMatchObject({ ok: true, spp: 0, fullyOpen: true });
    // and the formula itself tends to zero there, so the snap hides no jump
    const near = papatzacosPseudoSkin({ h: 100, hp: 100 * (1 - 2 * FULL_PENETRATION_TOLERANCE), h1: 0, rw: 0.25, kvkh: 0.1 });
    expect(near.fullyOpen).toBe(false);
    expect(near.spp).toBeGreaterThan(0);
    expect(near.spp).toBeLessThan(0.15);
  });

  test('an interval and its mirror image give the same value', () => {
    for (const [h, hp, h1] of [[100, 20, 0], [100, 30, 15], [45, 15, 5], [150, 30, 100]]) {
      const a = papatzacosPseudoSkin({ h, hp, h1, rw: 0.3, kvkh: 0.2 }).spp;
      const b = papatzacosPseudoSkin({ h, hp, h1: h - hp - h1, rw: 0.3, kvkh: 0.2 }).spp;
      expect(Math.abs(a - b)).toBeLessThan(1e-12 * Math.max(1, Math.abs(a)));
    }
  });

  test('less opening, less vertical permeability and a thinner well each raise it', () => {
    const base = { h: 100, hp: 40, h1: 0, rw: 0.3, kvkh: 0.1 };
    const s = (o) => papatzacosPseudoSkin({ ...base, ...o }).spp;
    expect(s({ hp: 20 })).toBeGreaterThan(s({}));
    expect(s({ kvkh: 0.01 })).toBeGreaterThan(s({}));
    expect(s({ rw: 0.15 })).toBeGreaterThan(s({}));
    // a centred interval converges from both sides and costs less than one at the top
    expect(s({ h1: 30 })).toBeLessThan(s({}));
  });

  test('the result names its method, formula and reference', () => {
    const out = papatzacosPseudoSkin({ h: 100, hp: 20, h1: 0, rw: 0.25, kvkh: 0.1 });
    expect(out.method).toBe('Papatzacos (1987)');
    expect(out.formula).toBe(PAPATZACOS_FORMULA);
    expect(out.reference).toBe(PAPATZACOS_REFERENCE);
    expect(out.hpD).toBeCloseTo(0.2, 12);
    expect(out.rD).toBeCloseTo((0.25 / 100) * Math.sqrt(0.1), 15);
  });
});

describe('Brons and Marting as the second published estimate', () => {
  test.each(goldens.pseudoSkin.filter((r) => r.position).map((r) => [r.name, r]))('%s', (_name, r) => {
    const out = bronsMartingPseudoSkin(r);
    expect(out.ok).toBe(true);
    expect(Math.abs(out.spp - r.bronsMarting)).toBeLessThan(1e-11);
    // two published correlations for the same geometry stay close
    const pap = papatzacosPseudoSkin(r).spp;
    expect(Math.abs(out.spp - pap)).toBeLessThan(1.3);
  });

  test('G(b) is the published polynomial and the positions are limited', () => {
    expect(bronsMartingG(0.5)).toBeCloseTo(2.948 - 7.363 * 0.5 + 11.45 * 0.25 - 4.675 * 0.125, 14);
    expect(bronsMartingPseudoSkin({ h: 100, hp: 20, rw: 0.25, kvkh: 1, position: 'somewhere' })).toMatchObject({ ok: false, code: 'bad-position' });
    expect(bronsMartingPseudoSkin({ h: 100, hp: 100, rw: 0.25, kvkh: 1 }).spp).toBe(0);
  });
});

describe('hostile inputs are refused with a reason and no number', () => {
  const good = { h: 100, hp: 20, h1: 0, rw: 0.25, kvkh: 0.1 };
  test.each([
    ['missing net pay', { h: NaN }, 'no-net-pay'],
    ['zero net pay', { h: 0 }, 'no-net-pay'],
    ['missing perforated length', { hp: undefined }, 'no-open-interval'],
    ['perforations longer than the pay', { hp: 130 }, 'interval-longer-than-pay'],
    ['interval running out of the base', { hp: 40, h1: 70 }, 'interval-outside-pay'],
    ['zero kv/kh', { kvkh: 0 }, 'no-anisotropy'],
    ['negative kv/kh', { kvkh: -0.1 }, 'no-anisotropy'],
    ['missing kv/kh', { kvkh: null }, 'no-anisotropy'],
    ['missing rw', { rw: NaN }, 'no-wellbore-radius'],
    ['negative offset', { h1: -5 }, 'bad-offset'],
  ])('%s', (_name, patch, code) => {
    const out = papatzacosPseudoSkin({ ...good, ...patch });
    expect(out.ok).toBe(false);
    expect(out.code).toBe(code);
    expect(out.reason).toMatch(/\S/);
    expect(out.spp).toBeUndefined();
  });

  test('an overshoot inside the tolerance is the whole pay, not an error', () => {
    const out = papatzacosPseudoSkin({ ...good, hp: 100.3 });
    expect(out).toMatchObject({ ok: true, spp: 0, fullyOpen: true, hpD: 1 });
  });
});

describe('the skin split', () => {
  test('s = (h/hp) s_d + s_pp closes exactly', () => {
    for (const [totalSkin, h, hp, spp] of [[12, 100, 20, 9], [25, 45, 15, 9.0072], [3, 100, 50, 4.66], [-2, 80, 80, 0]]) {
      const out = decomposeSkin({ totalSkin, h, hp, spp });
      expect(out.ok).toBe(true);
      expect((h / hp) * out.mechanicalSkin + out.spp).toBeCloseTo(totalSkin, 12);
      expect(out.formula).toBe(SKIN_SPLIT_FORMULA);
    }
  });

  test('negative control: without the hp/h factor the identity breaks', () => {
    const { mechanicalSkin } = decomposeSkin({ totalSkin: 25, h: 45, hp: 15, spp: 9 });
    expect(mechanicalSkin).toBeCloseTo((15 / 45) * 16, 12);
    expect(mechanicalSkin).not.toBeCloseTo(16, 3); // the unscaled difference
  });

  test('a total skin below the pseudo-skin gives a negative mechanical skin, stated not hidden', () => {
    const out = decomposeSkin({ totalSkin: 5, h: 100, hp: 20, spp: 16.8 });
    expect(out.mechanicalSkin).toBeCloseTo(0.2 * (5 - 16.8), 12);
  });

  test('refusals', () => {
    expect(decomposeSkin({ totalSkin: null, h: 100, hp: 20, spp: 9 })).toMatchObject({ ok: false, code: 'no-total-skin' });
    expect(decomposeSkin({ totalSkin: 5, h: 100, hp: 20, spp: NaN })).toMatchObject({ ok: false, code: 'no-pseudo-skin' });
    expect(decomposeSkin({ totalSkin: 5, h: 100, hp: 130, spp: 1 })).toMatchObject({ ok: false, code: 'interval-longer-than-pay' });
  });

  test('partialPenetrationSkin joins the two, and leaves the split out when no total skin is given', () => {
    const geo = { h: 45, hp: 15, h1: 0, rw: 0.354, kvkh: 0.1 };
    const out = partialPenetrationSkin({ ...geo, totalSkin: 20 });
    expect(out.ok).toBe(true);
    expect(out.spp).toBeCloseTo(papatzacosPseudoSkin(geo).spp, 14);
    expect(out.split.mechanicalSkin).toBeCloseTo((15 / 45) * (20 - out.spp), 12);
    expect(partialPenetrationSkin(geo).split).toBeNull();
    expect(partialPenetrationSkin({ ...geo, kvkh: 0, totalSkin: 20 })).toMatchObject({ ok: false, code: 'no-anisotropy' });
  });
});
