// Curated CRS catalog: the projected and geographic systems petroleum
// data actually arrives in, each carried as a proj4 definition string with
// an explicit datum shift (+towgs84) so any pair in the catalog transforms
// without external grid files.
//
// Datum accuracy is honest, not optimistic: 3-parameter Helmert shifts
// (NAD27, ED50) are metre-level approximations of what Petrel resolves
// with grid-shift files; datumAccuracyM records that, and callers must
// surface it as provenance, never hide it.
//
// Minna (Nigeria) carries named EPSG transformations instead of one
// generic shift: every Minna entry names a default EPSG Minna to WGS 84
// transformation (datumTransform) and the alternatives whose published
// area of use overlaps it (datumTransformOptions). datumAccuracyM on a
// Minna entry is the published accuracy of its default transformation.
// See MINNA_TO_WGS84 below for the provenance of every parameter.
//
// Tag vocabulary (shared with the Suite): 'EPSG:<code>' resolves here;
// 'CUSTOM:<uuid>' resolves from user settings; 'LOCAL' and 'UNKNOWN' are
// sentinels that never transform.

/** Exact US survey foot (1200/3937 m) and international foot. */
export const M_PER_FT = 0.3048;
export const M_PER_FT_US = 1200 / 3937;

export const XY_UNITS = Object.freeze(['m', 'ft', 'ftUS']);

/** Metres per one of `unit` ('m' | 'ft' | 'ftUS'). */
export function unitToMetres(unit) {
  if (unit === 'm' || unit == null) return 1;
  if (unit === 'ft') return M_PER_FT;
  if (unit === 'ftUS') return M_PER_FT_US;
  throw new Error(`Unknown XY unit "${unit}"`);
}

// Clarke 1880 (RGS), the Minna ellipsoid — spelled out because proj's
// built-in clrk80 alias is Clarke 1880 (modified), a different figure.
const CLARKE_1880_RGS = '+a=6378249.145 +rf=293.465';

const ED50_TOWGS84 = '+towgs84=-87,-98,-121,0,0,0,0';
const NAD27_TOWGS84 = '+towgs84=-8,160,176,0,0,0,0';

// ---------------------------------------------------------------------------
// Minna to WGS 84: the EPSG transformations, transcribed from the EPSG
// Geodetic Parameter Dataset v12.029 (2025-10-02) as shipped in PROJ 9.8.1
// proj.db, table helmert_transformation, source EPSG:4263 target
// EPSG:4326, deprecated = 0. test-data/crs/generate_minna_goldens.py
// re-reads the dataset and the crs.minna test asserts every number below
// equals it, so a transcription slip fails CI.
//
// Methods: 'GT' = Geocentric translations (geog2D domain), EPSG:9603, three
// parameters. 'PV' = Position Vector transformation (geog2D domain),
// EPSG:9606, seven parameters, rotations in arc-seconds and scale in ppm.
// proj4's +towgs84 uses the Position Vector convention with exactly those
// units, so PV parameters are carried verbatim. (No Minna transformation in
// the dataset uses the Coordinate Frame method, whose rotations would need
// their signs flipped for +towgs84.)
//
// Excluded: EPSG:1167 Minna to WGS 84 (1), whose area is Cameroon onshore
// (EPSG remarks: "Minna is used in Nigeria, not Cameroon"), and the
// deprecated EPSG:1534 and EPSG:1819 (superseded by EPSG:1754).
// ---------------------------------------------------------------------------
function minnaTf(code, name, method, params, accuracyM, areaName, areaBboxLonLat, source) {
  return Object.freeze({
    code,
    name,
    method: method === 'PV'
      ? 'Position Vector transformation (geog2D domain)'
      : 'Geocentric translations (geog2D domain)',
    methodCode: method === 'PV' ? 'EPSG:9606' : 'EPSG:9603',
    params: Object.freeze(params.slice()),
    towgs84: `+towgs84=${(params.length === 3 ? [...params, 0, 0, 0, 0] : params).join(',')}`,
    accuracyM,
    areaName,
    areaBboxLonLat: Object.freeze(areaBboxLonLat.slice()),
    source,
  });
}

