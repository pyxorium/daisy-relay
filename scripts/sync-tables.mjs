// Copies the relay's rules from C:\thunderbird-cafe\daisy-tiles\relay\tables.js (the one source, also used
// by the stand-in relay) into this folder, so the deployed relay runs exactly the same rules.
// Run after changing tables.js in daisy-tiles:  npm run sync   (then npm test, commit, fly deploy --ha=false)
//   --check  only reports whether the copy matches (exit code 1 if not).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
export const SOURCE = join(HERE, '..', 'daisy-tiles', 'relay', 'tables.js');
export const COPY = join(HERE, 'tables.js');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!existsSync(SOURCE)) { console.error(`Not found: ${SOURCE} (daisy-tiles should sit beside this folder)`); process.exit(1); }
  const src = readFileSync(SOURCE);
  const same = existsSync(COPY) && Buffer.compare(src, readFileSync(COPY)) === 0;
  if (process.argv.includes('--check')) {
    console.log(same ? 'tables.js matches daisy-tiles.' : 'tables.js differs from daisy-tiles: run npm run sync.');
    process.exit(same ? 0 : 1);
  }
  if (same) console.log('tables.js already matches daisy-tiles.');
  else { writeFileSync(COPY, src); console.log('Copied tables.js from daisy-tiles. Run npm test, then commit and deploy.'); }
}
