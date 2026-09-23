/**
 * Carrying a horizon across a fault into a block no well reaches (Tops to
 * Horizons plan, TP4), gated on the synthetic field's exact truth.
 *
 * The hard case on purpose: every well is on the footwall, and the throw
 * is 33 m, about one wavelet period in time, so the event of the right
 * kind nearest across the fault is the WRONG one. Tracked with barriers,
 * the hanging wall stays empty; the jump must find the true throw from the
 * character of the sequence and fill it on the true horizon.
 */
import { buildSyntheticField } from '../engines/seismolord/syntheticField';
import { makeTvdssToTwt } from '../engines/seismolord/wellSection';
import { wellTopsForMatching, gatherTopTraces, matchTopsToEvents } from '../engines/seismolord/topsToEvents';
import {
  trackingOrder, trackTop, approxLevelGrid, faultBarriersForTop,
} from '../engines/seismolord/framework';
import {
  jumpAcrossFaults, faultDipDirection, measuredThrow, chooseThrow, pairsAcrossBarrier,
} from '../engines/seismolord/faultJump';
import { labelBlocks } from '../engines/seismolord/faultBarriers';

const isNull = (v) => !Number.isFinite(v) || Math.abs(v) > 1e29;
const base = buildSyntheticField().spec;
const field = buildSyntheticField({
  faults: [{ ...base.faults[0], throwM: 33 }],
  wells: base.wells.filter((w) => ['W-1', 'W-2'].includes(w.name)),   // footwall only
});
const faults = [{ name: 'F1', sticks: field.truth.faults[0].sticksLattice() }];
const ORDER = field.spec.interfaces.map((i) => i.name);

async function trackAll(f, { barriersOn = true } = {}) {
  const wells = [];
  for (const w of f.wells) {
    const timeConv = makeTvdssToTwt({ checkshots: w.checkshots, dtUs: f.dtUs, maxTwtMs: f.geom.ns * f.dtMs });
    const tops = wellTopsForMatching({ ...w, tops: w.tops.map((t) => ({ name: t.name, md: t.md })) }, {
      affine: f.affine, geom: f.geom, dtUs: f.dtUs, timeConv,
    });
    wells.push({ name: w.name, tops, traces: await gatherTopTraces(f.getTrace, f.geom, tops) });
  }
  const match = matchTopsToEvents({ wells, dtMs: f.dtMs, order: ORDER });
  const tracked = new Map();
  const barriers = new Map();
  const kinds = new Map();
  for (const t of trackingOrder(match, wells)) {
    const bar = barriersOn ? faultBarriersForTop(faults, approxLevelGrid(t.seeds, f.geom), f.geom) : null;
    // eslint-disable-next-line no-await-in-loop
    const r = await trackTop({
      getTrace: f.getTrace, geom: f.geom, seeds: t.seeds, kind: t.kind, name: t.name, order: ORDER, tracked, barriers: bar,
    });
    tracked.set(t.name, r.picks);
    barriers.set(t.name, bar);
    kinds.set(t.name, t.kind);
  }
  return { tracked, barriers, kinds };
}

function hangingAccuracy(picks, truth, jumpedMask) {
  let n = 0; let ok = 0;
  for (let c = 0; c < picks.length; c++) {
    if (!jumpedMask[c] || isNull(picks[c]) || isNull(truth[c])) continue;
    n += 1;
    if (Math.abs(picks[c] - truth[c]) <= 1) ok += 1;
  }
  return { n, accuracy: n ? ok / n : 0 };
}

let fw;
beforeAll(async () => { fw = await trackAll(field); }, 120000);

test('the fault dips toward larger crosslines (its hanging wall)', () => {
  const d = faultDipDirection(faults[0]);
  expect(d.xl).toBeGreaterThan(0.9);
});

test('with barriers and footwall wells only, the hanging wall of TOP_A is left empty', () => {
  const picks = fw.tracked.get('TOP_A');
  const { labels } = labelBlocks(fw.barriers.get('TOP_A'), field.geom.nIl, field.geom.nXl);
  const blockSizes = new Map();
  const blockPicked = new Map();
  for (let c = 0; c < labels.length; c++) {
    if (labels[c] < 0) continue;
    blockSizes.set(labels[c], (blockSizes.get(labels[c]) || 0) + 1);
    if (!isNull(picks[c])) blockPicked.set(labels[c], (blockPicked.get(labels[c]) || 0) + 1);
  }
  expect(blockSizes.size).toBe(2);
  expect([...blockSizes.keys()].filter((l) => !blockPicked.get(l))).toHaveLength(1);
});

