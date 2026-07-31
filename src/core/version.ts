import fs from 'node:fs';

/** Resolves the same from `src/` and the built `dist/`, so nothing hardcodes a version. */
export const VERSION = (
  JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
