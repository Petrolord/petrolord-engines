/**
 * SCAL Studio U2 fits (SCAL-U2-003, SCAL-U2-004).
 *
 * U2-003: a Corey fit to a lab kr table that stops short of an end point
 * (unsteady-state data seldom reach residual oil), with Swc and Sor stated
 * by the user. Before, validateKrTable refused the table ("kro at the
 * highest Sw should be 0").
 *
 * U2-004: a Corey fit to a gas-oil lab table at connate water, through the
 * oil-water fit on the mapped axis.
 *
 * Truth is synthetic and noise-free: the tables are made by the engine's
 * own Corey builders (buildCoreyOilWater, buildCoreyGasOil) from known
 * parameters, so a correct fit returns those parameters to optimiser
 * precision. No published lab kr table with a published Corey fit was found
 * to hold these against (see docs/upgrade/SCALStudio-UPGRADE.md); the
 * negative controls below show each gate can fail.
 */
import {
  buildCoreyOilWater,
  buildCoreyGasOil,
  coreyKrGasOil,
  fitCoreyToKrTable,
  fitCoreyGasOilToKrTable,
} from '../engines/scal/scal.js';
import { coreyKr, validateKrTable } from '../engines/scal/fractionalFlow.js';

const TRUE_OW = { Swc: 0.2, Sor: 0.25, krwMax: 0.35, kroMax: 0.9, nw: 2.5, no: 2.0 };
const TRUE_GO = { Swc: 0.18, Sgc: 0.04, Sorg: 0.12, krgMax: 0.7, krogMax: 0.8, ng: 1.8, nog: 2.6 };

/** Engine rows of a set, kept between two saturations (a lab table that stops short). */
const owTable = (lo, hi, n = 40) => buildCoreyOilWater(TRUE_OW, { n }).rows
  .filter((r) => r.Sw >= lo - 1e-12 && r.Sw <= hi + 1e-12);
const goTable = (lo, hi, p = TRUE_GO, n = 40) => buildCoreyGasOil(p, { n }).rows
  .filter((r) => r.Sg >= lo - 1e-12 && r.Sg <= hi + 1e-12);

describe('SCAL-U2-003: Corey fit with entered Swc and Sor', () => {
  const short = owTable(0.2, 0.62); // stops short of 1 - Sor = 0.75: kro never reaches 0

  it('the table really lacks the end point: the default fit refuses it, as before', () => {
    expect(short[short.length - 1].kro).toBeGreaterThan(0.01);
    const res = fitCoreyToKrTable(short);
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/kro at the highest Sw should be 0/);
  });

  it('with Swc and Sor stated, the fit returns the generating set; krw(Sor) is fitted', () => {
    const res = fitCoreyToKrTable(short, { fixedEndpoints: { Swc: 0.2, Sor: 0.25 } });
    expect(res.ok).toBe(true);
    expect(res.endpointSource).toEqual({ Swc: 'entered', Sor: 'entered', krwMax: 'fitted', kroMax: 'table' });
    expect(res.params.nw).toBeCloseTo(2.5, 5);
    expect(res.params.no).toBeCloseTo(2.0, 5);
    expect(res.params.krwMax).toBeCloseTo(0.35, 5);
    expect(res.params.kroMax).toBe(short[0].kro);
    expect(res.ci95.krwMax).toHaveLength(2);
    expect(res.r2Log).toBeGreaterThan(0.999999);
  });

  it('a table short at both ends: both end point kr are fitted', () => {
    const both = owTable(0.26, 0.62);
    const res = fitCoreyToKrTable(both, { fixedEndpoints: { Swc: 0.2, Sor: 0.25 } });
    expect(res.ok).toBe(true);
    expect(res.endpointSource).toMatchObject({ krwMax: 'fitted', kroMax: 'fitted' });
    for (const k of ['nw', 'no', 'krwMax', 'kroMax']) expect(res.params[k]).toBeCloseTo(TRUE_OW[k], 4);
  });

  it('NEGATIVE CONTROL: the table-implied end point (Sor = 1 - last Sw) gives a wrong set', () => {
    const last = short[short.length - 1].Sw;
    // what a fit that took the end point from the short table would report
    const wrong = fitCoreyToKrTable(short, { fixedEndpoints: { Swc: 0.2, Sor: 1 - last } });
    // the table's last row is then the "end point": kro there is not 0, so the fit cannot match
    expect(wrong.ok).toBe(true);
    expect(Math.abs(wrong.params.no - TRUE_OW.no)).toBeGreaterThan(0.3);
  });

  it('a full table and its own end points give the same fit as before (no stated end points)', () => {
    const full = buildCoreyOilWater(TRUE_OW, { n: 12 }).rows;
    const a = fitCoreyToKrTable(full);
    const b = fitCoreyToKrTable(full, { fixedEndpoints: { Swc: 0.2, Sor: 0.25 } });
    expect(a.endpointSource).toEqual({ Swc: 'table', Sor: 'table', krwMax: 'table', kroMax: 'table' });
    expect(b.endpointSource).toEqual({ Swc: 'entered', Sor: 'entered', krwMax: 'table', kroMax: 'table' });
    for (const k of ['nw', 'no', 'krwMax', 'kroMax']) expect(b.params[k]).toBeCloseTo(a.params[k], 10);
  });

  it('refuses rows outside the stated mobile range, with the reason', () => {
    const res = fitCoreyToKrTable(short, { fixedEndpoints: { Swc: 0.25, Sor: 0.25 } });
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/below the stated Swc 0\.25/);
    const hi = fitCoreyToKrTable(short, { fixedEndpoints: { Swc: 0.2, Sor: 0.4 } });
    expect(hi.ok).toBe(false);
    expect(hi.errors[0]).toMatch(/above 1 - Sor/);
    expect(fitCoreyToKrTable(short, { fixedEndpoints: { Swc: 0.2 } }).ok).toBe(false);
  });

  it('validateKrTable keeps its end point rule by default (Waterflood relies on it)', () => {
    expect(validateKrTable(short).ok).toBe(false);
    expect(validateKrTable(short, { requireEndpoints: false }).ok).toBe(true);
  });
});

