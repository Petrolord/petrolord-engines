// Wellsite Studio WS0: the time model (spec section 12). Every record
// carries UTC (authoritative) and the rig-local offset in minutes. Tour
// and report-day boundaries are computed from that offset by arithmetic,
// never from the machine's timezone, because a rig laptop's clock zone is
// whatever the last user left it.

const MIN = 60000;
const DAY = 24 * 60;

export function parseUtc(iso) {
  if (typeof iso === 'number') return Number.isFinite(iso) ? iso : null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function pad(n) { return String(n).padStart(2, '0'); }

/** Rig-local wall clock for a UTC instant. */
export function toRigLocal(utcMs, offsetMin) {
  const shifted = new Date(utcMs + offsetMin * MIN);
  const y = shifted.getUTCFullYear();
  const mo = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  const h = shifted.getUTCHours();
  const mi = shifted.getUTCMinutes();
  const s = shifted.getUTCSeconds();
  const dateIso = `${y}-${pad(mo)}-${pad(d)}`;
  const hhmm = `${pad(h)}:${pad(mi)}`;
  return { ms: utcMs, offsetMin, dateIso, hhmm, iso: `${dateIso}T${hhmm}:${pad(s)}`, minuteOfDay: h * 60 + mi };
}

/** Rig-local wall clock (YYYY-MM-DDTHH:mm[:ss]) to a UTC instant. */
export function fromRigLocal(localIso, offsetMin) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(localIso || '');
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  return ms - offsetMin * MIN;
}

export function durationMin(startUtcMs, endUtcMs) {
  return (endUtcMs - startUtcMs) / MIN;
}

export function offsetLabel(offsetMin) {
  const sign = offsetMin < 0 ? '-' : '+';
  const a = Math.abs(offsetMin);
  return `UTC${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

function minuteOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return null;
  return (+m[1]) * 60 + (+m[2]);
}

/** Normalise a tour config; defaults are two tours starting 06:00 and 18:00 rig local. */
export function tourConfig(cfg = {}) {
  const starts = (cfg.tourStartsLocal && cfg.tourStartsLocal.length ? cfg.tourStartsLocal : ['06:00', '18:00'])
    .map((s) => ({ label: s, minute: minuteOf(s) }))
    .filter((s) => s.minute != null)
    .sort((a, b) => a.minute - b.minute);
  const labels = cfg.tourLabels && cfg.tourLabels.length === starts.length ? cfg.tourLabels : starts.map((s, i) => (starts.length === 2 ? ['Day', 'Night'][i] : `Tour ${i + 1}`));
  return {
    offsetMin: Number.isFinite(cfg.offsetMin) ? cfg.offsetMin : 0,
    starts,
    labels,
    reportDayStartMinute: minuteOf(cfg.reportDayStartLocal || '06:00') ?? 360,
  };
}

/** The UTC instant of a rig-local minute of day on a rig-local date. */
function localMinuteToUtc(dateIso, minute, offsetMin) {
  const [y, mo, d] = dateIso.split('-').map(Number);
  return Date.UTC(y, mo - 1, d, 0, 0, 0) + minute * MIN - offsetMin * MIN;
}

/** The tour containing a UTC instant. */
export function tourAt(utcMs, cfgIn) {
  const cfg = tourConfig(cfgIn);
  const loc = toRigLocal(utcMs, cfg.offsetMin);
  const n = cfg.starts.length;
  let idx = -1;
  for (let i = 0; i < n; i += 1) if (loc.minuteOfDay >= cfg.starts[i].minute) idx = i;
  let startUtc;
  if (idx === -1) {
    // before the first start: the last tour of the previous day
    idx = n - 1;
    startUtc = localMinuteToUtc(loc.dateIso, cfg.starts[idx].minute, cfg.offsetMin) - DAY * MIN;
  } else {
    startUtc = localMinuteToUtc(loc.dateIso, cfg.starts[idx].minute, cfg.offsetMin);
  }
  const nextMinute = idx + 1 < n ? cfg.starts[idx + 1].minute : cfg.starts[0].minute + DAY;
  const endUtc = startUtc + (nextMinute - cfg.starts[idx].minute) * MIN;
  return { index: idx, label: cfg.labels[idx], startUtc, endUtc, startLocal: toRigLocal(startUtc, cfg.offsetMin).iso, endLocal: toRigLocal(endUtc, cfg.offsetMin).iso };
}

/** The `count` tours ending at or before the instant, most recent first (the ones a handover covers). */
export function previousTours(utcMs, cfgIn, { count = 2 } = {}) {
  const out = [];
  let t = tourAt(utcMs - 1, cfgIn);
  // the tour containing utcMs is "current"; completed tours end at or before utcMs
  const current = tourAt(utcMs, cfgIn);
  if (current.endUtc <= utcMs) t = current;
  else t = tourAt(current.startUtc - 1, cfgIn);
  while (out.length < count) {
    out.push(t);
    t = tourAt(t.startUtc - 1, cfgIn);
  }
  return out;
}

/** The 24 h report day containing the instant. */
export function reportPeriod(utcMs, cfgIn) {
  const cfg = tourConfig(cfgIn);
  const loc = toRigLocal(utcMs, cfg.offsetMin);
  let startUtc = localMinuteToUtc(loc.dateIso, cfg.reportDayStartMinute, cfg.offsetMin);
  if (startUtc > utcMs) startUtc -= DAY * MIN;
  const endUtc = startUtc + DAY * MIN;
  return { startUtc, endUtc, dateLabel: toRigLocal(startUtc, cfg.offsetMin).dateIso };
}

/** Records must carry UTC and the offset. */
export function assertUtc(rec) {
  const errors = [];
  if (!rec || parseUtc(rec.occurred_at) == null) errors.push('Record time (occurred_at, UTC) is missing.');
  if (!rec || !Number.isInteger(rec.local_offset_min) || Math.abs(rec.local_offset_min) > 14 * 60) errors.push('Record local offset (local_offset_min) is missing or out of range.');
  return errors;
}

/** A stamp for a record being written now. */
export function nowStamp(offsetMin, nowMs = Date.now()) {
  return { occurred_at: new Date(nowMs).toISOString(), local_offset_min: offsetMin };
}
