import { spawnSync } from 'node:child_process';

type ClipboardWriter = (command: string, args: readonly string[], text: string) => boolean;

const writeToSystemClipboard: ClipboardWriter = (command, args, text) =>
  spawnSync(command, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] }).status === 0;

/**
 * Copy text without adding a dependency just to reach the operating system's
 * native clipboard. Returning false is intentional: lending still works in a
 * headless shell, where the printed command remains the fallback.
 */
export function copyToClipboard(text: string, write: ClipboardWriter = writeToSystemClipboard): boolean {
  const commands =
    process.platform === 'darwin'
      ? [['pbcopy', []] as const]
      : process.platform === 'win32'
        ? [['clip', []] as const]
        : [
            ['wl-copy', []] as const,
            ['xclip', ['-selection', 'clipboard']] as const,
          ];

  for (const [command, args] of commands) {
    if (write(command, args, text)) return true;
  }
  return false;
}

/** The whole command is safer to paste than a bare connect string. */
export function connectCommand(connectString: string): string {
  return `npx -y @puffle/cookiejar connect '${connectString}'`;
}
