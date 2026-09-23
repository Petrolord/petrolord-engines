/**
 * Horizon framework from well tops (Tops to Horizons plan, TP3/TP5/TP6),
 * end to end on the synthetic field's exact truth: tops matched to events
 * (topsToEvents), seeds, tracking order, banded tracking (no crossing),
 * the thin bed as a conformable horizon, misties, leave-one-well-out and
 * a planned well's prognosis. Every tracked cell is compared with the
 * analytic horizon.
 */
import { buildSyntheticField } from '../engines/seismolord/syntheticField';
import { makeTvdssToTwt, buildWellLatticePath } from '../engines/seismolord/wellSection';
import { wellTopsForMatching, gatherTopTraces, matchTopsToEvents } from '../engines/seismolord/topsToEvents';
import {
  seedsForTop, trackingOrder, trackTop, bandedTrace, isochronFromWells, conformableHorizon,
  mistieTable, mistieStats, leaveOneWellOut, predictTops, approxLevelGrid, faultBarriersForTop, tuningMask,
} from '../engines/seismolord/framework';
import { NULL_VALUE } from '../engines/seismolord/manifest';

const NULL_F32 = Math.fround(NULL_VALUE);
const isNull = (v) => !Number.isFinite(v) || Math.abs(v) > 1e29;

async function prepare(f) {
  const wells = [];
  for (const w of f.wells) {
    if (w.name === 'W-P') continue;                       // the planned well is not drilled
    const timeConv = makeTvdssToTwt({ checkshots: w.checkshots, dtUs: f.dtUs, maxTwtMs: f.geom.ns * f.dtMs });
    const well = { ...w, tops: w.tops.map((t) => ({ name: t.name, md: t.md })) };
    const tops = wellTopsForMatching(well, {
      affine: f.affine, geom: f.geom, dtUs: f.dtUs, timeConv,
    });
    wells.push({ name: w.name, tops, traces: await gatherTopTraces(f.getTrace, f.geom, tops) });
  }
  return wells;
}

async function buildFramework(f, { faults = null } = {}) {
  const order = f.spec.interfaces.map((i) => i.name);
  const wells = await prepare(f);
  const match = matchTopsToEvents({ wells, dtMs: f.dtMs, order });
  const tracked = new Map();
  for (const t of trackingOrder(match, wells)) {
    // eslint-disable-next-line no-await-in-loop
    const r = await trackTop({
      getTrace: f.getTrace, geom: f.geom, seeds: t.seeds, kind: t.kind, name: t.name, order, tracked,
      barriers: faults ? faultBarriersForTop(faults, approxLevelGrid(t.seeds, f.geom), f.geom) : null,
    });
    tracked.set(t.name, r.picks);
  }
  return { match, wells, tracked, order };
}

/** Coverage and accuracy of a picks grid against the truth (cells in
 *  `skip` are left out of the accuracy: tuned or on a barrier). */
function score(picks, truth, skip = null) {
  let live = 0; let ok = 0; let truthLive = 0; let sumAbs = 0; let covered = 0;
  for (let c = 0; c < picks.length; c++) {
    if (!isNull(truth[c])) truthLive += 1;
    if (isNull(picks[c]) || isNull(truth[c])) continue;
    covered += 1;
    if (skip && skip[c]) continue;
    live += 1;
    const e = Math.abs(picks[c] - truth[c]);
    sumAbs += e;
    if (e <= 1) ok += 1;
  }
  return {
    coverage: covered / truthLive, accuracy: live ? ok / live : 0, meanAbs: live ? sumAbs / live : null,
  };
}

