import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useApi } from '../hooks';
import { Empty, ErrorBox, Skeleton } from '../ui';

interface Account {
  connected: boolean; provisioning: boolean; mode: 'own_key' | 'platform_split' | null; environment: 'sandbox' | 'production' | null;
  platformAvailable: boolean; company: { name: string; documentMask: string | null; email: string } | null; companyMissing: string[];
  webhookUrl: string | null; publicUrlConfigured: boolean;
}
interface Ev { id: string; event: string; payment_id: string | null; status: string; detail: string | null; attempts: number; received_at: string }
const STATUS: Record<string, string> = { processed: 'Processado', ignored: 'Ignorado', needs_review: 'Precisa de revisão', failed: 'Falhou (será repetido)', pending: 'Na fila' };
const fmt = (d: string) => new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
/** "50.000,00" -> 5000000 centavos; null se inválido. */
const toCents = (v: string) => { const n = Number(v.replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null; };

function Copy({ text, label }: { text: string; label: string }) {
  const [ok, setOk] = useState(false);
  return <button type="button" className="btn ghost" onClick={async () => { try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); } catch { /* sem permissão */ } }}>{ok ? 'Copiado' : label}</button>;
}

function CompanyForm({ account, onSaved, onError }: { account: Account; onSaved: (m: string) => void; onError: (m: string) => void }) {
  const [f, setF] = useState({ name: account.company?.name ?? '', document: '', email: account.company?.email ?? '', phone: '', birthDate: '', revenue: '', street: '', number: '', complement: '', neighborhood: '', cep: '' });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const isCpf = f.document.replace(/\D/g, '').length === 11;
  async function save(e: FormEvent) {
    e.preventDefault();
    const monthlyRevenueCents = toCents(f.revenue);
    if (!monthlyRevenueCents) { onError('Informe o faturamento mensal, por exemplo 50.000,00.'); return; }
    try {
      await api('/api/payments/company', { method: 'PUT', body: JSON.stringify({ name: f.name, document: f.document, email: f.email, phone: f.phone || undefined,
        birthDate: isCpf && f.birthDate ? f.birthDate : undefined, monthlyRevenueCents, street: f.street || undefined, number: f.number || undefined,
        complement: f.complement || undefined, neighborhood: f.neighborhood || undefined, cep: f.cep || undefined }) });
      onSaved('Dados da empresa salvos.');
    } catch (e: any) { onError(e.message); }
  }
  return (
    <form onSubmit={save} className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
      <div><label htmlFor="cn">Nome da empresa</label><input id="cn" required value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
      <div><label htmlFor="cd">CNPJ (ou CPF)</label><input id="cd" required inputMode="numeric" placeholder={account.company?.documentMask ?? ''} value={f.document} onChange={(e) => set('document', e.target.value)} /></div>
      <div><label htmlFor="ce">E-mail do financeiro</label><input id="ce" type="email" required value={f.email} onChange={(e) => set('email', e.target.value)} /></div>
      <div><label htmlFor="cp">Telefone</label><input id="cp" inputMode="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></div>
      {isCpf && <div><label htmlFor="cb">Data de nascimento (obrigatória para CPF)</label><input id="cb" type="date" required value={f.birthDate} onChange={(e) => set('birthDate', e.target.value)} /></div>}
      <div><label htmlFor="cr">Faturamento mensal (R$)</label><input id="cr" required inputMode="decimal" placeholder="50.000,00" value={f.revenue} onChange={(e) => set('revenue', e.target.value)} /></div>
      <div><label htmlFor="cs">Rua</label><input id="cs" value={f.street} onChange={(e) => set('street', e.target.value)} /></div>
      <div><label htmlFor="cu">Número</label><input id="cu" value={f.number} onChange={(e) => set('number', e.target.value)} /></div>
      <div><label htmlFor="cm">Complemento</label><input id="cm" value={f.complement} onChange={(e) => set('complement', e.target.value)} /></div>
      <div><label htmlFor="cg">Bairro</label><input id="cg" value={f.neighborhood} onChange={(e) => set('neighborhood', e.target.value)} /></div>
      <div><label htmlFor="cc">CEP</label><input id="cc" inputMode="numeric" value={f.cep} onChange={(e) => set('cep', e.target.value)} /></div>
      <div style={{ alignSelf: 'end' }}><button className="btn gold">Salvar dados da empresa</button></div>
    </form>
  );
}