export const MINNA_TO_WGS84 = Object.freeze([
  minnaTf('EPSG:1168', 'Minna to WGS 84 (2)', 'GT', [-92, -93, 122], 15, 'Nigeria - onshore and offshore', [2.66, 1.92, 14.65, 13.9], 'DMA, derived at 6 stations'),
  minnaTf('EPSG:1754', 'Minna to WGS 84 (3)', 'PV', [-111.92, -87.85, 114.5, 1.875, 0.202, 0.219, 0.032], 5, 'Nigeria - onshore south', [4.35, 4.22, 9.45, 6.95], 'Shell SPDC, derived at 8 stations across the Niger delta; used throughout southern Nigeria onshore, delta and shallow offshore from 1994'),
  minnaTf('EPSG:1818', 'Minna to WGS 84 (4)', 'PV', [-89, -112, 125.9, 0, 0, 0.814, -0.38], 12, 'Nigeria - offshore beyond continental shelf', [2.66, 1.92, 7.82, 6.14], 'RSL, concatenated via WGS 72BE'),
  minnaTf('EPSG:1820', 'Minna to WGS 84 (6)', 'GT', [-93.2, -93.31, 121.156], 12, 'Nigeria - offshore blocks OPL 209, 219 and 220', [4.01, 3.25, 6.96, 5.54], 'Nortech for Conoco and ExxonMobil (NNPC 1989 GPS network)'),
  minnaTf('EPSG:1821', 'Minna to WGS 84 (7)', 'GT', [-88.98, -83.23, 113.55], 6, 'Nigeria - offshore blocks OML 99-102 and OPL 222 and 223', [7.16, 3.25, 8.25, 4.51], 'Elf Petroleum Nigeria 1994'),
  minnaTf('EPSG:1822', 'Minna to WGS 84 (8)', 'GT', [-92.726, -90.304, 115.735], 10, 'Nigeria - offshore blocks OPL 209-213 and 316', [3.83, 4.22, 5.17, 6.31], 'Shell SNEPCO, 1990 Niger Delta control survey'),
  minnaTf('EPSG:1823', 'Minna to WGS 84 (9)', 'GT', [-93.134, -86.647, 114.196], 8, 'Nigeria - offshore blocks OPL 217-223', [5.58, 3.24, 8, 3.86], 'Shell SNEPCO, 1990 Niger Delta control survey'),
  minnaTf('EPSG:1824', 'Minna to WGS 84 (10)', 'GT', [-93, -94, 124], 25, 'Nigeria - onshore - Gongola Basin', [9.41, 8.78, 12.13, 11.63], 'Shell SNEPCO, Gongola basin'),
  minnaTf('EPSG:1067', 'Minna to WGS 84 (11)', 'GT', [-92.1, -89.9, 114.9], 8, 'Nigeria - offshore blocks OPL 210, 213, 217 and 218', [4.41, 3.24, 6.29, 5.54], 'Statoil deep water blocks'),
  minnaTf('EPSG:15705', 'Minna to WGS 84 (12)', 'PV', [-83.13, -104.95, 114.63, 0, 0, 0.554, 0], 8, 'Nigeria - offshore blocks OPL 215 and 221', [5.02, 3.25, 7.31, 4.23], 'Mobil (MEPCON), via WGS 72BE'),
  minnaTf('EPSG:15706', 'Minna to WGS 84 (13)', 'GT', [-93.6, -83.7, 113.8], 7, 'Nigeria - offshore beyond continental shelf', [2.66, 1.92, 7.82, 6.14], 'Elf and Mobil, deep water'),
  minnaTf('EPSG:15755', 'Minna to WGS 84 (14)', 'GT', [-90.2, -87.32, 114.17], 7, 'Nigeria - block OML 58', [6.53, 5.05, 6.84, 5.36], 'Elf, onshore block OML 58'),
  minnaTf('EPSG:15493', 'Minna to WGS 84 (15)', 'GT', [-94.031, -83.317, 116.708], 5, 'Nigeria - 4°N to 5°N and 6°E to 8°E', [5.99, 3.99, 8.01, 5.01], 'MPN joint venture operations from 1996'),
  minnaTf('EPSG:6196', 'Minna to WGS 84 (16)', 'GT', [-93.179, -87.124, 114.338], 5, 'Nigeria - onshore - block OML 124 (formerly OPL 118)', [6.72, 5.56, 6.97, 5.74], 'Addax, OPL 118 / OML 124'),
]);

const DATUM_TRANSFORM_BY_CODE = new Map(MINNA_TO_WGS84.map((t) => [t.code, t]));

/** A named EPSG datum transformation record, or null. */
export function datumTransformGet(code) {
  return DATUM_TRANSFORM_BY_CODE.get(code) || null;
}

