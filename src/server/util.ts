import type { IncomingMessage, ServerResponse } from 'node:http';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export async function readJsonBody<T>(req: IncomingMessage, limitBytes = 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const alt = req.headers['x-cookiejar-token'];
  return typeof alt === 'string' && alt ? alt : undefined;
}

/**
 * The server only listens on loopback, but a page in the user's browser could
 * still POST to it, so require same-origin for state-changing UI requests.
 */
export function originAllowed(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // curl, agents, and same-origin GETs
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
  // Vite's dev server proxies from its own port during `npm run dev`.
  if (process.env.COOKIEJAR_DEV_ORIGIN) allowed.add(process.env.COOKIEJAR_DEV_ORIGIN);
  return allowed.has(origin);
}
