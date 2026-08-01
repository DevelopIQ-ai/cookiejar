#!/usr/bin/env node
// tsc only emits JS, so the UI page and the agent SKILL.md are copied into dist
// alongside it. Both are resolved relative to the compiled files at runtime.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const asset of ['ui/index.html', 'skill/SKILL.md']) {
  const from = path.join(root, 'src', asset);
  const to = path.join(root, 'dist', asset);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`copied ${asset}`);
}
