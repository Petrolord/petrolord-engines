// Curated CRS catalog: the projected and geographic systems petroleum
// data actually arrives in, each carried as a proj4 definition string with
// an explicit datum shift (+towgs84) so any pair in the catalog transforms
// without external grid files.
//
// Datum accuracy is honest, not optimistic: 3-parameter Helmert shifts
// (NAD27, Minna) are metre-level approximations of what Petrel resolves
// with grid-shift files; datumAccuracyM records that, and callers must
// surface it as provenance, never hide it.
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
const MINNA_TOWGS84 = '+towgs84=-92,-93,122,0,0,0,0';

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
      proj4: `+proj=tmerc +lat_0=4 +lon_0=${b.lon0} +k=0.99975 +x_0=${b.x0} +y_0=0 ${CLARKE_1880_RGS} ${MINNA_TOWGS84} +units=m +no_defs`,
      areaBboxLonLat: [b.bbox[0], b.bbox[1], b.bbox[2], b.bbox[3]],
      region: 'Nigeria onshore',
      datumAccuracyM: 5,
    });
  }
  for (const zone of [31, 32]) {
    entries.push(utmEntry({
      code: `EPSG:${26300 + zone}`,
      name: `Minna / UTM zone ${zone}N`,
      zone,
      south: false,
      datumFrag: `${CLARKE_1880_RGS} ${MINNA_TOWGS84}`,
      latRange: [1, 14],
      region: 'Nigeria offshore',
      datumAccuracyM: 5,
    }));
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
    { code: 'EPSG:4263', name: 'Minna (lat/lon)', proj4: `+proj=longlat ${CLARKE_1880_RGS} ${MINNA_TOWGS84} +no_defs`, bbox: [2.5, 1, 15, 14], region: 'Nigeria', datumAccuracyM: 5 },
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
