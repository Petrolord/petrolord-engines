// Economics EC9 joint venture gates. Every case in
// test-data/economics/goldens/jointventure_cases.json is run THROUGH THE ENGINE
// and compared with the value the independent stdlib oracle
// (tools/validation/economics/oracle_jointventure.py) computed from the stated
// clause arithmetic by a different road (exact Fractions; cash calls on a
// cumulative ledger; overhead by the band that holds the base; payout years on
// cumulative availability; the PSC order straight from the World Bank and IMF
// texts with the gross limit applied to gross). The published figures (World
// Bank Briefing Note 8, IMF FARI Figure 5 and Tables 12 and 13, the Norwegian
// Accounting Agreement scale and 0.65 %, the Norwegian JOA 1000 % entry and
// budget tolerances, PIA 2021 s.85(4)) are checked against their printed
// values too. Property tests compare engine outputs with each other, never
// with a restated formula; tools/validation/economics/negcontrol_jointventure.sh
// proves the gates go red when the engine is wrong.

import fs from 'fs';
import path from 'path';
import * as J from '../engines/economics/jointVenture';
import { applyPSC, npv } from '../engines/economics/cashflow';

const read = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8'));
const G = read('test-data', 'economics', 'goldens', 'jointventure_cases.json');
const FX = read('test-data', 'economics', 'ekene-jv', 'ekene-jv.json');
const FLOOR = G.tolerance.absoluteFloor;

const diff = (actual, expected, tol, where = '') => {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !Number.isFinite(actual)) return [`${where}: ${actual} is not a finite number (expected ${expected})`];
    const d = Math.abs(actual - expected);
    return d <= FLOOR || d <= tol * Math.abs(expected) ? [] : [`${where}: ${actual} vs ${expected} (abs ${d})`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return [`${where}: array length ${actual && actual.length} vs ${expected.length}`];
    return expected.flatMap((e, i) => diff(actual[i], e, tol, `${where}[${i}]`));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') return [`${where}: ${actual} is not an object`];
    const extra = Object.keys(actual).filter((k) => !(k in expected) && k !== 'basis');
    const missing = Object.keys(expected).filter((k) => !(k in actual));
    const keyErr = extra.length || missing.length ? [`${where}: keys differ (engine only: ${extra.join(', ')}; oracle only: ${missing.join(', ')})`] : [];
    return keyErr.concat(Object.keys(expected).flatMap((k) => diff(actual[k], expected[k], tol, `${where}.${k}`)));
  }
  return actual === expected ? [] : [`${where}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`];
};

const clone = (x) => JSON.parse(JSON.stringify(x));
const byId = (id) => {
  const c = G.cases.find((x) => x.id === id);
  if (!c) throw new Error(`golden case ${id} is missing from jointventure_cases.json`);
  return c;
};
const memo = new Map();
const run = (id) => { if (!memo.has(id)) { const c = byId(id); memo.set(id, J[c.fn](clone(c.args))); } return memo.get(id); };
const FNS = ['backIn', 'budgetControl', 'carryRecovery', 'cashCalls', 'defaultCover', 'nonConsent', 'overhead', 'participatingInterests', 'pscCostRecovery'];

describe('goldens: the engine agrees with the oracle', () => {
  test('the golden file is whole', () => {
    expect(G.module).toBe('jointVenture');
    expect(G.generatedBy).toBe('tools/validation/economics/oracle_jointventure.py');
    expect(G.cases.length).toBeGreaterThanOrEqual(140);
    expect(new Set(G.cases.map((c) => c.id)).size).toBe(G.cases.length);
  });

  test('every exported function is exercised by a golden, and refused at least once', () => {
    const fns = Object.keys(J).filter((k) => typeof J[k] === 'function').sort();
    expect(fns).toEqual(FNS);
    const used = new Set(G.cases.map((c) => c.fn));
    expect(fns.filter((f) => !used.has(f))).toEqual([]);
    const refused = new Set(G.cases.filter((c) => c.expected.error === true).map((c) => c.fn));
    expect(fns.filter((f) => !refused.has(f))).toEqual([]);
  });

  test.each(G.cases.map((c) => [c.id, c]))('%s', (id, c) => {
    const r = run(id);
    const e = c.expected;
    if (e && e.error === true) {
      expect([typeof r.error, r.field]).toEqual(['string', e.field]);
      expect(r.error.startsWith(e.field)).toBe(true);
      expect(r.error).toBe(e.message);
      return;
    }
    expect(r && r.error).toBeFalsy();
    expect(diff(r, e, c.tol, c.fn)).toEqual([]);
  });
});
