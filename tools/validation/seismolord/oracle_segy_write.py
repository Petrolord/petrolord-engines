"""segyio read-back oracle for engines/seismolord/segyWrite.js (QI Q11).

Writes the sample file with the engine (node segy_write_sample.mjs), reads
it with segyio (iline 189, xline 193), asserts the geometry, the headers
and the samples, and records the file's SHA-256 with what segyio read, so
the jest gate can prove the bytes are the ones segyio accepted.
Usage: python -I oracle_segy_write.py <engines repo root>
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import numpy as np
import segyio

root = sys.argv[1]
here = os.path.join(root, 'tools/validation/seismolord')
with tempfile.TemporaryDirectory() as d:
    path = os.path.join(d, 'sample.sgy')
    spec_path = os.path.join(root, 'test-data/seismolord/segyWrite.sample.json')
    subprocess.run(['node', os.path.join(here, 'segy_write_sample.mjs'), path, spec_path], check=True, cwd=root)
    spec = json.load(open(spec_path))
    raw = open(path, 'rb').read()
    with segyio.open(path, iline=189, xline=193) as f:
        ilines = f.ilines.tolist(); xlines = f.xlines.tolist()
        samples = f.samples.tolist()
        fmt = int(f.format)
        cube = segyio.tools.cube(f)
        h0 = f.header[0]
        hdr = {
            'inline': h0[segyio.TraceField.INLINE_3D], 'crossline': h0[segyio.TraceField.CROSSLINE_3D],
            'cdp_x': h0[segyio.TraceField.CDP_X], 'cdp_y': h0[segyio.TraceField.CDP_Y],
            'scalar': h0[segyio.TraceField.SourceGroupScalar], 'ns': h0[segyio.TraceField.TRACE_SAMPLE_COUNT],
            'dt': h0[segyio.TraceField.TRACE_SAMPLE_INTERVAL],
        }
        text = segyio.tools.wrap(f.text[0])
        rev = f.bin[segyio.BinField.SEGYRevision]
assert ilines == [1001, 1002, 1003, 1004]
assert xlines == [2001, 2003, 2005, 2007, 2009]
assert len(samples) == 50 and abs(samples[1] - samples[0] - 2.0) < 1e-9
assert fmt == 5
assert hdr['cdp_x'] == 43125025 and hdr['scalar'] == -100
assert cube[2, 3, 10] == 0.0
assert 'Petrolord QI Studio export' in text
expect = np.array([[[0.0 if v >= 1e29 else v for v in spec['traces'][i * 5 + j]['samples']] for j in range(5)] for i in range(4)], dtype=np.float32)
assert np.array_equal(cube, expect)  # bit for bit: float32 in, float32 out
out = {
    'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
    'segyio': {'ilines': ilines, 'xlines': xlines, 'format': fmt, 'revision': int(rev), 'header0': hdr, 'sum': float(cube.astype(np.float64).sum())},
}
with open(os.path.join(root, 'test-data/seismolord/goldens.segyWrite.json'), 'w') as fh:
    json.dump(out, fh, indent=1)
print('segyio read the file back:', ilines, xlines, 'revision', rev)
