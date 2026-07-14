// LAS 1.2 / 2.0 parser (Well Data Manager G1.2) — validated bit-for-bit
// against lasio via the committed goldens in test-data/wells/ (see
// tools/validation/wells/oracle.py). Where LAS files are ambiguous this
// parser deliberately reproduces lasio's reading, because the goldens
// ARE lasio's reading; the quirks below cite the lasio source rule they
// mirror:
//
//   - header lines parse as  name . unit  value : descr  with the value
//     running GREEDILY to the LAST colon (descriptions after a second
//     colon win; colons inside the value survive) — lasio
//     reader.configure_metadata_patterns
//   - LAS 1.2 ~Well STRING entries put the VALUE after the colon
//     ("WELL. WELL : KETA G1-2"); STRT/STOP/STEP/NULL keep value-first.
//     lasio defaults.ORDER_DEFINITIONS[1.2]
//   - UWI and API are never converted to numbers (leading zeros are
//     significant) — lasio SectionParser.metadata number_strings
//   - null substitution (NULL value -> NaN) happens on the parsed
//     FLOAT64 before the float32 cast, so -999.2500 matches -999.25
//   - data reads as a flat token stream reshaped by curve count, which
//     makes WRAP YES and unwrapped files the same code path
//
// LAS 3.0 is out of v1 scope and is rejected with a clear message,
// never half-parsed. All errors are plain, line-numbered domain Errors
// (the wellImport / malformedSegy philosophy) — never a raw TypeError.
//
// Pure functions, worker-safe, no I/O. Curve samples come back as
// Float32Array (little-endian on every platform we ship to) with LAS
// nulls as NaN — the exact bytes that go to the `wells` bucket.

/** Mnemonics whose ~Well value stays value-first even in LAS 1.2. */
const VALUE_FIRST_12 = new Set(['STRT', 'STOP', 'STEP', 'NULL',
  'strt', 'stop', 'step', 'null']);

/** Mnemonics never converted to numbers (leading zeros significant). */
const NUMBER_STRINGS = new Set(['API', 'UWI']);

/** lasio SectionParser.num: int if possible, else float, else the raw
 *  string; comma decimal marks ("1500,5") normalize first. */
function headerNum(raw) {
  const s = String(raw).replace(/(\d),(\d)/g, '$1.$2').trim();
  if (s === '') return raw;
  const v = Number(s);
  return Number.isFinite(v) ? v : raw;
}

/**
 * One header line -> {name, unit, value, descr} (all strings, trimmed),
 * mirroring lasio reader.read_header_line:
 *   - no '.' before the first ':' -> name : value (no unit, no descr)
 *   - no ':' at all               -> name . unit  value (no descr)
 *   - otherwise                   -> name . unit  value-to-LAST-colon : descr
 * Unit tolerates one "1000 psi"-style embedded space and sheds a
 * trailing period.
 */
export function parseHeaderLine(line) {
  const hasColon = line.includes(':');
  if (hasColon && !line.slice(0, line.indexOf(':')).includes('.')) {
    const i = line.indexOf(':');
    return {
      name: line.slice(0, i).trim(),
      unit: '',
      value: line.slice(i + 1).trim(),
      descr: '',
    };
  }
  const m = hasColon
    ? line.match(/^\.?([^.]*)\.(([0-9]+\s)?[^\s]*)(.*):(.*)$/)
    : line.match(/^\.?([^.]*)\.(([0-9]+\s)?[^\s]*)([^:]*)$/);
  if (!m) return null;
  let unit = (m[2] || '').trim();
  if (unit.endsWith('.')) unit = unit.replace(/\.+$/, '');
  if (unit.length >= 2 && ((unit[0] === '[' && unit[unit.length - 1] === ']')
    || (unit[0] === '(' && unit[unit.length - 1] === ')'))) {
    unit = unit.slice(1, -1);
  }
  return {
    name: (m[1] || '').trim(),
    unit,
    value: (m[4] || '').trim(),
    descr: hasColon ? (m[5] || '').trim() : '',
  };
}

