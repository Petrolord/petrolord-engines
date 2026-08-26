// Eclipse-deck text primitives for the sim deck generators (S3 of the
// Reservoir Simulation Studio program). Pure string shaping: numbers are
// formatted compactly, runs of equal values compress to Eclipse N*value
// repeats, and every record ends with the slash the format requires.
//
// The emitters in this domain are deliberately dumb serializers: physics
// stays in the fluid/scal/mbal engines, unit choices are the caller's
// (FIELD units throughout the Suite composer), and the OPM Flow worker
// re-validates every generated deck exactly like an uploaded one.

/** Compact numeric token: up to `digits` decimals, trailing zeros trimmed. */
export function fmt(value, digits = 6) {
  if (value == null || !Number.isFinite(Number(value))) {
    throw new Error(`deckFormat.fmt: non-finite value ${value}`);
  }
  const n = Number(value);
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  let s = n.toFixed(digits);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  // Very small magnitudes lose everything to toFixed — fall back to
  // exponential so compressibilities survive.
  if ((s === '0' || s === '-0') && n !== 0) s = n.toExponential(4);
  return s;
}

/** Eclipse repeat compression: [1,1,1,2] -> "3*1 2". */
export function starRepeat(values, digits = 6) {
  const tokens = values.map((v) => fmt(v, digits));
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    let j = i;
    while (j + 1 < tokens.length && tokens[j + 1] === tokens[i]) j += 1;
    const count = j - i + 1;
    out.push(count > 1 ? `${count}*${tokens[i]}` : tokens[i]);
    i = j + 1;
  }
  return out.join(' ');
}

/** One data record line: tokens joined, terminated by " /". */
export function record(tokens) {
  return `  ${tokens.join(' ')} /`;
}

/** Keyword block: KEYWORD + body lines + optional terminating slash. */
export function block(keyword, lines, { close = false } = {}) {
  const body = Array.isArray(lines) ? lines : [lines];
  return [keyword, ...body, ...(close ? ['/'] : []), ''].join('\n');
}

/** Wrap long value streams at ~70 chars for readable decks. */
export function wrap(text, width = 70) {
  const words = text.split(' ');
  const lines = [];
  let line = ' ';
  for (const w of words) {
    if (line.length + w.length + 1 > width && line.trim()) {
      lines.push(line);
      line = ' ';
    }
    line += ` ${w}`;
  }
  if (line.trim()) lines.push(line);
  return lines.join('\n');
}
