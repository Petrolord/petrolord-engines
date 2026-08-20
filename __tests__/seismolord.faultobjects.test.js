/**
 * W3.1 fault-object oracles: lofted surfaces, horizon-fault cutoffs with
 * KNOWN throw/heave on synthetic faulted horizons, polygon rasterization.
 * All constructions are analytic (planar horizons, planar faults) so the
 * expected cutoff positions follow from line-line intersection by hand.
 */

import {
  loftFaultSurface, resampleStickLattice, stickChordDir,
  horizonFaultCutoff, faultHorizonIntersection,
  polygonMask, applyPolygonMask, profileStepMeters,
} from '../engines/seismolord/faultObjects';
import { NULL_VALUE } from '../engines/seismolord/manifest';

const NULL_F32 = Math.fround(NULL_VALUE);

const NIL = 64;
const NXL = 64;
const geom = { nIl: NIL, nXl: NXL };

/**
 * Step horizon across a fault that dips along xl:
 *   fault plane:  xl_f(s) = xlAt50 + beta * (s - 50)
 *   horizon:      s = sNeg for xl on the neg side of the fault at
 *                 horizon level, s = sNeg + throw on the pos side.
 * The side test uses the fault's xl at the LOCAL horizon level so the
 * step sits exactly on the fault (each wall ends at its own cutoff).
 */
function stepHorizon({ sNeg = 40, throwS = 8, xlAt50 = 32, beta = 0 }) {
  const picks = new Float32Array(NIL * NXL).fill(NULL_F32);
  for (let i = 0; i < NIL; i++) {
    for (let j = 0; j < NXL; j++) {
      const xlFaultNeg = xlAt50 + beta * (sNeg - 50);
      const xlFaultPos = xlAt50 + beta * (sNeg + throwS - 50);
      if (j < xlFaultNeg) picks[i * NXL + j] = sNeg;
      else if (j >= xlFaultPos) picks[i * NXL + j] = sNeg + throwS;
      // cells between the two cutoffs stay NULL: the fault gap
    }
  }
  return picks;
}

/** Vertical-plane fault sticks along xl at several inlines. */
function faultSticks({ xlAt50 = 32, beta = 0, ils = [8, 24, 40, 56] }) {
  return ils.map((il) => ({
    points: Array.from({ length: 13 }, (_, n) => {
      const s = 20 + n * 5; // 20..80
      return { il, xl: xlAt50 + beta * (s - 50), s };
    }),
  }));
}

describe('loftFaultSurface', () => {
  test('rails x samples grid in lattice space, stored order', () => {
    const sticks = faultSticks({ beta: 0.5 });
    const surf = loftFaultSurface(sticks, { samples: 9 });
    expect(surf.version).toBe(1);
    expect(surf.rails).toHaveLength(4);
    expect(surf.rails[0]).toHaveLength(9);
    // first rail spans the stick exactly: endpoints preserved
    const [il0, xl0, s0] = surf.rails[0][0];
    const [il1, xl1, s1] = surf.rails[0][8];
    expect(il0).toBeCloseTo(8, 9);
    expect(s0).toBeCloseTo(20, 9);
    expect(xl0).toBeCloseTo(32 + 0.5 * (20 - 50), 9);
    expect(il1).toBeCloseTo(8, 9);
    expect(s1).toBeCloseTo(80, 9);
    expect(xl1).toBeCloseTo(32 + 0.5 * (80 - 50), 9);
  });

  test('a reversed stick is re-oriented to match its neighbour', () => {
    const sticks = faultSticks({ beta: 0 });
    const flipped = sticks.map((st, idx) => (idx === 1
      ? { points: [...st.points].reverse() } : st));
    const a = loftFaultSurface(sticks, { samples: 8 });
    const b = loftFaultSurface(flipped, { samples: 8 });
    const fa = a.rails[1].flat();
    const fb = b.rails[1].flat();
    fb.forEach((v, k) => expect(v).toBeCloseTo(fa[k], 9));
  });

  test('fewer than two usable sticks -> null', () => {
    expect(loftFaultSurface([faultSticks({})[0]])).toBeNull();
    expect(loftFaultSurface([])).toBeNull();
    expect(loftFaultSurface([{ points: [{ il: 1, xl: 1, s: 5 }] },
      { points: [{ il: 2, xl: 1, s: 5 }] }])).toBeNull();
  });

  test('resampleStickLattice is uniform in arc length', () => {
    const stick = { points: [{ il: 0, xl: 0, s: 0 }, { il: 0, xl: 0, s: 10 }] };
    const pts = resampleStickLattice(stick, 5);
    expect(pts.map((p) => p[2])).toEqual([0, 2.5, 5, 7.5, 10]);
  });
});

