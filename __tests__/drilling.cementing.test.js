// Cementing: closed-form exactness + oracle golden agreement.
import fs from 'fs';
import path from 'path';
import {
  annulusRows, jobVolumes, fluidIntervals, segmentsForLeg, simulatePlacement,
  standoffProfile, requiredSpacing, placementChecklist, API_TARGET_STANDOFF,
} from '../engines/drilling/cementing.js';
import { fitModels } from '../engines/drilling/rheology.js';

const G = (name) => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', name), 'utf8'));

const g = 9.80665;

function expectClose(a, b, rtol, atol = 0) {
  if (!Number.isFinite(a)) throw new Error(`non-finite value ${a} (expected ~ ${b})`);
  const tol = atol + rtol * Math.abs(b);
  if (Math.abs(a - b) > tol) {
    throw new Error(`expected ${a} ~ ${b} (rtol ${rtol}, atol ${atol})`);
  }
}

const golden = G('cementing_cases.json');
const FX = golden.verticalFixture;

describe('closed forms (the vertical fixture, friction-free)', () => {
  test('job volumes are exact cylinder algebra', () => {
    const vols = jobVolumes({
      stations: FX.stations, holeSections: FX.holeSections, casing: FX.casing,
      tocMd: FX.tocMd, excessOpenHolePct: 0, spacerVolM3: 3,
    });
    const capIn = (Math.PI / 4) * FX.casing.idM ** 2;
    expectClose(vols.displacementM3, capIn * 1960, 1e-12);
    expectClose(vols.shoeTrackM3, capIn * 40, 1e-12);
    expectClose(vols.slurryM3, FX.volumes.slurryM3, 1e-9, 1e-9);
    expectClose(vols.totalPumpedM3, FX.volumes.totalPumpedM3, 1e-9, 1e-9);
  });

  test('placement reproduces the fixture end state (TOC, U-tube, free fall)', () => {
    const res = simulatePlacement({
      stations: FX.stations, holeSections: FX.holeSections, casing: FX.casing,
      mudInHole: FX.mudInHole, fluids: FX.fluids, pumpRateM3s: FX.pumpRateM3s,
      tocMd: FX.tocMd,
    });
    expectClose(res.achievedTocMd, FX.tocMd, 1e-9, 1e-6);
    expectClose(res.floatDiffPa, FX.placement.floatDiffPa, 1e-9, 1);
    expectClose(res.endPumpPressurePa, FX.placement.endPumpPressurePa, 1e-9, 1);
    expect(res.freeFall).toBe(FX.placement.freeFall);
    expect(res.warnings.join(' ')).toMatch(/Free fall/);
  });

  test('equal-density friction-free program has zero U-tube everywhere', () => {
    const rho = FX.mudInHole.densityKgM3;
    const vols = jobVolumes({
      stations: FX.stations, holeSections: FX.holeSections, casing: FX.casing,
      tocMd: FX.tocMd, excessOpenHolePct: 0,
    });
    const res = simulatePlacement({
      stations: FX.stations, holeSections: FX.holeSections, casing: FX.casing,
      mudInHole: FX.mudInHole,
      fluids: [
        { kind: 'tail', densityKgM3: rho, volumeM3: vols.slurryM3 },
        { kind: 'displacement', densityKgM3: rho, volumeM3: vols.displacementM3 },
      ],
      pumpRateM3s: 0.02,
      tocMd: FX.tocMd,
    });
    for (const row of res.series) expectClose(row.uTubePa, 0, 0, 1);
    expect(res.freeFall).toBe(false);
  });

  test('volume-interval bookkeeping conserves volume', () => {
    const vPath = 100;
    const fluids = [
      { kind: 'spacer', densityKgM3: 1500, volumeM3: 10 },
      { kind: 'tail', densityKgM3: 1900, volumeM3: 30 },
    ];
    for (const V of [0, 5, 15, 40]) {
      const iv = fluidIntervals({ V, fluids, mudInHole: FX.mudInHole, vPath });
      const total = iv.reduce((a, i) => a + (i.v1 - i.v0), 0);
      expectClose(total, vPath, 1e-12);
    }
  });

  test('guards', () => {
    expect(() => jobVolumes({
      stations: FX.stations, holeSections: FX.holeSections,
      casing: { ...FX.casing, hangerMd: 500 }, tocMd: 800,
    })).toThrow(/later phase/);
    expect(() => jobVolumes({
      stations: FX.stations, holeSections: FX.holeSections,
      casing: { ...FX.casing, odM: 0.25 }, tocMd: 800,
    })).toThrow(/does not fit/);
    expect(() => annulusRows({
      holeSections: [{ from_md_m: 0, to_md_m: 500, cased: false, hole_id_m: 0.22 }],
      casing: FX.casing,
    })).toThrow(/does not cover/);
  });
});

