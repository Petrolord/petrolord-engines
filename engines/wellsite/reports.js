// Wellsite Studio WS7 and WS8: the shift handover and the daily
// geological report as MODELS generated from records (spec sections 29
// to 32). Every factual value in a model names the record ids it came
// from; the free-text sections are records too (narratives). A model is
// plain JSON: the Suite renders it to a screen, a PDF or a DOCX, and a
// sign-off hashes its canonical form. Nothing here is typed twice.
//
// Inputs are plain rows in the ws_* shapes (records, samples, stages,
// tops, photos, events as engine shapes) already selected for the well;
// selectPeriod clips them to the period by their time.

import { toRigLocal, tourAt, previousTours, reportPeriod } from './time.js';
import { eventsInPeriod, timeByType, eventType } from './events.js';
import { highestStage } from './sampleProgram.js';
import { abbreviate, PETROLORD_PROFILE } from './abbreviations.js';
import { showSummary, showAbbrev } from './shows.js';
import { chainHeads, currentCall } from './tops.js';

export const REPORT_KINDS = Object.freeze(['handover', 'daily']);
export const SECTION_SOURCES = Object.freeze(['status', 'drilled', 'samples', 'lithology', 'shows', 'gas', 'observations', 'tops', 'events', 'photos', 'notes', 'narrative']);

export const HANDOVER_TEMPLATE = Object.freeze({
  id: 'petrolord-handover', name: 'Petrolord shift handover', version: 1,
  sections: [
    { id: 'status', title: 'Status at handover', source: 'status' },
    { id: 'drilled', title: 'Interval drilled this tour', source: 'drilled' },
    { id: 'tops', title: 'Tops called', source: 'tops' },
    { id: 'lithology', title: 'Current lithology', source: 'lithology' },
    { id: 'shows', title: 'Significant shows', source: 'shows' },
    { id: 'gas', title: 'Gas observations', source: 'gas' },
    { id: 'observations', title: 'Other observations', source: 'observations' },
    { id: 'events', title: 'Operations', source: 'events' },
    { id: 'samples', title: 'Samples', source: 'samples' },
    { id: 'summary', title: 'Geological summary', source: 'narrative', narrative: 'geological_summary' },
    { id: 'watch', title: 'Watch items', source: 'narrative', narrative: 'watch_items' },
    { id: 'outstanding', title: 'Outstanding items', source: 'narrative', narrative: 'outstanding_items' },
    { id: 'remarks', title: 'Additional remarks', source: 'narrative', narrative: 'remarks' },
  ],
});

export const DEFAULT_DAILY_TEMPLATE = Object.freeze({
  id: 'generic-dgr', name: 'Generic daily geological report', version: 1,
  sections: [
    { id: 'status', title: 'Well status', source: 'status' },
    { id: 'drilled', title: 'Progress in the period', source: 'drilled' },
    { id: 'events', title: 'Operations summary', source: 'events' },
    { id: 'lithology', title: 'Lithology', source: 'lithology', options: { all: true } },
    { id: 'shows', title: 'Hydrocarbon shows', source: 'shows' },
    { id: 'gas', title: 'Gas', source: 'gas' },
    { id: 'tops', title: 'Formation tops', source: 'tops' },
    { id: 'observations', title: 'Observations', source: 'observations' },
    { id: 'samples', title: 'Sampling', source: 'samples' },
    { id: 'photos', title: 'Photographs', source: 'photos' },
    { id: 'summary', title: 'Geological summary', source: 'narrative', narrative: 'geological_summary' },
    { id: 'forecast', title: 'Forecast and recommendations', source: 'narrative', narrative: 'forecast' },
  ],
});

export function validateTemplate(t) {
  const errors = [];
  if (!t || typeof t !== 'object') return ['A template must be an object.'];
  if (!t.id) errors.push('A template needs an id.');
  if (!Array.isArray(t.sections) || !t.sections.length) errors.push('A template needs at least one section.');
  const ids = new Set();
  for (const s of t.sections || []) {
    if (!s.id) errors.push('Every section needs an id.');
    else if (ids.has(s.id)) errors.push(`Section id ${s.id} is used twice.`);
    ids.add(s.id);
    if (!SECTION_SOURCES.includes(s.source)) errors.push(`Section ${s.id || '?'} has an unknown source ${s.source}.`);
    if (s.source === 'narrative' && !s.narrative) errors.push(`Section ${s.id} needs the narrative key it edits.`);
    if (typeof s.title !== 'string' || !s.title.trim()) errors.push(`Section ${s.id || '?'} needs a title.`);
    if (/[–—]/.test(String(s.title || ''))) errors.push(`Section ${s.id} title uses a dash character that the copy rule forbids.`);
  }
  return errors;
}

