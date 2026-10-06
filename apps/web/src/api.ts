const KEY = 'aimob.session';

export interface SessionUser { id: string; name: string; role: string }
interface Stored { token: string; user: SessionUser }

export function getSession(): Stored | null {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? 'null'); } catch { return null; }
}
export function setSession(s: Stored | null) {
  try { s ? sessionStorage.setItem(KEY, JSON.stringify(s)) : sessionStorage.removeItem(KEY); } catch { /* storage indisponível */ }
}

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const s = getSession();
  const res = await fetch(path, {
    ...init,
    // content-type só com corpo: o servidor rejeita JSON declarado com corpo vazio.
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(s ? { authorization: `Bearer ${s.token}` } : {}), ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/auth/login') { setSession(null); location.assign('/login'); }
  if (!res.ok) throw new ApiError(body.error ?? 'Não conseguimos concluir esta ação agora.', res.status);
  return body as T;
}

export const brl = (cents: number | string | null | undefined) =>
  cents == null ? '—' : (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
