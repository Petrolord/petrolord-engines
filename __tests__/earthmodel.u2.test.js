// Earth Modeling upgrade U2 (2026-10-01): two engine changes the Suite
// build needs.
//
// 1. U2-004 / EM-U1-022: the kriging systems checked the variogram on
//    EVERY covariance call ((k + 1)^2 per system plus k per target).
//    covarianceFn checks it once and returns the covariance as a function;
//    its values equal variogramCovariance exactly, and the kriging goldens
//    (mapping.kriging.test.js) still hold through okSystem.
// 2. U2-006: zoneVolumesWithContacts takes a contact per NODE, so a trap
//    bounded by its closure and spill can give each node its own contact.
//    Gate: the oracle's per-block case (tools/validation/earthmodel/
//    oracle_contacts.py via contacts_cases.json) expressed per node gives
//    the oracle's numbers; a scalar spread over every node equals the
//    scalar.
//
// Negative controls (run 2026-10-01): with covarianceFn delegating to
// variogramCovariance per call the "checked once" gate reads the
// parameters 1000 times and fails; with contactFor ignoring the node index
// the per-node gates fail (a typed array is then read as a block map).
import fs from 'fs';
import path from 'path';
import {
  covarianceFn, variogramCovariance, krigePoints, VARIOGRAM_MODELS,
} from '../lib/gridding/kriging.js';
import { zoneVolumesWithContacts } from '../engines/earthmodeling/volumes.js';

/** Variogram parameters whose reads are counted (variogramParams reads each field once per check). */
function countingParams(p) {
  const counter = { reads: 0 };
  const o = {};
  for (const k of ['model', 'range', 'sill', 'nugget']) {
    Object.defineProperty(o, k, { enumerable: true, get() { if (k === 'model') counter.reads += 1; return p[k]; } });
  }
  return { params: o, counter };
}

describe('U2-004: the variogram is checked once', () => {
  test('covarianceFn equals variogramCovariance exactly for every model', () => {
    for (const model of VARIOGRAM_MODELS) {
      const p = { model, range: 900, sill: 0.0025, nugget: 0.00025 };
      const f = covarianceFn(p);
      for (const h of [0, -1, 1e-9, 1, 50, 449.5, 899.999, 900, 900.001, 2500, 1e6]) {
        expect(f(h)).toBe(variogramCovariance(h, p));
      }
    }
  });

  test('checked once for a function called many times; the old path checks per call', () => {
    const { params, counter } = countingParams({ model: 'spherical', range: 500, sill: 1, nugget: 0.1 });
    const f = covarianceFn(params);
    for (let i = 0; i < 1000; i++) f(i);
    expect(counter.reads).toBe(1);
    // negative control: the per-call function reads the parameters every time
    const neg = countingParams({ model: 'spherical', range: 500, sill: 1, nugget: 0.1 });
    for (let i = 0; i < 1000; i++) variogramCovariance(i, neg.params);
    expect(neg.counter.reads).toBe(1000);
  });

  test('a bad variogram is refused when the function is made', () => {
    expect(() => covarianceFn({ model: 'cubic', range: 1, sill: 1 })).toThrow(/Unknown variogram model/);
    expect(() => covarianceFn({ model: 'spherical', range: 0, sill: 1 })).toThrow(/range greater than zero/);
    expect(() => covarianceFn({ model: 'spherical', range: 1, sill: 1, nugget: 1 })).toThrow(/nugget/);
  });

  test('krigePoints through the hoisted covariance equals a solve with variogramCovariance', () => {
    const pts = Array.from({ length: 12 }, (_, i) => ({ x: (i * 137) % 1000, y: (i * 311) % 1000, z: Math.sin(i) }));
    const p = { model: 'exponential', range: 600, sill: 1, nugget: 0.05 };
    const r = krigePoints(pts, [[333, 444]], p);
    // reference: the ordinary-kriging system written out with variogramCovariance
    const m = pts.length + 1;
    const A = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => {
      if (i === pts.length && j === pts.length) return 0;
      if (i === pts.length || j === pts.length) return 1;
      return variogramCovariance(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y), p);
    }));
    const b = [...pts.map((q) => variogramCovariance(Math.hypot(q.x - 333, q.y - 444), p)), 1];
    // Gaussian elimination with partial pivoting
    for (let c = 0; c < m; c++) {
      let piv = c;
      for (let k = c + 1; k < m; k++) if (Math.abs(A[k][c]) > Math.abs(A[piv][c])) piv = k;
      [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
      for (let k = c + 1; k < m; k++) {
        const f = A[k][c] / A[c][c];
        for (let j = c; j < m; j++) A[k][j] -= f * A[c][j];
        b[k] -= f * b[c];
      }
    }
    const w = new Array(m).fill(0);
    for (let i = m - 1; i >= 0; i--) {
      let s2 = b[i];
      for (let j = i + 1; j < m; j++) s2 -= A[i][j] * w[j];
      w[i] = s2 / A[i][i];
    }
    const est = pts.reduce((acc, q, i) => acc + w[i] * q.z, 0);
    expect(Math.abs(r.values[0] - est)).toBeLessThan(1e-10);
  });
});

