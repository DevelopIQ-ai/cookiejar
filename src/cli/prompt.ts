import readline from 'node:readline/promises';
import { Writable } from 'node:stream';

/** Asks a question on the terminal. Returns '' when stdin is not interactive. */
export async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Asks for a secret, echoing nothing. */
export async function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  const answer = rl.question(question);
  muted = true;
  try {
    return await answer;
  } finally {
    muted = false;
    rl.close();
    process.stdout.write('\n');
  }
}

export async function confirm(question: string): Promise<boolean> {
  const answer = await ask(`${question} [y/N] `);
  return /^y(es)?$/i.test(answer);
}
