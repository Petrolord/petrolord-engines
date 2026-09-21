// PT9: the petrophysics pipeline against the EFFECTIVE golden block —
// PHIT is the source porosity as read, PHIE the shale-corrected one,
// and the default recipe (Larionov-tertiary, Archie, Timur from Buckles
// Swirr, base cutoffs) runs on PHIE. Pre-existing goldens (on PHID) are
// consumed by the Suite suites; this one pins the v5 contract at the
// engine boundary so a subtree consumer cannot drift from it.

import fs from 'fs';
import path from 'path';
import { computeWell, computeWellZoned, zoneSummary, DEFAULT_PARAMS, PIPELINE_VERSION } from '../engines/petrophysics/pipeline';

const DATA_DIR = path.join(__dirname, '..', 'test-data', 'petrophysics');
const typewell = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'typewell.json'), 'utf8'));
const goldens = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'goldens.json'), 'utf8'));
const E = goldens.EFFECTIVE;

const curve = (name) => Float64Array.from(typewell.curves[name], (v) => (v === null ? NaN : v));
const curves = { DEPT: curve('DEPT'), GR: curve('GR'), RHOB: curve('RHOB'), NPHI: curve('NPHI'), DT: curve('DT'), RT: curve('RT') };
const params = { ...DEFAULT_PARAMS, phiShale: typewell.params.phi_shale, bucklesConst: E.params.bucklesConst };

const close = (a, b) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
const expectCurve = (got, want, label) => {
  expect(got.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    if (want[i] === null) { if (!Number.isNaN(got[i])) throw new Error(`${label}[${i}] expected NaN got ${got[i]}`); }
    else if (!close(got[i], want[i])) throw new Error(`${label}[${i}] ${got[i]} !== ${want[i]}`);
  }
};
const expectSummary = (got, want, label) => {
  for (const [k, gv] of Object.entries(want)) {
    if (gv === null) expect(got[k] === null || Number.isNaN(got[k])).toBe(true);
    else if (!close(got[k], gv)) throw new Error(`${label}.${k}: ${got[k]} !== ${gv}`);
  }
};

test('v5 contract: permeability on by default, PIPELINE_VERSION 5', () => {
  expect(DEFAULT_PARAMS.permMethod).toBe('timur');
  expect(PIPELINE_VERSION).toBe(6); // PT11d: phiSource 'mineral'
  expect(typeof DEFAULT_PARAMS.phiShale).toBe('number');
});

test('PHIT is the source porosity as read; PHIE is shale-corrected; Sw, k, BVW run on PHIE', () => {
  const { outputs, missing } = computeWell(curves, params);
  expect(missing).toEqual([]);
  expectCurve(outputs.PHIT, goldens.PHID, 'PHIT');
  expectCurve(outputs.PHIE, E.PHIE, 'PHIE');
  expectCurve(outputs.SW, E.SW_ARCHIE, 'SW');
  expectCurve(outputs.KPERM, E.K_TIMUR, 'KPERM');
  expectCurve(outputs.BVW, E.BVW, 'BVW');
  for (const [name, want] of Object.entries(E.ZONES)) {
    const [top, base] = typewell.params.zones[name];
    const s = zoneSummary(curves, outputs, params, { top_md_m: top, base_md_m: base });
    expectSummary(s, want.summary, name);
  }
});

test('linear Vsh shale correction recovers the construction porosity exactly', () => {
  const { outputs } = computeWell(curves, { ...params, vshMethod: 'linear' });
  expectCurve(outputs.PHIE, E.PHIE_LINEAR, 'PHIE_LINEAR');
  const phiTrue = typewell.construction.phi_true;
  for (let i = 0; i < phiTrue.length; i++) {
    if (Number.isNaN(outputs.PHIE[i])) continue;
    expect(Math.abs(outputs.PHIE[i] - phiTrue[i]) < 1e-12).toBe(true);
  }
});

test('modified Simandoux and the temperature path run on PHIE', () => {
  const ms = computeWell(curves, { ...params, swMethod: 'mod-simandoux' });
  expectCurve(ms.outputs.SW, E.SW_MOD_SIMANDOUX, 'SW_MS');
  const t = computeWell(curves, { ...params, tempMode: 'linear', ...goldens.TEMP.params });
  expectCurve(t.outputs.SW, E.SW_ARCHIE_T, 'SW_ARCHIE_T');
});

test('total-porosity models (Waxman-Smits, dual-water) keep running on PHIT', () => {
  const cp = goldens.CLAY.params;
  const ws = computeWell(curves, { ...params, swMethod: 'waxman-smits', qv: cp.qv, bMode: 'manual', bValue: cp.b, m: cp.mStar, n: cp.nStar });
  expectCurve(ws.outputs.SW, goldens.CLAY.SW_WS, 'SW_WS');
  const dw = computeWell(curves, { ...params, swMethod: 'dual-water', rwb: cp.rwb, swb: cp.swb });
  expectCurve(dw.outputs.SW, goldens.CLAY.SW_DW, 'SW_DW');
});

test('zoned compute on PHIE reproduces the EFFECTIVE.ZONED golden', () => {
  const zp = E.ZONED.zone_params;
  const list = Object.entries(zp).map(([name, patch]) => {
    const [top, base] = typewell.params.zones[name];
    return { top, base, params: patch };
  });
  const { outputs } = computeWellZoned(curves, params, list);
  expectCurve(outputs.SW, E.ZONED.SW, 'ZONED.SW');
  for (let i = 0; i < E.ZONED.PAY.length; i++) {
    const want = E.ZONED.PAY[i];
    const got = Number.isNaN(outputs.PAY[i]) ? 0 : outputs.PAY[i];
    if (got !== want) throw new Error(`ZONED.PAY[${i}] ${got} !== ${want}`);
  }
  for (const [name, want] of Object.entries(E.ZONED.zones)) {
    const [top, base] = typewell.params.zones[name];
    const s = zoneSummary(curves, outputs, { ...params, ...zp[name] }, { top_md_m: top, base_md_m: base });
    expectSummary(s, want.summary, `ZONED.${name}`);
  }
});

test('without GR there is no PHIE; Sw and k fall back to PHIT and missing says so', () => {
  const { outputs, missing } = computeWell({ DEPT: curves.DEPT, RHOB: curves.RHOB, RT: curves.RT }, params);
  expect(outputs.PHIT).toBeDefined();
  expect(outputs.PHIE).toBeUndefined();
  expect(outputs.SW).toBeDefined();
  expect(outputs.KPERM).toBeDefined();
  expect(outputs.PAY).toBeUndefined();
  expect(missing.some((m) => m.startsWith('GR'))).toBe(true);
});
