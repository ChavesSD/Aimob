import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setSession, type SessionUser } from '../api';
import { brand } from '../brand';

export default function Login() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api<{ token: string; user: SessionUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      setSession(r);
      nav('/');
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
        <div><label htmlFor="email">E-mail</label><input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div><label htmlFor="pw">Senha</label><input id="pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        {error && <div className="error-box" role="alert">{error}</div>}
        <button className="btn gold" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </div>
  );
}
