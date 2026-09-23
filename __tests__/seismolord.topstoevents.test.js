/**
 * Tops to events (Tops to Horizons plan, TP1), gated on the synthetic
 * field's exact truth (engines/seismolord/syntheticField.js): every
 * interface's two-way time at every trace, every top's MD, and every
 * reflection coefficient are known analytically.
 *
 * The pipeline under test is the real one: tops placed along the well
 * path through the well's own checkshots (buildWellLatticePath,
 * makeTvdssToTwt), traces read at each top's own lattice cell, candidates
 * scored, per-well dynamic programme, field vote, tuning groups.
 */
import { buildSyntheticField } from '../engines/seismolord/syntheticField';
import { makeTvdssToTwt } from '../engines/seismolord/wellSection';
import {
  wellTopsForMatching, gatherTopTraces, matchTopsToEvents, findEvents, expectedEventAtTop,
  assignWellTops, tuningTimeMs, peakFrequencyHz, scoreCandidate,
} from '../engines/seismolord/topsToEvents';

const field = buildSyntheticField();
const { geom, dtMs, dtUs } = field;
const ORDER = field.spec.interfaces.map((i) => i.name);

async function prepare(f = field, { shiftMs = 0, sigmaMs = null, logs = true, source = null } = {}) {
  const wells = [];
  for (const w of f.wells) {
    const checkshots = w.checkshots.map((c) => ({ tvdss_m: c.tvdss_m, twt_ms: c.twt_ms + shiftMs }));
    const timeConv = makeTvdssToTwt({ checkshots, dtUs, maxTwtMs: geom.ns * dtMs });
    const well = { ...w, tops: w.tops.map((t) => ({ name: t.name, md: t.md })), logs: logs ? w.logs : null };
    const tops = wellTopsForMatching(well, {
      affine: f.affine, geom, dtUs, timeConv, sigmaMs, source,
    });
    const traces = await gatherTopTraces(f.getTrace, geom, tops);
    wells.push({ name: w.name, tops, traces });
  }
  return wells;
}

const truthSample = (name, cell) => field.truth.horizons[name][cell.il * geom.nXl + cell.xl];

describe('pieces', () => {
  test('findEvents finds the peak of a Ricker at its exact sub-sample time', () => {
    const tr = field.traceAt(10, 10);
    const ev = field.eventsAt(10, 10).find((e) => e.name === 'TOP_A');
    const s = ev.twtMs / dtMs;
    const found = findEvents(tr, s - 3, s + 3).filter((e) => e.kind === 'peak');
    expect(found).toHaveLength(1);
    expect(Math.abs(found[0].sample - s)).toBeLessThan(0.1);
  });

  test('the logs predict the event kind from the impedance contrast', () => {
    const w = field.wells[1];
    const kinds = w.tops.map((t) => [t.name, expectedEventAtTop(w.logs, t.md).kind]);
    expect(Object.fromEntries(kinds)).toMatchObject({
      TOP_A: 'peak', TOP_B: 'trough', TOP_C: 'peak', TOP_C2: 'trough', SU: 'peak', TOP_D: 'trough', TOP_E: 'peak',
    });
    expect(expectedEventAtTop(w.logs, w.tops[0].md, { polarity: 'reverse' }).kind).toBe('trough');
    expect(expectedEventAtTop(w.logs, w.tops[0].md, { phaseDeg: 90 }).kind).toBe('zero_pos');
    expect(expectedEventAtTop(null, 100)).toBeNull();
  });

  test('peak frequency of the field wavelet is its 30 Hz Ricker', () => {
    // an isolated reflector: the spectrum peaks at the Ricker's peak
    const tr = field.traceAt(30, 10);
    const s = field.eventsAt(30, 10)[0].twtMs / dtMs;
    const f = peakFrequencyHz(tr, dtMs, { s0: Math.round(s - 20), s1: Math.round(s + 20) });
    expect(f).toBeGreaterThan(25);
    expect(f).toBeLessThan(35);
    expect(tuningTimeMs(30)).toBeCloseTo(14.43, 2);
  });

  test('the programme keeps order and never shares an event', () => {
    const c = (sample, score, kind = 'peak') => ({ kind, sample, amp: 1, score });
    // the best-scoring event for B is ABOVE A's best: order must win
    const tops = [
      { name: 'A', candidates: [c(10, 0.9), c(20, 0.5)] },
      { name: 'B', candidates: [c(9, 0.95), c(25, 0.6)] },
    ];
    const out = assignWellTops(tops);
    expect(out[0].choice.sample).toBeLessThan(out[1].choice.sample);
    expect(out.map((o) => o.choice.sample)).toEqual([10, 25]);
    // one event only: one of them stays unmatched rather than share it
    const one = assignWellTops([
      { name: 'A', candidates: [c(10, 0.9)] },
      { name: 'B', candidates: [c(10, 0.9)] },
    ]);
    expect(one.filter((o) => o.choice).length).toBe(1);
  });

  test('score parts: time, polarity, amplitude, coherence', () => {
    const base = { predSample: 100, sigmaSamples: 2, expectedKind: 'peak', rms: 1, coherence: 0.9 };
    const good = scoreCandidate({ kind: 'peak', sample: 100, amp: 1.5 }, base);
    const late = scoreCandidate({ kind: 'peak', sample: 106, amp: 1.5 }, base);
    const wrong = scoreCandidate({ kind: 'trough', sample: 100, amp: -1.5 }, base);
    expect(good.score).toBeGreaterThan(late.score);
    expect(good.score).toBeGreaterThan(wrong.score * 5);
    expect(good.parts.time).toBeCloseTo(1, 6);
  });
});