describe('SCAL-U2-004: Corey fit to a gas-oil lab table', () => {
  it('the gas-oil form is the oil-water form on the mapped axis (identity the fit rests on)', () => {
    const mapped = { Swc: TRUE_GO.Sgc, Sor: TRUE_GO.Swc + TRUE_GO.Sorg, krwMax: TRUE_GO.krgMax, kroMax: TRUE_GO.krogMax, nw: TRUE_GO.ng, no: TRUE_GO.nog };
    for (let Sg = 0; Sg <= 1 - TRUE_GO.Swc; Sg += 0.01) {
      const a = coreyKrGasOil(Sg, TRUE_GO);
      const b = coreyKr(Sg, mapped);
      expect(Math.abs(a.krg - b.krw)).toBeLessThan(1e-14);
      expect(Math.abs(a.krog - b.kro)).toBeLessThan(1e-14);
    }
  });

  it('a full gas-oil table returns all seven parameters', () => {
    const res = fitCoreyGasOilToKrTable(goTable(0, 1), { Swc: TRUE_GO.Swc });
    expect(res.ok).toBe(true);
    expect(res.endpointSource).toEqual({ Sgc: 'table', Sorg: 'table', krgMax: 'table', krogMax: 'table' });
    expect(res.params.Swc).toBe(TRUE_GO.Swc);
    for (const k of ['Sgc', 'Sorg', 'krgMax', 'krogMax']) expect(res.params[k]).toBeCloseTo(TRUE_GO[k], 10);
    expect(res.params.ng).toBeCloseTo(TRUE_GO.ng, 5);
    expect(res.params.nog).toBeCloseTo(TRUE_GO.nog, 5);
    expect(res.ci95.ng).toHaveLength(2);
  });

  it('a gas-oil table short of residual oil, with Sgc and Sorg stated', () => {
    const short = goTable(0, 0.5);
    expect(fitCoreyGasOilToKrTable(short, { Swc: TRUE_GO.Swc }).ok).toBe(false);
    const res = fitCoreyGasOilToKrTable(short, { Swc: TRUE_GO.Swc, fixedEndpoints: { Sgc: 0.04, Sorg: 0.12 } });
    expect(res.ok).toBe(true);
    expect(res.endpointSource).toMatchObject({ Sgc: 'entered', Sorg: 'entered', krgMax: 'fitted' });
    for (const k of ['krgMax', 'ng', 'nog']) expect(res.params[k]).toBeCloseTo(TRUE_GO[k], 4);
  });

  it('NEGATIVE CONTROL: krg and krog swapped is refused with gas-oil words', () => {
    const swapped = goTable(0, 1).map((r) => ({ Sg: r.Sg, krg: r.krog, krog: r.krg }));
    const res = fitCoreyGasOilToKrTable(swapped, { Swc: TRUE_GO.Swc });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/krg must be non-decreasing in Sg/);
  });

  it('NEGATIVE CONTROL: a wrong Swc moves Sorg and nothing else', () => {
    const t = goTable(0, 1);
    const right = fitCoreyGasOilToKrTable(t, { Swc: TRUE_GO.Swc });
    const wrong = fitCoreyGasOilToKrTable(t, { Swc: 0.1 });
    expect(wrong.params.Sorg).toBeCloseTo(TRUE_GO.Sorg + 0.08, 10);
    expect(wrong.params.ng).toBeCloseTo(right.params.ng, 10);
  });

  it('refuses a table with no Swc, and one that leaves no room for it', () => {
    expect(fitCoreyGasOilToKrTable(goTable(0, 1), {}).errors[0]).toMatch(/State the connate water/);
    const res = fitCoreyGasOilToKrTable(goTable(0, 1), { Swc: 0.4 });
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/no room for the stated connate water/);
  });
});
