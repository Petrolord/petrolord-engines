/**
 * Every relative import in a TypeScript engine must carry its file extension.
 *
 * Supabase Edge Functions bundle with Deno, which does NOT resolve
 * `'../fluid/blackOil'` to `blackOil.ts`. Jest (babel) and Vite both do, so an
 * extensionless import passes every test and every build here and fails only at
 * `supabase functions deploy`, with "failed to create the graph / Module not
 * found". That is the worst place to find out: the deploy is the step that
 * carries engine work to users, and until it succeeds the live edge function
 * keeps running an older bundle while the repo looks correct.
 *
 * Found 2026-09-11, when `calculate-mbal` would not deploy because
 * mbalEngine.ts imported '../fluid/blackOil' (extensionless since the fluid
 * extraction on 2026-08-28).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
};

// `from '...'` and `import('...')`, capturing only relative specifiers.
const SPECIFIER = /(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"]*)['"]/g;
const HAS_EXTENSION = /\.(ts|js|mjs|cjs|json)$/;

describe('Deno-compatible import specifiers', () => {
  const files = walk(ROOT);

  it('finds engine sources to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every relative import in a .ts file carries its extension', () => {
    const offenders = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const match of src.matchAll(SPECIFIER)) {
        if (!HAS_EXTENSION.test(match[1])) {
          const line = src.slice(0, match.index).split('\n').length;
          offenders.push(`${path.relative(ROOT, file)}:${line} → '${match[1]}'`);
        }
      }
    }
    // Named rather than counted, so a failure says exactly what to fix.
    expect(offenders).toEqual([]);
  });
});
