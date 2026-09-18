/**
 * AS12 gate: every Assurance engine agrees with its independent oracle.
 *
 * Each file in test-data/assurance/goldens/ was written by a stdlib Python
 * oracle in tools/validation/assurance/, from the rules as the modules and
 * docs/scope/AssuranceApps-STATUS.md state them, not by transcribing the
 * JavaScript. The runner and the file contract are in
 * __tests__/helpers/assuranceGoldens.js.
 *
 * A second pass replays every case in child processes under six time
 * zones (ASC-0 added Pacific/Pago_Pago, UTC-11), because every Assurance
 * rule that falls due does so on a calendar date and AS3 found a UTC parse
 * that moved a permit's expiry by a day west of Greenwich.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { runCase } from './helpers/assuranceGoldens.js';

const DIR = path.join(__dirname, '../test-data/assurance/goldens');
const ENGINES = path.join(__dirname, '../engines/assurance');
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort() : [];
const goldens = files.map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }));

// eslint-disable-next-line global-require, import/no-dynamic-require
const load = (m) => require(path.join(ENGINES, `${m}.js`));

const EXPECTED_MODULES = [
  'auditManagement', 'calendar', 'complianceStatus', 'documentControl', 'isoCompliance',
  'lessonsLearned', 'managementOfChange', 'peerReview', 'qualityAssurance', 'riskScoring',
];

describe('assurance goldens', () => {
  test('every engine module has a golden, and every golden a module', () => {
    const covered = [...new Set(goldens.map((g) => g.module))].sort();
    expect(covered).toEqual(EXPECTED_MODULES);
    const onDisk = fs.readdirSync(ENGINES).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).sort();
    expect(onDisk).toEqual(EXPECTED_MODULES);
  });

  test('every rule export is exercised by at least one case', () => {
    goldens.forEach(({ module, cases }) => {
      const mod = load(module);
      const fns = Object.keys(mod).filter((k) => typeof mod[k] === 'function');
      const used = new Set(cases.map((c) => c.fn || c.sort));
      const missing = fns.filter((f) => !used.has(f));
      expect({ module, missing }).toEqual({ module, missing: [] });
    });
  });

  goldens.forEach(({ file, module, cases }) => {
    describe(file, () => {
      test('has cases, and unique ids', () => {
        expect(cases.length).toBeGreaterThan(0);
        expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
      });
      test.each(cases.map((c) => [c.id, c]))('%s', (_id, c) => {
        const { problems } = runCase(load(module), c);
        if (c.knownDefect) {
          // The engine and the oracle disagree and FINDINGS records why.
          // Pinned as a failure so a repair shows up here and the marker
          // has to be removed: the list can only shrink.
          expect(problems.length).toBeGreaterThan(0);
        } else {
          expect(problems).toEqual([]);
        }
      });
    });
  });
});

// January offsets, minutes (Date#getTimezoneOffset sign). The offset, not the
// zone name, is the proof the child ran in the zone: ICU reports Asia/Kolkata
// as Asia/Calcutta, and a missing tzdata would silently give UTC.
const ZONES = {
  UTC: 0,
  'America/Los_Angeles': 480,
  'America/St_Johns': 210,
  'Asia/Kolkata': -330,
  'Pacific/Auckland': -780,
  // ASC-0 (RC-11): the far west. A UTC read of a calendar date shows only
  // west of Greenwich, and RC-1 (a string as-of date) was invisible to a
  // gate whose one western zone had not been handed that input. UTC-11,
  // no daylight saving.
  'Pacific/Pago_Pago': 660,
};

const CHILD = (goldenDir, enginesDir, helper) => `
import fs from 'fs';
import path from 'path';
const { runCase } = await import(${JSON.stringify(helper)});
const out = { januaryOffset: new Date(2026, 0, 15).getTimezoneOffset(), failures: [], ran: 0 };
for (const f of fs.readdirSync(${JSON.stringify(goldenDir)}).filter((x) => x.endsWith('.json'))) {
  const g = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(goldenDir)}, f), 'utf8'));
  const mod = await import(path.join(${JSON.stringify(enginesDir)}, g.module + '.js'));
  for (const c of g.cases) {
    out.ran += 1;
    if (c.knownDefect) continue;
    const { problems } = runCase(mod, c);
    if (problems.length) out.failures.push(f + ' ' + c.id + ': ' + problems.join('; '));
  }
}
process.stdout.write(JSON.stringify(out));
`;

describe('assurance goldens hold in every time zone', () => {
  const total = goldens.reduce((n, g) => n + g.cases.length, 0);
  test.each(Object.entries(ZONES))('%s', (tz, offset) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      CHILD(DIR, ENGINES, path.join(__dirname, 'helpers/assuranceGoldens.js'))], {
      env: { ...process.env, TZ: tz }, encoding: 'utf8', timeout: 120000,
    });
    if (r.status !== 0) throw new Error(`child under TZ=${tz} failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    expect(out.januaryOffset).toBe(offset);
    expect(total).toBeGreaterThan(0);
    expect(out.ran).toBe(total);
    expect(out.failures).toEqual([]);
  });
});
