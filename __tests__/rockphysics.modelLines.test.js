/**
 * Rock-model template lines (QI programme Q2, 2026-10-06): each line is the
 * validated dry model (granular.js, inclusion.js; goldens from the
 * independent oracles) followed by the validated Gassmann step. The gates
 * tie every line back to those goldens and to the existing critical-porosity
 * sand line, with negative controls.
 */

import fs from 'fs';
import path from 'path';
import {
  rockModelPoint, rockModelLine, rockModelMaxPhi, ROCK_MODELS, sandPoint,
} from '../engines/rockphysics/templates';
import { ksat } from '../engines/rockphysics/gassmann';

const GR = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/rockphysics/goldens.granular.json'), 'utf8'));
const IN = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/rockphysics/goldens.inclusion.json'), 'utf8'));
const QZ = { k: 36.6e9, mu: 45e9, rho: 2650 };
const BRINE = { k: 2.8e9, rho: 1030 };
const GAS = { k: 0.05e9, rho: 150 };
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-30);
const phis = Array.from({ length: 41 }, (_, i) => i / 100);

test('five models are offered', () => {
  expect(ROCK_MODELS.map((m) => m.key)).toEqual(['critical', 'soft', 'stiff', 'constantCement', 'xuWhite']);
});

test('the critical model is the existing sand line, point for point', () => {
  for (const phi of [0, 0.1, 0.25, 0.39]) {
    const a = rockModelPoint('critical', QZ, BRINE, phi);
    const b = sandPoint(QZ, BRINE, phi);
    expect(a.vp).toBe(b.vp);
    expect(a.vs).toBe(b.vs);
  }
});

test.each([['soft', 'softSand'], ['stiff', 'stiffSand']])('%s: the dry frame is the oracle golden and Gassmann puts brine in', (model, key) => {
  const g = GR[key].find((r) => r.phi === 0.2);
  const p = rockModelPoint(model, QZ, BRINE, 0.2, { phiC: g.phiC, n: g.n, pMPa: g.P / 1e6 });
  expect(rel(p.kdry, g.k)).toBeLessThan(1e-12);
  expect(rel(p.mudry, g.g)).toBeLessThan(1e-12);
  const ks = ksat(g.k, QZ.k, BRINE.k, 0.2);
  const rho = 0.8 * QZ.rho + 0.2 * BRINE.rho;
  expect(rel(p.vp, Math.sqrt((ks + (4 / 3) * g.g) / rho))).toBeLessThan(1e-12);
  expect(rel(p.vs, Math.sqrt(g.g / rho))).toBeLessThan(1e-12);
});

test('constant cement: the dry frame is the oracle golden', () => {
  const g = GR.constantCement.find((r) => r.phi === 0.2);
  const p = rockModelPoint('constantCement', QZ, BRINE, 0.2, { phiB: g.phiB, phiC: g.phi0, n: g.n });
  expect(rel(p.kdry, g.k)).toBeLessThan(1e-12);
  expect(rel(p.mudry, g.g)).toBeLessThan(1e-12);
});

test('Xu-White: the dry frame is the oracle two-pore DEM golden (200 steps, 1e-6)', () => {
  const g = IN.dem.find((r) => r.inclusions.length === 2);
  const p = rockModelPoint('xuWhite', QZ, BRINE, g.y, { clayShare: 0.3, alphaSand: 0.12, alphaClay: 0.03 });
  expect(rel(p.kdry, g.K)).toBeLessThan(1e-6);
  expect(rel(p.mudry, g.G)).toBeLessThan(1e-6);
});

test('lines stop at each model reach and start at the mineral', () => {
  expect(rockModelLine('soft', QZ, BRINE, phis).at(-1).phi).toBe(0.36);
  expect(rockModelLine('constantCement', QZ, BRINE, phis, { phiB: 0.3 }).at(-1).phi).toBe(0.3);
  expect(rockModelLine('critical', QZ, BRINE, phis).at(-1).phi).toBe(0.39);
  expect(rockModelLine('xuWhite', QZ, BRINE, phis).at(-1).phi).toBe(0.4);
  expect(rockModelMaxPhi('stiff', { phiC: 0.4 })).toBe(0.4);
  for (const m of ROCK_MODELS) expect(rockModelLine(m.key, QZ, BRINE, [0])[0].vp).toBeCloseTo(Math.sqrt((QZ.k + (4 / 3) * QZ.mu) / QZ.rho), 6);
});

test('stiff sand sits above soft sand in impedance at every interior porosity', () => {
  const s = rockModelLine('soft', QZ, BRINE, phis);
  const t = rockModelLine('stiff', QZ, BRINE, phis);
  for (let i = 1; i < s.length - 1; i++) expect(t[i].ai).toBeGreaterThan(s[i].ai);
});

test('higher effective pressure stiffens the soft-sand line', () => {
  const a = rockModelPoint('soft', QZ, BRINE, 0.25, { pMPa: 10 });
  const b = rockModelPoint('soft', QZ, BRINE, 0.25, { pMPa: 40 });
  expect(b.ai).toBeGreaterThan(a.ai);
});

test('negative control: gas lowers impedance and Vp/Vs against brine on every model', () => {
  for (const m of ROCK_MODELS) {
    const b = rockModelPoint(m.key, QZ, BRINE, 0.25);
    const g = rockModelPoint(m.key, QZ, GAS, 0.25);
    expect(g.ai).toBeLessThan(b.ai);
    expect(g.vpvs).toBeLessThan(b.vpvs);
  }
});

test('refuses an unknown model and a fluid without modulus', () => {
  expect(() => rockModelPoint('nope', QZ, BRINE, 0.2)).toThrow(/Unknown rock model/);
  expect(() => rockModelPoint('soft', QZ, { k: 0, rho: 1000 }, 0.2)).toThrow(/pore fluid/);
});

test('the one-pass Xu-White line equals point-by-point Xu-White (path DEM against per-point DEM)', () => {
  const line = rockModelLine('xuWhite', QZ, BRINE, [0.3, 0.05, 0.2]);
  for (const p of line) {
    const q = rockModelPoint('xuWhite', QZ, BRINE, p.phi);
    expect(rel(p.kdry, q.kdry)).toBeLessThan(1e-7);
    expect(rel(p.vp, q.vp)).toBeLessThan(1e-7);
  }
  expect(line.map((p) => p.phi)).toEqual([0.3, 0.05, 0.2]);
});
