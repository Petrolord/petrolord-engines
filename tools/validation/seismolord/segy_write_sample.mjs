// Writes the oracle's sample SEG-Y with the engine (QI Q11): 4 inlines x 5
// crosslines x 50 samples at 2 ms, known values, one null, UTM-sized
// coordinates. The spec is saved beside the goldens so the jest gate and
// segyio read the same values.
// Usage: node segy_write_sample.mjs <out.sgy> <spec.json>
import { writeFileSync } from 'node:fs';
import { writeSegy } from '../../../engines/seismolord/segyWrite.js';

const traces = [];
for (let i = 0; i < 4; i++) {
  for (let j = 0; j < 5; j++) {
    const samples = Array.from({ length: 50 }, (_, k) => Math.fround(Math.sin((k + 3 * i + 7 * j) / 4) * (1 + i) + 0.001 * j));
    if (i === 2 && j === 3) samples[10] = 1e30; // a null, written as 0
    traces.push({ il: 1001 + i, xl: 2001 + 2 * j, x: 431250.25 + 25 * j, y: 6512500.75 + 25 * i, samples });
  }
}
const spec = { lines: ['Petrolord QI Studio export', 'Sample file for the segyio read-back gate', 'Nulls are written as 0'], dtUs: 2000, ns: 50, traces };
writeFileSync(process.argv[2], writeSegy(spec));
writeFileSync(process.argv[3], JSON.stringify(spec));
