// Shared numeric constants/helpers for the gridding + surface-export +
// contour modules (extracted from Seismolord at the second consumer,
// Mapping & Surface Studio G4.0). Both are stable spec values:
// NULL_VALUE is the industry export null (1.0e30; the "1.0000000E+30"
// string in CPS-3/ZMAP), and niceStepUp is the 1/2/5·10^n rounding
// contour/tick levels use. Seismolord keeps its own copies
// (engine/manifest.NULL_VALUE, viewer/annotations.niceStepUp) for its
// viewer chrome — identical values, so the byte-goldens are unaffected.

/** Industry surface-export null sentinel. */
export const NULL_VALUE = 1.0e30;

/** Smallest "nice" number (1/2/5 x 10^n) >= raw. */
export function niceStepUp(raw) {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const m = raw / mag;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * mag;
}
