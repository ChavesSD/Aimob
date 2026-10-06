import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setSession, type SessionUser } from '../api';
import { brand } from '../brand';

type LoginResponse = { token: string; user: SessionUser } | { mfaRequired: true; mfaToken: string };

export default function Login() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (!mfaToken) {
        const r = await api<LoginResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
        if ('mfaRequired' in r) { setMfaToken(r.mfaToken); return; }
        setSession(r); nav('/');
      } else {
        const body = useRecovery ? { mfaToken, recoveryCode: code.trim() } : { mfaToken, code: code.trim() };
        const r = await api<{ token: string; user: SessionUser }>('/api/auth/mfa/verify', { method: 'POST', body: JSON.stringify(body) });
        setSession(r); nav('/');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div>
          <div className="logo" style={{ padding: 0 }}>{brand.name}<span>.</span></div>
          <p className="sub" style={{ margin: 0 }}>{brand.tagline}</p>
        </div>
        {!mfaToken ? (
          <>
            <div><label htmlFor="email">E-mail</label><input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div><label htmlFor="pw">Senha</label><input id="pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          </>
        ) : (
          <>
            <p style={{ margin: 0 }}>{useRecovery ? 'Digite um dos seus códigos de recuperação.' : 'Digite o código de 6 dígitos do seu aplicativo autenticador.'}</p>
            <div>
              <label htmlFor="code">{useRecovery ? 'Código de recuperação' : 'Código de verificação'}</label>
              <input id="code" required autoFocus autoComplete="one-time-code" inputMode={useRecovery ? 'text' : 'numeric'} maxLength={useRecovery ? 20 : 6}
                value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            <button type="button" className="btn ghost" onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(null); }}>
              {useRecovery ? 'Usar o aplicativo autenticador' : 'Usar um código de recuperação'}
            </button>
          </>
        )}
        {error && <div className="error-box" role="alert">{error}</div>}
        <button className="btn gold" disabled={busy}>{busy ? 'Verificando…' : mfaToken ? 'Confirmar' : 'Entrar'}</button>
      </form>
    </div>
  );
}
