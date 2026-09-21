/** WS2 event vocabulary and timeline arithmetic. */
import { EVENT_TYPES, EVENT_CODES, startEvent, endEvent, validateEvents, eventsInPeriod, timeByType, openEvents } from '../engines/wellsite/events';

const MIN = 60000;
const T0 = Date.parse('2026-09-07T06:00:00Z');

test('the seventeen event types with unique codes and hotkeys', () => {
  expect(EVENT_TYPES).toHaveLength(17);
  expect(new Set(EVENT_CODES).size).toBe(17);
  expect(new Set(EVENT_TYPES.map((e) => e.hotkey)).size).toBe(17);
  expect(EVENT_CODES).toEqual(expect.arrayContaining(['drilling', 'connection', 'trip_in', 'trip_out', 'circulation', 'bottoms_up', 'losses', 'gains', 'sweep', 'cavings', 'gas_event', 'coring', 'casing', 'logging', 'pump_rate_change', 'top_called', 'user_defined']));
});

test('start, end, open events and refusals', () => {
  const c = startEvent({ type: 'circulation', utcMs: T0, mdM: 3000, by: 'me' });
  expect(c.endUtcMs).toBeNull();
  expect(openEvents([c])).toHaveLength(1);
  const ended = endEvent(c, T0 + 30 * MIN);
  expect(ended.endUtcMs).toBe(T0 + 30 * MIN);
  expect(openEvents([ended])).toHaveLength(0);
  const point = startEvent({ type: 'top_called', utcMs: T0, label: 'Top Agbada called' });
  expect(point.endUtcMs).toBe(T0);
  expect(() => endEvent(point, T0)).toThrow('Only a duration event can be ended.');
  expect(() => endEvent(ended, T0)).toThrow('The event has already ended.');
  expect(() => endEvent(c, T0 - 1)).toThrow('An event cannot end before it started.');
  expect(() => startEvent({ type: 'user_defined', utcMs: T0 })).toThrow('A user-defined event needs a label.');
  expect(() => startEvent({ type: 'lunch', utcMs: T0 })).toThrow('Unknown event type lunch.');
});

test('validation catches overlapping open rig events; a period clips durations', () => {
  const a = startEvent({ type: 'drilling', utcMs: T0 });
  const b = startEvent({ type: 'connection', utcMs: T0 + 10 * MIN });
  expect(validateEvents([a, b])).toEqual(['Connection starts while Drilling is still open.']);
  const a2 = endEvent(a, T0 + 10 * MIN);
  const b2 = endEvent(b, T0 + 15 * MIN);
  const gas = startEvent({ type: 'gas_event', utcMs: T0 + 5 * MIN });
  expect(validateEvents([a2, b2, gas])).toEqual([]);
  const period = { startUtc: T0 + 5 * MIN, endUtc: T0 + 12 * MIN };
  const inP = eventsInPeriod([a2, b2, gas], period, T0 + 60 * MIN);
  expect(inP.map((e) => [e.type, e.durationMin, e.stillOpen])).toEqual([['drilling', 5, false], ['gas_event', 7, true], ['connection', 2, false]]);
  expect(timeByType([a2, b2, gas], period, T0 + 60 * MIN)).toEqual({ drilling: 5, gas_event: 7, connection: 2 });
});
