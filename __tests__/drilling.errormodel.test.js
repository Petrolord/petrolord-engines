// ISCWSA MWD Rev4 error model vs the official example Well #1
// (test-data/drilling/goldens/iscwsa_mwd_rev4_well1.json).
//
// perSource rows are the validation workbook's full-precision
// Calculated per-source NEV covariance components at the four ISCWSA
// checkpoint depths (1200/2100/5100/8000 m); totalsAll is the welleng
// 0.29.0 oracle summed covariance at every station (which matches the
// workbook to ~5e-13 absolute). A correct port matches both to within
// float accumulation noise; weighting-function or propagation mistakes
// miss by orders of magnitude.

import fs from 'fs';
import path from 'path';
import {
  computeErrorModel, hlaSigmas, horizontalEllipse, nevToHlaCov, hlaToNevCov,
} from '../engines/drilling/errorModel';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', 'iscwsa_mwd_rev4_well1.json'),
  'utf8',
));

const stations = G.survey.md.map((md, i) => ({
  md, inc: G.survey.inc[i], azi: G.survey.azi[i],
}));

const result = computeErrorModel(stations, G.header);
const mdIndex = new Map(G.survey.md.map((md, i) => [md, i]));
const bySource = new Map(result.sources.map((s) => [s.code, s]));

const comps = (cov) => ({
  nn: cov[0][0], ee: cov[1][1], vv: cov[2][2],
  ne: cov[0][1], nv: cov[0][2], ev: cov[1][2],
});

// max |got - exp| relative to the source's largest component at that MD,
// so tiny cross-terms are held to the same scale as the diagonals.
function maxScaledDiff(got, exp) {
  const scale = Math.max(1e-9, ...Object.values(exp).map(Math.abs));
  return Math.max(...Object.keys(exp).map(
    (key) => Math.abs(got[key] - exp[key]) / scale,
  ));
}

describe('ISCWSA MWD Rev4 per-source covariances vs the official workbook', () => {
  const byMdSource = new Map();
  for (const row of G.perSource) {
    byMdSource.set(`${row.md}|${row.source}`, row);
  }
  for (const [key, row] of byMdSource) {
    test(key, () => {
      const i = mdIndex.get(row.md);
      const cov = row.source === 'Totals'
        ? result.totalCov[i]
        : bySource.get(row.source).covNEV[i];
      expect(maxScaledDiff(comps(cov), {
        nn: row.nn, ee: row.ee, vv: row.vv, ne: row.ne, nv: row.nv, ev: row.ev,
      })).toBeLessThan(1e-8);
    });
  }

  test('all 27 Rev4 sources are present', () => {
    expect(result.sources).toHaveLength(27);
  });
});

describe('ISCWSA MWD Rev4 totals at every station vs the welleng oracle', () => {
  test('summed covariance matches at all stations', () => {
    let worst = 0;
    for (let i = 0; i < G.survey.md.length; i++) {
      const got = comps(result.totalCov[i]);
      const exp = {
        nn: G.totalsAll.nn[i], ee: G.totalsAll.ee[i], vv: G.totalsAll.vv[i],
        ne: G.totalsAll.ne[i], nv: G.totalsAll.nv[i], ev: G.totalsAll.ev[i],
      };
      worst = Math.max(worst, maxScaledDiff(got, exp));
    }
    expect(worst).toBeLessThan(1e-8);
  });
});

describe('covariance structure properties', () => {
  test('total covariance is symmetric positive semi-definite everywhere', () => {
    for (const cov of result.totalCov) {
      expect(cov[0][1]).toBeCloseTo(cov[1][0], 12);
      expect(cov[0][2]).toBeCloseTo(cov[2][0], 12);
      expect(cov[1][2]).toBeCloseTo(cov[2][1], 12);
      // principal minors of a PSD matrix
      expect(cov[0][0]).toBeGreaterThanOrEqual(0);
      expect(cov[0][0] * cov[1][1] - cov[0][1] ** 2).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  test('NEV->HLA->NEV round-trips', () => {
    const i = mdIndex.get(5100);
    const inc = result.incRad[i];
    const azi = result.aziTrueRad[i];
    const hla = nevToHlaCov(inc, azi, result.totalCov[i]);
    const back = hlaToNevCov(inc, azi, hla);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        expect(back[r][c]).toBeCloseTo(result.totalCov[i][r][c], 8);
      }
    }
  });

  test('HLA sigmas and horizontal ellipse are sane at TD', () => {
    const i = G.survey.md.length - 1;
    const { sigmaH, sigmaL, sigmaA } = hlaSigmas(
      result.incRad[i], result.aziTrueRad[i], result.totalCov[i],
    );
    expect(sigmaH).toBeGreaterThan(0);
    expect(sigmaL).toBeGreaterThan(0);
    expect(sigmaA).toBeGreaterThan(0);
    const ell = horizontalEllipse(result.totalCov[i], { k: 2.79 });
    expect(ell.semiMajor).toBeGreaterThanOrEqual(ell.semiMinor);
    expect(ell.azimuthDeg).toBeGreaterThanOrEqual(0);
    expect(ell.azimuthDeg).toBeLessThan(180);
  });

  test('a geomagnetic reference is required', () => {
    expect(() => computeErrorModel(stations, { declinationDeg: 0 }))
      .toThrow(/geomagnetic reference/);
  });
});
