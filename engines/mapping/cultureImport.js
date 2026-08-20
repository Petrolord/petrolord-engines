// Culture / GIS layer import (interpreter program Wave 1 / W1.3):
// GeoJSON and ESRI shapefile parsing into one normalized feature model,
// plus reprojection and bbox helpers. Pure parsing — CRS conversion is
// the caller's business (features are imported in a DECLARED CRS and
// converted to the Project CRS through the Suite's crs lib).
//
// Normalized features:
//   { type: 'point',    x, y,                          props }
//   { type: 'polyline', paths: [[[x,y], ...], ...],    props }
//   { type: 'polygon',  rings: [[[x,y], ...], ...],    props }
// Ring 0 is the outer boundary; later rings are holes (not
// distinguished in v1 rendering, recorded for fidelity).

/** Shapefile shape-type ids (XY read for all; Z/M tails skipped). */
const SHP_NULL = 0;
const SHP_POINT = new Set([1, 11, 21]);
const SHP_POLYLINE = new Set([3, 13, 23]);
const SHP_POLYGON = new Set([5, 15, 25]);
const SHP_MULTIPOINT = new Set([8, 18, 28]);

/**
 * Parse a GeoJSON document (string or object) into normalized features.
 * Multi-geometries flatten (MultiPoint -> n point features; MultiPolygon
 * -> n polygon features); GeometryCollections recurse. Unsupported or
 * malformed geometries are counted, never fatal.
 * @returns {{features: Array, skipped: number}}
 */
export function parseGeoJSON(input) {
  let doc = input;
  if (typeof input === 'string') {
    try {
      doc = JSON.parse(input);
    } catch (e) {
      throw new Error(`Not valid JSON: ${e.message}`);
    }
  }
  if (!doc || typeof doc !== 'object') throw new Error('Not a GeoJSON document.');
  const out = [];
  let skipped = 0;

  const pt = (c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]);
  const path = (cs) => Array.isArray(cs) && cs.length >= 2 && cs.every(pt);
  const cleanRing = (r) => (Array.isArray(r) ? r.filter(pt).map(([x, y]) => [x, y]) : []);

  const addGeometry = (g, props) => {
    if (!g || typeof g !== 'object') { skipped += 1; return; }
    const c = g.coordinates;
    switch (g.type) {
      case 'Point':
        if (pt(c)) out.push({ type: 'point', x: c[0], y: c[1], props });
        else skipped += 1;
        break;
      case 'MultiPoint':
        if (Array.isArray(c)) {
          for (const p of c) {
            if (pt(p)) out.push({ type: 'point', x: p[0], y: p[1], props });
            else skipped += 1;
          }
        } else skipped += 1;
        break;
      case 'LineString':
        if (path(c)) out.push({ type: 'polyline', paths: [c.map(([x, y]) => [x, y])], props });
        else skipped += 1;
        break;
      case 'MultiLineString':
        if (Array.isArray(c)) {
          const paths = c.filter(path).map((p) => p.map(([x, y]) => [x, y]));
          if (paths.length) out.push({ type: 'polyline', paths, props });
          skipped += c.length - paths.length;
        } else skipped += 1;
        break;
      case 'Polygon':
        if (Array.isArray(c)) {
          const rings = c.map(cleanRing).filter((r) => r.length >= 3);
          if (rings.length) out.push({ type: 'polygon', rings, props });
          else skipped += 1;
        } else skipped += 1;
        break;
      case 'MultiPolygon':
        if (Array.isArray(c)) {
          for (const poly of c) {
            const rings = Array.isArray(poly)
              ? poly.map(cleanRing).filter((r) => r.length >= 3) : [];
            if (rings.length) out.push({ type: 'polygon', rings, props });
            else skipped += 1;
          }
        } else skipped += 1;
        break;
      case 'GeometryCollection':
        for (const sub of g.geometries || []) addGeometry(sub, props);
        break;
      default:
        skipped += 1;
    }
  };

  if (doc.type === 'FeatureCollection') {
    for (const f of doc.features || []) addGeometry(f?.geometry, f?.properties || {});
  } else if (doc.type === 'Feature') {
    addGeometry(doc.geometry, doc.properties || {});
  } else {
    addGeometry(doc, {});
  }
  return { features: out, skipped };
}

/**
 * Parse an ESRI shapefile (.shp, optionally .dbf for attributes) into
 * normalized features. Record-level scan (record headers carry content
 * lengths, so Z/M tails and unknown types skip cleanly); byte order per
 * spec: file header lengths big-endian, geometry little-endian.
 * @param {ArrayBuffer|Uint8Array} shpBuf
 * @param {ArrayBuffer|Uint8Array} [dbfBuf]
 * @returns {{features: Array, skipped: number, bbox: {x0,y0,x1,y1}}}
 */
