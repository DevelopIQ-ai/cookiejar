/**
 * Handing a bundle to a real browser.
 *
 * Fetching a URL only gets an agent so far: anything that needs a click, a form
 * or JavaScript wants Playwright. Playwright takes a `storageState` file, so the
 * handoff is that file — written 0600 under the cookiejar home, containing real
 * cookie values, which is why it only ever happens locally and never for a lent
 * bundle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exportCookies, hostsOf } from './agent.js';
import { ensureConfigDir } from './paths.js';
import type { Bundle } from './types.js';

export const browserStatePath = (bundle: Bundle): string =>
  path.join(ensureConfigDir(), `browser-${bundle.id}.json`);

export function writeBrowserState(bundle: Bundle, file?: string): string {
  const target = file ?? browserStatePath(bundle);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, exportCookies(bundle, 'storage-state'), { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return target;
}

/** A runnable script, because "use storageState" is not instructions. */
export function playwrightSnippet(bundle: Bundle, file: string): string {
  const host = hostsOf(bundle)[0] ?? 'example.com';
  return `import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: ${JSON.stringify(file)} });
const page = await context.newPage();
await page.goto('https://${host}/');       // already signed in
console.log(await page.title());
await browser.close();`;
}
