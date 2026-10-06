import { useState, type FormEvent } from 'react';
import { api, getSession } from '../api';
import { useApi } from '../hooks';
import { ErrorBox, Skeleton } from '../ui';

interface Me { name: string; role: string; mfaEnabled: boolean; mfaRequired?: boolean; mfaPolicy?: string }
interface Setup { secret: string; qrDataUrl: string }

export default function Security() {
  const me = useApi<Me>('/api/me');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState('');

  async function start() {
    setErr(null);
    try { setSetup(await api<Setup>('/api/auth/mfa/setup', { method: 'POST' })); } catch (e: any) { setErr(e.message); }
  }
  async function enable(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try {
      const r = await api<{ recoveryCodes: string[] }>('/api/auth/mfa/enable', { method: 'POST', body: JSON.stringify({ code: code.trim() }) });
      setRecovery(r.recoveryCodes); setSetup(null); setCode(''); me.reload();
    } catch (e: any) { setErr(e.message); }
  }
  async function disable(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try {
      await api('/api/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ password, code: code.trim() }) });
      setMsg('Verificação em duas etapas desativada.'); setDisabling(false); setPassword(''); setCode(''); me.reload();
    } catch (e: any) { setErr(e.message); }
  }

  if (me.loading && !me.data) return <Skeleton rows={3} />;
  if (me.error || !me.data) return <ErrorBox message={me.error ?? ''} onRetry={me.reload} />;

  return (
    <>
      <h1>Segurança da conta</h1>
      <p className="sub">Proteja o acesso com um segundo fator: além da senha, é preciso um código do seu celular.</p>
      {msg && <div className="alert baixa" role="status">{msg}</div>}
      {!me.data.mfaEnabled && (me.data.mfaRequired || new URLSearchParams(location.search).has('obrigatorio')) && (
        <div className="alert alta" role="alert"><div><strong>Sua imobiliária exige verificação em duas etapas.</strong> Ative-a abaixo para voltar a usar o sistema: até lá, as outras telas ficam bloqueadas.</div></div>
      )}
      {err && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{err}</div>}

      {recovery && (
        <section className="card" style={{ borderColor: 'var(--gold)', marginBottom: 16 }} aria-labelledby="rec">
          <h2 id="rec" style={{ marginTop: 0, fontSize: 16 }}>Guarde seus códigos de recuperação</h2>
          <p>Cada código funciona uma única vez e só é mostrado agora. Se perder o celular, são a única forma de entrar. Guarde-os em local seguro, fora do computador.</p>
          <pre style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 8, columns: 2, margin: 0 }}>{recovery.join('\n')}</pre>
          <button className="btn" style={{ marginTop: 12 }} onClick={() => setRecovery(null)}>Já guardei os códigos</button>
        </section>
      )}

      <section className="card" aria-labelledby="mfa">
        <h2 id="mfa" style={{ marginTop: 0, fontSize: 16 }}>Verificação em duas etapas: {me.data.mfaEnabled ? 'ativa' : 'desativada'}</h2>

        {!me.data.mfaEnabled && !setup && (
          <>
            <p>Use um aplicativo como Google Authenticator, Microsoft Authenticator, Authy ou 1Password.</p>
            <button className="btn gold" onClick={start}>Ativar verificação em duas etapas</button>
          </>
        )}

        {setup && (
          <form onSubmit={enable}>
            <ol>
              <li>No aplicativo, escaneie o QR code (ou digite a chave manualmente).</li>
              <li>Digite abaixo o código de 6 dígitos que o aplicativo mostrar.</li>
            </ol>
            <img src={setup.qrDataUrl} alt="QR code para configurar o aplicativo autenticador" width={220} height={220} style={{ background: '#fff', borderRadius: 8 }} />
            <p>Chave manual: <code style={{ wordBreak: 'break-all' }}>{setup.secret}</code></p>
            <label htmlFor="c">Código de 6 dígitos</label>
            <div style={{ display: 'flex', gap: 8, maxWidth: 320 }}>
              <input id="c" required inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
              <button className="btn gold">Ativar</button>
            </div>
          </form>
        )}

        {me.data.mfaEnabled && !disabling && (
          <button className="btn ghost" onClick={() => { setDisabling(true); setErr(null); }}>Desativar…</button>
        )}
        {me.data.mfaEnabled && disabling && (
          <form onSubmit={disable} style={{ maxWidth: 360 }}>
            <p>Para desativar, confirme sua senha e um código do aplicativo.</p>
            <div><label htmlFor="p">Senha</label><input id="p" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
            <div style={{ marginTop: 8 }}><label htmlFor="d">Código de 6 dígitos</label><input id="d" required inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} /></div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}><button className="btn gold">Desativar</button><button type="button" className="btn ghost" onClick={() => setDisabling(false)}>Cancelar</button></div>
          </form>
        )}
      </section>
      {getSession()?.user.role === 'owner' && me.data.mfaEnabled && <TeamSecurity notify={(m) => { setErr(null); setMsg(m); }} fail={(m) => { setMsg(null); setErr(m); }} />}
    </>
  );
}