describe('centralization algebra', () => {
  test('vertical well: no lateral load, standoff 100%', () => {
    const so = standoffProfile({
      stations: FX.stations, holeSections: FX.holeSections, casing: FX.casing,
      mudDensityKgM3: 1440,
      centralizer: { type: 'bow', spacingM: 12, restoringForceN: 8900 },
    });
    expectClose(so.minStandoff, 1, 1e-9);
  });

  test('bow spring algebra at 45 degrees, single interval', () => {
    const stations = [{ md: 0, inc: 45, azi: 0 }, { md: 30, inc: 45, azi: 0 }];
    const hole = [{ from_md_m: 0, to_md_m: 30, cased: false, hole_id_m: 0.2159 }];
    const casing = { odM: 0.1778, idM: 0.157064, shoeMd: 30, floatCollarMd: 30, hangerMd: 0, weightKgM: 43.16 };
    const so = standoffProfile({
      stations, holeSections: hole, casing, mudDensityKgM3: 1440,
      centralizer: { type: 'bow', spacingM: 10, restoringForceN: 8900 },
    });
    const clearance = (0.2159 - 0.1778) / 2;
    const wBuoy = 43.16 * g * (1 - 1440 / 7850);
    const k = 8900 / ((1 - API_TARGET_STANDOFF) * clearance);
    const defl = (wBuoy * 10 * Math.SQRT1_2) / k;
    expectClose(so.rows[0].standoffAtCentralizer, (clearance - defl) / clearance, 1e-9);
  });

  test('rigid centralizer standoff from blade OD', () => {
    const stations = [{ md: 0, inc: 60, azi: 0 }, { md: 30, inc: 60, azi: 0 }];
    const hole = [{ from_md_m: 0, to_md_m: 30, cased: false, hole_id_m: 0.2159 }];
    const casing = { odM: 0.1778, idM: 0.157064, shoeMd: 30, floatCollarMd: 30, hangerMd: 0, weightKgM: 43.16 };
    const so = standoffProfile({
      stations, holeSections: hole, casing, mudDensityKgM3: 1440,
      centralizer: { type: 'rigid', spacingM: 10, bladeOdM: 0.206 },
    });
    expectClose(so.rows[0].standoffAtCentralizer, (0.206 - 0.1778) / (0.2159 - 0.1778), 1e-9);
  });
});

