import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { brand } from '../brand';

export default function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw !== pw2) { setError('As senhas não conferem.'); return; }
    setBusy(true); setError(null);
    try { await api('/api/auth/accept-invite', { method: 'POST', body: JSON.stringify({ token, password: pw }) }); setDone(true); }
    catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div>
          <div className="logo" style={{ padding: 0 }}>{brand.name}<span>.</span></div>
          <p className="sub" style={{ margin: 0 }}>Portal do proprietário</p>
        </div>
        {!token ? <div className="error-box" role="alert">Link de convite incompleto. Peça um novo convite à imobiliária.</div> : done ? (
          <>
            <p role="status">Senha definida. Seu acesso está ativo.</p>
            <Link className="btn gold" to="/login">Entrar no portal</Link>
          </>
        ) : (
          <>
            <p style={{ margin: 0 }}>Crie a senha do seu acesso. Use pelo menos 10 caracteres, misturando letras e números.</p>
            <div><label htmlFor="n1">Nova senha</label><input id="n1" type="password" autoComplete="new-password" required minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} /></div>
            <div><label htmlFor="n2">Repita a senha</label><input id="n2" type="password" autoComplete="new-password" required minLength={10} value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
            {error && <div className="error-box" role="alert">{error}</div>}
            <button className="btn gold" disabled={busy}>{busy ? 'Salvando…' : 'Ativar meu acesso'}</button>
          </>
        )}
      </form>
    </div>
  );
}