/** Split raw text into ~sections: [{title, lines, lineNo}] where lineNo
 *  is the 1-based line number of the section title. Blank and #-comment
 *  lines are dropped from header sections here; the ~A data section
 *  keeps everything (tokenised later). */
function splitSections(text) {
  const lines = String(text || '').split(/\r\n|\r|\n/);
  const sections = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t.startsWith('~')) {
      // everything after ~A is data regardless of later tildes
      if (current && current.isData) { current.lines.push(line); continue; }
      current = {
        title: t, lineNo: i + 1, lines: [],
        isData: /^~A/i.test(t),
      };
      sections.push(current);
      continue;
    }
    if (!current) {
      if (t === '' || t.startsWith('#')) continue;
      throw new Error(`Line ${i + 1}: content before the first ~section — not a LAS file?`);
    }
    if (current.isData) { current.lines.push(line); continue; }
    if (t === '' || t.startsWith('#')) continue;
    current.lines.push({ text: line, lineNo: i + 1 });
  }
  if (!sections.length) throw new Error('No ~sections found — this is not a LAS file.');
  return sections;
}

/** Parse a header section's lines into an ordered item map.
 *  order: 'value:descr' | 'descr:value' resolved per line for ~Well 1.2. */
function parseHeaderSection(section, { isWell = false, version = 2.0 } = {}) {
  const items = {};
  for (const { text, lineNo } of section.lines) {
    const raw = parseHeaderLine(text);
    if (!raw || !raw.name) {
      throw new Error(`Line ${lineNo}: cannot parse header line "${text.trim()}" in ${section.title}.`);
    }
    const descrFirst = isWell && version < 2.0 && !VALUE_FIRST_12.has(raw.name);
    let value = descrFirst ? raw.descr : raw.value;
    const descr = descrFirst ? raw.value : raw.descr;
    if (!NUMBER_STRINGS.has(raw.name.toUpperCase())) value = headerNum(value);
    items[raw.name.toUpperCase()] = { unit: raw.unit, value, descr };
  }
  return items;
}

/** Tokenise the ~A section into float64s (NULL -> NaN), tracking line
 *  numbers for error messages. Unparseable tokens are domain errors —
 *  silent NaNs hide broken files from the import preview. */
function readDataSection(section, nullValue) {
  const out = [];
  for (let i = 0; i < section.lines.length; i++) {
    const line = section.lines[i];
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const tokens = t.split(/\s+/);
    for (const tok of tokens) {
      const v = Number(tok);
      if (!Number.isFinite(v)) {
        throw new Error(`Line ${section.lineNo + 1 + i}: "${tok}" in the ~ASCII data section is not a number.`);
      }
      out.push(v === nullValue ? NaN : v);
    }
  }
  return out;
}

/**
 * Parse a LAS 1.2 / 2.0 file.
 *
 * @param {string} text raw file text
 * @returns {{
 *   version: number, wrap: string, nullValue: ?number,
 *   well: Object<string, {unit: string, value: (number|string), descr: string}>,
 *   params: Object<string, {unit: string, value: (number|string), descr: string}>,
 *   other: string,
 *   depthUnit: string,
 *   curves: Array<{
 *     mnemonic: string, unit: string, descr: string, apiValue: string,
 *     data: Float32Array, nSamples: number, nullCount: number,
 *     firstFinite: ?number, lastFinite: ?number, sumFiniteF64: ?number,
 *   }>,
 * }}
 */
