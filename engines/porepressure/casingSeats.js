// Kick and trip margins and the bottom-up casing-seat selection (Pore
// Pressure Studio U2-003).
//
// The drilling window is bounded below by the pore pressure and above by
// the fracture pressure, both as equivalent mud weights (EMW). Two design
// lines are drawn from them (Bourgoyne, Millheim, Chenevert and Young,
// Applied Drilling Engineering, SPE Textbook Series vol. 2, 1986, ch. 7,
// casing setting depth selection):
//   planned mud weight  = pore pressure EMW + trip margin
//   design fracture EMW = fracture EMW - kick margin
// Bottom-up: the mud needed at TD sets how high the open hole may reach,
// so the next casing shoe up goes at least to the depth where the design
// fracture line equals that mud weight; the mud needed at that shoe sets
// the next shoe up, and so on until the design line holds to the top.
//
// Pure, unit-agnostic: depths in any one unit, EMW and margins in any one
// density unit (the caller converts; the Suite passes metres and kg/m3).
// Depths must increase. Between samples both lines are linear in depth,
// which is how the published table is drawn.

function check(depths, pp, fg) {
  if (!Array.isArray(depths) && !ArrayBuffer.isView(depths)) throw new Error('Depths must be an array.');
  const n = depths.length;
  if (n < 2 || pp.length !== n || fg.length !== n) {
    throw new Error('Need at least two depths with matching pore and fracture EMW.');
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(depths[i]) || !Number.isFinite(pp[i]) || !Number.isFinite(fg[i])) {
      throw new Error(`Bad sample at index ${i}.`);
    }
    if (i > 0 && !(depths[i] > depths[i - 1])) throw new Error('Depths must increase.');
  }
}

/**
 * The two design lines.
 * @returns {{mud: number[], designFg: number[]}}
 */
export function marginLines(ppEmw, fgEmw, tripMargin, kickMargin) {
  if (!(tripMargin >= 0) || !(kickMargin >= 0)) throw new Error('Trip and kick margins must be >= 0.');
  return {
    mud: Array.from(ppEmw, (v) => v + tripMargin),
    designFg: Array.from(fgEmw, (v) => v - kickMargin),
  };
}

const lerp = (z0, z1, v0, v1, z) => (z1 === z0 ? v0 : v0 + ((z - z0) / (z1 - z0)) * (v1 - v0));

/** A line's value at depth z (linear between samples, clamped at the ends). */
export function lineAt(depths, values, z) {
  const n = depths.length;
  if (z <= depths[0]) return values[0];
  if (z >= depths[n - 1]) return values[n - 1];
  let lo = 0; let hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (depths[mid] <= z) lo = mid; else hi = mid; }
  return lerp(depths[lo], depths[hi], values[lo], values[hi], z);
}

/**
 * Bottom-up casing seats.
 * @param {{depths: number[], ppEmw: number[], fgEmw: number[], tripMargin: number,
 *   kickMargin: number, tdDepth?: number, minShallowSeat?: number}} input
 *   tdDepth defaults to the deepest sample; minShallowSeat is a regulatory or
 *   aquifer minimum for the shallowest string (0 when none).
 * @returns {{
 *   seats: {depth: number, mudBelow: number, designFgAtShoe: number, driver: string}[],
 *   sections: {top: number, base: number, mud: number, minDesignFg: number, margin: number}[],
 *   closedAt: ?number, mud: number[], designFg: number[]}}
 *   seats run shallow to deep (the protective strings above TD); sections
 *   are the open-hole intervals each drilled with one mud weight; closedAt
 *   is the shallowest depth where the planned mud exceeds the design
 *   fracture line at the same depth (no seat can open the window there).
 */
export function casingSeatsBottomUp({
  depths, ppEmw, fgEmw, tripMargin, kickMargin, tdDepth = null, minShallowSeat = 0,
}) {
  check(depths, ppEmw, fgEmw);
  const { mud, designFg } = marginLines(ppEmw, fgEmw, tripMargin, kickMargin);
  const n = depths.length;
  const td = tdDepth == null ? depths[n - 1] : Number(tdDepth);
  if (!(td > depths[0]) || td > depths[n - 1] + 1e-9) throw new Error('TD must lie within the depths given.');

  let closedAt = null;
  for (let i = 0; i < n && depths[i] <= td; i++) {
    if (mud[i] > designFg[i]) { closedAt = depths[i]; break; }
  }

  const seats = [];
  const sections = [];
  let base = td;
  for (let guard = 0; guard < n + 2; guard++) {
    // the mud that drills the open hole up from `base`: the highest planned
    // mud over the section, found while walking up
    let M = lineAt(depths, mud, base);
    let k = n - 1;
    while (k > 0 && depths[k] >= base) k -= 1; // depths[k] < base <= depths[k+1]
    let shoe = null;
    let zPrev = base; let dPrev = lineAt(depths, designFg, base);
    let minD = dPrev;
    for (let i = k; i >= 0; i--) {
      const z = depths[i];
      const d = designFg[i];
      M = Math.max(M, mud[i]);
      if (d < M) {
        // the design line falls below the section's mud between z and zPrev
        shoe = dPrev === d ? zPrev : lerp(dPrev, d, zPrev, z, M);
        if (shoe > zPrev) shoe = zPrev;
        if (shoe < z) shoe = z;
        break;
      }
      minD = Math.min(minD, d);
      zPrev = z; dPrev = d;
    }
    if (shoe == null || shoe >= base - 1e-9) {
      // the design line holds to the top: one section reaches surface
      sections.push({ top: depths[0], base, mud: M, minDesignFg: minD, margin: minD - M });
      break;
    }
    const mBelow = M;
    sections.push({ top: shoe, base, mud: mBelow, minDesignFg: Math.min(minD, lineAt(depths, designFg, shoe)), margin: Math.min(minD, lineAt(depths, designFg, shoe)) - mBelow });
    seats.push({ depth: shoe, mudBelow: mBelow, designFgAtShoe: lineAt(depths, designFg, shoe), driver: 'design fracture line' });
    base = shoe;
  }
  seats.reverse();
  sections.reverse();
  // a shallowest string set deeper than its minimum is still admissible
  // (the minimum is "at least"); with no protective string the minimum adds one
  if (minShallowSeat > 0 && minShallowSeat < td) {
    if (!seats.length) {
      seats.push({ depth: minShallowSeat, mudBelow: lineAt(depths, mud, minShallowSeat), designFgAtShoe: lineAt(depths, designFg, minShallowSeat), driver: 'minimum shallow seat' });
    } else if (seats[0].depth < minShallowSeat && (seats.length < 2 || minShallowSeat < seats[1].depth)) {
      seats[0] = { ...seats[0], depth: minShallowSeat, designFgAtShoe: lineAt(depths, designFg, minShallowSeat), driver: 'minimum shallow seat' };
    }
  }
  return { seats, sections, closedAt, mud, designFg };
}

/**
 * Whether a proposed shoe holds the mud that drills below it to `base`:
 * the design fracture line at every depth from the shoe down stays at or
 * above the highest planned mud over the same interval.
 */
export function seatHolds({ depths, ppEmw, fgEmw, tripMargin, kickMargin }, shoe, base) {
  check(depths, ppEmw, fgEmw);
  const { mud, designFg } = marginLines(ppEmw, fgEmw, tripMargin, kickMargin);
  const zs = [shoe, ...Array.from(depths).filter((z) => z > shoe && z < base), base];
  const M = Math.max(...zs.map((z) => lineAt(depths, mud, z)));
  return zs.every((z) => lineAt(depths, designFg, z) >= M - 1e-9);
}
