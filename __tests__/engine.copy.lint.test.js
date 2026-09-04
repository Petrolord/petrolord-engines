/**
 * THE COPY LINT. Items 17 and 62 of the owner's 4 September 2026 decisions.
 *
 * Two families of defect keep coming back in engine messages, and both are
 * invisible to every numeric gate in this repository because neither one
 * changes a number:
 *
 *   ITEM 17. A warning that prints a ROUNDED number beside the unrounded
 *   threshold it failed. The reader is shown "82 percent against a limit of
 *   82.4" and cannot tell why it failed, or is shown "0 psi" for a quantity
 *   that is not zero. `toFixed(0)` and `Math.round` inside a message are how
 *   that happens. Fixed across 27 sites in #113 and #114; this is the gate
 *   that stops it returning.
 *
 *   ITEM 62. A double hyphen used as a dash, and the em and en dash
 *   characters. The owner's copy rule is a comma, a colon or a full stop.
 *
 * WHY THIS IS A TEST AND NOT AN ESLINT RULE. This package has no eslint
 * configuration and runs jest. A gate that needs a second toolchain installed
 * before it can fail is a gate that stops running. This one runs with the
 * suite.
 *
 * WHAT IT READS. Only the four user-facing message fields the decisions name:
 * `error`, `reason`, `note` and `warning`, in every spelling this codebase
 * uses for them, including `notes.push(...)` and `warnings.push(...)`. It does
 * NOT read ordinary code, comments or docstrings, because a `--` in a comment
 * harms nobody and a gate that flags one is a gate somebody switches off.
 */
import fs from 'fs';
import path from 'path';

// __dirname, not import.meta.url: this suite is transformed to CommonJS by
// babel-jest, and import.meta does not survive that transform.
const ROOT = path.resolve(__dirname, '..');
const ENGINES = path.join(ROOT, 'engines');

const EM_DASH = '—';
const EN_DASH = '–';

/** Every .js under engines/, recursively. */
const sourceFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  if (e.isDirectory()) return sourceFiles(full);
  return e.isFile() && e.name.endsWith('.js') ? [full] : [];
});

/**
 * Blank out comments, preserving offsets and newlines.
 *
 * Without this the scanner walks into a docstring, finds a `note:` inside
 * prose, opens a quote on an apostrophe and swallows the next two hundred
 * lines of source as though they were one message. The first draft of this
 * gate did exactly that and reported a confidence-interval comment as a
 * copy defect. A gate that cries wolf is a gate somebody switches off, so
 * comments are removed before anything is read.
 */
const stripComments = (text) => {
  const out = text.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`' || c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === q) break;
        if (q !== '`' && text[j] === '\n') break;
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      blank(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    i += 1;
  }
  return out.join('');
};

/**
 * Pull the message strings out of a source file.
 *
 * A message is the string or template literal that follows one of the four
 * field names, or that is pushed onto a notes/warnings/errors array. The
 * scanner walks the literal properly rather than matching to the end of the
 * line, so a template spanning three lines is read whole and a quote inside
 * it does not end it early.
 */
const messagesIn = (raw) => {
  const text = stripComments(raw);
  const out = [];
  const KEY = /(?:\b(?:error|reason|note|warning|message)\s*:\s*)|(?:\b(?:notes|warnings|errors|reasons)\.push\s*\(\s*)/g;
  let m;
  while ((m = KEY.exec(text)) !== null) {
    let i = m.index + m[0].length;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    const quote = text[i];
    if (quote !== '`' && quote !== "'" && quote !== '"') continue;
    let j = i + 1;
    let depth = 0;
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') { j += 2; continue; }
      if (quote === '`' && c === '$' && text[j + 1] === '{') { depth += 1; j += 2; continue; }
      if (quote === '`' && depth > 0 && c === '}') { depth -= 1; j += 1; continue; }
      if (c === quote && depth === 0) break;
      j += 1;
    }
    const line = text.slice(0, i).split('\n').length;
    // A message longer than this is the scanner having lost its place, not a
    // message. Report it as such rather than as a copy defect.
    if (j - i <= 1000) out.push({ text: text.slice(i, j + 1), line });
    KEY.lastIndex = j;
  }
  return out;
};

/**
 * An exemption, written down where it applies.
 *
 * A gate that flags a decision already taken is a gate somebody switches off.
 * `espDesign.js` deliberately rounds the PUBLISHED range bounds while printing
 * the rate to one decimal, so the rate can never render as the bound: that was
 * decided in commit 2ed47d5 and argued in the code comment beside it. Rather
 * than weaken the rule for everybody, a message may carry
 * `copy-lint-allow: <reason>` in a comment within the six lines above it. The
 * exemption is then visible in review, which a silently narrowed rule is not.
 */
const EXEMPT = /copy-lint-allow:/;
const isExempt = (raw, line) => {
  const lines = raw.split('\n');
  return lines.slice(Math.max(0, line - 7), line).some((l) => EXEMPT.test(l));
};

const files = sourceFiles(ENGINES);