describe('horizonFaultCutoff — known throw and heave', () => {
  test('vertical fault: throw exact, heave zero', () => {
    const picks = stepHorizon({ sNeg: 40, throwS: 8, beta: 0 });
    const stick = faultSticks({ beta: 0 })[0];
    // vertical-in-map stick: profile direction must come from opts.dir
    expect(stickChordDir(stick)).toBeNull();
    const cut = horizonFaultCutoff(stick, picks, geom, { dir: [0, 1] });
    expect(cut).not.toBeNull();
    expect(cut.throwSamples).toBeCloseTo(8, 6);
    expect(cut.heaveCells).toBeCloseTo(0, 6);
    expect(cut.neg.s).toBeCloseTo(40, 6);
    expect(cut.pos.s).toBeCloseTo(48, 6);
    // both cutoffs sit on the fault plane xl = 32
    expect(cut.neg.xl).toBeCloseTo(32, 6);
    expect(cut.pos.xl).toBeCloseTo(32, 6);
  });

  test('dipping fault: heave = beta * throw (analytic)', () => {
    const beta = 0.5;
    const picks = stepHorizon({ sNeg: 40, throwS: 8, beta });
    const stick = faultSticks({ beta })[1];
    const cut = horizonFaultCutoff(stick, picks, geom, { dir: [0, 1] });
    expect(cut).not.toBeNull();
    expect(cut.throwSamples).toBeCloseTo(8, 5);
    expect(cut.heaveCells).toBeCloseTo(beta * 8, 5);
    // cutoffs on the fault plane at their own levels
    expect(cut.neg.xl).toBeCloseTo(32 + beta * (40 - 50), 5);
    expect(cut.pos.xl).toBeCloseTo(32 + beta * (48 - 50), 5);
  });

  test('dipping horizon walls: line-line intersection recovered', () => {
    // horizon dips along xl on both walls: s = 40 + 0.2 (xl - 32) on the
    // neg wall, s = 48 + 0.2 (xl - 32) on the pos wall; vertical fault
    // at xl = 32. Intersections by hand: neg (u=0, s=40), pos (0, 48).
    const picks = new Float32Array(NIL * NXL).fill(NULL_F32);
    for (let i = 0; i < NIL; i++) {
      for (let j = 0; j < NXL; j++) {
        if (j < 32) picks[i * NXL + j] = 40 + 0.2 * (j - 32);
        else if (j >= 32) picks[i * NXL + j] = 48 + 0.2 * (j - 32);
      }
    }
    const stick = faultSticks({ beta: 0 })[0];
    const cut = horizonFaultCutoff(stick, picks, geom, { dir: [0, 1] });
    expect(cut.throwSamples).toBeCloseTo(8, 5);
    expect(cut.heaveCells).toBeCloseTo(0, 5);
    expect(cut.neg.s).toBeCloseTo(40, 5);
    expect(cut.pos.s).toBeCloseTo(48, 5);
  });

  test('holes beside the fault: recovered from samples beyond them', () => {
    const picks = stepHorizon({ sNeg: 40, throwS: 8, beta: 0 });
    // punch a hole 3..4 cells out on the neg side at the stick inline
    for (let j = 28; j <= 29; j++) picks[8 * NXL + j] = NULL_F32;
    const cut = horizonFaultCutoff(faultSticks({ beta: 0 })[0], picks, geom,
      { dir: [0, 1] });
    expect(cut).not.toBeNull();
    expect(cut.throwSamples).toBeCloseTo(8, 4);
  });

  test('no crossing (horizon above the stick) -> null', () => {
    const picks = new Float32Array(NIL * NXL).fill(5); // stick spans 20..80
    const cut = horizonFaultCutoff(faultSticks({ beta: 0 })[0], picks, geom,
      { dir: [0, 1] });
    expect(cut).toBeNull();
  });
});