function bboxOverlap(a, b) {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

// Default transformation per Minna CRS (owner decision 2026-09-22: split by
// region). Onshore belts: EPSG:1754, the Niger delta onshore transformation
// (5 m). The East Belt lies wholly outside EPSG:1754's area (east of
// 10.49°E against 9.45°E), so it takes EPSG:1168, the only published
// transformation covering it apart from the Gongola Basin one. Offshore UTM
// pair (EPSG area: Nigeria offshore beyond the continental shelf): EPSG:15706 (7 m), the best
// published accuracy for that exact area. Minna geographic (area: all of
// Nigeria): EPSG:1168, the one transformation whose area is the whole
// country; users pick a regional one per site.
const MINNA_DEFAULTS = {
  'EPSG:26391': 'EPSG:1754',
  'EPSG:26392': 'EPSG:1754',
  'EPSG:26393': 'EPSG:1168',
  'EPSG:26331': 'EPSG:15706',
  'EPSG:26332': 'EPSG:15706',
  'EPSG:4263': 'EPSG:1168',
};

// EPSG areas of use of the Minna CRSs (proj.db, same dataset version). The
// options list for each CRS is every transformation whose area overlaps it.
const MINNA_CRS_AREA = {
  'EPSG:26391': [2.69, 3.57, 6.5, 13.9],
  'EPSG:26392': [6.5, 3.57, 10.51, 13.53],
  'EPSG:26393': [10.49, 6.43, 14.65, 13.72],
  'EPSG:26331': [2.66, 1.92, 6, 6.14],
  'EPSG:26332': [6, 2.61, 7.82, 3.68],
  'EPSG:4263': [2.66, 1.92, 14.65, 13.9],
};

function minnaTowgs84(code) {
  return datumTransformGet(MINNA_DEFAULTS[code]).towgs84;
}

function minnaTransformFields(code) {
  const def = datumTransformGet(MINNA_DEFAULTS[code]);
  const area = MINNA_CRS_AREA[code];
  const options = [def.code, ...MINNA_TO_WGS84
    .filter((t) => t.code !== def.code && bboxOverlap(t.areaBboxLonLat, area))
    .map((t) => t.code)];
  return {
    datum: 'Minna',
    datumTransform: def.code,
    datumTransformOptions: Object.freeze(options),
    datumAccuracyM: def.accuracyM,
  };
}

/** Longitude span of a UTM zone: [west, east]. */
function utmZoneLon(zone) {
  return [zone * 6 - 186, zone * 6 - 180];
}

function utmEntry({ code, name, zone, south, datumFrag, latRange, region, datumAccuracyM }) {
  const [w, e] = utmZoneLon(zone);
  return {
    code,
    name,
    kind: 'projected',
    unit: 'm',
    proj4: `+proj=utm +zone=${zone}${south ? ' +south' : ''} ${datumFrag} +units=m +no_defs`,
    areaBboxLonLat: [w, latRange[0], e, latRange[1]],
    region,
    ...(datumAccuracyM ? { datumAccuracyM } : {}),
  };
}

function buildCatalog() {
  const entries = [];

  // WGS 84 / UTM, all 120 zones.
  for (let zone = 1; zone <= 60; zone += 1) {
    entries.push(utmEntry({
      code: `EPSG:${32600 + zone}`,
      name: `WGS 84 / UTM zone ${zone}N`,
      zone,
      south: false,
      datumFrag: '+datum=WGS84',
      latRange: [0, 84],
      region: 'Global, northern hemisphere',
    }));
    entries.push(utmEntry({
      code: `EPSG:${32700 + zone}`,
      name: `WGS 84 / UTM zone ${zone}S`,
      zone,
      south: true,
      datumFrag: '+datum=WGS84',
      latRange: [-80, 0],
      region: 'Global, southern hemisphere',
    }));
  }

  // ED50 / UTM (Europe, North Sea heritage surveys).
  for (let zone = 28; zone <= 38; zone += 1) {
    entries.push(utmEntry({
      code: `EPSG:${23000 + zone}`,
      name: `ED50 / UTM zone ${zone}N`,
      zone,
      south: false,
      datumFrag: `+ellps=intl ${ED50_TOWGS84}`,
      latRange: [25, 84],
      region: 'Europe',
      datumAccuracyM: 3,
    }));
  }

  // NAD27 / UTM (North American heritage surveys).
  for (let zone = 1; zone <= 23; zone += 1) {
    entries.push(utmEntry({
      code: `EPSG:${26700 + zone}`,
      name: `NAD27 / UTM zone ${zone}N`,
      zone,
      south: false,
      datumFrag: `+ellps=clrk66 ${NAD27_TOWGS84}`,
      latRange: [7, 84],
      region: 'North America',
      datumAccuracyM: 10,
    }));
  }

  // Minna (Nigeria): the three national Transverse Mercator belts plus the
  // offshore UTM pair. Belt parameters per EPSG 26391/26392/26393.
  const minnaBelts = [
    { code: 'EPSG:26391', name: 'Minna / Nigeria West Belt', lon0: 4.5, x0: 230738.26, bbox: [2.5, 3.5, 7, 14] },
    { code: 'EPSG:26392', name: 'Minna / Nigeria Mid Belt', lon0: 8.5, x0: 670553.98, bbox: [6.5, 3.5, 11, 14] },
    { code: 'EPSG:26393', name: 'Minna / Nigeria East Belt', lon0: 12.5, x0: 1110369.7, bbox: [10.5, 3.5, 15, 14] },
  ];
  for (const b of minnaBelts) {
    entries.push({
      code: b.code,
      name: b.name,
      kind: 'projected',
      unit: 'm',
      proj4: `+proj=tmerc +lat_0=4 +lon_0=${b.lon0} +k=0.99975 +x_0=${b.x0} +y_0=0 ${CLARKE_1880_RGS} ${minnaTowgs84(b.code)} +units=m +no_defs`,
      areaBboxLonLat: [b.bbox[0], b.bbox[1], b.bbox[2], b.bbox[3]],
      region: 'Nigeria onshore',
      ...minnaTransformFields(b.code),
    });
  }
  for (const zone of [31, 32]) {
    const code = `EPSG:${26300 + zone}`;
    entries.push({
      ...utmEntry({
        code,
        name: `Minna / UTM zone ${zone}N`,
        zone,
        south: false,
        datumFrag: `${CLARKE_1880_RGS} ${minnaTowgs84(code)}`,
        latRange: [1, 14],
        region: 'Nigeria offshore',
      }),
      ...minnaTransformFields(code),
    });
  }

  // British National Grid (7-parameter Helmert, ~1 m).
  entries.push({
    code: 'EPSG:27700',
    name: 'OSGB36 / British National Grid',
    kind: 'projected',
    unit: 'm',
    proj4: '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs',
    areaBboxLonLat: [-9, 49, 2, 61],
    region: 'Great Britain',
    datumAccuracyM: 1,
  });

  // Starter US state-plane entry in US survey feet (the ftUS exemplar).
  entries.push({
    code: 'EPSG:2274',
    name: 'NAD83 / Tennessee (ftUS)',
    kind: 'projected',
    unit: 'ftUS',
    proj4: '+proj=lcc +lat_1=36.41666666666666 +lat_2=35.25 +lat_0=34.33333333333334 +lon_0=-86 +x_0=600000.0000000001 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs',
    areaBboxLonLat: [-90.5, 34.9, -81.6, 36.7],
    region: 'Tennessee, USA',
  });

  // Geographic systems (degrees; kind 'geographic' gates UI entry modes).
  const geographic = [
    { code: 'EPSG:4326', name: 'WGS 84 (lat/lon)', proj4: '+proj=longlat +datum=WGS84 +no_defs', bbox: [-180, -90, 180, 90], region: 'Global' },
    { code: 'EPSG:4230', name: 'ED50 (lat/lon)', proj4: `+proj=longlat +ellps=intl ${ED50_TOWGS84} +no_defs`, bbox: [-16, 25, 48, 84], region: 'Europe', datumAccuracyM: 3 },
    { code: 'EPSG:4267', name: 'NAD27 (lat/lon)', proj4: `+proj=longlat +ellps=clrk66 ${NAD27_TOWGS84} +no_defs`, bbox: [-172, 7, -47, 84], region: 'North America', datumAccuracyM: 10 },
    { code: 'EPSG:4263', name: 'Minna (lat/lon)', proj4: `+proj=longlat ${CLARKE_1880_RGS} ${minnaTowgs84('EPSG:4263')} +no_defs`, bbox: [2.5, 1, 15, 14], region: 'Nigeria', minna: true },
    { code: 'EPSG:4277', name: 'OSGB36 (lat/lon)', proj4: '+proj=longlat +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +no_defs', bbox: [-9, 49, 2, 61], region: 'Great Britain', datumAccuracyM: 1 },
    { code: 'EPSG:4258', name: 'ETRS89 (lat/lon)', proj4: '+proj=longlat +ellps=GRS80 +no_defs', bbox: [-16, 32, 40, 84], region: 'Europe' },
  ];
  for (const g of geographic) {
    entries.push({
      code: g.code,
      name: g.name,
      kind: 'geographic',
      unit: 'deg',
      proj4: g.proj4,
      areaBboxLonLat: g.bbox,
      region: g.region,
      ...(g.datumAccuracyM ? { datumAccuracyM: g.datumAccuracyM } : {}),
      ...(g.minna ? minnaTransformFields(g.code) : {}),
    });
  }

  return entries;
}

export const CRS_CATALOG = Object.freeze(buildCatalog().map(Object.freeze));

const BY_CODE = new Map(CRS_CATALOG.map((e) => [e.code, e]));

/** Catalog entry for an 'EPSG:<code>' tag, or null. */
export function catalogGet(code) {
  return BY_CODE.get(code) || null;
}

/**
 * Case-insensitive catalog search over code, name and region.
 * Multi-word queries must match every word.
 */
export function searchCatalog(query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return CRS_CATALOG.slice();
  return CRS_CATALOG.filter((e) => {
    const hay = `${e.code} ${e.name} ${e.region}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// ---------------------------------------------------------------------------
// Datum transformation choice (per site / per dataset override).
// ---------------------------------------------------------------------------

function withTowgs84(def, towgs84) {
  return def.replace(/\+towgs84=[^\s]+/, towgs84);
}

/**
 * The datum transformation a catalog entry uses: `transformCode` when it is
 * one of the entry's published options, else the entry's default. Returns
 * null for entries with no named transformation (WGS 84, ED50, NAD27...).
 * Throws when `transformCode` is given but is not an option for the entry,
 * so a mistyped or stale override never passes silently.
 */
export function datumTransformFor(code, transformCode = null) {
  const e = catalogGet(code);
  if (!e || !e.datumTransform) {
    if (transformCode) throw new Error(`${code} has no selectable datum transformation.`);
    return null;
  }
  if (!transformCode) return datumTransformGet(e.datumTransform);
  if (!e.datumTransformOptions.includes(transformCode)) {
    throw new Error(`${transformCode} is not a published ${e.datum} to WGS 84 transformation for ${code}.`);
  }
  return datumTransformGet(transformCode);
}

/** True when `transformCode` may be chosen for catalog entry `code`. */
export function isDatumTransformOption(code, transformCode) {
  const e = catalogGet(code);
  return Boolean(e?.datumTransformOptions?.includes(transformCode));
}

/**
 * proj4 definition of catalog entry `code` using the chosen datum
 * transformation (default when `transformCode` is null).
 */
export function catalogDef(code, transformCode = null) {
  const e = catalogGet(code);
  if (!e) throw new Error(`${code} is not in the CRS catalog.`);
  const tf = datumTransformFor(code, transformCode);
  return tf ? withTowgs84(e.proj4, tf.towgs84) : e.proj4;
}

/**
 * proj4 definitions for a transform between two catalog entries. When both
 * sit on the same datum (e.g. Minna / Nigeria West Belt to Minna lat/lon)
 * the pair is a pure projection change, so both sides are given the SAME
 * datum shift and proj4 applies none; otherwise two different Minna to
 * WGS 84 choices would inject a spurious metre-level shift. The shared
 * shift is the source side's choice (else the target's, else the source
 * default); it cancels either way.
 *
 * @returns {[string, string]} [fromDef, toDef]
 */
export function catalogPairDefs(fromCode, toCode, { fromTransform = null, toTransform = null } = {}) {
  const a = catalogGet(fromCode);
  const b = catalogGet(toCode);
  if (!a) throw new Error(`${fromCode} is not in the CRS catalog.`);
  if (!b) throw new Error(`${toCode} is not in the CRS catalog.`);
  if (a.datum && a.datum === b.datum) {
    const shared = fromTransform
      ? datumTransformFor(fromCode, fromTransform)
      : (toTransform ? datumTransformFor(toCode, toTransform) : datumTransformFor(fromCode));
    return [withTowgs84(a.proj4, shared.towgs84), withTowgs84(b.proj4, shared.towgs84)];
  }
  return [catalogDef(fromCode, fromTransform), catalogDef(toCode, toTransform)];
}
