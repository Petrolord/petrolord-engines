/**
 * One AVO classifier for Rock Physics Studio and QI Studio (owner decision
 * 2026-10-12). Before it, the two put a value lying exactly on a class border
 * in different classes. The convention is in engines/rockphysics/avo.js:
 * class II is the closed band |A| <= t, class IV needs B above zero.
 * Independent references: tools/validation/rockphysics/oracle.py (avo_class)
 * and tools/validation/qi/oracle_qi_avo.py, whose goldens both gates read.
 */
import { avoClass as rpClass } from '../engines/rockphysics/avo';
import { avoClass as qiClass } from '../engines/qi/avo';
import QI from '../test-data/qi/goldens.qiAvo.json';

const BORDERS = [
  [0.02, -0.3, 'II'], [0.0200001, -0.3, 'I'], [-0.02, -0.3, 'II'], [-0.02, 0.3, 'II'],
  [-0.0200001, -0.3, 'III'], [-0.0200001, 0, 'III'], [-0.0200001, 1e-12, 'IV'], [-0.05, 0, 'III'],
  [0, 0, 'II'], [0.05, 0.4, 'I'],
];

test('QI Studio and Rock Physics Studio call the same function', () => {
  expect(qiClass).toBe(rpClass);
});

test.each(BORDERS)('A %p, B %p is class %p in both apps', (A, B, want) => {
  expect(rpClass(A, B)).toBe(want);
  expect(qiClass(A, B, { band: 0.02 })).toBe(want);
  expect(rpClass(A, B, 0.02)).toBe(want);
});

test('the QI oracle goldens agree with the shared classifier at every border case', () => {
  expect(QI.classes.length).toBeGreaterThanOrEqual(15);
  for (const c of QI.classes) expect(rpClass(c.A, c.B)).toBe(c.avoClass);
});

test('the band is read from a number or from { band }', () => {
  expect(rpClass(0.03, -0.1, 0.05)).toBe('II');
  expect(qiClass(0.03, -0.1, { band: 0.05 })).toBe('II');
  expect(qiClass(0.03, -0.1, {})).toBe('I');
});

test('a value that is not a finite number has no class', () => {
  for (const [A, B] of [[NaN, 0.1], [0.1, NaN], [null, 0.1], [0.1, undefined], [Infinity, 0]]) {
    expect(rpClass(A, B)).toBeNull();
  }
});

test('negative control: the earlier QI rule disagrees on the border cases this test pins', () => {
  const oldQi = (A, B, band = 0.02) => (A >= band ? 'I' : A > -band ? 'II' : B < 0 ? 'III' : 'IV');
  const differ = BORDERS.filter(([A, B, want]) => oldQi(A, B) !== want);
  expect(differ.length).toBeGreaterThanOrEqual(3);
});
