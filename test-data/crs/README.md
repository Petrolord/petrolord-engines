# CRS goldens: Minna (Nigeria) to WGS 84

Provenance note for the Minna datum transformations in `lib/crs/catalog.js`
(`MINNA_TO_WGS84`). Owner decision 2026-09-22: split the Minna to WGS 84
transformation by region, allow a per-site override, always show accuracy.

## Source

EPSG Geodetic Parameter Dataset **v12.029 (2025-10-02)**, read from the
`proj.db` bundled with PROJ 9.8.1 (pyproj 3.8.0 wheel), table
`helmert_transformation`, source EPSG:4263 (Minna), target EPSG:4326
(WGS 84), `deprecated = 0`. `generate_minna_goldens.py` re-reads the
dataset and writes `goldens/minna_epsg_goldens.json`; it also computes
oracle coordinates with PROJ (C library) through each named EPSG operation.
`__tests__/crs.minna.test.js` asserts the hand-transcribed catalog equals the
dataset and that proj4js lands on PROJ's coordinates within 1e-7 degrees.

## Defaults chosen

| Catalog CRS | EPSG area of use (CRS) | Default transformation | Method | Parameters | Area of use (transformation) | Accuracy |
|---|---|---|---|---|---|---|
| EPSG:26391 Minna / Nigeria West Belt | Nigeria onshore west of 6°30'E, onshore and offshore shelf | EPSG:1754 Minna to WGS 84 (3) | Position Vector (EPSG:9606), 7-param | tx -111.92, ty -87.85, tz 114.5 m; rx 1.875, ry 0.202, rz 0.219 arcsec; ds 0.032 ppm | EPSG:2371 Nigeria - onshore south (4.35-9.45°E, 4.22-6.95°N) | 5 m |
| EPSG:26392 Minna / Nigeria Mid Belt | Nigeria 6°30'E to 10°30'E, onshore and offshore shelf | EPSG:1754 Minna to WGS 84 (3) | as above | as above | as above | 5 m |
| EPSG:26393 Minna / Nigeria East Belt | Nigeria east of 10°30'E | EPSG:1168 Minna to WGS 84 (2) | Geocentric translations (EPSG:9603), 3-param | -92, -93, 122 m | EPSG:1178 Nigeria - onshore and offshore | 15 m |
| EPSG:26331 Minna / UTM zone 31N | Nigeria offshore beyond continental shelf west of 6°E | EPSG:15706 Minna to WGS 84 (13) | Geocentric translations, 3-param | -93.6, -83.7, 113.8 m | EPSG:1717 Nigeria - offshore beyond continental shelf | 7 m |
| EPSG:26332 Minna / UTM zone 32N | Nigeria offshore deep water east of 6°E | EPSG:15706 Minna to WGS 84 (13) | as above | as above | as above | 7 m |
| EPSG:4263 Minna (lat/lon) | Nigeria onshore and offshore | EPSG:1168 Minna to WGS 84 (2) | Geocentric translations, 3-param | -92, -93, 122 m | EPSG:1178 Nigeria - onshore and offshore | 15 m |

Why the East Belt differs: EPSG:1754's area ends at 9.45°E and the East Belt
starts at 10.49°E, so EPSG:1754 does not apply there at all. The only
Nigeria transformations whose area reaches the East Belt are EPSG:1168
(whole country, 15 m) and EPSG:1824 (Gongola Basin, 25 m).

Rotation convention: EPSG:1754, EPSG:1818 and EPSG:15705 use the Position
Vector method, the same convention proj4's `+towgs84` uses, with rotations in
arc-seconds and scale in ppm, so they are carried verbatim. No Minna
transformation in the dataset uses the Coordinate Frame method.

## Alternatives (per-site override)

Each Minna entry lists `datumTransformOptions`: the default first, then
every non-deprecated EPSG Minna to WGS 84 transformation whose area overlaps
the CRS's EPSG area of use. Excluded from the table: EPSG:1167 (Cameroon
onshore; EPSG remarks "Minna is used in Nigeria, not Cameroon") and the
deprecated EPSG:1534 and EPSG:1819.

## Findings

- The previous single shift `-92,-93,122` is exactly EPSG:1168, whose
  published accuracy is 15 m; the catalog carried `datumAccuracyM: 5`,
  understating the error threefold.
- At 5.5°N 5°E (West Belt) EPSG:1754 and EPSG:1168 differ by about 10 m on
  the ground.
- Two Minna CRSs with different default transformations would inject a
  spurious metre-level shift if transformed naively through WGS 84, so
  `catalogPairDefs` gives same-datum pairs one shared shift (a pure
  projection change).
- Not changed here: the catalog `areaBboxLonLat` of the Minna CRSs is looser
  than the EPSG areas (e.g. 26331/26332 are EPSG deep-water offshore only).
  Tightening it would change area-of-use warnings for existing data.