interface Member { id: string; name: string; role: string; mfa_enabled: boolean }
const POLICY: Record<string, string> = { off: 'Ninguém', admins: 'Diretoria, gerência e financeiro (recomendado)', staff: 'Toda a equipe' };
const ROLE_LABEL: Record<string, string> = { owner: 'Diretoria', manager: 'Gerência', finance: 'Financeiro', broker: 'Corretor', marketing: 'Marketing' };

/** Só a diretoria (com o próprio MFA ativo): quem precisa de verificação em duas etapas e redefinição para colegas. */
function TeamSecurity({ notify, fail }: { notify: (m: string) => void; fail: (m: string) => void }) {
  const policy = useApi<{ policy: string }>('/api/settings/mfa-policy');
  const team = useApi<{ items: Member[] }>('/api/team');
  async function setPolicy(p: string) {
    try { await api('/api/settings/mfa-policy', { method: 'PUT', body: JSON.stringify({ policy: p }) }); notify('Regra atualizada. Vale imediatamente para quem ainda não tem a verificação ativa.'); policy.reload(); } catch (e: any) { fail(e.message); }
  }
  async function reset(m: Member) {
    if (!confirm(`Redefinir a verificação em duas etapas de ${m.name}? Ele será desconectado e precisará cadastrar de novo.`)) return;
    try { await api(`/api/team/${m.id}/mfa-reset`, { method: 'POST' }); notify(`Verificação de ${m.name} redefinida.`); team.reload(); } catch (e: any) { fail(e.message); }
  }
  return (
    <section className="card" style={{ marginTop: 16 }} aria-labelledby="eq">
      <h2 id="eq" style={{ marginTop: 0, fontSize: 16 }}>Verificação em duas etapas da equipe</h2>
      <label htmlFor="pol">Quem precisa ter a verificação ativa</label>
      <select id="pol" value={policy.data?.policy ?? 'admins'} onChange={(e) => setPolicy(e.target.value)} style={{ maxWidth: 420 }}>
        {Object.entries(POLICY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>Quem deve ter e ainda não tem só consegue abrir esta página. Proprietários do portal nunca são obrigados.</p>
      {team.data && (
        <table>
          <thead><tr><th>Pessoa</th><th>Papel</th><th>Verificação</th><th /></tr></thead>
          <tbody>{team.data.items.map((m) => (
            <tr key={m.id}><td>{m.name}</td><td>{ROLE_LABEL[m.role] ?? m.role}</td><td>{m.mfa_enabled ? 'Ativa' : 'Não ativada'}</td>
              <td>{m.mfa_enabled && m.id !== getSession()?.user.id && <button className="btn ghost" onClick={() => reset(m)}>Redefinir</button>}</td></tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}
