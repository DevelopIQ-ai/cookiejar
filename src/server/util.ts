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

export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const alt = req.headers['x-cookiejar-token'];
  return typeof alt === 'string' && alt ? alt : undefined;
}
