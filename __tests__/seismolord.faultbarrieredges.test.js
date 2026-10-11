/**
 * Fault barriers that stop short of the survey edge, or of a horizon.
 *
 * Automatic sticks come every 8th line from the first, so on the Ekene
 * survey (128 inlines) the last stick sat on inline 120 and the growth
 * fault's barrier stopped 7 lines short of the edge. The tracker walked
 * round that end and carried the deep horizons across the fault on the
 * wrong reflector; "Across faults" stayed at 0 because no block was left
 * unreached for the jump. Likewise an automatic stick ends where the fault
 * likelihood fades, at the last strong reflector, so the deepest horizon
 * sat a few samples below every stick and got no barrier at all.
 *
 * Gated on the synthetic field's exact truth, footwall wells only (the
 * hard case of seismolord.faultjump.test.js).
 */
import { buildSyntheticField } from '../engines/seismolord/syntheticField';
import { makeTvdssToTwt } from '../engines/seismolord/wellSection';
import { wellTopsForMatching, gatherTopTraces, matchTopsToEvents } from '../engines/seismolord/topsToEvents';
import {
  trackingOrder, trackTop, approxLevelGrid, faultBarriersForTop,
} from '../engines/seismolord/framework';
import { jumpAcrossFaults } from '../engines/seismolord/faultJump';
import {
  labelBlocks, faultTraces, rasterizeTraces, extendTraceToEdges, extendStickEnds,
} from '../engines/seismolord/faultBarriers';

const isNull = (v) => !Number.isFinite(v) || Math.abs(v) > 1e29;
const base = buildSyntheticField().spec;
const field = buildSyntheticField({
  faults: [{ ...base.faults[0], throwM: 33 }],
  wells: base.wells.filter((w) => ['W-1', 'W-2'].includes(w.name)), // footwall only
});
const { nIl, nXl } = field.geom;
const ORDER = field.spec.interfaces.map((i) => i.name);

// the automatic picker's spacing: every 8th inline from the first, no stick on the last
const autoSticks = (opts = {}) => field.truth.faults[0].sticksLattice({ everyIl: 8, ...opts })
  .filter((st) => st.points[0].il % 8 === 0);

let seeds;
beforeAll(async () => {
  const wells = [];
  for (const w of field.wells) {
    const timeConv = makeTvdssToTwt({ checkshots: w.checkshots, dtUs: field.dtUs, maxTwtMs: field.geom.ns * field.dtMs });
    const tops = wellTopsForMatching({ ...w, tops: w.tops.map((t) => ({ name: t.name, md: t.md })) }, {
      affine: field.affine, geom: field.geom, dtUs: field.dtUs, timeConv,
    });
    wells.push({ name: w.name, tops, traces: await gatherTopTraces(field.getTrace, field.geom, tops) });
  }
  const match = matchTopsToEvents({ wells, dtMs: field.dtMs, order: ORDER });
  seeds = new Map(trackingOrder(match, wells).map((t) => [t.name, t]));
}, 120000);

const blocks = (mask) => labelBlocks(mask, nIl, nXl);

function hangingWallPicks(picks, mask) {
  const { labels } = blocks(mask);
  const sizes = new Map();
  const picked = new Map();
  for (let c = 0; c < labels.length; c++) {
    if (labels[c] < 0) continue;
    sizes.set(labels[c], (sizes.get(labels[c]) || 0) + 1);
    if (!isNull(picks[c])) picked.set(labels[c], (picked.get(labels[c]) || 0) + 1);
  }
  return { sizes, picked };
}

