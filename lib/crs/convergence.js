// Grid convergence by central difference: proj4 exposes no analytic
// convergence, so we project a short true-north step through the CRS
// itself and measure its grid bearing. Accurate to well under 0.01
// degrees for any smooth projection, and immune to per-projection
// formula mistakes because it uses the same math that positions data.
//
// Sign convention (spelled out because the literature disagrees):
// the returned value is the GRID AZIMUTH OF TRUE NORTH, clockwise
// positive. A direction measured clockwise from true north converts as
//   gridAzimuth = trueAzimuth + gridConvergenceDeg(...)
// East of a Transverse Mercator central meridian in the northern
// hemisphere the returned value is negative (true north leans toward
// the central meridian), matching -(lon - lon0) * sin(lat).

const LAT_STEP_DEG = 1e-5;

/**
 * @param {{toLonLat:Function, fromLonLat:Function}} projector
 *   a makeProjector() result for the CRS in question
 * @param {number} x easting in the CRS's native units
 * @param {number} y northing in the CRS's native units
 * @returns {number} grid azimuth of true north, degrees clockwise
 */
export function gridConvergenceDeg(projector, x, y) {
  const { lon, lat } = projector.toLonLat(x, y);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return NaN;
  const south = projector.fromLonLat(lon, lat - LAT_STEP_DEG / 2);
  const north = projector.fromLonLat(lon, lat + LAT_STEP_DEG / 2);
  return (Math.atan2(north.x - south.x, north.y - south.y) * 180) / Math.PI;
}

/** Grid azimuth of a direction given by its true azimuth (degrees). */
export function gridAzFromTrueAz(trueAzDeg, convergenceDeg) {
  return trueAzDeg + convergenceDeg;
}

/** True azimuth of a direction given by its grid azimuth (degrees). */
export function trueAzFromGridAz(gridAzDeg, convergenceDeg) {
  return gridAzDeg - convergenceDeg;
}