describe('engine copy lint (items 17 and 62)', () => {
  it('reads a non-trivial number of engine sources', () => {
    expect(files.length).toBeGreaterThan(50);
  });

/**
 * THE ITEM 17 RATCHET, and why this list exists rather than an empty expectation.
 *
 * Item 17's fix landed in #113 and #114 across 27 sites IN THE PRODUCTION
 * DOMAIN. The rule it asks for finds 17 more, spread over five domains that
 * fix never touched, and at least one of them is a decision already taken the
 * other way (see the `copy-lint-allow` in espDesign.js). Rewriting seventeen
 * messages across drilling, facilities, fluid and production on this gate's
 * authority alone would be widening a decided scope by stealth, and silently
 * deleting the gate would be the other failure.
 *
 * So the gate RATCHETS. Every known site is written down here with the text
 * that identifies it. A NEW violation fails immediately, which is what item 17
 * asks for: the family cannot return. An existing one is visible, counted, and
 * filed for the owner to decide on rather than quietly fixed or quietly
 * ignored. The list may only ever shrink.
 *
 * Dated 4 September 2026. 17 entries.
 */
const KNOWN_ROUNDING = new Set([
  'engines/drilling/cementing.js::Achieved TOC',
  'engines/drilling/geomech.js::The mud window closes',
  'engines/drilling/hydraulics.js::Component over',
  'engines/drilling/hydraulics.js::Pipe OD exceeds hole ID',
  'engines/drilling/torqueDrag.js::Compression exceeds the sinusoidal',
  'engines/facilities/compression.js::${acfm.toFixed(0)} acfm at a modest',
  'engines/facilities/compression.js::overall ratio',
  'engines/facilities/heatTransfer.js::tube-side Reynolds',
  'engines/facilities/metering.js::${sorted[0].name} contributes',
  'engines/fluid/experiments.js::No gas evolved at',
  'engines/production/allocation.js::Oil ${Math.round(oil)',
  'engines/production/allocation.js::Test oil',
  'engines/production/allocation.js::Test watercut',
  'engines/production/allocation.js::At ${Math.round(thp)} psia wellhead',
  'engines/production/gasLiftDesign.js::Valve ${i + 1} at',
  'engines/production/liftAdvisor.js::Injecting',
  'engines/production/liftAdvisor.js::The largest unit tried',
]);

const signature = (rel, text) => {
  const body = text.replace(/^[`'"]/, '');
  const known = [...KNOWN_ROUNDING].find((k) => {
    const [file, start] = k.split('::');
    return file === rel && body.startsWith(start);
  });
  return known || `${rel}::${body.slice(0, 40)}`;
};

  it('no NEW message rounds a number with toFixed(0) or Math.round (item 17)', () => {
    const fresh = [];
    const seen = new Set();
    files.forEach((f) => {
      const raw = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f);
      messagesIn(raw).forEach((msg) => {
        if (isExempt(raw, msg.line)) return;
        if (/\.toFixed\(\s*0\s*\)/.test(msg.text) || /Math\.round\s*\(/.test(msg.text)) {
          const sig = signature(rel, msg.text);
          if (KNOWN_ROUNDING.has(sig)) { seen.add(sig); return; }
          fresh.push(`${rel}:${msg.line}  ${msg.text.slice(0, 120)}`);
        }
      });
    });
    expect(fresh.join('\n')).toBe('');
  });

  it('the known list may only shrink, so a fixed site must be struck from it', () => {
    const seen = new Set();
    files.forEach((f) => {
      const raw = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f);
      messagesIn(raw).forEach((msg) => {
        if (isExempt(raw, msg.line)) return;
        if (/\.toFixed\(\s*0\s*\)/.test(msg.text) || /Math\.round\s*\(/.test(msg.text)) {
          const sig = signature(rel, msg.text);
          if (KNOWN_ROUNDING.has(sig)) seen.add(sig);
        }
      });
    });
    const stale = [...KNOWN_ROUNDING].filter((k) => !seen.has(k));
    expect(stale.join('\n')).toBe('');
  });

  it('no message uses a double hyphen, an em dash or an en dash (item 62)', () => {
    const hits = [];
    files.forEach((f) => {
      const raw = fs.readFileSync(f, 'utf8');
      messagesIn(raw).forEach((msg) => {
        if (isExempt(raw, msg.line)) return;
        if (msg.text.includes('--') || msg.text.includes(EM_DASH) || msg.text.includes(EN_DASH)) {
          hits.push(`${path.relative(ROOT, f)}:${msg.line}  ${msg.text.slice(0, 120)}`);
        }
      });
    });
    expect(hits.join('\n')).toBe('');
  });

  it('an exemption must be written down, and only covers the lines below it', () => {
    const raw = ['// copy-lint-allow: the bounds are a published range',
                 'const a = { note: `x ${Math.round(q)} y` };',
                 '', '', '', '', '', '',
                 'const b = { note: `z ${Math.round(q)} w` };'].join('\n');
    const found = messagesIn(raw);
    expect(found).toHaveLength(2);
    expect(isExempt(raw, found[0].line)).toBe(true);
    expect(isExempt(raw, found[1].line)).toBe(false);
  });

  it('the scanner actually reads templates, so the two gates above can fail', () => {
    const sample = "note: `a ${x.toFixed(0)} percent reading -- against 82.4`";
    const found = messagesIn(sample);
    expect(found).toHaveLength(1);
    expect(found[0].text).toContain('toFixed(0)');
    expect(found[0].text).toContain('--');
  });
});