export default function Payments() {
  const acc = useApi<Account>('/api/payments/account');
  const evs = useApi<{ items: Ev[] }>('/api/payments/events');
  const [env, setEnv] = useState<'sandbox' | 'production'>('sandbox');
  const [key, setKey] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ webhookUrl: string; webhookToken: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const ok = (m: string) => { setErr(null); setMsg(m); acc.reload(); };
  const fail = (m: string) => { setMsg(null); setErr(m); };

  async function provision() {
    setBusy(true); setErr(null); setMsg(null);
    try { await api('/api/payments/account/provision', { method: 'POST' }); ok('Conta de recebimento criada. O Asaas pode pedir o envio de documentos para liberar os recebimentos.'); }
    catch (e: any) { fail(e.message); } finally { setBusy(false); }
  }
  async function connectOwnKey(e: FormEvent) {
    e.preventDefault(); setErr(null); setMsg(null);
    try { setSecret(await api('/api/payments/account', { method: 'PUT', body: JSON.stringify({ environment: env, apiKey: key.trim() }) })); setKey(''); acc.reload(); }
    catch (e: any) { fail(e.message); }
  }
  async function newToken() {
    try { setSecret(await api('/api/payments/account/webhook-token', { method: 'POST' })); setMsg('Novo token gerado. Atualize-o no painel do Asaas: o anterior deixou de valer.'); } catch (e: any) { fail(e.message); }
  }
  async function disconnect() {
    if (!confirm('Desconectar a conta de recebimento? Cobranças já emitidas continuam existindo no Asaas, mas o sistema deixa de emitir e de receber confirmações.')) return;
    try { await api('/api/payments/account', { method: 'DELETE' }); setSecret(null); ok('Conta desconectada.'); } catch (e: any) { fail(e.message); }
  }
  async function retry() {
    try { const r = await api<{ retried: number }>('/api/payments/events/retry', { method: 'POST' }); setMsg(`${r.retried} evento(s) reprocessado(s).`); evs.reload(); } catch (e: any) { fail(e.message); }
  }

  if (acc.loading && !acc.data) return <Skeleton rows={4} />;
  if (acc.error || !acc.data) return <ErrorBox message={acc.error ?? ''} onRetry={acc.reload} />;
  const a = acc.data;

  return (
    <>
      <h1>Pagamentos</h1>
      <p className="sub">Emissão de boleto com Pix pelo Asaas e baixa automática quando o pagamento é confirmado. O valor recebido vai para a conta de recebimento da sua imobiliária.</p>
      {msg && <div className="alert baixa" role="status">{msg}</div>}
      {err && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{err}</div>}

      {a.connected && (
        <section className="card" style={{ marginBottom: 16 }} aria-labelledby="conta">
          <h2 id="conta" style={{ marginTop: 0, fontSize: 16 }}>Conta de recebimento: conectada {a.mode === 'own_key' ? '(chave própria)' : '(criada pela plataforma)'}</h2>
          <p style={{ color: 'var(--muted)' }}>{a.mode === 'platform_split'
            ? 'As cobranças são criadas na conta principal e repassadas automaticamente (split) para a sua conta de recebimento. Se o Asaas pedir documentos, envie-os no painel do Asaas para liberar os saques.'
            : `Ambiente: ${a.environment === 'production' ? 'produção' : 'sandbox'}.`}</p>
          <button className="btn ghost" onClick={disconnect}>Desconectar</button>
        </section>
      )}

      {!a.connected && a.platformAvailable && (
        <>
          <section className="card" style={{ marginBottom: 16 }} aria-labelledby="emp">
            <h2 id="emp" style={{ marginTop: 0, fontSize: 16 }}>1. Dados da empresa {a.company && <span className="badge">salvos: {a.company.name} · {a.company.documentMask}</span>}</h2>
            <p style={{ color: 'var(--muted)' }}>O Asaas exige estes dados para abrir a conta de recebimento. O CPF/CNPJ é guardado criptografado.</p>
            <CompanyForm account={a} onSaved={ok} onError={fail} />
          </section>
          <section className="card" style={{ marginBottom: 16 }} aria-labelledby="cria">
            <h2 id="cria" style={{ marginTop: 0, fontSize: 16 }}>2. Criar conta de recebimento</h2>
            {a.companyMissing.length > 0 && <p role="note" style={{ color: 'var(--warn)' }}>Falta preencher: {a.companyMissing.join(', ')}.</p>}
            {a.provisioning && <p role="status">Criação em andamento…</p>}
            <button className="btn gold" disabled={busy || a.companyMissing.length > 0 || a.provisioning} onClick={provision}>{busy ? 'Criando…' : 'Criar conta de recebimento'}</button>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 0 }}>Esta ação cria uma conta de verdade no Asaas e só pode ser feita uma vez por imobiliária.</p>
          </section>
        </>
      )}

      {!a.connected && (
        <section className="card" style={{ marginBottom: 16 }} aria-labelledby="own">
          <h2 id="own" style={{ marginTop: 0, fontSize: 16 }}>
            {a.platformAvailable ? <button type="button" className="btn ghost" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>Avançado: já tenho conta no Asaas e quero usar minha própria chave</button> : 'Conectar com a chave de API do Asaas'}
          </h2>
          {(advanced || !a.platformAvailable) && (
            <form onSubmit={connectOwnKey} style={{ display: 'grid', gap: 12, maxWidth: 480 }}>
              <div><label htmlFor="env">Ambiente</label>
                <select id="env" value={env} onChange={(e) => setEnv(e.target.value as any)}><option value="sandbox">Sandbox (testes, sem dinheiro real)</option><option value="production">Produção (dinheiro real)</option></select></div>
              <div><label htmlFor="key">Chave de API</label><input id="key" type="password" autoComplete="off" required minLength={20} placeholder="$aact_..." value={key} onChange={(e) => setKey(e.target.value)} /></div>
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>A chave é testada antes de salvar, guardada criptografada e nunca é exibida de novo.</p>
              <button className="btn gold">Conectar e testar</button>
            </form>
          )}
        </section>
      )}

      {secret && (
        <section className="card" aria-labelledby="hook" style={{ marginBottom: 16, borderColor: 'var(--gold)' }}>
          <h2 id="hook" style={{ marginTop: 0, fontSize: 16 }}>Webhook de confirmação (chave própria)</h2>
          <p>No painel do Asaas, cadastre um webhook de <strong>cobranças</strong> com os dados abaixo.</p>
          {!a.publicUrlConfigured && <div className="error-box" role="alert" style={{ marginBottom: 8 }}>O endereço público da API (PUBLIC_API_URL) ainda não está configurado, então a URL está incompleta.</div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><code style={{ wordBreak: 'break-all', flex: 1 }}>{secret.webhookUrl}</code><Copy text={secret.webhookUrl} label="Copiar URL" /></div>
          <label style={{ marginTop: 12 }}>Token (mostrado só agora)</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><code style={{ wordBreak: 'break-all', flex: 1 }}>{secret.webhookToken}</code><Copy text={secret.webhookToken} label="Copiar token" /></div>
        </section>
      )}
      {a.connected && a.mode === 'own_key' && !secret && a.webhookUrl && (
        <section className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Webhook de confirmação</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><code style={{ wordBreak: 'break-all', flex: 1 }}>{a.webhookUrl}</code><Copy text={a.webhookUrl} label="Copiar URL" /></div>
          <button className="btn ghost" style={{ marginTop: 12 }} onClick={newToken}>Gerar novo token</button>
        </section>
      )}

      {a.connected && (
        <section className="card table-wrap" aria-labelledby="eventos">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h2 id="eventos" style={{ margin: 0, fontSize: 16 }}>Eventos recebidos</h2>
            <button className="btn ghost" onClick={retry}>Reprocessar pendentes</button>
          </div>
          {evs.loading && !evs.data ? <Skeleton rows={3} /> : evs.error || !evs.data ? <ErrorBox message={evs.error ?? ''} onRetry={evs.reload} /> :
            evs.data.items.length === 0 ? <Empty text="Nenhum evento recebido ainda." /> : (
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
