# Golden ZGY fixtures for the engines' ZGY reader, written by the OpenZGY
# pure-Python reference (v0.17.0, Apache-2.0) and read back by it.
# Run: venv/bin/python -I gen_fixtures.py <openzgy-python-dir> <outdir>
import sys, json, os, gzip, hashlib
import numpy as np
np.product = np.prod  # numpy 2 shim for the old reference code
sys.path.insert(0, sys.argv[1])
from openzgy.api import ZgyWriter, ZgyReader, SampleDataType, UnitDimension, ZgyCompressFactory
out = sys.argv[2]

SIZE = (66, 70, 70)  # 2 x 2 x 2 bricks of 64
i, j, k = np.meshgrid(np.arange(SIZE[0]), np.arange(SIZE[1]), np.arange(SIZE[2]), indexing="ij")
C0 = (500000.0, 6000000.0)
C1 = (C0[0] + (SIZE[0]-1)*2*12.5*0.866, C0[1] + (SIZE[0]-1)*2*12.5*0.5)
C2 = (C0[0] - (SIZE[1]-1)*4*12.5*0.5, C0[1] + (SIZE[1]-1)*4*12.5*0.866)
C3 = (C1[0] + C2[0] - C0[0], C1[1] + C2[1] - C0[1])
common = dict(size=SIZE, zunitdim=UnitDimension.time, zunitname="ms", zunitfactor=0.001,
              hunitdim=UnitDimension.length, hunitname="m", hunitfactor=1.0,
              zstart=500.0, zinc=4.0, annotstart=(1000, 2000), annotinc=(2, 4), corners=(C0, C1, C2, C3))

def gz(path, data):
    with open(path, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=9, mtime=0) as f: f.write(data)

def make(name, datatype, data, datarange=None, compressor=None, golden=False, **over):
    fn = os.path.join(out, name + ".zgy")
    kw = dict(common, datatype=datatype, **over)
    if datarange: kw["datarange"] = datarange
    with ZgyWriter(fn, compressor=compressor, **kw) as w:
        w.write((0, 0, 0), data)
        w.finalize()
    with ZgyReader(fn) as r:
        full = np.zeros(SIZE, dtype=np.float32); r.read((0, 0, 0), full)
        s1 = tuple((s + 1) // 2 for s in SIZE)
        l1 = np.zeros(s1, dtype=np.float32); r.read((0, 0, 0), l1, lod=1)
        meta = dict(size=list(r.size), datatype=str(r.datatype).split(".")[-1],
                    datarange=list(map(float, r.datarange)),
                    zunitdim=str(r.zunitdim).split(".")[-1], zunitname=r.zunitname, zunitfactor=r.zunitfactor,
                    hunitname=r.hunitname, hunitfactor=r.hunitfactor,
                    zstart=r.zstart, zinc=r.zinc, annotstart=list(r.annotstart), annotinc=list(r.annotinc),
                    corners=[list(c) for c in r.corners], nlods=r.nlods,
                    lod0_sha256=hashlib.sha256(full.astype("<f4").tobytes()).hexdigest(),
                    lod1_shape=list(s1),
                    lod1_sha256=hashlib.sha256(l1.astype("<f4").tobytes()).hexdigest())
    if golden:
        gz(os.path.join(out, name + ".lod0.f32.gz"), full.astype("<f4").tobytes())
        gz(os.path.join(out, name + ".lod1.f32.gz"), l1.astype("<f4").tobytes())
    gz(fn + ".gz", open(fn, "rb").read()); os.remove(fn)
    json.dump(meta, open(os.path.join(out, name + ".json"), "w"), indent=1)
    print(name, meta["nlods"], meta["datarange"], os.path.getsize(fn + ".gz"))

# float32: exact values; brick (0,1,0) constant 42.5 (stored as a constant brick)
f = (i * 10000.0 + j * 10.0 + k * 0.0625).astype(np.float32)
f[0:64, 64:70, 0:64] = 42.5
make("gen-float32", SampleDataType.float, f, golden=False)
# int16: storage ((i*7 + j*3 + k) % 2000) - 1000, datarange (-327.68, 327.67) => step 0.01
s16 = (((i * 7 + j * 3 + k) % 2000) - 1000).astype(np.int16)
make("gen-int16", SampleDataType.int16, s16.astype(np.float32) * 0.01, datarange=(-327.68, 327.67))
# int8: datarange (-12.8, 12.7) => step 0.1
s8 = (((i + 2 * j + 3 * k) % 256) - 128).astype(np.int8)
make("gen-int8", SampleDataType.int8, s8.astype(np.float32) * 0.1, datarange=(-12.8, 12.7))
# float32 ZFP (version 4), a smooth signal so it compresses
z = (np.sin(i / 7.0) * np.cos(j / 11.0) * np.sin(k / 5.0) * 1000.0).astype(np.float32)
make("gen-zfp-snr30", SampleDataType.float, z, compressor=ZgyCompressFactory("ZFP", snr=30), golden=False)
# depth in feet from 1000 ft every 5 ft
make("gen-depth-ft", SampleDataType.int8, s8.astype(np.float32) * 0.1, datarange=(-12.8, 12.7), zunitdim=UnitDimension.length, zunitname="ft", zunitfactor=0.3048,
     zstart=1000.0, zinc=5.0, hunitname="ft", hunitfactor=0.3048)
