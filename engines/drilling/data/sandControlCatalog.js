// Commercial gravel-pack sand and screen-gauge catalog (Drilling D8).
//
// PLANNING-LEVEL nominal data. Gravel rows are the standard US-mesh
// dual-designation sands with sieve-opening bounds from the US Standard
// Sieve series (ASTM E11 openings, µm); the pack d50 is taken as the
// arithmetic mid-range and is marked approx — vendor sieve certificates
// govern a real pack. Screen gauges are the standard wire-wrap slot
// series in thousandths of an inch. The L16 literature gate spot-checks
// these against the owner-supplied references.

const UM = 1e-6;
const THOU = 25.4e-6;

const gravel = (mesh, minUm, maxUm) => ({
  mesh,
  minM: minUm * UM,
  maxM: maxUm * UM,
  d50M: ((minUm + maxUm) / 2) * UM,
  approx: true,
});

// US Standard Sieve openings: 8 = 2380, 12 = 1680, 16 = 1190, 20 = 841,
// 30 = 595, 40 = 420, 50 = 297, 60 = 250, 70 = 210 (µm).
export const GRAVEL_CATALOG = [
  gravel('8/12', 1680, 2380),
  gravel('12/20', 841, 1680),
  gravel('16/30', 595, 1190),
  gravel('20/40', 420, 841),
  gravel('30/50', 297, 595),
  gravel('40/60', 250, 420),
  gravel('50/70', 210, 297),
];

// Standard wire-wrap screen gauges (slot widths), ascending, metres.
export const SCREEN_GAUGE_THOU = [6, 8, 10, 12, 16, 20, 25];
export const SCREEN_GAUGES_M = SCREEN_GAUGE_THOU.map((t) => t * THOU);