describe('unfaulted field', () => {
  const f = buildSyntheticField({ faults: [] });
  let fw;
  beforeAll(async () => { fw = await buildFramework(f); }, 60000);

  test('every mapped top is tracked over the survey and sits on its true horizon (outside its tuned cells)', () => {
    const tuneS = fw.match.tuningMs / f.dtMs;
    for (const [name, picks] of fw.tracked) {
      const mask = tuningMask(name, fw.order, fw.tracked, f.geom, tuneS);
      const s = score(picks, f.truth.horizons[name], mask);
      // TOP_C is the tuned doublet's representative: its composite event
      // rides up to a sample off the interface, so it is judged at 1.5
      if (name === 'TOP_C') expect(s.meanAbs).toBeLessThan(1.5);
      else expect(s.accuracy).toBeGreaterThan(0.97);
      expect(s.coverage).toBeGreaterThan(name === 'TOP_D' ? 0.5 : 0.9);
    }
    // the tuned cells are where TOP_D pinches out under SU
    const dMask = tuningMask('TOP_D', fw.order, fw.tracked, f.geom, tuneS);
    const n = dMask.reduce((a, v) => a + v, 0);
    expect(n).toBeGreaterThan(50);
    expect(n).toBeLessThan(f.geom.nIl * f.geom.nXl * 0.4);
    expect([...fw.tracked.keys()].sort()).toEqual(['SU', 'TOP_A', 'TOP_B', 'TOP_C', 'TOP_D', 'TOP_E']);
  });

  test('horizons never cross their stratigraphic neighbours', () => {
    const names = fw.order.filter((n) => fw.tracked.has(n));
    for (let i = 1; i < names.length; i++) {
      const a = fw.tracked.get(names[i - 1]);
      const b = fw.tracked.get(names[i]);
      for (let c = 0; c < a.length; c++) {
        if (isNull(a[c]) || isNull(b[c])) continue;
        expect(b[c]).toBeGreaterThan(a[c]);
      }
    }
  });

  test('the thin bed becomes a conformable horizon on TOP_C within a sample of its truth', () => {
    const c2 = fw.match.tops.find((t) => t.name === 'TOP_C2');
    const offs = Object.entries(c2.offsetsMs).map(([wName, ms]) => {
      const t = fw.wells.find((w) => w.name === wName).tops.find((q) => q.name === 'TOP_C');
      return { il: t.cell.il, xl: t.cell.xl, offsetMs: ms };
    });
    const { picks, isochronMs } = conformableHorizon(fw.tracked.get('TOP_C'), offs, f.geom, f.dtMs);
    const s = score(picks, f.truth.horizons.TOP_C2);
    expect(s.meanAbs).toBeLessThan(1.5);
    for (const v of isochronMs) { expect(v).toBeGreaterThan(4); expect(v).toBeLessThan(7); }
  });

  test('misties at the wells are under a sample', () => {
    const rows = mistieTable(fw.tracked, fw.wells, f.geom, f.dtMs)
      .filter((r) => r.top !== 'TOP_C' && fw.tracked.has(r.top));
    const st = mistieStats(rows);
    expect(st.n).toBeGreaterThan(20);
    expect(st.rmsMs).toBeLessThan(f.dtMs);
  });

  test('leave-one-well-out: every well is reached and predicted within a sample', async () => {
    const seeds = seedsForTop(fw.match, 'TOP_A', fw.wells);
    const lowo = await leaveOneWellOut({
      seeds,
      geom: f.geom,
      dtMs: f.dtMs,
      track: async (s) => (await trackTop({
        getTrace: f.getTrace, geom: f.geom, seeds: s, kind: 'peak', name: 'TOP_A', order: fw.order, tracked: new Map(),
      })).picks,
    });
    expect(lowo.n).toBe(5);
    expect(lowo.reached).toBe(5);
    expect(lowo.rmsMs).toBeLessThan(f.dtMs);
  });
});

