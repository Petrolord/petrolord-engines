"""Generate test-data/crs/goldens/minna_epsg_goldens.json.

Source of truth: the EPSG Geodetic Parameter Dataset as shipped inside
PROJ's proj.db (pyproj wheel). The script records the dataset version,
reads every non-deprecated Minna (EPSG:4263) -> WGS 84 (EPSG:4326)
Helmert transformation straight from the database, and computes
independent oracle points with PROJ (C library) using each named EPSG
operation. The engines test then checks (a) the catalog's transcribed
parameters equal these database values and (b) proj4js, driven by the
catalog, reproduces PROJ's coordinates.

Run:  python3 -m venv venv && venv/bin/pip install pyproj
      venv/bin/python test-data/crs/generate_minna_goldens.py
"""
import json
import os
import sqlite3

import pyproj
from pyproj.transformer import TransformerGroup

DB = os.path.join(pyproj.datadir.get_data_dir(), 'proj.db')
OUT = os.path.join(os.path.dirname(__file__), 'goldens', 'minna_epsg_goldens.json')

c = sqlite3.connect(DB)
meta = dict(c.execute("select key, value from metadata").fetchall())

rows = c.execute("""
  select h.code, h.name, h.method_code, m.name, h.accuracy,
         h.tx, h.ty, h.tz, h.rx, h.ry, h.rz, h.rotation_uom_code,
         h.scale_difference, h.scale_difference_uom_code, h.operation_version, h.description
  from helmert_transformation_table h
  join coordinate_operation_method m on m.auth_name = h.method_auth_name and m.code = h.method_code
  where h.auth_name = 'EPSG' and h.source_crs_code = 4263 and h.target_crs_code = 4326
    and h.deprecated = 0
  order by h.code
""").fetchall()

transforms = []
for (code, name, mcode, mname, acc, tx, ty, tz, rx, ry, rz, ruom, ds, dsuom, ver, desc) in rows:
    ext = c.execute("""
      select e.code, e.name, e.description, e.west_lon, e.south_lat, e.east_lon, e.north_lat
      from usage u join extent e on e.auth_name = u.extent_auth_name and e.code = u.extent_code
      where u.object_table_name = 'helmert_transformation' and u.object_auth_name = 'EPSG'
        and u.object_code = ?""", (code,)).fetchone()
    uom = lambda k: c.execute("select name from unit_of_measure where auth_name='EPSG' and code=?", (k,)).fetchone()[0] if k else None
    transforms.append({
        'code': f'EPSG:{code}', 'name': name, 'methodCode': f'EPSG:{mcode}', 'method': mname,
        'accuracyM': acc, 'version': ver,
        'tx': tx, 'ty': ty, 'tz': tz, 'rx': rx, 'ry': ry, 'rz': rz,
        'rotationUnit': uom(ruom), 'scaleDifference': ds, 'scaleUnit': uom(dsuom),
        'area': {'extent': f'EPSG:{ext[0]}', 'name': ext[1], 'description': ext[2], 'bboxLonLat': [ext[3], ext[4], ext[5], ext[6]]},
        'remarks': desc,
    })

def op(src, name):
    tg = TransformerGroup(src, 4326, always_xy=True)
    hits = [t for t in tg.transformers if f'+ {name} ' in t.description or t.description.startswith(f'{name} ')]
    if len(hits) != 1:
        raise SystemExit(f'expected one operation for {src} via {name}, got {[t.description for t in tg.transformers]}')
    return hits[0]

# Geographic Minna -> WGS 84 through each transform, at its area centre.
geog = []
for t in transforms:
    w, s, e, n = t['area']['bboxLonLat']
    lon, lat = round((w + e) / 2, 4), round((s + n) / 2, 4)
    tr = op(4263, t['name'])
    olon, olat = tr.transform(lon, lat)
    geog.append({'transform': t['code'], 'lonMinna': lon, 'latMinna': lat, 'lonWgs84': olon, 'latWgs84': olat, 'op': tr.description})

# Projected Minna -> WGS 84 lon/lat for the catalog defaults and alternates.
proj_cases = [
    ('EPSG:26391', 'Minna to WGS 84 (3)', 5.0, 5.5),
    ('EPSG:26391', 'Minna to WGS 84 (2)', 5.0, 5.5),
    ('EPSG:26392', 'Minna to WGS 84 (3)', 7.0, 5.0),
    ('EPSG:26392', 'Minna to WGS 84 (2)', 7.0, 5.0),
    ('EPSG:26392', 'Minna to WGS 84 (15)', 7.0, 4.5),
    ('EPSG:26393', 'Minna to WGS 84 (2)', 12.5, 9.0),
    ('EPSG:26393', 'Minna to WGS 84 (10)', 11.0, 10.0),
    ('EPSG:26331', 'Minna to WGS 84 (13)', 4.5, 3.5),
    ('EPSG:26331', 'Minna to WGS 84 (4)', 4.5, 3.5),
    ('EPSG:26332', 'Minna to WGS 84 (13)', 7.0, 3.0),
    ('EPSG:26332', 'Minna to WGS 84 (4)', 7.0, 3.0),
]
projected = []
for crs, name, lon, lat in proj_cases:
    # Grid coordinates of a Minna-datum point (pure projection, no datum op).
    fwd = pyproj.Transformer.from_crs(4263, int(crs.split(':')[1]), always_xy=True)
    x, y = fwd.transform(lon, lat)
    x, y = round(x, 2), round(y, 2)
    tr = op(int(crs.split(':')[1]), name)
    olon, olat = tr.transform(x, y)
    code = next(t['code'] for t in transforms if t['name'] == name)
    projected.append({'crs': crs, 'transform': code, 'x': x, 'y': y, 'lonWgs84': olon, 'latWgs84': olat, 'op': tr.description})

json.dump({
    'source': 'EPSG Geodetic Parameter Dataset via PROJ proj.db',
    'epsgVersion': meta['EPSG.VERSION'], 'epsgDate': meta['EPSG.DATE'],
    'projVersion': pyproj.proj_version_str, 'pyprojVersion': pyproj.__version__,
    'transforms': transforms, 'geographic': geog, 'projected': projected,
}, open(OUT, 'w'), indent=2)
print('wrote', OUT, len(transforms), 'transforms', len(geog), '+', len(projected), 'points')
