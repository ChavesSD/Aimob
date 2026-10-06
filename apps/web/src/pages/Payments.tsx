import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useApi } from '../hooks';
import { Empty, ErrorBox, Skeleton } from '../ui';

interface Account { connected: boolean; environment: 'sandbox' | 'production' | null; webhookUrl: string; publicUrlConfigured: boolean }
interface Ev { id: string; event: string; payment_id: string | null; status: string; detail: string | null; attempts: number; received_at: string }
const STATUS: Record<string, string> = { processed: 'Processado', ignored: 'Ignorado', needs_review: 'Precisa de revisão', failed: 'Falhou (será repetido)', pending: 'Na fila' };
const fmt = (d: string) => new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function Copy({ text, label }: { text: string; label: string }) {
  const [ok, setOk] = useState(false);
  return <button type="button" className="btn ghost" onClick={async () => { try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); } catch { /* sem permissão de área de transferência */ } }}>{ok ? 'Copiado' : label}</button>;
}

export default function Payments() {
  const acc = useApi<Account>('/api/payments/account');
  const evs = useApi<{ items: Ev[] }>('/api/payments/events');
  const [env, setEnv] = useState<'sandbox' | 'production'>('sandbox');
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState<{ webhookUrl: string; webhookToken: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function connect(e: FormEvent) {
    e.preventDefault(); setErr(null); setMsg(null);
    try {
      const r = await api<{ webhookUrl: string; webhookToken: string }>('/api/payments/account', { method: 'PUT', body: JSON.stringify({ environment: env, apiKey: key.trim() }) });
      setSecret(r); setKey(''); acc.reload();
    } catch (e: any) { setErr(e.message); }
  }
  async function newToken() {
    setErr(null);
    try { setSecret(await api('/api/payments/account/webhook-token', { method: 'POST' })); setMsg('Novo token gerado. Atualize-o no painel do Asaas: o anterior deixou de valer.'); }
    catch (e: any) { setErr(e.message); }
  }
  async function disconnect() {
    if (!confirm('Desconectar a conta de pagamentos? Cobranças já emitidas continuam existindo no provedor, mas o sistema deixa de emitir e de receber confirmações.')) return;
    try { await api('/api/payments/account', { method: 'DELETE' }); setSecret(null); setMsg('Conta desconectada.'); acc.reload(); } catch (e: any) { setErr(e.message); }
  }
  async function retry() {
    try { const r = await api<{ retried: number }>('/api/payments/events/retry', { method: 'POST' }); setMsg(`${r.retried} evento(s) reprocessado(s).`); evs.reload(); } catch (e: any) { setErr(e.message); }
  }

  if (acc.loading && !acc.data) return <Skeleton rows={4} />;
  if (acc.error || !acc.data) return <ErrorBox message={acc.error ?? ''} onRetry={acc.reload} />;
  const a = acc.data;

  return (
    <>
      <h1>Pagamentos</h1>
      <p className="sub">Emissão de Pix e boleto pelo Asaas e baixa automática quando o pagamento é confirmado. Cada imobiliária usa a própria conta no Asaas: o dinheiro vai direto para ela.</p>
      {msg && <div className="alert baixa" role="status">{msg}</div>}
      {err && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{err}</div>}

      <section className="card" aria-labelledby="conta" style={{ marginBottom: 16 }}>
        <h2 id="conta" style={{ marginTop: 0, fontSize: 16 }}>Conta do Asaas: {a.connected ? `conectada (${a.environment === 'production' ? 'produção' : 'sandbox'})` : 'não conectada'}</h2>
        <form onSubmit={connect} style={{ display: 'grid', gap: 12, maxWidth: 480 }}>
          <div><label htmlFor="env">Ambiente</label>
            <select id="env" value={env} onChange={(e) => setEnv(e.target.value as any)}>
              <option value="sandbox">Sandbox (testes, sem dinheiro real)</option><option value="production">Produção (dinheiro real)</option></select></div>
          <div><label htmlFor="key">Chave de API {a.connected && '(informe para trocar)'}</label>
            <input id="key" type="password" autoComplete="off" required minLength={20} placeholder="$aact_..." value={key} onChange={(e) => setKey(e.target.value)} /></div>
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>A chave é testada antes de salvar, guardada criptografada e nunca é exibida de novo. Gere uma chave só para esta integração no painel do Asaas.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn gold">{a.connected ? 'Atualizar conexão' : 'Conectar e testar'}</button>
            {a.connected && <button type="button" className="btn ghost" onClick={disconnect}>Desconectar</button>}
          </div>
        </form>
      </section>

      {(secret || a.connected) && (
        <section className="card" aria-labelledby="hook" style={{ marginBottom: 16, borderColor: secret ? 'var(--gold)' : undefined }}>
          <h2 id="hook" style={{ marginTop: 0, fontSize: 16 }}>Webhook de confirmação</h2>
          <p>No painel do Asaas, cadastre um webhook de <strong>cobranças</strong> com os dados abaixo. É ele que avisa o sistema quando um pagamento é recebido.</p>
          {!a.publicUrlConfigured && <div className="error-box" role="alert" style={{ marginBottom: 8 }}>O endereço público da API (PUBLIC_API_URL) ainda não está configurado, então a URL abaixo está incompleta.</div>}
          <label>URL</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><code style={{ wordBreak: 'break-all', flex: 1 }}>{(secret ?? a).webhookUrl}</code><Copy text={(secret ?? a).webhookUrl} label="Copiar URL" /></div>
          {secret ? (
            <>
              <label style={{ marginTop: 12 }}>Token de autenticação (mostrado só agora)</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><code style={{ wordBreak: 'break-all', flex: 1 }}>{secret.webhookToken}</code><Copy text={secret.webhookToken} label="Copiar token" /></div>
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>Cole no campo de token de autenticação do webhook. Se perder, gere outro abaixo.</p>
            </>
          ) : <button className="btn ghost" style={{ marginTop: 12 }} onClick={newToken}>Gerar novo token</button>}
        </section>
      )}

      {a.connected && (
        <section className="card table-wrap" aria-labelledby="eventos">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h2 id="eventos" style={{ margin: 0, fontSize: 16 }}>Eventos recebidos</h2>
            <button className="btn ghost" onClick={retry}>Reprocessar pendentes</button>
          </div>
          {evs.loading && !evs.data ? <Skeleton rows={3} /> : evs.error || !evs.data ? <ErrorBox message={evs.error ?? ''} onRetry={evs.reload} /> :
            evs.data.items.length === 0 ? <Empty text="Nenhum evento recebido ainda. Faça um pagamento de teste no sandbox." /> : (
              <table>
                <thead><tr><th>Quando</th><th>Evento</th><th>Resultado</th><th>Detalhe</th></tr></thead>
                <tbody>{evs.data.items.map((e) => (
                  <tr key={e.id}><td>{fmt(e.received_at)}</td><td>{e.event.replace('PAYMENT_', '').toLowerCase()}</td>
                    <td>{STATUS[e.status] ?? e.status}{e.status === 'failed' ? ` · ${e.attempts}x` : ''}</td><td>{e.detail ?? '—'}</td></tr>
                ))}</tbody>
              </table>
            )}
        </section>
      )}
    </>
  );
}
