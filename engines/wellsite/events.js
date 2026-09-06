// Wellsite Studio WS2: the operational event vocabulary and timeline
// arithmetic (spec sections 27 and 28). Events are what happened on the
// rig; some have a duration (started now, ended later). Pure.

export const EVENT_TYPES = Object.freeze([
  { code: 'drilling', name: 'Drilling', duration: true, family: 'rig', hotkey: 'D' },
  { code: 'connection', name: 'Connection', duration: true, family: 'rig', hotkey: 'C' },
  { code: 'trip_in', name: 'Trip in', duration: true, family: 'rig', hotkey: 'I' },
  { code: 'trip_out', name: 'Trip out', duration: true, family: 'rig', hotkey: 'O' },
  { code: 'circulation', name: 'Circulation', duration: true, family: 'rig', hotkey: 'R' },
  { code: 'bottoms_up', name: 'Bottoms up', duration: false, family: 'geology', hotkey: 'B' },
  { code: 'losses', name: 'Losses', duration: true, family: 'well', hotkey: 'L' },
  { code: 'gains', name: 'Gains', duration: true, family: 'well', hotkey: 'G' },
  { code: 'sweep', name: 'Sweep', duration: true, family: 'rig', hotkey: 'W' },
  { code: 'cavings', name: 'Cavings', duration: false, family: 'geology', hotkey: 'V' },
  { code: 'gas_event', name: 'Gas event', duration: true, family: 'geology', hotkey: 'A' },
  { code: 'coring', name: 'Coring', duration: true, family: 'rig', hotkey: 'K' },
  { code: 'casing', name: 'Casing', duration: true, family: 'rig', hotkey: 'S' },
  { code: 'logging', name: 'Logging', duration: true, family: 'rig', hotkey: 'N' },
  { code: 'pump_rate_change', name: 'Pump rate change', duration: false, family: 'rig', hotkey: 'P' },
  { code: 'top_called', name: 'Top called', duration: false, family: 'geology', hotkey: 'T' },
  { code: 'user_defined', name: 'Other event', duration: true, family: 'other', hotkey: 'U' },
]);
export const EVENT_CODES = Object.freeze(EVENT_TYPES.map((e) => e.code));
export const eventType = (code) => EVENT_TYPES.find((e) => e.code === code) || null;

/** Start an event now. Duration events stay open until endEvent. */
export function startEvent({ type, utcMs, mdM = null, by = null, label = null, note = null }) {
  const t = eventType(type);
  if (!t) throw new Error(`Unknown event type ${type}.`);
  if (!Number.isFinite(utcMs)) throw new Error('An event needs a start time.');
  if (type === 'user_defined' && !(label && String(label).trim())) throw new Error('A user-defined event needs a label.');
  return { type, label: label || t.name, startUtcMs: utcMs, endUtcMs: t.duration ? null : utcMs, mdM, by, note, duration: t.duration, family: t.family };
}

export function endEvent(ev, utcMs) {
  if (!ev || !ev.duration) throw new Error('Only a duration event can be ended.');
  if (ev.endUtcMs != null) throw new Error('The event has already ended.');
  if (!(utcMs >= ev.startUtcMs)) throw new Error('An event cannot end before it started.');
  return { ...ev, endUtcMs: utcMs };
}

export const isOpen = (ev) => ev.duration && ev.endUtcMs == null;
export const openEvents = (events) => events.filter(isOpen);

/** Problems in a list of events: overlapping open events of the rig family, ends before starts. */
export function validateEvents(events) {
  const errors = [];
  const sorted = [...events].sort((a, b) => a.startUtcMs - b.startUtcMs);
  let openRig = null;
  for (const ev of sorted) {
    if (!eventType(ev.type)) errors.push(`Unknown event type ${ev.type}.`);
    if (ev.endUtcMs != null && ev.endUtcMs < ev.startUtcMs) errors.push(`${ev.label} ends before it starts.`);
    if (ev.family === 'rig' && ev.duration) {
      if (openRig && (openRig.endUtcMs == null || openRig.endUtcMs > ev.startUtcMs)) errors.push(`${ev.label} starts while ${openRig.label} is still open.`);
      openRig = ev;
    }
  }
  return errors;
}

/** Events touching a period, clipped to it, with durations in minutes. */
export function eventsInPeriod(events, { startUtc, endUtc }, nowUtcMs = endUtc) {
  const out = [];
  for (const ev of events) {
    const end = ev.endUtcMs == null ? (ev.duration ? nowUtcMs : ev.startUtcMs) : ev.endUtcMs;
    if (end < startUtc || ev.startUtcMs >= endUtc) continue;
    const from = Math.max(ev.startUtcMs, startUtc);
    const to = Math.min(end, endUtc);
    out.push({ ...ev, clippedStartUtcMs: from, clippedEndUtcMs: to, durationMin: ev.duration ? (to - from) / 60000 : 0, stillOpen: isOpen(ev) });
  }
  return out.sort((a, b) => a.startUtcMs - b.startUtcMs);
}

/** Minutes per event type over a period (the handover and daily report tables). */
export function timeByType(events, period, nowUtcMs) {
  const out = {};
  for (const ev of eventsInPeriod(events, period, nowUtcMs)) out[ev.type] = (out[ev.type] || 0) + ev.durationMin;
  return out;
}