test.each(['TOP_A', 'TOP_B', 'SU', 'TOP_E'])('%s: the jump finds the true throw and fills the hanging wall on the true horizon', async (name) => {
  const r = await jumpAcrossFaults({
    getTrace: field.getTrace,
    geom: field.geom,
    picks: fw.tracked.get(name),
    barriers: fw.barriers.get(name),
    faults,
    kind: fw.kinds.get(name),
  });
  expect(r.jumps.filter((j) => !j.skipped)).toHaveLength(1);
  const j = r.jumps.find((x) => !x.skipped);
  expect(j.throwSamples).toBeGreaterThan(4);                  // hanging wall down (normal fault)
  const acc = hangingAccuracy(r.picks, field.truth.horizons[name], r.jumped);
  expect(acc.n).toBeGreaterThan(800);
  expect(acc.accuracy).toBeGreaterThan(0.95);
}, 60000);

test('negative control: a one-event window cannot tell the true throw from a period off', async () => {
  const name = 'TOP_A';
  const picks = fw.tracked.get(name);
  const barriers = fw.barriers.get(name);
  const { labels } = labelBlocks(barriers, field.geom.nIl, field.geom.nXl);
  const empty = [...new Set(labels)].find((l) => l >= 0 && ![...labels].some((v, c) => v === l && !isNull(picks[c])));
  const dipDir = faultDipDirection(faults[0]);
  const pairs = pairsAcrossBarrier({
    picks, barriers, labels, targetLabel: empty, geom: field.geom, dipDir,
  });
  const long = await chooseThrow({ pairs, getTrace: field.getTrace, picks, dipDir, windowHalf: 20 });
  const short = await chooseThrow({ pairs, getTrace: field.getTrace, picks, dipDir, windowHalf: 2 });
  // the long window separates the true throw clearly; one event barely does
  expect(long.margin).toBeGreaterThan(3 * Math.max(0.01, short.margin));
});

test('negative control: the wrong fault sense (reverse) cannot reach the true throw', async () => {
  const name = 'TOP_A';
  const picks = fw.tracked.get(name);
  const barriers = fw.barriers.get(name);
  const { labels } = labelBlocks(barriers, field.geom.nIl, field.geom.nXl);
  const empty = [...new Set(labels)].find((l) => l >= 0 && ![...labels].some((v, c) => v === l && !isNull(picks[c])));
  const dipDir = faultDipDirection(faults[0]);
  const pairs = pairsAcrossBarrier({
    picks, barriers, labels, targetLabel: empty, geom: field.geom, dipDir,
  });
  const right = await chooseThrow({ pairs, getTrace: field.getTrace, picks, dipDir });
  const wrong = await chooseThrow({ pairs, getTrace: field.getTrace, picks, dipDir, sense: 'reverse' });
  expect(wrong.throwSamples).toBeLessThan(0);
  expect(wrong.ncc).toBeLessThan(right.ncc - 0.1);
});

test('the throw measured on a horizon picked on both sides agrees with the jump', async () => {
  // all five wells: both blocks seeded, so the throw can be measured
  const full = buildSyntheticField({ faults: [{ ...base.faults[0], throwM: 33 }] });
  const both = await (async () => {
    const f = full;
    const wells = [];
    for (const w of f.wells) {
      const timeConv = makeTvdssToTwt({ checkshots: w.checkshots, dtUs: f.dtUs, maxTwtMs: f.geom.ns * f.dtMs });
      const tops = wellTopsForMatching({ ...w, tops: w.tops.map((t) => ({ name: t.name, md: t.md })) }, {
        affine: f.affine, geom: f.geom, dtUs: f.dtUs, timeConv,
      });
      wells.push({ name: w.name, tops, traces: await gatherTopTraces(f.getTrace, f.geom, tops) });
    }
    const match = matchTopsToEvents({ wells, dtMs: f.dtMs, order: ORDER });
    const t = trackingOrder(match, wells).find((x) => x.name === 'TOP_A');
    const bar = faultBarriersForTop(faults, approxLevelGrid(t.seeds, f.geom), f.geom);
    const r = await trackTop({
      getTrace: f.getTrace, geom: f.geom, seeds: t.seeds, kind: t.kind, name: 'TOP_A', order: ORDER, tracked: new Map(), barriers: bar,
    });
    return { picks: r.picks, bar };
  })();
  const measured = measuredThrow({
    picks: both.picks, barriers: both.bar, geom: full.geom, dipDir: faultDipDirection(faults[0]),
  });
  const r = await jumpAcrossFaults({
    getTrace: field.getTrace, geom: field.geom, picks: fw.tracked.get('TOP_A'), barriers: fw.barriers.get('TOP_A'), faults, kind: 'peak',
  });
  const j = r.jumps.find((x) => !x.skipped);
  expect(Math.abs(measured - j.throwSamples)).toBeLessThan(1.5);
}, 120000);