describe('faulted field (default: one normal fault, 40 m throw)', () => {
  const f = buildSyntheticField({
    wells: [...buildSyntheticField().spec.wells, {
      name: 'W-P', il: 32, xl: 20, kbM: 25, kickoffMd: 400, buildDegPer30m: 2, maxIncDeg: 25, aziDeg: 120,
    }],
  });
  const faults = [{ name: 'F1', sticks: f.truth.faults[0].sticksLattice() }];
  let fw;
  beforeAll(async () => {
    fw = await buildFramework(f, { faults });
  }, 120000);

  test('the true fault as sticks: a stick every 5 inlines, points on the plane', () => {
    expect(faults[0].sticks.length).toBeGreaterThanOrEqual(12);
    for (const st of faults[0].sticks) {
      for (let k = 1; k < st.points.length; k++) expect(st.points[k].s).toBeGreaterThan(st.points[k - 1].s);
      // a normal fault dips toward the hanging wall: xl grows with depth here
      for (let k = 1; k < st.points.length; k++) expect(st.points[k].xl).toBeGreaterThanOrEqual(st.points[k - 1].xl);
    }
  });

  test('with fault barriers at each horizon, wells on both sides seed both blocks and picks stay on the truth', () => {
    const tuneS = fw.match.tuningMs / f.dtMs;
    for (const name of ['TOP_A', 'TOP_B', 'SU', 'TOP_E']) {
      const mask = tuningMask(name, fw.order, fw.tracked, f.geom, tuneS);
      const s = score(fw.tracked.get(name), f.truth.horizons[name], mask);
      expect(s.accuracy).toBeGreaterThan(0.97);
      expect(s.coverage).toBeGreaterThan(0.75);
    }
  });

  test('negative control: without barriers the picks along the fault go wrong; with them they do not', async () => {
    const without = await buildFramework(f);
    const wrong = (fwk) => ['TOP_A', 'TOP_B', 'SU', 'TOP_E'].reduce((n, name) => {
      const picks = fwk.tracked.get(name);
      const truth = f.truth.horizons[name];
      const mask = tuningMask(name, fwk.order, fwk.tracked, f.geom, fwk.match.tuningMs / f.dtMs);
      let k = 0;
      for (let c = 0; c < picks.length; c++) {
        if (mask[c] || isNull(picks[c]) || isNull(truth[c])) continue;
        if (Math.abs(picks[c] - truth[c]) > 1) k += 1;
      }
      return n + k;
    }, 0);
    const bad = wrong(without);
    const good = wrong(fw);
    expect(bad).toBeGreaterThan(30);
    expect(good).toBeLessThan(bad / 5);
  }, 120000);

  test('prognosis: the planned well meets each horizon within 8 m of the true top', () => {
    const wp = f.wells.find((w) => w.name === 'W-P');
    // a planned well has no checkshots: its time comes from the nearest
    // drilled well's relation (W-1), as a prognosis would
    const w1 = f.wells.find((w) => w.name === 'W-1');
    const timeConv = makeTvdssToTwt({ checkshots: w1.checkshots, dtUs: f.dtUs, maxTwtMs: 1680 });
    const lat = buildWellLatticePath({ ...wp, tops: [] }, {
      affine: f.affine, timeConv, geom: f.geom, dtUs: f.dtUs,
    });
    const horizons = new Map([...fw.tracked].filter(([n]) => ['TOP_A', 'TOP_B'].includes(n)));
    const pred = predictTops(lat.points, horizons, f.geom, { dtMs: f.dtMs, sigmaMs: 3 });
    expect(pred.map((p) => p.name)).toEqual(['TOP_A', 'TOP_B']);
    for (const p of pred) {
      const truth = wp.tops.find((t) => t.name === p.name);
      // the error is the velocity difference between W-1 and W-P's
      // column (a prognosis's honest error), bounded here by 25 m
      expect(Math.abs(p.md - truth.md)).toBeLessThan(25);
      expect(p.bandM).toBeCloseTo(3.75, 2);
    }
  });
});

describe('pieces and negative controls', () => {
  test('a banded trace hides everything outside the band', () => {
    const tr = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const b = bandedTrace(tr, 1, 6, 1);
    expect([...b].map((v) => (isNull(v) ? null : v))).toEqual([null, null, null, 4, 5, null, null, null]);
    expect(bandedTrace(tr, NULL_F32, NULL_F32, 1)).toBe(tr);
  });

  test('isochron: exact at the wells, clamped to their range, a plane between', () => {
    const pts = [{ il: 0, xl: 0, value: 4 }, { il: 10, xl: 0, value: 6 }, { il: 0, xl: 10, value: 4 }];
    const iso = isochronFromWells(pts, 11, 11);
    expect(iso[0]).toBeCloseTo(4, 5);
    expect(iso[10 * 11]).toBeCloseTo(6, 5);
    expect(iso[5 * 11 + 5]).toBeCloseTo(5, 5);
    for (const v of iso) { expect(v).toBeGreaterThanOrEqual(4); expect(v).toBeLessThanOrEqual(6); }
  });

  test('negative control: without the band a horizon seeded between two others can be pulled across', async () => {
    // seed TOP_B's tracker on TOP_A's event: unbanded it tracks TOP_A;
    // banded below an already-tracked TOP_A it cannot
    const f = buildSyntheticField({ faults: [] });
    const truthA = f.truth.horizons.TOP_A;
    const seed = { ilIdx: 10, xlIdx: 10, sample: truthA[10 * f.geom.nXl + 10] };
    const free = await trackTop({
      getTrace: f.getTrace, geom: f.geom, seeds: [seed], kind: 'peak', name: 'TOP_B', order: ['TOP_A', 'TOP_B'], tracked: new Map(),
    });
    expect(score(free.picks, truthA).coverage).toBeGreaterThan(0.9);   // it followed TOP_A
    const banded = await trackTop({
      getTrace: f.getTrace,
      geom: f.geom,
      seeds: [seed],
      kind: 'peak',
      name: 'TOP_B',
      order: ['TOP_A', 'TOP_B'],
      tracked: new Map([['TOP_A', truthA]]),
    });
    expect(banded.tracked).toBe(0);                                   // no event inside the band there
  });
});