export function parseLas(text) {
  const sections = splitSections(text);

  const find = (prefix) => sections.filter((s) => s.title.toUpperCase().startsWith(prefix));

  const vSec = find('~V')[0];
  if (!vSec) throw new Error('No ~Version section — LAS files must declare VERS and WRAP.');
  const versionItems = parseHeaderSection(vSec);
  const vers = versionItems.VERS ? versionItems.VERS.value : null;
  if (typeof vers !== 'number') {
    throw new Error('The ~Version section has no readable VERS line.');
  }
  if (vers >= 3.0) {
    throw new Error(`LAS ${vers} is not supported — export the file as LAS 2.0 and re-import.`);
  }
  const wrap = versionItems.WRAP ? String(versionItems.WRAP.value).toUpperCase() : 'NO';

  const wSec = find('~W')[0];
  if (!wSec) throw new Error('No ~Well section.');
  const well = parseHeaderSection(wSec, { isWell: true, version: vers });
  const nullValue = (well.NULL && typeof well.NULL.value === 'number')
    ? well.NULL.value : null;

  const cSec = find('~C')[0];
  if (!cSec) throw new Error('No ~Curve section — cannot tell which curves the data columns are.');
  const curveDefs = [];
  for (const { text: lineText, lineNo } of cSec.lines) {
    const raw = parseHeaderLine(lineText);
    if (!raw || !raw.name) {
      throw new Error(`Line ${lineNo}: cannot parse curve definition "${lineText.trim()}".`);
    }
    curveDefs.push({
      mnemonic: raw.name.toUpperCase(),
      unit: raw.unit,
      descr: raw.descr,
      apiValue: raw.value,
    });
  }
  if (!curveDefs.length) throw new Error('The ~Curve section defines no curves.');
  // lasio-style duplicate handling: every occurrence of a repeated
  // mnemonic gets a :1, :2, ... suffix (including the first).
  const counts = {};
  for (const c of curveDefs) counts[c.mnemonic] = (counts[c.mnemonic] || 0) + 1;
  const seen = {};
  for (const c of curveDefs) {
    if (counts[c.mnemonic] > 1) {
      seen[c.mnemonic] = (seen[c.mnemonic] || 0) + 1;
      c.mnemonic = `${c.mnemonic}:${seen[c.mnemonic]}`;
    }
  }

  const pSec = find('~P')[0];
  const params = pSec ? parseHeaderSection(pSec) : {};
  const oSec = find('~O')[0];
  const other = oSec
    ? oSec.lines.map((l) => l.text.trim()).join('\n')
    : '';

  const aSecs = find('~A');
  if (!aSecs.length) throw new Error('No ~ASCII data section.');
  if (aSecs.length > 1) throw new Error('More than one ~ASCII data section — file is corrupt or concatenated.');
  const flat = readDataSection(aSecs[0], nullValue);
  const nCurves = curveDefs.length;
  if (flat.length === 0) throw new Error('The ~ASCII data section has no samples.');
  if (flat.length % nCurves !== 0) {
    throw new Error(`The data section has ${flat.length} values, not a multiple of the `
      + `${nCurves} curves declared in ~Curve — a ragged or truncated file.`);
  }
  const nSamples = flat.length / nCurves;

  const curves = curveDefs.map((def, ci) => {
    const data = new Float32Array(nSamples);
    for (let r = 0; r < nSamples; r++) data[r] = flat[r * nCurves + ci];
    let nullCount = 0;
    let firstFinite = null;
    let lastFinite = null;
    let sum = 0;
    let any = false;
    for (let r = 0; r < nSamples; r++) {
      const v = data[r];
      if (Number.isFinite(v)) {
        if (!any) { firstFinite = v; any = true; }
        lastFinite = v;
        sum += v;                       // sequential f64 accumulation
      } else {
        nullCount++;
      }
    }
    return {
      ...def, data, nSamples, nullCount,
      firstFinite, lastFinite,
      sumFiniteF64: any ? sum : null,
    };
  });

  return {
    version: vers,
    wrap,
    nullValue,
    well,
    params,
    other,
    depthUnit: curves[0].unit || '',
    curves,
  };
}
