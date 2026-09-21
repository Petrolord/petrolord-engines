/**
 * ASC-0 item 12: a created_at fallback is an instant, dated by its LOCAL
 * calendar date.
 *
 * lessonAgeDays and lessonByAttention fall back from event_date to
 * created_at, and ncrAgeDays from raised_date to created_at. created_at is a
 * timestamptz, sent as '2026-09-17T23:30:00+00:00'; its leading YYYY-MM-DD is
 * the UTC date, so in Lagos (UTC+1) a lesson created at 00:30 local time was
 * dated a day early. The goldens pin the rule zone-invariantly with
 * {"$localInstant"}; this file pins the literal 23:30Z instant the finding
 * was reported with, whose local date is the 17th or the 18th depending on
 * the zone, in child processes under each zone of the golden sweep and
 * Lagos.
 */
import path from 'path';
import { spawnSync } from 'child_process';

const ENGINES = path.join(__dirname, '../engines/assurance');

// January offset (the proof the child ran in the zone) and the local
// calendar date of 2026-09-17T23:30:00Z there.
const ZONES = {
  UTC: [0, '2026-09-17'],
  'Africa/Lagos': [-60, '2026-09-18'],
  'America/Los_Angeles': [480, '2026-09-17'],
  'America/St_Johns': [210, '2026-09-17'],
  'Asia/Kolkata': [-330, '2026-09-18'],
  'Pacific/Auckland': [-780, '2026-09-18'],
  'Pacific/Pago_Pago': [660, '2026-09-17'],
};

const CHILD = (dir) => `
const C = await import(${JSON.stringify(path.join(dir, 'calendar.js'))});
const L = await import(${JSON.stringify(path.join(dir, 'lessonsLearned.js'))});
const Q = await import(${JSON.stringify(path.join(dir, 'qualityAssurance.js'))});
const today = new Date(2026, 8, 20);
const out = {
  januaryOffset: new Date(2026, 0, 15).getTimezoneOffset(),
  postgrest: C.toDateOnlyString(C.localDateOf('2026-09-17T23:30:00+00:00')),
  zulu: C.toDateOnlyString(C.localDateOf('2026-09-17T23:30:00Z')),
  dateOnly: C.toDateOnlyString(C.localDateOf('2026-09-17')),
  parseDateOnlyUnchanged: C.toDateOnlyString(C.parseDateOnly('2026-09-17T23:30:00+00:00')),
  lessonAge: L.lessonAgeDays({ created_at: '2026-09-17T23:30:00+00:00' }, today),
  lessonAgeByEventDate: L.lessonAgeDays({ event_date: '2026-09-17', created_at: '2026-09-17T23:30:00+00:00' }, today),
  ncrAge: Q.ncrAgeDays({ status: 'Open', created_at: '2026-09-17T23:30:00+00:00' }, today),
};
process.stdout.write(JSON.stringify(out));
`;

describe('a created_at instant is dated by its local calendar date, in every zone', () => {
  test.each(Object.entries(ZONES))('%s', (tz, [offset, localDate]) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD(ENGINES)], {
      env: { ...process.env, TZ: tz }, encoding: 'utf8', timeout: 60000,
    });
    if (r.status !== 0) throw new Error(`child under TZ=${tz} failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    const age = localDate === '2026-09-17' ? 3 : 2;
    expect(out).toEqual({
      januaryOffset: offset,
      postgrest: localDate,
      zulu: localDate,
      dateOnly: '2026-09-17',
      parseDateOnlyUnchanged: '2026-09-17',
      lessonAge: age,
      lessonAgeByEventDate: 3,
      ncrAge: age,
    });
  });
});
