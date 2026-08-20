#!/usr/bin/env python3
"""Golden shapefile fixtures for engines/mapping/cultureImport.js.

Hand-written per the ESRI shapefile spec (July 1998): file header lengths
big-endian, geometry little-endian; dBASE III headers for attributes.
Deterministic bytes -- re-run only when adding fixtures.
"""
import struct
from pathlib import Path

OUT = Path(__file__).resolve().parents[4] / "test-data" / "mapping" / "culture"
OUT.mkdir(parents=True, exist_ok=True)


def shp(records, shape_type, bbox):
    body = b"".join(
        struct.pack(">ii", i + 1, len(content) // 2) + content
        for i, content in enumerate(records)
    )
    total_words = (100 + len(body)) // 2
    header = struct.pack(">iiiiiii", 9994, 0, 0, 0, 0, 0, total_words)
    header += struct.pack("<ii", 1000, shape_type)
    header += struct.pack("<4d", *bbox)
    header += struct.pack("<4d", 0, 0, 0, 0)  # z/m ranges
    return header + body


def dbf(fields, rows):
    fdesc = b""
    for name, ftype, length in fields:
        fdesc += name.encode().ljust(11, b"\0") + ftype.encode()
        fdesc += b"\0" * 4 + bytes([length]) + b"\0" * 15
    header_size = 32 + len(fdesc) + 1
    record_size = 1 + sum(f[2] for f in fields)
    head = struct.pack("<BBBBIHH", 3, 26, 8, 20, len(rows), header_size, record_size)
    head += b"\0" * 20 + fdesc + b"\x0d"
    body = b""
    for row in rows:
        body += b" "
        for (name, ftype, length), val in zip(fields, row):
            s = ("" if val is None else str(val))
            body += (s.rjust(length) if ftype in "NF" else s.ljust(length)).encode()[:length]
    return head + body + b"\x1a"


# 1. points.shp: two wells-of-interest + names
p1 = struct.pack("<idd", 1, 500000.0, 300000.0)
p2 = struct.pack("<idd", 1, 500250.5, 300125.25)
(OUT / "points.shp").write_bytes(shp([p1, p2], 1, (500000.0, 300000.0, 500250.5, 300125.25)))
(OUT / "points.dbf").write_bytes(dbf([("NAME", "C", 12)], [["ALPHA-1"], ["BETA-2"]]))

# 2. lines.shp: one polyline record with two parts (a broken pipeline)
pts = [(0.0, 0.0), (100.0, 50.0), (200.0, 50.0), (500.0, 500.0), (600.0, 625.0)]
content = struct.pack("<i", 3) + struct.pack("<4d", 0, 0, 600, 625)
content += struct.pack("<ii", 2, len(pts)) + struct.pack("<2i", 0, 3)
for x, y in pts:
    content += struct.pack("<2d", x, y)
(OUT / "lines.shp").write_bytes(shp([content], 3, (0.0, 0.0, 600.0, 625.0)))

# 3. blocks.shp: one polygon with an outer ring + a hole, with attributes
outer = [(0.0, 0.0), (0.0, 1000.0), (1000.0, 1000.0), (1000.0, 0.0), (0.0, 0.0)]
hole = [(200.0, 200.0), (400.0, 200.0), (400.0, 400.0), (200.0, 400.0), (200.0, 200.0)]
allp = outer + hole
content = struct.pack("<i", 5) + struct.pack("<4d", 0, 0, 1000, 1000)
content += struct.pack("<ii", 2, len(allp)) + struct.pack("<2i", 0, len(outer))
for x, y in allp:
    content += struct.pack("<2d", x, y)
(OUT / "blocks.shp").write_bytes(shp([content], 5, (0.0, 0.0, 1000.0, 1000.0)))
(OUT / "blocks.dbf").write_bytes(
    dbf([("NAME", "C", 10), ("AREA_KM2", "N", 8)], [["OML-42", 0.96]])
)

# 4. pointz.shp: PointZ (type 11) -- XY must read, Z/M tail must skip;
#    plus a null shape record that must count as skipped
pz = struct.pack("<idddd", 11, 7.5, -3.25, 999.0, 111.0)
nullrec = struct.pack("<i", 0)
(OUT / "pointz.shp").write_bytes(shp([pz, nullrec], 11, (7.5, -3.25, 7.5, -3.25)))

print("wrote", sorted(p.name for p in OUT.iterdir()))
