import readline from 'node:readline/promises';
import { Writable } from 'node:stream';

/**
 * Asks a question on the terminal. Piped answers work too, so these commands
 * can be scripted; an empty stdin just takes the default.
 */
export async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  try {
    const answered = rl.question(question);
    const endOfInput = new Promise<string>((resolve) => rl.once('close', () => resolve('')));
    return (await Promise.race([answered, endOfInput])).trim();
  } finally {
    rl.close();
    if (!process.stdin.isTTY) process.stdin.pause();
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
