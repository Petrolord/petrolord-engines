/**
 * W3.4 depth-stretch oracles: constant-velocity analytic resample
 * (exact for a linear-in-time trace), the layer-boundary exact-row
 * guarantee, per-column dependence of a layer cake, null propagation
 * and below-column nulls.
 */

import {
  columnDepths, depthAxisFor, depthResampleColumn, depthStretchSlice,
  depthRowOfSample, depthRowGrid,
} from '../engines/seismolord/depthConvert';
import { makeDepthConverter } from '../engines/seismolord/velocityModel';
import { NULL_VALUE } from '../engines/seismolord/manifest';

const NULL_F32 = Math.fround(NULL_VALUE);
const DT_MS = 4;
const NS = 100;

describe('constant velocity — analytic resample', () => {
  // V = 2000 m/s: z(t) = 2000 * (t/2000) = t  (1 m per ms of TWT)
  const conv = makeDepthConverter({ v0: 2000, k: 0 });

  test('a linear ramp is reproduced exactly at every depth row', () => {
    const trace = Float32Array.from({ length: NS }, (_, i) => i * DT_MS); // value = twt
    const z = columnDepths(conv, 0, DT_MS, NS);
    expect(z[NS - 1]).toBeCloseTo((NS - 1) * DT_MS, 9);
    const axis = depthAxisFor(conv, [0], (NS - 1) * DT_MS, 128);
    const out = depthResampleColumn(trace, z, axis);
    for (let k = 0; k < axis.nz; k++) {
      const zk = axis.z0 + k * axis.dz;
      // value(t) = t and z = t -> the resampled value must equal zk
      expect(out[k]).toBeCloseTo(zk, 4);
    }
  });

  test('depthRowOfSample inverts the same closure', () => {
    const axis = depthAxisFor(conv, [0], (NS - 1) * DT_MS, 128);
    const r = depthRowOfSample(conv, 0, 50, DT_MS, axis);   // t = 200 ms -> z = 200
    expect(axis.z0 + r * axis.dz).toBeCloseTo(200, 9);
  });
});

describe('layer cake — boundary lands on its exact stretched row', () => {
  // two layers: 2000 m/s above the boundary, 4000 m/s below; boundary
  // TIME varies per column (dipping horizon)
  const NIL = 1;
  const NXL = 8;
  const boundarySample = (j) => 40 + 2 * j;                 // sample index
  const boundaries = [Float32Array.from({ length: NIL * NXL },
    (_, c) => boundarySample(c))];
  const model = {
    type: 'layercake',
    layers: [
      { base_horizon_id: 'h1', v0: 2000, k: 0 },
      { base_horizon_id: null, v0: 4000, k: 0 },
    ],
  };
  const conv = makeDepthConverter(model, { dtUs: DT_MS * 1000, boundaries });

  test('per-column maps differ and the boundary lands on its exact stretched row', () => {
    const trace = Float32Array.from({ length: NS }, (_, i) => i * DT_MS); // value = twt
    // 1 m rows: every column's boundary depth (z = t above the boundary
    // at 2000 m/s, so zB = tB) falls exactly on an integer row
    const axis = { z0: 0, dz: 1, nz: 800 };
    for (const j of [0, 3, 7]) {
      const z = columnDepths(conv, j, DT_MS, NS);
      const out = depthResampleColumn(trace, z, axis);
      const tB = boundarySample(j) * DT_MS;
      const rB = depthRowOfSample(conv, j, boundarySample(j), DT_MS, axis);
      expect(rB).toBeCloseTo(tB, 6);          // zB = tB at 1 m/ms above
      expect(rB % 1).toBeCloseTo(0, 6);       // exact row
      expect(out[Math.round(rB)]).toBeCloseTo(tB, 3); // boundary value on it
    }
    // column dependence: same depth row maps to different times across columns
    const zColA = columnDepths(conv, 0, DT_MS, NS);
    const zColB = columnDepths(conv, 7, DT_MS, NS);
    expect(zColA[80]).not.toBeCloseTo(zColB[80], 0);
  });

  test('depthRowGrid converts a pick grid through the same closure', () => {
    const picks = Float32Array.from({ length: NIL * NXL },
      (_, c) => boundarySample(c));
    picks[5] = NULL_F32;
    const axis = depthAxisFor(conv, [0, 1, 2, 3, 4, 5, 6, 7], (NS - 1) * DT_MS, 256);
    const rows = depthRowGrid(picks, conv, DT_MS, axis);
    expect(rows[5]).toBe(NULL_F32);
    for (const j of [0, 2, 7]) {
      // rows store float32 — compare at f32 precision
      expect(rows[j]).toBeCloseTo(
        depthRowOfSample(conv, j, boundarySample(j), DT_MS, axis), 4,
      );
    }
  });
});

describe('nulls and slice stretching', () => {
  const conv = makeDepthConverter({ v0: 2000, k: 0 });

  test('null input samples null the touching rows; below-column rows stay null', () => {
    const trace = Float32Array.from({ length: NS }, (_, i) => i);
    trace[50] = NULL_F32;
    const z = columnDepths(conv, 0, DT_MS, NS);
    const axis = { z0: 0, dz: 1, nz: 500 };                 // 1 m rows
    const out = depthResampleColumn(trace, z, axis);
    // sample 50 covers z 196..204 (z = t = i*4): every row interpolating
    // across it is null
    let nulls = 0;
    for (let k = 197; k <= 203; k++) if (out[k] === NULL_F32) nulls++;
    expect(nulls).toBeGreaterThanOrEqual(6);
    expect(out[190]).not.toBe(NULL_F32);
    // beyond the column bottom (z > 396): null
    expect(out[420]).toBe(NULL_F32);
    expect(out[499]).toBe(NULL_F32);
  });

  test('depthStretchSlice runs per column with its own cell', () => {
    const nTraces = 4;
    const slice = {
      width: NS,
      height: nTraces,
      data: new Float32Array(nTraces * NS),
    };
    for (let t = 0; t < nTraces; t++) {
      for (let i = 0; i < NS; i++) slice.data[t * NS + i] = t * 1000 + i * DT_MS;
    }
    const axis = depthAxisFor(conv, [0], (NS - 1) * DT_MS, 64);
    const out = depthStretchSlice(slice, (t) => t, conv, DT_MS, axis);
    expect(out.width).toBe(64);
    expect(out.height).toBe(nTraces);
    for (let t = 0; t < nTraces; t++) {
      const zk = axis.z0 + 10 * axis.dz;
      expect(out.data[t * 64 + 10]).toBeCloseTo(t * 1000 + zk, 3);
    }
  });
});