describe('field-wide matching on the synthetic field', () => {
  let result;
  let wells;
  beforeAll(async () => {
    wells = await prepare();
    result = matchTopsToEvents({ wells, dtMs, order: ORDER });
  });

  test('the dominant frequency and tuning come from the data', () => {
    expect(result.peakHz).toBeGreaterThan(24);
    expect(result.peakHz).toBeLessThan(36);
    expect(result.tuningMs).toBeGreaterThan(11);
    expect(result.tuningMs).toBeLessThan(18);
  });

  test('the thin pair is grouped: TOP_C mapped (stronger contrast), TOP_C2 conformable at about 5.5 ms', () => {
    const c = result.tops.find((t) => t.name === 'TOP_C');
    const c2 = result.tops.find((t) => t.name === 'TOP_C2');
    expect(c.role).toBe('mapped');
    expect(c2.role).toBe('conformable');
    expect(c2.representative).toBe('TOP_C');
    for (const off of Object.values(c2.offsetsMs)) {
      expect(off).toBeGreaterThan(4);
      expect(off).toBeLessThan(7);
    }
    expect(result.groups).toHaveLength(1);
  });

  test('every mapped top gets the event kind its contrast makes', () => {
    const kinds = Object.fromEntries(result.tops.filter((t) => t.role === 'mapped').map((t) => [t.name, t.kind]));
    expect(kinds).toEqual({
      TOP_A: 'peak', TOP_B: 'trough', TOP_C: 'peak', SU: 'peak', TOP_D: 'trough', TOP_E: 'peak',
    });
  });

  test('every mapped pick lands on the true horizon at its cell (0.5 sample; 1 for a tuned group), except where the well flags tuning', () => {
    let checked = 0;
    const misses = [];
    for (const t of result.tops.filter((x) => x.role === 'mapped')) {
      for (const [wName, at] of Object.entries(t.atWells)) {
        const flagged = result.wells.find((w) => w.name === wName).tuned.some((g) => g.includes(t.name));
        if (flagged) continue;
        const top = wells.find((w) => w.name === wName).tops.find((q) => q.name === t.name);
        const truth = truthSample(t.name, top.cell);
        expect(at.choice).not.toBeNull();
        const err = Math.abs(at.choice.sample - truth);
        // a tuned group's representative rides on the interference of the
        // doublet: its composite event sits up to a sample off the
        // interface (tuning bias, physics); an isolated top sits on it
        const tol = t.group ? 1 : 0.5;
        if (err > tol) misses.push({ top: t.name, well: wName, err });
        checked += 1;
      }
    }
    expect(misses).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(25);
  });

  test('where SU and TOP_D pinch toward the unconformity the well is flagged as tuned', () => {
    // W-3 sits near the truncation: SU and TOP_D are under 14 ms apart
    const w3 = result.wells.find((w) => w.name === 'W-3');
    expect(w3.tuned.some((g) => g.includes('SU') && g.includes('TOP_D'))).toBe(true);
    // elsewhere they are resolved
    const w2 = result.wells.find((w) => w.name === 'W-2');
    expect(w2.tuned).toEqual([]);
  });

  test('an absent top (eroded at W-1) is simply not asked for there', () => {
    expect(result.tops.find((t) => t.name === 'TOP_D').atWells['W-1']).toBeUndefined();
  });

  test('a bad tie (all checkshots 10 ms late) is recovered by the event search', async () => {
    const shifted = await prepare(field, { shiftMs: 10, sigmaMs: 12 });
    const r = matchTopsToEvents({ wells: shifted, dtMs, order: ORDER });
    const a = r.tops.find((t) => t.name === 'TOP_A');
    for (const [wName, at] of Object.entries(a.atWells)) {
      const top = shifted.find((w) => w.name === wName).tops.find((q) => q.name === 'TOP_A');
      expect(Math.abs(at.choice.sample - truthSample('TOP_A', top.cell))).toBeLessThan(0.5);
      expect(at.deltaMs).toBeLessThan(-7);              // the pick sits about 10 ms above the prediction
    }
  });

  test('noise: 10 percent of the strongest reflection still matches every clean top', async () => {
    const noisy = buildSyntheticField({ noise: 0.02, seed: 11 });
    const nw = await prepare(noisy);
    const r = matchTopsToEvents({ wells: nw, dtMs, order: ORDER });
    const a = r.tops.find((t) => t.name === 'TOP_A');
    for (const [wName, at] of Object.entries(a.atWells)) {
      const top = nw.find((w) => w.name === wName).tops.find((q) => q.name === 'TOP_A');
      expect(Math.abs(at.choice.sample - noisy.truth.horizons.TOP_A[top.cell.il * geom.nXl + top.cell.xl])).toBeLessThan(1);
    }
  });
});