/** Rows whose time (field) falls in [startUtc, endUtc). */
export function selectPeriod(rows, { startUtc, endUtc }, field = 'occurred_at') {
  return rows.filter((r) => { const t = typeof r[field] === 'number' ? r[field] : Date.parse(r[field]); return Number.isFinite(t) && t >= startUtc && t < endUtc; });
}

const ref = (rows) => rows.map((r) => r.id);
const last = (rows) => (rows.length ? rows[rows.length - 1] : null);
const byTime = (rows, f = 'occurred_at') => [...rows].sort((a, b) => Date.parse(a[f]) - Date.parse(b[f]));
const GAS = new Set(['total_gas', 'connection_gas', 'trip_gas']);

/**
 * The report model.
 * @param {Object} p
 * @param {'handover'|'daily'} p.kind
 * @param {{startUtc:number, endUtc:number, label:string}} p.period
 * @param {Object} p.well ws_wells row
 * @param {Object} p.data { records, samples, stages, tops, photos, events (engine shapes), lagReadout }
 * @param {Object} [p.template]
 * @param {Object} [p.profile] abbreviation profile
 * @param {number} p.nowUtcMs
 */
export function buildReportModel({ kind, period, well, data, template = null, profile = PETROLORD_PROFILE, nowUtcMs, offsetMin = 0 }) {
  if (!REPORT_KINDS.includes(kind)) throw new Error(`Unknown report kind ${kind}.`);
  const tpl = template || (kind === 'handover' ? HANDOVER_TEMPLATE : DEFAULT_DAILY_TEMPLATE);
  const errs = validateTemplate(tpl);
  if (errs.length) throw new Error(errs[0]);
  const records = data.records || [];
  const inPeriod = selectPeriod(records, period);
  const observations = (rows) => rows.filter((r) => r.kind === 'observation');
  const bits = byTime(observations(records).filter((r) => r.subtype === 'bit_depth'));
  const bitsIn = selectPeriod(bits, period);
  const bitAtStart = [...bits].reverse().find((b) => Date.parse(b.occurred_at) <= period.startUtc) || null;
  const bitAtEnd = [...bits].reverse().find((b) => Date.parse(b.occurred_at) < period.endUtc) || null;
  const descriptions = byTime(observations(records).filter((r) => r.subtype === 'cuttings_description' && !records.some((x) => x.supersedes_id === r.id)));
  const shows = byTime(observations(records).filter((r) => r.subtype === 'show' && !records.some((x) => x.supersedes_id === r.id)));
  const gas = byTime(observations(inPeriod).filter((r) => GAS.has(r.subtype)));
  const others = byTime(observations(inPeriod).filter((r) => !GAS.has(r.subtype) && !['bit_depth', 'pump_rate', 'rig_config', 'cuttings_description', 'show'].includes(r.subtype)));
  const tops = data.tops || [];
  const topsIn = selectPeriod(tops.filter((t) => t.role === 'official'), period);
  const events = data.events || [];
  const evIn = eventsInPeriod(events, period, nowUtcMs);
  const samples = data.samples || [];
  const stages = data.stages || [];
  const stagesIn = selectPeriod(stages, period, 'at_utc');
  const photos = selectPeriod(data.photos || [], period, 'captured_at');
  const narratives = chainHeads(records.filter((r) => r.kind === 'narrative'));
  const local = (iso) => toRigLocal(Date.parse(iso), offsetMin).hhmm;
  const localMs = (ms) => toRigLocal(ms, offsetMin).hhmm;
  const lag = data.lagReadout || null;

  const sections = tpl.sections.map((sec) => {
    const base = { id: sec.id, title: sec.title, source: sec.source };
    switch (sec.source) {
      case 'status': {
        const rows = [];
        if (bitAtEnd) rows.push({ label: 'Bit depth', value_m: bitAtEnd.md_calc_m, tvd_m: bitAtEnd.tvd_calc_m ?? null, at: bitAtEnd.occurred_at, refs: [bitAtEnd.id] });
        if (lag && Number.isFinite(lag.laggedMdM)) rows.push({ label: 'Lagged sample depth', value_m: lag.laggedMdM, refs: [] });
        if (lag && Number.isFinite(lag.lagStrokes)) rows.push({ label: 'Lag', text: `${Math.round(lag.lagStrokes)} strokes${lag.lagTimeMin == null ? ', pumps off' : `, ${Math.round(lag.lagTimeMin)} min at ${lag.spmNow} spm`}`, refs: [] });
        const open = events.filter((e) => e.duration && e.endUtcMs == null);
        rows.push({ label: 'Current operation', text: open.length ? open.map((e) => e.label).join(', ') : 'none open', refs: open.map((e) => e.id) });
        const lastDesc = last(descriptions);
        if (lastDesc) rows.push({ label: 'Current lithology', text: abbreviate({ components: lastDesc.payload.components, comment: lastDesc.payload.comment }, profile).text, refs: [lastDesc.id] });
        const calls = tops.filter((t) => t.role === 'official');
        const keys = [...new Set(calls.map((t) => t.formation_key))];
        const current = keys.map((k) => currentCall(calls, k).call).filter(Boolean).sort((a, b) => b.md_calc_m - a.md_calc_m);
        if (current.length) rows.push({ label: 'Current formation', text: `${current[0].name} (${current[0].status})`, value_m: current[0].md_calc_m, refs: [current[0].id] });
        return { ...base, kind: 'kv', rows };
      }
      case 'drilled': {
        const from = bitAtStart ? bitAtStart.md_calc_m : (bitsIn.length ? bitsIn[0].md_calc_m : null);
        const to = bitAtEnd ? bitAtEnd.md_calc_m : null;
        return { ...base, kind: 'kv', rows: [
          { label: 'From', value_m: from, refs: bitAtStart ? [bitAtStart.id] : [] },
          { label: 'To', value_m: to, refs: bitAtEnd ? [bitAtEnd.id] : [] },
          { label: 'Made', value_m: from != null && to != null ? to - from : null, refs: ref([...(bitAtStart ? [bitAtStart] : []), ...(bitAtEnd ? [bitAtEnd] : [])]) },
        ] };
      }
      case 'tops': {
        return { ...base, kind: 'table', columns: ['Formation', 'Depth', 'Status', 'Version', 'Time', 'Basis'], rows: topsIn.map((t) => ({ cells: [t.name, { value_m: t.md_calc_m }, t.status, `v${t.version_no}`, local(t.occurred_at), t.basis || ''], refs: [t.id] })) };
      }
      case 'lithology': {
        const list = sec.options && sec.options.all ? selectPeriod(descriptions, period) : descriptions.slice(-6);
        return { ...base, kind: 'table', columns: ['From', 'To', 'Description'], rows: list.map((d) => ({ cells: [{ value_m: d.md_calc_m }, { value_m: d.md2_calc_m }, abbreviate({ components: d.payload.components, comment: d.payload.comment }, profile).text], refs: [d.id] })) };
      }
      case 'shows': {
        const list = selectPeriod(shows, period);
        return { ...base, kind: 'table', columns: ['Depth', 'Show', 'Quality'], rows: list.map((s) => ({ cells: [{ value_m: s.md_calc_m }, showAbbrev(s.payload), showSummary(s.payload).qualityName], refs: [s.id] })) };
      }
      case 'gas': {
        const peak = gas.filter((g) => g.subtype === 'total_gas').reduce((m, g) => (g.payload.value > (m ? m.payload.value : -Infinity) ? g : m), null);
        return { ...base, kind: 'table', columns: ['Time', 'Depth', 'Type', 'Value'], summary: peak ? { label: 'Peak total gas', text: `${peak.payload.value} ${peak.payload.unit}`, refs: [peak.id] } : null,
          rows: gas.map((g) => ({ cells: [local(g.occurred_at), { value_m: g.md_calc_m }, g.subtype.replace(/_/g, ' '), `${g.payload.value ?? ''} ${g.payload.unit || ''}`.trim()], refs: [g.id] })) };
      }
      case 'observations': {
        return { ...base, kind: 'table', columns: ['Time', 'Depth', 'Type', 'Observation'], rows: others.map((o) => ({ cells: [local(o.occurred_at), { value_m: o.md_calc_m }, o.subtype.replace(/_/g, ' '), o.payload.text || `${o.payload.value ?? ''} ${o.payload.unit || ''}`.trim()], refs: [o.id] })) };
      }
      case 'events': {
        const byType = timeByType(events, period, nowUtcMs);
        return { ...base, kind: 'table', columns: ['Start', 'End', 'Event', 'Depth', 'Minutes'],
          summary: Object.entries(byType).filter(([, m]) => m > 0).map(([t, m]) => ({ label: (eventType(t) || { name: t }).name, text: `${Math.round(m)} min` })),
          rows: evIn.map((e) => ({ cells: [localMs(e.clippedStartUtcMs), e.duration ? (e.stillOpen ? 'open' : localMs(e.clippedEndUtcMs)) : '', e.label, { value_m: e.mdM }, e.duration ? Math.round(e.durationMin) : ''], refs: [e.id] })) };
      }
      case 'samples': {
        const bySample = new Map();
        for (const st of stages) { if (!bySample.has(st.sample_id)) bySample.set(st.sample_id, []); bySample.get(st.sample_id).push(st); }
        const caught = stagesIn.filter((s) => s.stage === 'caught');
        const described = stagesIn.filter((s) => s.stage === 'described');
        const bagged = stagesIn.filter((s) => s.stage === 'bagged');
        const cut = samples.filter((s) => bitAtEnd && s.md_calc_m <= bitAtEnd.md_calc_m);
        const notCaught = cut.filter((s) => highestStage(bySample.get(s.id) || []) === 'scheduled');
        return { ...base, kind: 'kv', rows: [
          { label: 'Caught in the period', text: String(caught.length), refs: ref(caught) },
          { label: 'Described in the period', text: String(described.length), refs: ref(described) },
          { label: 'Bagged in the period', text: String(bagged.length), refs: ref(bagged) },
          { label: 'Cut, not yet caught', text: String(notCaught.length), refs: ref(notCaught) },
        ] };
      }
      case 'photos': {
        return { ...base, kind: 'table', columns: ['Time', 'Depth', 'Caption'], rows: photos.map((p) => ({ cells: [local(p.captured_at), { value_m: p.md_calc_m }, p.caption || ''], refs: [p.id], photo_id: p.id })) };
      }
      case 'notes': {
        const notes = others.filter((o) => o.subtype === 'note');
        return { ...base, kind: 'list', rows: notes.map((n) => ({ text: n.payload.text, refs: [n.id] })) };
      }
      case 'narrative': {
        const n = narratives.filter((r) => r.subtype === sec.narrative && (!r.payload.period_start || r.payload.period_start === new Date(period.startUtc).toISOString())).sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))[0] || null;
        return { ...base, kind: 'narrative', narrative: sec.narrative, text: n ? n.payload.text : '', refs: n ? [n.id] : [], editable: true };
      }
      default:
        return { ...base, kind: 'empty', rows: [] };
    }
  });

  return {
    kind, template: { id: tpl.id, name: tpl.name, version: tpl.version }, generated_at: new Date(nowUtcMs).toISOString(), local_offset_min: offsetMin,
    period: { start: new Date(period.startUtc).toISOString(), end: new Date(period.endUtc).toISOString(), label: period.label || '' },
    well: { id: well.id, name: well.name, field: (well.header || {}).field || null, rig: (well.header || {}).rig || null, operator: (well.header || {}).operator || null },
    sections,
    counts: { records_in_period: inPeriod.length, tops_called: topsIn.length, shows: selectPeriod(shows, period).length, photos: photos.length, events: evIn.length },
    profile: profile.id,
  };
}

