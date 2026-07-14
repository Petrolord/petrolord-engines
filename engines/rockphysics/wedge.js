// Wedge modeling + tuning analysis (Rock Physics Studio G6.1/G6.3) —
// two-interface wedge synthetics on the SHARED waveform primitives
// (src/lib/waveform.js, extracted from Seismolord synthetics).
// Validated against the rockphysics oracle goldens (tolerance 1e-5:
// the shared primitives store Float32; the oracle runs float64).
//
// The classic result the goldens pin: for an equal-and-opposite RC
// pair under a Ricker wavelet, tuning thickness = the wavelet's
// peak-to-trough time sqrt(6)/(2*pi*f) (~ Kallweit & Wood's 1/(2.6f)).

import { rickerWavelet, convolveSame } from '../../lib/waveform';

function checkParams(freqHz, dtMs) {
  if (!(freqHz > 0) || !(dtMs > 0)) {
    throw new Error('Wedge model needs a positive frequency and sample rate.');
  }
}

/** One wedge trace: rcTop at a fixed datum, rcBase thicknessMs below.
 *  Returns {trace: Float32Array, t0: index of the top interface}. */
export function wedgeTrace(thicknessMs, rcTop, rcBase, freqHz, dtMs, traceMs) {
  checkParams(freqHz, dtMs);
  if (!(thicknessMs >= 0)) throw new Error('Thickness must be >= 0 ms.');
  const n = Math.round(traceMs / dtMs) + 1;
  const t0 = Math.floor(n / 3);
  const spikes = new Float64Array(n);
  spikes[t0] += rcTop;
  const ib = t0 + Math.round(thicknessMs / dtMs);
  if (ib < n) spikes[ib] += rcBase;
  const { data } = convolveSame(spikes, rickerWavelet(freqHz, dtMs, 60));
  return { trace: data, t0 };
}

/** Full wedge panel: one trace per thickness step 0..maxThicknessMs.
 *  Returns {traces, thicknessesMs, t0, dtMs}. */
export function wedgePanel(rcTop, rcBase, freqHz, dtMs, maxThicknessMs) {
  checkParams(freqHz, dtMs);
  const steps = Math.round(maxThicknessMs / dtMs);
  const traces = [];
  const thicknessesMs = [];
  let t0 = 0;
  for (let k = 0; k <= steps; k++) {
    const thickness = k * dtMs;
    const out = wedgeTrace(thickness, rcTop, rcBase, freqHz, dtMs, maxThicknessMs * 3);
    traces.push(out.trace);
    thicknessesMs.push(thickness);
    t0 = out.t0;
  }
  return { traces, thicknessesMs, t0, dtMs };
}

/** Peak |amplitude| near the top interface per thickness (the tuning
 *  curve), searched within the wavelet's peak-to-trough time of t0 —
 *  the same window the oracle uses. */
export function tuningCurve(rcTop, rcBase, freqHz, dtMs, maxThicknessMs) {
  const { traces, thicknessesMs, t0 } = wedgePanel(rcTop, rcBase, freqHz, dtMs, maxThicknessMs);
  const w = Math.round(((0.5 * Math.sqrt(6)) / (Math.PI * freqHz)) * 1000 / dtMs) + 1;
  const amplitudes = traces.map((trace) => {
    let peak = 0;
    const lo = Math.max(0, t0 - w);
    const hi = Math.min(trace.length - 1, t0 + w);
    for (let i = lo; i <= hi; i++) peak = Math.max(peak, Math.abs(trace[i]));
    return peak;
  });
  return { thicknessesMs, amplitudes };
}

/** Thickness (ms) at the tuning-curve maximum. */
export function tuningThicknessMs(amplitudes, dtMs) {
  let best = 0;
  for (let i = 1; i < amplitudes.length; i++) {
    if (amplitudes[i] > amplitudes[best]) best = i;
  }
  return best * dtMs;
}
