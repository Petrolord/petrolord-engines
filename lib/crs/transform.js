// Transform construction over an injected proj4. The engines package is
// pure math with zero runtime dependencies, so proj4 is always passed in
// by the caller (the Suite binds the real library; tests use the devDep).
//
// All transformers work in each CRS's native units (proj4 honors +units=),
// so a ftUS state-plane CRS speaks survey feet on its side of the
// transform; unitToMetres/convertUnit handle unit-only conversions.

import { unitToMetres } from './catalog';

/** Convert a coordinate value between XY units ('m' | 'ft' | 'ftUS'). */
export function convertUnit(v, from, to) {
  if (from === to) return v;
  return (v * unitToMetres(from)) / unitToMetres(to);
}

/**
 * Point transformer between two proj4 definition strings.
 *
 * @param {Function} proj4 the proj4 module
 * @param {string} fromDef proj4 definition of the source CRS
 * @param {string} toDef proj4 definition of the target CRS
 * @returns {{forward:(x:number,y:number)=>{x:number,y:number},
 *   inverse:(x:number,y:number)=>{x:number,y:number}}}
 */
export function makeTransformer(proj4, fromDef, toDef) {
  const conv = proj4(fromDef, toDef);
  return {
    forward(x, y) {
      const [X, Y] = conv.forward([x, y]);
      return { x: X, y: Y };
    },
    inverse(x, y) {
      const [X, Y] = conv.inverse([x, y]);
      return { x: X, y: Y };
    },
  };
}

/**
 * Projector between a CRS and geographic WGS 84, for area-of-use checks,
 * convergence and lat/lon readouts.
 *
 * @returns {{toLonLat:(x:number,y:number)=>{lon:number,lat:number},
 *   fromLonLat:(lon:number,lat:number)=>{x:number,y:number}}}
 */
export function makeProjector(proj4, def) {
  const conv = proj4('+proj=longlat +datum=WGS84 +no_defs', def);
  return {
    toLonLat(x, y) {
      const [lon, lat] = conv.inverse([x, y]);
      return { lon, lat };
    },
    fromLonLat(lon, lat) {
      const [x, y] = conv.forward([lon, lat]);
      return { x, y };
    },
  };
}