/** The handover period: the tour that just ended (or the current one when `current` is set). */
export function handoverPeriod(nowUtcMs, tourCfg, { current = false } = {}) {
  const t = current ? tourAt(nowUtcMs, tourCfg) : previousTours(nowUtcMs, tourCfg, { count: 1 })[0];
  return { startUtc: t.startUtc, endUtc: current ? nowUtcMs : t.endUtc, label: `${t.label} tour ${t.startLocal.slice(0, 10)}` };
}

/** The daily report period containing the instant (rig-local report day). */
export function dailyPeriod(utcMs, tourCfg) {
  const p = reportPeriod(utcMs, tourCfg);
  return { startUtc: p.startUtc, endUtc: p.endUtc, label: `report day ${p.dateLabel}`, dateLabel: p.dateLabel };
}

/** Every record id a model cites. */
export function citedIds(model) {
  const ids = new Set();
  for (const s of model.sections) {
    for (const r of s.rows || []) for (const id of r.refs || []) ids.add(id);
    for (const id of s.refs || []) ids.add(id);
    if (s.summary) for (const sm of Array.isArray(s.summary) ? s.summary : [s.summary]) for (const id of sm.refs || []) ids.add(id);
  }
  return [...ids];
}

/** Stable JSON: keys sorted at every level, so two renderings of the same model hash alike. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

/** A small stable hash (FNV-1a, 64 bit as hex) for environments without WebCrypto; the Suite uses SHA-256 when available. */
export function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  const p = 0x100000001b3n;
  for (let i = 0; i < str.length; i += 1) { h ^= BigInt(str.charCodeAt(i)); h = (h * p) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, '0');
}