describe('faultHorizonIntersection — trace, polygon, throw map', () => {
  test('full construction on the dipping fault', () => {
    const beta = 0.5;
    const picks = stepHorizon({ sNeg: 40, throwS: 8, beta });
    const fault = { sticks: faultSticks({ beta }) };
    const x = faultHorizonIntersection(fault, picks, geom);
    expect(x).not.toBeNull();
    expect(x.trace).toHaveLength(4);
    expect(x.segments).toHaveLength(4);
    for (const seg of x.segments) {
      expect(Math.abs(seg.throwSamples)).toBeCloseTo(8, 4);
      expect(Math.abs(seg.heaveCells)).toBeCloseTo(beta * 8, 4);
    }
    // sides are consistent along the fault (no sign flips between sticks)
    const signs = new Set(x.segments.map((s) => Math.sign(s.throwSamples)));
    expect(signs.size).toBe(1);
    // polygon: closed ring around the gap, one vertex per cutoff per wall
    expect(x.polygon).toHaveLength(8);
    // the two walls sit at the analytic cutoff crosslines
    for (const p of x.cutNeg) expect(p.xl).toBeCloseTo(32 + beta * (40 - 50), 4);
    for (const p of x.cutPos) expect(p.xl).toBeCloseTo(32 + beta * (48 - 50), 4);
  });

  test('single crossing -> null', () => {
    const picks = stepHorizon({ sNeg: 40, throwS: 8, beta: 0 });
    const fault = { sticks: [faultSticks({ beta: 0 })[0]] };
    expect(faultHorizonIntersection(fault, picks, geom)).toBeNull();
  });

  test('sticks stored in reversed point order keep consistent walls', () => {
    const beta = 0.5;
    const picks = stepHorizon({ sNeg: 40, throwS: 8, beta });
    const sticks = faultSticks({ beta }).map((st, idx) => (idx % 2
      ? { points: [...st.points].reverse() } : st));
    const x = faultHorizonIntersection({ sticks }, picks, geom);
    const signs = new Set(x.segments.map((s) => Math.sign(s.throwSamples)));
    expect(signs.size).toBe(1);
  });
});

describe('polygonMask / applyPolygonMask', () => {
  test('square ring rasterizes its interior cells', () => {
    const ring = [
      { il: 10.5, xl: 10.5 }, { il: 10.5, xl: 20.5 },
      { il: 20.5, xl: 20.5 }, { il: 20.5, xl: 10.5 },
    ];
    const mask = polygonMask([ring], NIL, NXL);
    expect(mask[15 * NXL + 15]).toBe(1);
    expect(mask[15 * NXL + 25]).toBe(0);
    expect(mask[5 * NXL + 15]).toBe(0);
    let count = 0;
    for (const v of mask) count += v;
    expect(count).toBe(100); // cells 11..20 x 11..20
  });

  test('applyPolygonMask nulls masked cells only', () => {
    const grid = new Float32Array(NIL * NXL).fill(7);
    const mask = new Uint8Array(NIL * NXL);
    mask[3 * NXL + 4] = 1;
    const out = applyPolygonMask(grid, mask);
    expect(out[3 * NXL + 4]).toBe(NULL_F32);
    expect(out[3 * NXL + 5]).toBe(7);
    expect(grid[3 * NXL + 4]).toBe(7); // input untouched
  });

  test('degenerate rings are ignored', () => {
    const mask = polygonMask([[{ il: 1, xl: 1 }, { il: 2, xl: 2 }]], 8, 8);
    expect(mask.every((v) => v === 0)).toBe(true);
  });
});

describe('profileStepMeters', () => {
  test('mixes spacings by direction', () => {
    expect(profileStepMeters([0, 1], 25, 12.5)).toBeCloseTo(12.5, 9);
    expect(profileStepMeters([1, 0], 25, 12.5)).toBeCloseTo(25, 9);
    expect(profileStepMeters([Math.SQRT1_2, Math.SQRT1_2], 20, 20))
      .toBeCloseTo(20, 9);
  });
});

describe('surfaceLevelTrace', () => {
  const { loftFaultSurface: loft, surfaceLevelTrace } = require('../engines/seismolord/faultObjects');

  test('dipping fault: analytic xl at the level, one point per rail', () => {
    const beta = 0.5;
    const sticks = [8, 24, 40, 56].map((il) => ({
      points: Array.from({ length: 13 }, (_, n) => {
        const s = 20 + n * 5;
        return { il, xl: 32 + beta * (s - 50), s };
      }),
    }));
    const surf = loft(sticks, { samples: 16 });
    const trace = surfaceLevelTrace(surf, 44);
    expect(trace).toHaveLength(4);
    trace.forEach((p, k) => {
      expect(p.i).toBeCloseTo([8, 24, 40, 56][k], 6);
      expect(p.j).toBeCloseTo(32 + beta * (44 - 50), 6);
    });
  });

  test('level outside every rail span -> null', () => {
    const sticks = [0, 10].map((il) => ({
      points: [{ il, xl: 5, s: 30 }, { il, xl: 5, s: 60 }],
    }));
    const surf = loft(sticks, { samples: 4 });
    expect(surfaceLevelTrace(surf, 90)).toBeNull();
    expect(surfaceLevelTrace(surf, 10)).toBeNull();
    expect(surfaceLevelTrace(null, 40)).toBeNull();
  });

  test('a single rail reaching the level is not a trace', () => {
    const sticks = [
      { points: [{ il: 0, xl: 5, s: 30 }, { il: 0, xl: 5, s: 60 }] },
      { points: [{ il: 10, xl: 5, s: 70 }, { il: 10, xl: 5, s: 90 }] },
    ];
    const surf = loft(sticks, { samples: 4 });
    expect(surfaceLevelTrace(surf, 40)).toBeNull();
  });
});
