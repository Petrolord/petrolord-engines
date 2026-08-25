// Drilling survey math vs the analytic oracle goldens
// (tools/validation/drilling/oracle.py — independent numpy geometry) and
// property checks. Minimum curvature is EXACT on circular arcs, so the
// arc goldens gate at near machine precision.

import fs from 'fs';
import path from 'path';
import {
  computeWellPath, positionAtMd, attitudeAtMd, stationAtMd,
  doglegSeverity, buildTurnRates, verticalSection, closure,
  defaultVsAzimuth, mdsAtTvd, resample, computeSurveyTable,
  normalizeAzi, wrapDeltaDeg,
} from '../engines/drilling/surveyMath';

const G = (name) => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', name), 'utf8',
));

const toStations = (rows) => rows.map(([md, inc, azi]) => ({ md, inc, azi }));

describe('vertical-plane build arcs (closed form, exact)', () => {
  for (const c of G('arc_vertical_plane.json').cases) {
    test(`azi ${c.aziDeg}, DLS ${c.dls30m} deg/30m`, () => {
      const stations = toStations(c.stations);
      const p = computeWellPath(stations);
      c.expected.forEach((exp, i) => {
        expect(p[i].x).toBeCloseTo(exp.e, 6);
        expect(p[i].y).toBeCloseTo(exp.n, 6);
        expect(p[i].tvd).toBeCloseTo(exp.tvd, 6);
      });
    });
  }
});

describe('TVD-plane crossings (independent dense-sampled oracle)', () => {
  const g = G('tvd_crossings.json');
  const stations = toStations(g.stations);
  const p = computeWellPath(stations);
  for (const c of g.cases) {
    test(`tvd ${c.tvd}`, () => {
      const mds = mdsAtTvd(stations, p, c.tvd);
      expect(mds.length).toBe(c.mds.length);
      mds.forEach((md, i) => expect(md).toBeCloseTo(c.mds[i], 4));
    });
  }
});

describe('survey table vs independent numpy listing (m and ft)', () => {
  const g = G('survey_table.json');
  for (const key of ['metric', 'feet']) {
    test(key, () => {
      const c = g[key];
      const rows = computeSurveyTable(toStations(c.stations), {
        mdUnit: c.mdUnit, vsAzimuthDeg: c.vsAzimuthDeg,
      });
      c.rows.forEach((exp, i) => {
        const r = rows[i];
        expect(r.tvd).toBeCloseTo(exp.tvd, 6);
        expect(r.n).toBeCloseTo(exp.n, 6);
        expect(r.e).toBeCloseTo(exp.e, 6);
        expect(r.dls30m).toBeCloseTo(exp.dls30m, 6);
        expect(r.dls100ft).toBeCloseTo(exp.dls100ft, 6);
        expect(r.vs).toBeCloseTo(exp.vs, 6);
        expect(r.closureDist).toBeCloseTo(exp.closureDist, 6);
        if (exp.closureDist > 1e-6) {
          expect(r.closureAzi).toBeCloseTo(exp.closureAzi, 6);
        }
      });
    });
  }

  test('the ft regression class: 3 deg/100ft over 1000 ft is exactly 30 deg', () => {
    const c = g.feet;
    const rows = computeSurveyTable(toStations(c.stations), { mdUnit: 'ft' });
    const eob = rows.find((r) => r.md === 2000);
    expect(eob.inc).toBe(30);
    // and the reported severity is 3 deg/100ft, NOT 3/3.28
    expect(rows[3].dls100ft).toBeCloseTo(3, 9);
  });
});

