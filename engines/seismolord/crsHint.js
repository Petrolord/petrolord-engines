// CRS hints from the SEG-Y textual header. The playbook rule stands: the
// textual header lies, so nothing here is ever auto-committed — hints only
// prefill the import panel's CRS picker, always quoting the exact line
// they came from so the user can judge the source.
//
// Recognized evidence, strongest first: an explicit EPSG code; a UTM zone
// plus a datum keyword (composed into the catalog code for that family);
// a UTM zone alone (offered as WGS 84 with reduced confidence); a datum
// keyword alone (named, no code). Unit keywords are reported separately
// so the import panel can cross-check the declared XY unit.

import { catalogGet } from '../../lib/crs/catalog';

const DATUMS = [
  { key: 'WGS84', re: /\bWGS[\s-]*(?:19)?84\b/i, utmBase: 32600, utmSouthBase: 32700 },
  { key: 'ED50', re: /\bED[\s-]*50\b|\bEUROPEAN\s+DATUM\s+(?:19)?50\b/i, utmBase: 23000 },
  { key: 'NAD27', re: /\bNAD[\s-]*27\b|\bNORTH\s+AMERICAN\s+(?:DATUM\s+)?(?:19)?27\b/i, utmBase: 26700 },
  { key: 'MINNA', re: /\bMINNA\b|\bCLARKE\s*1880\b/i, utmBase: 26300 },
  { key: 'OSGB36', re: /\bOSGB[\s-]*36\b|\bORDNANCE\s+SURVEY\b/i },
];

const UNITS = [
  { unit: 'm', re: /\bMET(?:RE|ER)S?\b/i },
  { unit: 'ftUS', re: /\bUS\s+(?:SURVEY\s+)?F(?:EE|OO)T\b/i },
  { unit: 'ft', re: /\bF(?:EE|OO)T\b|\bFT\b/i },
];

function pushUnique(list, hint) {
  if (!list.some((h) => h.code === hint.code && h.kind === hint.kind)) list.push(hint);
}

/**
 * Scan textual-header lines for CRS evidence.
 *
 * @param {string[]} lines the 40 decoded header lines
 * @returns {{suggestions:{code:string|null, name:string|null, kind:string,
 *   confidence:number, line:string, match:string}[],
 *   unitHints:{unit:string, line:string, match:string}[]}}
 *   suggestions sorted by confidence, catalog-known codes resolved to
 *   names; code null when only a datum was recognized
 */
export function crsHintsFromText(lines) {
  const suggestions = [];
  const unitHints = [];

  for (const raw of lines || []) {
    const line = String(raw || '');

    const epsg = line.match(/\bEPSG\s*[:#\s]\s*(\d{4,5})\b/i);
    if (epsg) {
      const code = `EPSG:${epsg[1]}`;
      const entry = catalogGet(code);
      pushUnique(suggestions, {
        code,
        name: entry ? entry.name : null,
        kind: 'epsg',
        confidence: entry ? 0.9 : 0.6,
        line: line.trim(),
        match: epsg[0],
      });
    }

    const utm = line.match(/\bUTM\b.{0,20}?\bZONE?\s*[:#\s]?\s*(\d{1,2})\s*([NS])?\b/i)
      || line.match(/\bZONE?\s*[:#\s]?\s*(\d{1,2})\s*([NS])?\b.{0,20}?\bUTM\b/i);
    if (utm) {
      const zone = Number(utm[1]);
      const south = (utm[2] || 'N').toUpperCase() === 'S';
      if (zone >= 1 && zone <= 60) {
        const datum = DATUMS.find((d) => d.utmBase && d.re.test(line));
        if (datum && !(south && !datum.utmSouthBase)) {
          const code = `EPSG:${(south ? datum.utmSouthBase : datum.utmBase) + zone}`;
          const entry = catalogGet(code);
          pushUnique(suggestions, {
            code,
            name: entry ? entry.name : null,
            kind: 'utm-datum',
            confidence: entry ? 0.7 : 0.4,
            line: line.trim(),
            match: utm[0],
          });
        } else {
          const code = `EPSG:${(south ? 32700 : 32600) + zone}`;
          const entry = catalogGet(code);
          pushUnique(suggestions, {
            code,
            name: entry ? entry.name : null,
            kind: 'utm-only',
            confidence: 0.5,
            line: line.trim(),
            match: utm[0],
          });
        }
      }
    }

    for (const d of DATUMS) {
      const m = line.match(d.re);
      if (m) {
        pushUnique(suggestions, {
          code: null,
          name: d.key,
          kind: 'datum-only',
          confidence: 0.3,
          line: line.trim(),
          match: m[0],
        });
      }
    }

    for (const u of UNITS) {
      const m = line.match(u.re);
      if (m) {
        if (!unitHints.some((h) => h.unit === u.unit)) {
          unitHints.push({ unit: u.unit, line: line.trim(), match: m[0] });
        }
        break;
      }
    }
  }

  // Datum-only rows that a composed suggestion already explains are noise.
  const composed = suggestions.filter((s) => s.code);
  const filtered = suggestions.filter((s) => s.code || !composed.length);
  filtered.sort((a, b) => b.confidence - a.confidence);
  return { suggestions: filtered, unitHints };
}