describe('a fault whose last stick stops short of the survey edge', () => {
  const sticks = autoSticks();

  test('the sticks stop 5 inlines short of the edge, as the automatic picker leaves them', () => {
    expect(Math.max(...sticks.map((s) => s.points[0].il))).toBe(64);
    expect(nIl - 1).toBe(69);
  });

  test('the old barrier (no extension) leaves one block: the tracker can walk round the end', () => {
    const t = seeds.get('TOP_A');
    const level = approxLevelGrid(t.seeds, field.geom);
    const old = rasterizeTraces(faultTraces([{ sticks }], level, field.geom), nIl, nXl);
    expect(blocks(old).count).toBe(1);
  });

  test('the barrier is carried to the edge: two blocks, and footwall wells leave the hanging wall empty', async () => {
    const t = seeds.get('TOP_A');
    const mask = faultBarriersForTop([{ sticks }], approxLevelGrid(t.seeds, field.geom), field.geom);
    expect(blocks(mask).count).toBe(2);
    const r = await trackTop({
      getTrace: field.getTrace, geom: field.geom, seeds: t.seeds, kind: t.kind, name: t.name, order: ORDER, tracked: new Map(), barriers: mask,
    });
    const { sizes, picked } = hangingWallPicks(r.picks, mask);
    expect([...sizes.keys()].filter((l) => !picked.get(l))).toHaveLength(1);
  }, 60000);

  test('then the jump fills the hanging wall on the true horizon', async () => {
    const t = seeds.get('TOP_A');
    const mask = faultBarriersForTop([{ sticks }], approxLevelGrid(t.seeds, field.geom), field.geom);
    const r = await trackTop({
      getTrace: field.getTrace, geom: field.geom, seeds: t.seeds, kind: t.kind, name: t.name, order: ORDER, tracked: new Map(), barriers: mask,
    });
    const j = await jumpAcrossFaults({
      getTrace: field.getTrace, geom: field.geom, picks: r.picks, barriers: mask, faults: [{ name: 'F1', sticks }], kind: t.kind,
    });
    const truth = field.truth.horizons.TOP_A;
    let n = 0; let ok = 0;
    for (let c = 0; c < j.picks.length; c++) {
      if (!j.jumped[c] || isNull(j.picks[c]) || isNull(truth[c])) continue;
      n += 1;
      if (Math.abs(j.picks[c] - truth[c]) <= 1) ok += 1;
    }
    expect(n).toBeGreaterThan(800);
    expect(ok / n).toBeGreaterThan(0.95);
  }, 60000);

  test('without the extension the jump has no block to fill, so the hanging wall is never carried across', async () => {
    const t = seeds.get('TOP_A');
    const level = approxLevelGrid(t.seeds, field.geom);
    const old = rasterizeTraces(faultTraces([{ sticks }], level, field.geom), nIl, nXl);
    const r = await trackTop({
      getTrace: field.getTrace, geom: field.geom, seeds: t.seeds, kind: t.kind, name: t.name, order: ORDER, tracked: new Map(), barriers: old,
    });
    const j = await jumpAcrossFaults({
      getTrace: field.getTrace, geom: field.geom, picks: r.picks, barriers: old, faults: [{ name: 'F1', sticks }], kind: t.kind,
    });
    let jumped = 0;
    for (const v of j.jumped || []) jumped += v ? 1 : 0;
    expect(jumped).toBe(0);                      // "Across faults" stays at 0
    const truth = field.truth.horizons.TOP_A;
    let right = 0; let live = 0;
    for (let c = 0; c < j.picks.length; c++) {
      if (isNull(j.picks[c]) || isNull(truth[c])) continue;
      live += 1;
      if (Math.abs(j.picks[c] - truth[c]) <= 1) right += 1;
    }
    expect(live).toBeLessThan(0.8 * nIl * nXl);  // a block is missing or wrong
  }, 60000);
});

describe('extendTraceToEdges', () => {
  const g = { nIl: 70, nXl: 60 };
  test('a trace ending within one stick spacing of the edge is carried to it', () => {
    const t = extendTraceToEdges([{ i: 0, j: 38 }, { i: 32, j: 30 }, { i: 64, j: 22 }], g);
    expect(t[t.length - 1].i).toBeCloseTo(69.5, 6);
  });
  test('a real tip well inside the survey is left where it is', () => {
    const t = extendTraceToEdges([{ i: 0, j: 38 }, { i: 8, j: 36 }, { i: 16, j: 34 }, { i: 30, j: 30 }], g);
    expect(t[t.length - 1].i).toBe(30);
  });
});

describe('a horizon a few samples below the end of every stick', () => {
  test('lengthened sticks still cut it; unlengthened ones give no barrier', () => {
    const t = seeds.get('TOP_A');
    const level = approxLevelGrid(t.seeds, field.geom);
    let lo = Infinity;
    for (const v of level) if (v < lo) lo = v;
    // every stick ends 3 samples above the shallowest point of the level
    const short = autoSticks({ s1: Math.floor(lo) - 3 }).map((st) => ({ points: st.points.filter((p) => p.s <= lo - 3) }))
      .filter((st) => st.points.length >= 3);
    expect(short.length).toBeGreaterThan(4);
    expect(faultTraces([{ sticks: short }], level, field.geom)).toHaveLength(0);
    const mask = faultBarriersForTop([{ sticks: short }], level, field.geom);
    expect(blocks(mask).count).toBe(2);
  });

  test('extendStickEnds adds a point past each end along the end segments', () => {
    const st = { points: [{ il: 4, xl: 10, s: 100 }, { il: 4, xl: 11, s: 110 }, { il: 4, xl: 12, s: 120 }] };
    const e = extendStickEnds(st).points;
    expect(e).toHaveLength(5);
    expect(e[0].s).toBeLessThan(100);
    expect(e[4].s).toBeGreaterThan(120);
    expect(e[4].xl).toBeGreaterThan(12);
  });
});