describe('negative controls (the gates can fail)', () => {
  test('without logs and with a half-period time error the matcher picks the wrong events', async () => {
    // 17 ms is half the 30 Hz period: the neighbouring event of the
    // opposite kind now sits closer than the true one, and nothing else
    // (no logs, so no polarity) can overrule the time term
    const wells = await prepare(field, { shiftMs: 17, sigmaMs: 4, logs: false });
    const r = matchTopsToEvents({ wells, dtMs, order: ORDER });
    let wrong = 0;
    let total = 0;
    for (const t of r.tops.filter((x) => x.role === 'mapped')) {
      for (const [wName, at] of Object.entries(t.atWells)) {
        const top = wells.find((w) => w.name === wName).tops.find((q) => q.name === t.name);
        total += 1;
        if (!at.choice || Math.abs(at.choice.sample - truthSample(t.name, top.cell)) > 0.5) wrong += 1;
      }
    }
    expect(wrong / total).toBeGreaterThan(0.5);
  });

  test('with the logs back, the same time error is overruled by polarity for most tops', async () => {
    const wells = await prepare(field, { shiftMs: 17, sigmaMs: 12 });
    const r = matchTopsToEvents({ wells, dtMs, order: ORDER });
    const a = r.tops.find((t) => t.name === 'TOP_A');
    expect(a.kind).toBe('peak');
  });

  test('a tuning thickness the data cannot have (200 Hz) groups nothing', async () => {
    const wells = await prepare();
    const r = matchTopsToEvents({
      wells, dtMs, order: ORDER, peakHz: 200,
    });
    expect(r.groups).toEqual([]);
    expect(r.tops.find((t) => t.name === 'TOP_C2').role).toBe('mapped');
  });
});
