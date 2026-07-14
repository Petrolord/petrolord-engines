// Cutoffs, net pay and zone summaries (Petrophysics Studio G2.1).
// Shared engine conventions in vsh.js. Depth-aware by midpoint sample
// thickness — exact on regular steps, correct on irregular ones (the
// depth vector is data, the G1 lesson). Samples with any missing
// input are NOT pay; they still count as gross rock.

/** Midpoint-split thickness per sample (m). Endpoints extend their
 *  single half-interval symmetrically (matches the oracle). */
export function sampleThickness(depth) {
  const n = depth.length;
  if (n === 0) return new Float64Array(0);
  const th = new Float64Array(n);
  if (n === 1) return th;
  for (let i = 0; i < n; i++) {
    const lo = i > 0 ? depth[i] - (depth[i] - depth[i - 1]) / 2 : depth[0] - (depth[1] - depth[0]) / 2;
    const hi = i < n - 1 ? depth[i] + (depth[i + 1] - depth[i]) / 2 : depth[n - 1] + (depth[n - 1] - depth[n - 2]) / 2;
    th[i] = hi - lo;
    if (!(th[i] >= 0)) throw new Error(`Depth vector must increase (violated near index ${i}).`);
  }
  return th;
}

/**
 * Pay flags + zone summary over [top, base] (inclusive; null = whole
 * log). Flag: phi >= cutPhi AND vsh <= cutVsh AND sw <= cutSw.
 * Averages are net-thickness-weighted, null when net = 0. Flags:
 * true/false inside the window, null outside (matches the goldens).
 *
 * @param {{depth: ArrayLike<number>, phi: ArrayLike<number>,
 *          vsh: ArrayLike<number>, sw: ArrayLike<number>}} curves
 * @param {{cutPhi: number, cutVsh: number, cutSw: number,
 *          top?: ?number, base?: ?number}} p
 */
export function netPay({ depth, phi, vsh, sw }, { cutPhi, cutVsh, cutSw, top = null, base = null }) {
  const th = sampleThickness(depth);
  let gross = 0;
  let net = 0;
  let sPhi = 0;
  let sVsh = 0;
  let sSw = 0;
  const flags = new Array(depth.length).fill(null);
  for (let i = 0; i < depth.length; i++) {
    const d = depth[i];
    if ((top !== null && d < top) || (base !== null && d > base)) continue;
    gross += th[i];
    const valid = Number.isFinite(phi[i]) && Number.isFinite(vsh[i]) && Number.isFinite(sw[i]);
    const f = valid && phi[i] >= cutPhi && vsh[i] <= cutVsh && sw[i] <= cutSw;
    flags[i] = f;
    if (f) {
      net += th[i];
      sPhi += phi[i] * th[i];
      sVsh += vsh[i] * th[i];
      sSw += sw[i] * th[i];
    }
  }
  return {
    flags,
    summary: {
      gross_m: gross,
      net_m: net,
      ntg: gross > 0 ? net / gross : null,
      phi_avg: net > 0 ? sPhi / net : null,
      vsh_avg: net > 0 ? sVsh / net : null,
      sw_avg: net > 0 ? sSw / net : null,
    },
  };
}