describe('interpolation properties', () => {
  const g = G('tvd_crossings.json');
  const stations = toStations(g.stations);
  const p = computeWellPath(stations);

  test('positionAtMd reproduces every station exactly', () => {
    stations.forEach((s, i) => {
      const q = positionAtMd(stations, p, s.md);
      expect(q.x).toBeCloseTo(p[i].x, 9);
      expect(q.y).toBeCloseTo(p[i].y, 9);
      expect(q.tvd).toBeCloseTo(p[i].tvd, 9);
    });
  });

  test('attitudeAtMd matches stations at endpoints and stays in range between', () => {
    stations.forEach((s) => {
      const a = attitudeAtMd(stations, s.md);
      expect(a.inc).toBeCloseTo(s.inc, 9);
      expect(normalizeAzi(a.azi - s.azi)).toBeCloseTo(0, 6);
    });
    for (let md = 5; md < stations[stations.length - 1].md; md += 97) {
      const a = attitudeAtMd(stations, md);
      expect(a.inc).toBeGreaterThanOrEqual(0);
      expect(a.inc).toBeLessThanOrEqual(90);
      expect(a.azi).toBeGreaterThanOrEqual(0);
      expect(a.azi).toBeLessThan(360);
    }
  });

  test('resample keeps original stations and is MD-monotonic', () => {
    const rs = resample(stations, { step: 37 });
    for (let i = 1; i < rs.length; i++) expect(rs[i].md).toBeGreaterThan(rs[i - 1].md);
    for (const s of stations) {
      const hit = rs.find((r) => Math.abs(r.md - s.md) < 1e-9);
      expect(hit).toBeTruthy();
      expect(hit.inc).toBeCloseTo(s.inc, 9);
    }
  });

  test('stationAtMd merges position and attitude', () => {
    const q = stationAtMd(stations, p, 750);
    expect(q.md).toBe(750);
    expect(Number.isFinite(q.inc)).toBe(true);
    expect(Number.isFinite(q.x)).toBe(true);
  });
});

describe('closure, VS, rates, helpers', () => {
  test('closure is wellhead-relative with compass atan2(dE, dN)', () => {
    const c = closure({ x: 1100, y: 1000 }, { originX: 100, originY: 1000 });
    expect(c.dist).toBeCloseTo(1000, 9);
    expect(c.azi).toBeCloseTo(90, 9); // due east
    const c2 = closure({ x: 0, y: -500 }, { originX: 0, originY: 0 });
    expect(c2.azi).toBeCloseTo(180, 9); // due south
  });

  test('vertical section projects onto the VS azimuth', () => {
    const vsN = verticalSection({ x: 0, y: 700 }, { vsAzimuthDeg: 0 });
    expect(vsN).toBeCloseTo(700, 9);
    const vs45 = verticalSection({ x: 500, y: 500 }, { vsAzimuthDeg: 45 });
    expect(vs45).toBeCloseTo(Math.hypot(500, 500), 9);
    // displacement perpendicular to the VS plane contributes nothing
    expect(verticalSection({ x: 300, y: 0 }, { vsAzimuthDeg: 0 })).toBe(0);
  });

  test('defaultVsAzimuth is the closure azimuth of TD', () => {
    const stations = [{ md: 0, inc: 0, azi: 0 }, { md: 500, inc: 0, azi: 0 },
      { md: 1500, inc: 60, azi: 135 }];
    const p = computeWellPath(stations);
    expect(defaultVsAzimuth(p)).toBeCloseTo(135, 6);
  });

  test('dls unit identity: dls100ft = dls30m * 30.48/30 exactly', () => {
    const s1 = { md: 100, inc: 10, azi: 40 };
    const s2 = { md: 190, inc: 19, azi: 52 };
    const m = doglegSeverity(s1, s2, { mdUnit: 'm' });
    expect(m.dls100ft).toBeCloseTo(m.dls30m * (30.48 / 30), 12);
    const f = doglegSeverity(s1, s2, { mdUnit: 'ft' });
    expect(f.dls30m).toBeCloseTo(f.dls100ft * (30 / 30.48), 12);
  });

  test('turn rate uses shortest signed azimuth change', () => {
    const r = buildTurnRates({ md: 0, inc: 30, azi: 350 }, { md: 30, inc: 30, azi: 10 }, { mdUnit: 'm' });
    expect(r.turnRate).toBeCloseTo(20, 9); // through north, +20 deg over 30 m
    expect(wrapDeltaDeg(10, 350)).toBeCloseTo(-20, 12);
  });
});
