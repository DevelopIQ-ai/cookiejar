import assert from 'node:assert/strict';
import test from 'node:test';
import { connectCommand, copyToClipboard } from '../src/cli/clipboard.js';

test('lending copies the complete borrower command, not a bare connection string', () => {
  const connection = 'cjr1.a-test-connection';
  const command = connectCommand(connection);
  let copied = '';

  const didCopy = copyToClipboard(command, (_binary, _args, text) => {
    copied = text;
    return true;
  });

  assert.equal(didCopy, true);
  assert.equal(copied, `npx -y @puffle/cookiejar connect '${connection}'`);
});
