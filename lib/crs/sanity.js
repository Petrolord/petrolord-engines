// Area-of-use sanity check: the placement guard that catches the classic
// import mistakes before they land — coordinates in the wrong UTM zone,
// feet declared as metres, northings and eastings swapped, lat/lon fed
// where projected coordinates belong.
//
// The primary test is geodetic, not magnitude-based: inverse-project the
// sample coordinates through the declared CRS and ask whether they fall
// inside the CRS's published area of use (with margin). That one check
// subsumes hemisphere, false-easting band and zone tests, and works for
// belts and Lambert zones the same as for UTM.

import { M_PER_FT } from './catalog';

const MARGIN_DEG = 1;

function inBbox(lon, lat, bbox, margin) {
  return Number.isFinite(lon) && Number.isFinite(lat)
    && lon >= bbox[0] - margin && lon <= bbox[2] + margin
    && lat >= bbox[1] - margin && lat <= bbox[3] + margin;
}

function fractionInside(projector, bbox, samples, scale, swap) {
  let inside = 0;
  let usable = 0;
  for (const s of samples) {
    const x = (swap ? s.y : s.x) * scale;
    const y = (swap ? s.x : s.y) * scale;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    usable += 1;
    const { lon, lat } = projector.toLonLat(x, y);
    if (inBbox(lon, lat, bbox, MARGIN_DEG)) inside += 1;
  }
  return usable ? inside / usable : 0;
}

/**
 * Judge whether sample coordinates are plausible for a catalog CRS.
 *
 * @param {{toLonLat:Function}} projector makeProjector() for the CRS
 * @param {{areaBboxLonLat:number[], kind:string}} entry catalog entry
 * @param {{x:number,y:number}[]} samples a handful of representative
 *   points (survey corners, first traces, wellheads)
 * @returns {{ok:boolean, verdict:'ok'|'out-of-area'|'no-samples',
 *   insideFraction:number, suggestion:null|'unit-feet'|'unit-metres'|'axes-swapped'}}
 *   suggestion names the single rescue that makes the samples plausible,
 *   for the UI to offer ("these look like feet", "X and Y look swapped").
 */
export function checkAreaOfUse(projector, entry, samples) {
  const pts = (samples || []).filter((s) => s && Number.isFinite(s.x) && Number.isFinite(s.y));
  if (!pts.length) {
    return { ok: false, verdict: 'no-samples', insideFraction: 0, suggestion: null };
  }
  const bbox = entry.areaBboxLonLat;
  const direct = fractionInside(projector, bbox, pts, 1, false);
  if (direct >= 0.9) {
    return { ok: true, verdict: 'ok', insideFraction: direct, suggestion: null };
  }

  let suggestion = null;
  if (entry.kind === 'projected') {
    if (fractionInside(projector, bbox, pts, M_PER_FT, false) >= 0.9) {
      suggestion = 'unit-feet';
    } else if (fractionInside(projector, bbox, pts, 1 / M_PER_FT, false) >= 0.9) {
      suggestion = 'unit-metres';
    } else if (fractionInside(projector, bbox, pts, 1, true) >= 0.9) {
      suggestion = 'axes-swapped';
    }
  }
  return { ok: false, verdict: 'out-of-area', insideFraction: direct, suggestion };
}