describe('U2-006: a contact per node', () => {
  const G = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'earthmodel', 'contacts_cases.json'), 'utf8'));
  const n = G.top.length;
  const fill = (v) => Float64Array.from({ length: n }, () => v);
  const props = { ntg: fill(G.ntg), phi: fill(G.phi), sw: fill(G.sw) };
  const labels = Int32Array.from(G.labels);
  const top = Float64Array.from(G.top);
  const base = Float64Array.from(G.base);
  const near = (a, b) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(b)));
  const KEYS = ['bulk_m3', 'net_m3', 'pore_m3', 'hcpv_m3', 'gas_hcpv_m3', 'oil_hcpv_m3', 'gas_bulk_m3', 'oil_bulk_m3'];

  test('the oracle\'s per-block case, given per node, gives the oracle\'s numbers', () => {
    const c = G.cases.find((k) => k.name === 'owc_by_block');
    const owcGrid = Float64Array.from(labels, (lab) => c.fluids.owc[String(lab)]);
    const r = zoneVolumesWithContacts(G.spec, top, base, labels, props, { ...c.fluids, owc: owcGrid });
    for (const [blk, e] of Object.entries(c.expected)) for (const k of KEYS) near(r[blk][k], e[k]);
  });

  test('a scalar spread over every node equals the scalar; a plain array works too', () => {
    const c = G.cases.find((k) => k.name === 'goc_owc_fvf');
    const r = zoneVolumesWithContacts(G.spec, top, base, null, props, { ...c.fluids, goc: fill(c.fluids.goc), owc: Array.from(fill(c.fluids.owc)) });
    for (const k of [...KEYS, 'stoiip_m3', 'giip_m3']) near(r.total[k], c.expected.total[k]);
  });

  test('a non-finite node means no contact there; a shallow node contact removes that node\'s hydrocarbon', () => {
    const owc = fill(1880);
    const all = zoneVolumesWithContacts(G.spec, top, base, null, props, { owc: fill(1880) }).total;
    owc[0] = NaN;
    const none = zoneVolumesWithContacts(G.spec, top, base, null, props, { owc }).total;
    // node 0 now counts its whole column as hydrocarbon (no contact given)
    const node0Whole = Math.max(0, base[0] - top[0]);
    const node0Above = Math.max(0, Math.min(base[0], 1880) - top[0]);
    near(none.oil_bulk_m3 - all.oil_bulk_m3, (node0Whole - node0Above) * G.spec.dx * G.spec.dy);
    // the crest node given a contact above its own top holds no hydrocarbon
    let crest = 0;
    for (let j = 1; j < n; j++) if (top[j] < top[crest]) crest = j;
    const shallow = fill(1880);
    shallow[crest] = top[crest] - 1;
    const cut = zoneVolumesWithContacts(G.spec, top, base, null, props, { owc: shallow }).total;
    expect(cut.oil_bulk_m3).toBeLessThan(all.oil_bulk_m3);
    near(all.oil_bulk_m3 - cut.oil_bulk_m3, (Math.min(base[crest], 1880) - top[crest]) * G.spec.dx * G.spec.dy);
  });

  test('a per-node grid of the wrong length is refused', () => {
    expect(() => zoneVolumesWithContacts(G.spec, top, base, null, props, { owc: new Float64Array(3) })).toThrow(/per-node OWC grid must share/);
    expect(() => zoneVolumesWithContacts(G.spec, top, base, null, props, { goc: [1, 2] })).toThrow(/per-node GOC grid must share/);
  });
});
