export interface AppState {
  vaultExists: boolean;
  unlocked: boolean;
  platform: string;
  autoLockMinutes: number;
}

export interface Profile {
  id: string;
  browser: string;
  label: string;
  path: string;
  cookieCount: number;
  siteCount: number;
}

export interface BlockedProfile {
  id: string;
  browser: string;
  label: string;
  error: string;
  /** A fix the UI knows how to walk the user through. */
  fix: 'full-disk-access' | null;
}

export interface ProfilesResponse {
  profiles: Profile[];
  blocked: BlockedProfile[];
  emptyCount: number;
  safari: 'ok' | 'blocked' | 'absent';
}

export interface Onboarding {
  preferences: { browsers: string[]; onboardedAt: string | null };
  installed: string[];
  safari: 'ok' | 'blocked' | 'absent';
  platform: string;
}

export interface Site {
  site: string;
  cookieCount: number;
  profileIds: string[];
  expiring: number;
}

export interface CookieMeta {
  name: string;
  domain: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  profileId: string;
  browser: string;
  valueLength: number;
}

export interface Selector {
  profileId: string;
  domain: string;
  names: string[];
}

export interface Grant {
  id: string;
  tokenHash: string;
  label: string;
  createdAt: string;
  expiresAt: number;
  allowFetch: boolean;
  redactValues: boolean;
  lastUsedAt: string | null;
  useCount: number;
  revokedAt: string | null;
}

export interface Bundle {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  selectors: Selector[];
  grants: Grant[];
}

export interface AuditEntry {
  at: string;
  event: string;
  bundleId?: string;
  grantLabel?: string;
  detail?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const message = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : text;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  state: () => request<AppState>('/api/state'),
  createVault: (password: string) => post<{ ok: true }>('/api/vault/create', { password }),
  unlock: (password: string) => post<{ ok: true }>('/api/vault/unlock', { password }),
  lock: () => post<{ ok: true }>('/api/vault/lock'),
  changePassword: (current: string, next: string) => post<{ ok: true }>('/api/vault/password', { current, next }),
  profiles: () => request<ProfilesResponse>('/api/profiles'),
  onboarding: () => request<Onboarding>('/api/onboarding'),
  saveOnboarding: (browsers: string[], done: boolean) =>
    post<{ preferences: Onboarding['preferences'] }>('/api/onboarding', { browsers, done }),
  sites: (profileIds: string[], q: string) => {
    const params = new URLSearchParams();
    for (const id of profileIds) params.append('profileId', id);
    if (q) params.set('q', q);
    return request<{ sites: Site[]; errors: Array<{ profileId: string; error: string }> }>(`/api/sites?${params}`);
  },
  cookies: (site: string, profileIds: string[]) => {
    const params = new URLSearchParams({ site });
    for (const id of profileIds) params.append('profileId', id);
    return request<{ cookies: CookieMeta[] }>(`/api/cookies?${params}`);
  },
  bundles: () => request<{ bundles: Bundle[] }>('/api/bundles'),
  createBundle: (body: { name: string; description?: string; selectors: Selector[] }) =>
    post<{ bundle: Bundle }>('/api/bundles', body),
  updateBundle: (id: string, body: { name?: string; description?: string; selectors?: Selector[] }) =>
    request<{ bundle: Bundle }>(`/api/bundles/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteBundle: (id: string) => request<{ ok: true }>(`/api/bundles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  preview: (id: string) =>
    request<{ cookies: CookieMeta[]; emptySelectors: Selector[]; errors: Array<{ profileId: string; error: string }> }>(
      `/api/bundles/${encodeURIComponent(id)}/preview`,
    ),
  createGrant: (id: string, body: { label: string; expiresInDays?: number; allowFetch: boolean; redactValues: boolean }) =>
    post<{ token: string; grant: Grant }>(`/api/bundles/${encodeURIComponent(id)}/grants`, body),
  revokeGrant: (bundleId: string, grantId: string) =>
    request<{ ok: true }>(`/api/bundles/${encodeURIComponent(bundleId)}/grants/${grantId}`, { method: 'DELETE' }),
  audit: () => request<{ entries: AuditEntry[] }>('/api/audit'),
};
