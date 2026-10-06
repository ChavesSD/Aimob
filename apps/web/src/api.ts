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
  // 401 numa rota comum = sessão expirada. Nas rotas de autenticação (login, código MFA) 401 é "credencial incorreta":
  // o erro precisa aparecer na própria tela, sem recarregar.
  if (res.status === 401 && !path.startsWith('/api/auth/')) { setSession(null); location.assign('/login'); }
  if (!res.ok) throw new ApiError(body.error ?? 'Não conseguimos concluir esta ação agora.', res.status);
  return body as T;
}

export const brl = (cents: number | string | null | undefined) =>
  cents == null ? '—' : (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

/** Baixa um arquivo que exige autenticação (o link direto não carrega o cabeçalho Authorization). */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const s = getSession();
  const res = await fetch(path, { headers: s ? { authorization: `Bearer ${s.token}` } : {} });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? 'Não conseguimos gerar o arquivo agora.', res.status);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Envia um arquivo (multipart). O navegador define o cabeçalho com o limite do corpo; não defina content-type à mão. */
export async function uploadFile<T = unknown>(path: string, file: File): Promise<T> {
  const s = getSession();
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(path, { method: 'POST', body: form, headers: s ? { authorization: `Bearer ${s.token}` } : {} });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? 'Não conseguimos enviar o arquivo agora.', res.status);
  return body as T;
}
