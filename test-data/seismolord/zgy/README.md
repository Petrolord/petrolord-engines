# ZGY fixtures

Gzipped ZGY volumes for `__tests__/seismolord.zgy.test.js`.

## Written by OpenZGY (the oracle)

`gen-*.zgy.gz` were written by the OpenZGY pure-Python reference, tag
v0.17.0 (https://community.opengroup.org/osdu/platform/domain-data-mgmt-services/seismic/open-zgy,
Apache-2.0), with `tools/validation/seismolord/gen_zgy_fixtures.py`
(numpy 2.5.4, zfpy 1.0.1, run with `python -I`). Each `.json` holds what
OpenZGY reads back: header values, corners, and the SHA-256 of its full
level-0 and level-1 float32 reads (little-endian). All five are 66 x 70 x 70
samples (2 x 2 x 2 bricks), annotation 1000/2000 step 2/4, a rotated
survey.

| file | storage | values |
|---|---|---|
| gen-float32 | float32, v3 | i*10000 + j*10 + k*0.0625; brick (0,1,0) a constant 42.5 |
| gen-int16 | int16, range -327.68..327.67 | (((7i + 3j + k) mod 2000) - 1000) x 0.01 |
| gen-int8 | int8, range -12.8..12.7 | (((i + 2j + 3k) mod 256) - 128) x 0.1 |
| gen-zfp-snr30 | float32 ZFP, v4 | sin(i/7) cos(j/11) sin(k/5) x 1000, SNR 30 |
| gen-depth-ft | int8, depth in ft from 1000 ft every 5 ft | as gen-int8 |

## OpenZGY's own test data

`Empty-v1`, `Empty-v3`, `EmptyOldFile` and `Fancy-int8` are OpenZGY's
`testdata/*.zgy.bz2` (Apache-2.0, Copyright 2017-2021 Schlumberger),
recompressed with gzip. Empty-v1 and Empty-v3 hold the same survey in
versions 1 and 3; the first brick carries a pattern that tells the v1
8 x 8 trace tiling apart. Corners from OpenZGY's C++ tests.

## Cross-check not committed

equinor/pyzgy's test pairs (the same survey as .zgy and .sgy) were read
through `zgySegyReader` on 2026-10-16: samples equal (float32 exact, int8
and int16 within 1e-6), inline and crossline equal. Its rotated and
translated pairs store coordinates in centimetres in the ZGY (pyzgy
assumes scalar -100 while the .sgy says 0), so their world coordinates
differ by exactly that factor. Not vendored: the amplitudes come from
segyio's LGPL test data.
The OpenZGY files here are distributed under the Apache License 2.0 (`LICENSE-OpenZGY.txt`).
