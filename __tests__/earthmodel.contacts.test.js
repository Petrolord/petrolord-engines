// Earth Modeling T1 (EM-T1-001): zone volumes split by the GOC and OWC,
// with STOIIP and GIIP from Bo and Bg. Expected values from
// tools/validation/earthmodel/oracle_contacts.py (stdlib, never this code);
// negcontrol_contacts.sh proves the gates go red on a wrong engine.
import fs from 'fs';
import path from 'path';
import { zoneVolumes, zoneVolumesWithContacts } from '../engines/earthmodeling/volumes.js';

const G = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'earthmodel', 'contacts_cases.json'), 'utf8'));
const n = G.top.length;
const fill = (v) => Float64Array.from({ length: n }, () => v);
const props = { ntg: fill(G.ntg), phi: fill(G.phi), sw: fill(G.sw) };
const labels = Int32Array.from(G.labels);
const near = (a, b) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(b)));
const KEYS = ['bulk_m3', 'net_m3', 'pore_m3', 'hcpv_m3', 'gas_hcpv_m3', 'oil_hcpv_m3', 'gas_bulk_m3', 'oil_bulk_m3'];

describe.each(G.cases.map((c) => [c.name, c]))('%s', (_n, c) => {
  test('every block and the total match the oracle', () => {
    const r = zoneVolumesWithContacts(G.spec, Float64Array.from(G.top), Float64Array.from(G.base), c.labels ? labels : null, props, c.fluids);
    expect(Object.keys(r).sort()).toEqual(Object.keys(c.expected).sort());
    for (const [blk, e] of Object.entries(c.expected)) {
      for (const k of KEYS) near(r[blk][k], e[k]);
      expect(r[blk].cells).toBe(e.cells);
      if (e.stoiip_m3 === null) expect(r[blk].stoiip_m3).toBeNull(); else near(r[blk].stoiip_m3, e.stoiip_m3);
      if (e.giip_m3 === null) expect(r[blk].giip_m3).toBeNull(); else near(r[blk].giip_m3, e.giip_m3);
    }
  });
});

test('with no contacts the split volumes equal zoneVolumes (all hydrocarbon)', () => {
  const thick = Float64Array.from(G.top, (t, i) => G.base[i] - t);
  const a = zoneVolumes(G.spec, thick, null, props);
  const b = zoneVolumesWithContacts(G.spec, Float64Array.from(G.top), Float64Array.from(G.base), null, props, {});
  for (const k of ['bulk_m3', 'net_m3', 'pore_m3', 'hcpv_m3']) near(b.total[k], a.total[k]);
});

test('the grid sums agree with the radial integral within 1%', () => {
  const c = G.cases.find((k) => k.name === 'goc_owc_fvf');
  expect(Math.abs(c.expected.total.gas_bulk_m3 / G.radial.gas_bulk_m3 - 1)).toBeLessThan(0.01);
  expect(Math.abs(c.expected.total.oil_bulk_m3 / G.radial.oil_bulk_m3 - 1)).toBeLessThan(0.01);
});

test('refusals: frame mismatch, non-positive FVF', () => {
  const s = { dx: 1, dy: 1, nx: 2, ny: 1 };
  expect(() => zoneVolumesWithContacts(s, [1, 2], [3], null)).toThrow(/share a frame/);
  expect(() => zoneVolumesWithContacts(s, [1, 2], [3, 4], null, {}, { bo: 0 })).toThrow(/Bo/);
  expect(() => zoneVolumesWithContacts(s, [1, 2], [3, 4], null, {}, { bg: -1 })).toThrow(/Bg/);
});