describe('oracle golden agreement (cementing_cases.json)', () => {
  const hb = (fann) => fitModels(fann).herschelBulkley;
  for (const c of golden.cases) {
    test(`${c.well}: volumes, programs, standoff`, () => {
      const vols = jobVolumes({
        stations: c.stations, holeSections: c.holeSections, casing: c.casing,
        tocMd: c.tocMd, excessOpenHolePct: c.excessOpenHolePct, spacerVolM3: 4,
        slurryYieldM3PerSack: c.slurryYieldM3PerSack,
        leadTailSplitMd: c.leadTailSplitMd, pumpRateM3s: c.pumpRateM3s,
      });
      const ev = c.expected.volumes;
      for (const key of ['annularSlurryM3', 'shoeTrackM3', 'slurryM3', 'leadM3', 'tailM3', 'displacementM3', 'sacks', 'jobTimeS']) {
        expectClose(vols[key], ev[key], 1e-6, 1e-9);
      }
      const mud = { kind: 'mud', densityKgM3: 1440, rheology: hb(c.mudFann) };
      const programs = {
        lead_tail: [
          { kind: 'spacer', densityKgM3: 1500, volumeM3: 4, rheology: hb(c.spacerFann) },
          { kind: 'lead', densityKgM3: 1560, volumeM3: vols.leadM3, rheology: hb(c.leadFann) },
          { kind: 'tail', densityKgM3: 1900, volumeM3: vols.tailM3, rheology: hb(c.tailFann) },
          { kind: 'displacement', densityKgM3: 1440, volumeM3: vols.displacementM3, rheology: hb(c.mudFann) },
        ],
        neat: [
          { kind: 'tail', densityKgM3: 1900, volumeM3: vols.slurryM3, rheology: hb(c.tailFann) },
          { kind: 'displacement', densityKgM3: 1440, volumeM3: vols.displacementM3, rheology: hb(c.mudFann) },
        ],
      };
      for (const [name, fluids] of Object.entries(programs)) {
        const res = simulatePlacement({
          stations: c.stations, holeSections: c.holeSections, casing: c.casing,
          mudInHole: mud, fluids, pumpRateM3s: c.pumpRateM3s,
          tocMd: c.tocMd, excessOpenHolePct: c.excessOpenHolePct,
        });
        const exp = c.expected.programs[name];
        expectClose(res.endPumpPressurePa, exp.endPumpPressurePa, 1e-6, 1);
        expectClose(res.achievedTocMd, exp.achievedTocMd, 1e-6, 1e-6);
        expectClose(res.floatDiffPa, exp.floatDiffPa, 1e-6, 1);
        expect(res.freeFall).toBe(exp.freeFall);
        if (exp.maxEcdPrevShoeKgM3 != null) {
          expectClose(res.maxEcdPrevShoeKgM3, exp.maxEcdPrevShoeKgM3, 1e-6, 1e-4);
        }
        for (const cp of exp.checkpoints) {
          const row = res.series.find((r) => Math.abs(r.pumpedM3 - cp.pumpedM3) < 1e-6);
          expect(row).toBeTruthy();
          expectClose(row.pumpPressurePa, cp.pumpPressurePa, 1e-6, 1);
          if (cp.ecdPrevShoeKgM3 != null) expectClose(row.ecdPrevShoeKgM3, cp.ecdPrevShoeKgM3, 1e-6, 1e-4);
        }
      }
      const so = standoffProfile({
        stations: c.stations, holeSections: c.holeSections, casing: c.casing,
        mudDensityKgM3: 1440, centralizer: c.centralizer,
      });
      expectClose(so.minStandoff, c.expected.standoff.minStandoff, 1e-6, 1e-9);
      const req = requiredSpacing({
        stations: c.stations, holeSections: c.holeSections, casing: c.casing,
        mudDensityKgM3: 1440, centralizer: c.centralizer,
      });
      if (c.expected.requiredSpacingM == null) expect(req).toBeNull();
      else expectClose(req, c.expected.requiredSpacingM, 1e-6, 1e-6);
    });
  }

  test('checklist composes honestly', () => {
    const c = golden.cases[0];
    const mud = { kind: 'mud', densityKgM3: 1440, rheology: hb(c.mudFann) };
    const vols = jobVolumes({
      stations: c.stations, holeSections: c.holeSections, casing: c.casing,
      tocMd: c.tocMd, excessOpenHolePct: c.excessOpenHolePct,
      leadTailSplitMd: c.leadTailSplitMd,
    });
    const fluids = [
      { kind: 'tail', densityKgM3: 1900, volumeM3: vols.slurryM3, rheology: hb(c.tailFann) },
      { kind: 'displacement', densityKgM3: 1440, volumeM3: vols.displacementM3, rheology: hb(c.mudFann) },
    ];
    const placement = simulatePlacement({
      stations: c.stations, holeSections: c.holeSections, casing: c.casing,
      mudInHole: mud, fluids, pumpRateM3s: c.pumpRateM3s,
      tocMd: c.tocMd, excessOpenHolePct: c.excessOpenHolePct,
    });
    const standoff = standoffProfile({
      stations: c.stations, holeSections: c.holeSections, casing: c.casing,
      mudDensityKgM3: 1440, centralizer: c.centralizer,
    });
    const list = placementChecklist({
      placement, standoff, mudInHole: mud, fluids,
      pumpRateM3s: c.pumpRateM3s, annulusRowsList: vols.annulusRows,
    });
    expect(list.total).toBeGreaterThanOrEqual(5);
    const ids = list.items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(['density-hierarchy', 'standoff', 'no-free-fall', 'float-holds', 'annular-velocity']));
  });
});