export function parseShapefile(shpBuf, dbfBuf = null) {
  // ArrayBuffer.isView is realm-safe (a Node Buffer under jsdom fails
  // `instanceof Uint8Array` across realms)
  const buf = ArrayBuffer.isView(shpBuf)
    ? shpBuf.buffer.slice(shpBuf.byteOffset, shpBuf.byteOffset + shpBuf.byteLength)
    : shpBuf;
  const dv = new DataView(buf);
  if (dv.byteLength < 100) throw new Error('Shapefile is too short for a header.');
  if (dv.getInt32(0, false) !== 9994) throw new Error('Not a shapefile (bad magic).');
  const fileWords = dv.getInt32(24, false);
  const fileBytes = Math.min(fileWords * 2, dv.byteLength);
  const bbox = {
    x0: dv.getFloat64(36, true),
    y0: dv.getFloat64(44, true),
    x1: dv.getFloat64(52, true),
    y1: dv.getFloat64(60, true),
  };
  const attrs = dbfBuf ? parseDbf(dbfBuf) : null;

  const features = [];
  let skipped = 0;
  let off = 100;
  let recIndex = 0;
  while (off + 8 <= fileBytes) {
    const contentWords = dv.getInt32(off + 4, false);
    const contentStart = off + 8;
    const contentBytes = contentWords * 2;
    if (contentBytes < 4 || contentStart + contentBytes > dv.byteLength) break;
    const props = attrs && attrs[recIndex] ? attrs[recIndex] : {};
    const shapeType = dv.getInt32(contentStart, true);
    const p = contentStart;

    if (shapeType === SHP_NULL) {
      skipped += 1;
    } else if (SHP_POINT.has(shapeType)) {
      features.push({
        type: 'point',
        x: dv.getFloat64(p + 4, true),
        y: dv.getFloat64(p + 12, true),
        props,
      });
    } else if (SHP_MULTIPOINT.has(shapeType)) {
      const n = dv.getInt32(p + 36, true);
      for (let i = 0; i < n; i++) {
        features.push({
          type: 'point',
          x: dv.getFloat64(p + 40 + i * 16, true),
          y: dv.getFloat64(p + 48 + i * 16, true),
          props,
        });
      }
    } else if (SHP_POLYLINE.has(shapeType) || SHP_POLYGON.has(shapeType)) {
      const numParts = dv.getInt32(p + 36, true);
      const numPoints = dv.getInt32(p + 40, true);
      const partsAt = p + 44;
      const pointsAt = partsAt + numParts * 4;
      const parts = [];
      for (let i = 0; i < numParts; i++) parts.push(dv.getInt32(partsAt + i * 4, true));
      parts.push(numPoints);
      const rings = [];
      for (let i = 0; i < numParts; i++) {
        const ring = [];
        for (let j = parts[i]; j < parts[i + 1]; j++) {
          ring.push([
            dv.getFloat64(pointsAt + j * 16, true),
            dv.getFloat64(pointsAt + 8 + j * 16, true),
          ]);
        }
        if (ring.length >= 2) rings.push(ring);
      }
      if (!rings.length) skipped += 1;
      else if (SHP_POLYGON.has(shapeType)) features.push({ type: 'polygon', rings, props });
      else features.push({ type: 'polyline', paths: rings, props });
    } else {
      skipped += 1;                       // unknown type: length lets us hop it
    }
    off = contentStart + contentBytes;
    recIndex += 1;
  }
  return { features, skipped, bbox };
}

/** Minimal dBASE III attribute reader: character and numeric fields. */
export function parseDbf(dbfBuf) {
  const buf = ArrayBuffer.isView(dbfBuf)
    ? dbfBuf.buffer.slice(dbfBuf.byteOffset, dbfBuf.byteOffset + dbfBuf.byteLength)
    : dbfBuf;
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (dv.byteLength < 32) return [];
  const nRecords = dv.getInt32(4, true);
  const headerSize = dv.getInt16(8, true);
  const recordSize = dv.getInt16(10, true);
  const fields = [];
  for (let o = 32; o + 32 <= headerSize && bytes[o] !== 0x0d; o += 32) {
    let name = '';
    for (let i = 0; i < 11 && bytes[o + i] !== 0; i++) name += String.fromCharCode(bytes[o + i]);
    fields.push({ name, type: String.fromCharCode(bytes[o + 11]), length: bytes[o + 16] });
  }
  const rows = [];
  for (let r = 0; r < nRecords; r++) {
    const base = headerSize + r * recordSize;
    if (base + recordSize > dv.byteLength) break;
    const row = {};
    let fo = base + 1;                    // deletion flag byte
    for (const f of fields) {
      let raw = '';
      for (let i = 0; i < f.length; i++) raw += String.fromCharCode(bytes[fo + i]);
      raw = raw.trim();
      row[f.name] = f.type === 'N' || f.type === 'F'
        ? (raw === '' ? null : Number(raw))
        : raw;
      fo += f.length;
    }
    rows.push(row);
  }
  return rows;
}

/** Map every coordinate through fn(x, y) -> [x, y] (CRS conversion). */
export function reprojectFeatures(features, fn) {
  return features.map((f) => {
    if (f.type === 'point') {
      const [x, y] = fn(f.x, f.y);
      return { ...f, x, y };
    }
    const mapRing = (ring) => ring.map(([x, y]) => fn(x, y));
    if (f.type === 'polyline') return { ...f, paths: f.paths.map(mapRing) };
    if (f.type === 'polygon') return { ...f, rings: f.rings.map(mapRing) };
    return f;
  });
}

/** Bounding box over every coordinate; null for an empty set. */
export function featuresBBox(features) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const eat = (x, y) => {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  };
  for (const f of features) {
    if (f.type === 'point') eat(f.x, f.y);
    else if (f.type === 'polyline') f.paths.forEach((p) => p.forEach(([x, y]) => eat(x, y)));
    else if (f.type === 'polygon') f.rings.forEach((r) => r.forEach(([x, y]) => eat(x, y)));
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/** Dominant geometry type for the registry row ('mixed' when varied). */
export function geometryTypeOf(features) {
  const kinds = new Set(features.map((f) => f.type));
  if (kinds.size === 0) return 'mixed';
  return kinds.size === 1 ? [...kinds][0] : 'mixed';
}

/** Feature label from a chosen attribute field (first non-empty). */
export function labelOf(feature, labelField) {
  if (!labelField) return null;
  const v = feature.props?.[labelField];
  return v == null || v === '' ? null : String(v);
}
