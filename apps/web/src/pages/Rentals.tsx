import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useApi } from '../hooks';
import { Empty, ErrorBox, Skeleton } from '../ui';

const TABS: [string, string][] = [['contratos', 'Contratos'], ['cobrancas', 'Cobranças'], ['inadimplencia', 'Inadimplência'], ['repasses', 'Repasses'], ['reajustes', 'Reajustes'], ['proprietarios', 'Proprietários']];
// Financeiro sempre mostra centavos (o brl() global arredonda para reais inteiros, adequado só a KPIs grandes).
const money = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (iso: string) => iso.split('-').reverse().join('/');
/** "2.200,50" -> 220050 centavos; devolve null se inválido. */
function parseBRL(v: string): number | null {
  const n = Number(v.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

type Notify = (m: string) => void;

export default function Rentals() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('aba') ?? 'contratos';
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <>
      <h1>Locação e financeiro</h1>
      <p className="sub">Contratos, cobranças, inadimplência, repasses a proprietários e reajustes. Multa, juros e taxa de administração são definidos por contrato (valores padrão: 2%, 1% ao mês e 10%) e devem ser conferidos com o seu jurídico.</p>
      <div role="tablist" aria-label="Seções" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'btn' : 'btn ghost'} onClick={() => { setParams({ aba: k }); setMsg(null); }}>{l}</button>
        ))}
      </div>
      {msg && <div className="alert baixa" role="status">{msg}</div>}
      {tab === 'contratos' && <Contracts notify={setMsg} />}
      {tab === 'cobrancas' && <Charges notify={setMsg} />}
      {tab === 'inadimplencia' && <Delinquency notify={setMsg} />}
      {tab === 'repasses' && <Payouts notify={setMsg} />}
      {tab === 'reajustes' && <Adjustments notify={setMsg} />}
      {tab === 'proprietarios' && <Owners notify={setMsg} />}
    </>
  );
}

/* ---------- Contratos ---------- */
interface Contract { id: string; renter_id: string; renter_has_document: boolean; property_title: string; property_code: string; landlord_name: string; renter_name: string; rent_cents: string; due_day: number; status: string; start_date: string; end_date: string; next_adjustment: string }

function Contracts({ notify }: { notify: Notify }) {
  const { data, error, loading, reload } = useApi<{ items: Contract[] }>('/api/rentals');
  const [open, setOpen] = useState(false);
  if (loading && !data) return <Skeleton rows={4} />;
  if (error || !data) return <ErrorBox message={error ?? ''} onRetry={reload} />;
  return (
    <>
      <button className="btn gold" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Fechar' : 'Novo contrato'}</button>
      {open && <NewContract onDone={(m) => { notify(m); setOpen(false); reload(); }} />}
      <div className="card table-wrap" style={{ marginTop: 16 }}>
        {data.items.length === 0 ? <Empty text="Nenhum contrato de locação ainda." /> : (
          <table>
            <thead><tr><th>Imóvel</th><th>Proprietário</th><th>Inquilino</th><th>Aluguel</th><th>Vence dia</th><th>Próx. reajuste</th><th>Situação</th></tr></thead>
            <tbody>{data.items.map((c) => (
              <tr key={c.id}><td>#{c.property_code} {c.property_title}</td><td>{c.landlord_name}</td><td>{c.renter_name}{!c.renter_has_document && <DocumentField renterId={c.renter_id} onSaved={(m) => { notify(m); reload(); }} />}</td><td>{money(Number(c.rent_cents))}</td>
                <td>{c.due_day}</td><td>{fmtDate(c.next_adjustment)}</td><td>{c.status === 'active' ? 'Ativo' : 'Encerrado'}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}

function ContactPicker({ kind, label, value, onChange }: { kind: 'owner' | 'renter'; label: string; value: string; onChange: (id: string) => void }) {
  const { data, reload } = useApi<{ items: { id: string; name: string }[] }>(`/api/contacts?kind=${kind}`);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  async function add() {
    try { const c = await api<{ id: string }>('/api/contacts', { method: 'POST', body: JSON.stringify({ name, kind }) }); setName(''); setAdding(false); reload(); onChange(c.id); }
    catch (e: any) { setErr(e.message); }
  }
  const id = `cp-${kind}`;
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      {adding ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <input id={id} placeholder="Nome completo" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="button" className="btn" disabled={name.trim().length < 2} onClick={add}>Salvar</button>
        </div>
      ) : (
        <select id={id} required value={value} onChange={(e) => (e.target.value === '__new' ? setAdding(true) : onChange(e.target.value))}>
          <option value="">Selecione…</option>
          {data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          <option value="__new">+ Cadastrar novo…</option>
        </select>
      )}
      {err && <small role="alert" style={{ color: 'var(--danger)' }}>{err}</small>}
    </div>
  );
}

function NewContract({ onDone }: { onDone: (m: string) => void }) {
  const props = useApi<{ items: { id: string; code: string; title: string; purpose: string; status: string }[] }>('/api/properties?limit=100');
  const [f, setF] = useState({ propertyId: '', landlordId: '', renterId: '', rent: '', dueDay: '5', startDate: '', endDate: '' });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(null);
    const rentCents = parseBRL(f.rent);
    if (!rentCents) { setErr('Informe o valor do aluguel, por exemplo 2.200,00.'); return; }
    try {
      const r = await api<{ chargesGenerated: number }>('/api/rentals', { method: 'POST', body: JSON.stringify({ propertyId: f.propertyId, landlordId: f.landlordId, renterId: f.renterId, rentCents, dueDay: Number(f.dueDay), startDate: f.startDate, endDate: f.endDate }) });
      onDone(`Contrato criado. ${r.chargesGenerated} cobrança(s) gerada(s).`);
    } catch (e: any) { setErr(e.message); }
  }
  const rentable = props.data?.items.filter((p) => p.purpose !== 'venda' && p.status === 'active') ?? [];
  return (
    <form className="card" onSubmit={submit} style={{ marginTop: 16 }}>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <div><label htmlFor="c-prop">Imóvel (finalidade aluguel)</label>
          <select id="c-prop" required value={f.propertyId} onChange={(e) => set('propertyId', e.target.value)}>
            <option value="">Selecione…</option>{rentable.map((p) => <option key={p.id} value={p.id}>#{p.code} {p.title}</option>)}</select></div>
        <ContactPicker kind="owner" label="Proprietário" value={f.landlordId} onChange={(v) => set('landlordId', v)} />
        <ContactPicker kind="renter" label="Inquilino" value={f.renterId} onChange={(v) => set('renterId', v)} />
        <div><label htmlFor="c-rent">Aluguel mensal (R$)</label><input id="c-rent" inputMode="decimal" required placeholder="2.200,00" value={f.rent} onChange={(e) => set('rent', e.target.value)} /></div>
        <div><label htmlFor="c-day">Dia do vencimento (1 a 28)</label><input id="c-day" type="number" min={1} max={28} required value={f.dueDay} onChange={(e) => set('dueDay', e.target.value)} /></div>
        <div><label htmlFor="c-start">Início</label><input id="c-start" type="date" required value={f.startDate} onChange={(e) => set('startDate', e.target.value)} /></div>
        <div><label htmlFor="c-end">Fim</label><input id="c-end" type="date" required value={f.endDate} onChange={(e) => set('endDate', e.target.value)} /></div>
      </div>
      {err && <div className="error-box" role="alert" style={{ marginTop: 12 }}>{err}</div>}
      <button className="btn gold" style={{ marginTop: 12 }}>Criar contrato</button>
    </form>
  );
}

function DocumentField({ renterId, onSaved }: { renterId: string; onSaved: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [doc, setDoc] = useState('');
  const [err, setErr] = useState<string | null>(null);
  async function save(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try { await api(`/api/contacts/${renterId}/document`, { method: 'PUT', body: JSON.stringify({ document: doc }) }); onSaved('CPF/CNPJ cadastrado.'); setOpen(false); }
    catch (e: any) { setErr(e.message); }
  }
  if (!open) return <div><button className="btn ghost" style={{ minHeight: 28, padding: '0 8px', fontSize: 12 }} onClick={() => setOpen(true)}>Cadastrar CPF/CNPJ</button></div>;
  return (
    <form onSubmit={save} style={{ display: 'flex', gap: 4, marginTop: 4 }}>
      <input aria-label="CPF ou CNPJ do inquilino" inputMode="numeric" placeholder="CPF ou CNPJ" value={doc} onChange={(e) => setDoc(e.target.value)} style={{ minHeight: 32 }} />
      <button className="btn" style={{ minHeight: 32 }}>Salvar</button>
      {err && <small role="alert" style={{ color: 'var(--danger)' }}>{err}</small>}
    </form>
  );
}

/* ---------- Cobranças e baixa ---------- */
interface Charge { id: string; competence: string; due_date: string; paid_on: string | null; status: string; amount_cents: number; property_title: string; property_code: string; renter_name: string; days_late: number; late_fee_cents: number; interest_cents: number; total_due_cents: number; payment: { status: string | null; url: string | null; boletoUrl: string | null; pixPayload: string | null; stale: boolean; reconciliation: string | null } | null }
const STATUS: Record<string, string> = { open: 'A vencer', overdue: 'Vencida', paid: 'Paga', canceled: 'Cancelada' };

function PayRow({ c, onPaid, notify }: { c: Charge; onPaid: () => void; notify: Notify }) {
  const [open, setOpen] = useState(false);
  const [waive, setWaive] = useState(false);
  const total = waive ? c.amount_cents : c.total_due_cents;
  async function confirm() {
    try {
      const r = await api<{ totalCents: number; daysLate: number }>(`/api/charges/${c.id}/pay`, { method: 'POST', body: JSON.stringify({ waiveLateFees: waive }) });
      notify(`Baixa registrada: ${money(r.totalCents)} recebidos${r.daysLate ? ` (${r.daysLate} dia(s) de atraso)` : ''}. Repasse gerado.`); onPaid();
    } catch (e: any) { notify(e.message); }
  }
  return (
    <>
      <button className="btn ghost" aria-expanded={open} onClick={() => setOpen(!open)}>Dar baixa</button>
      {open && (
        <div className="card" style={{ position: 'absolute', right: 24, zIndex: 2, minWidth: 280, textAlign: 'left' }}>
          <div>Principal: {money(c.amount_cents)}</div>
          {c.days_late > 0 && <div>Multa: {money(waive ? 0 : c.late_fee_cents)} · Juros: {money(waive ? 0 : c.interest_cents)} <small>({c.days_late} dias)</small></div>}
          <strong>Total a receber: {money(total)}</strong>
          {c.days_late > 0 && <label className="check" style={{ display: 'flex', gap: 8, marginTop: 8 }}><input type="checkbox" checked={waive} onChange={(e) => setWaive(e.target.checked)} /> Dispensar multa e juros</label>}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}><button className="btn gold" onClick={confirm}>Confirmar recebimento</button><button className="btn ghost" onClick={() => setOpen(false)}>Cancelar</button></div>
        </div>
      )}
    </>
  );
}

function PaymentCell({ c, connected, onChanged, notify }: { c: Charge; connected: boolean; onChanged: () => void; notify: Notify }) {
  const [busy, setBusy] = useState(false);
  async function issue() {
    setBusy(true);
    try { await api(`/api/charges/${c.id}/issue`, { method: 'POST' }); notify('Pix/boleto emitido.'); onChanged(); }
    catch (e: any) { notify(e.message); } finally { setBusy(false); }
  }
  if (c.status === 'paid' || c.status === 'canceled') return <span style={{ color: 'var(--muted)' }}>—</span>;
  const p = c.payment;
  if (!p) return connected ? <button className="btn ghost" disabled={busy} onClick={issue}>{busy ? 'Emitindo…' : 'Gerar Pix/boleto'}</button> : <span style={{ color: 'var(--muted)', fontSize: 12 }}>Conecte o Asaas</span>;
  return (
    <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
      {p.stale && <span role="alert" style={{ color: 'var(--warn)' }}>Valor mudou (reajuste): reemita</span>}
      {p.reconciliation === 'divergent' && <span role="alert" style={{ color: 'var(--danger)' }}>Pagamento com valor diferente: revisar</span>}
      <span style={{ color: 'var(--muted)' }}>{p.status ?? 'emitido'}</span>
      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {p.url && <a href={p.url} target="_blank" rel="noopener noreferrer">Abrir cobrança</a>}
        {p.pixPayload && <button type="button" className="btn ghost" style={{ minHeight: 28, padding: '0 8px', fontSize: 12 }} onClick={() => navigator.clipboard?.writeText(p.pixPayload!).then(() => notify('Pix copia e cola copiado.')).catch(() => notify('Não foi possível copiar automaticamente.'))}>Copiar Pix</button>}
        {p.stale && <button type="button" className="btn gold" style={{ minHeight: 28, padding: '0 8px', fontSize: 12 }} disabled={busy} onClick={issue}>Reemitir</button>}
      </span>
    </div>
  );
}

function ChargeTable({ items, reload, notify }: { items: Charge[]; reload: () => void; notify: Notify }) {
  const account = useApi<{ connected: boolean }>('/api/payments/account');
  const connected = !!account.data?.connected;
  if (!items.length) return <Empty text="Nenhuma cobrança nesta lista." />;
  return (
    <table>
      <thead><tr><th>Competência</th><th>Imóvel</th><th>Inquilino</th><th>Vencimento</th><th>Valor</th><th>Situação</th><th>Pagamento</th><th /></tr></thead>
      <tbody>{items.map((c) => (
        <tr key={c.id}><td>{c.competence}</td><td>#{c.property_code} {c.property_title}</td><td>{c.renter_name}</td><td>{fmtDate(c.due_date)}</td>
          <td>{money(c.amount_cents)}</td>
          <td>{STATUS[c.status] ?? c.status}{c.days_late ? ` · ${c.days_late}d` : ''}{c.paid_on ? ` em ${fmtDate(c.paid_on)}` : ''}</td>
          <td><PaymentCell c={c} connected={connected} onChanged={reload} notify={notify} /></td>
          <td style={{ position: 'relative' }}>{c.status !== 'paid' && <PayRow c={c} onPaid={reload} notify={notify} />}</td></tr>
      ))}</tbody>
    </table>
  );
}

function Charges({ notify }: { notify: Notify }) {
  const [status, setStatus] = useState('');
  const { data, error, loading, reload } = useApi<{ items: Charge[] }>(`/api/charges${status ? `?status=${status}` : ''}`);
  return (
    <>
      <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap', marginBottom: 12 }}>
      <button className="btn gold" onClick={async () => {
        try {
          const r = await api<{ issued: number; skippedNoDocument: number; failed: { message: string }[]; considered: number }>('/api/charges/issue-batch', { method: 'POST', body: JSON.stringify({ daysAhead: 15 }) });
          notify(`${r.issued} Pix/boleto emitido(s) de ${r.considered} cobrança(s)${r.skippedNoDocument ? `; ${r.skippedNoDocument} sem CPF/CNPJ do inquilino` : ''}${r.failed.length ? `; ${r.failed.length} com falha (${r.failed[0].message})` : ''}.`);
          reload();
        } catch (e: any) { notify(e.message); }
      }}>Emitir Pix/boleto dos próximos 15 dias</button>
      <div style={{ maxWidth: 240 }}><label htmlFor="st">Situação</label>
        <select id="st" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todas</option><option value="open">A vencer</option><option value="overdue">Vencidas</option><option value="paid">Pagas</option></select></div>
      </div>
      <div className="card table-wrap" style={{ overflow: 'visible' }}>
        {loading && !data ? <Skeleton rows={5} /> : error || !data ? <ErrorBox message={error ?? ''} onRetry={reload} /> : <ChargeTable items={data.items} reload={reload} notify={notify} />}
      </div>
    </>
  );
}

function Delinquency({ notify }: { notify: Notify }) {
  const { data, error, loading, reload } = useApi<{ items: Charge[]; totals: { count: number; principalCents: number; lateFeeCents: number; interestCents: number; totalCents: number } }>('/api/delinquency');
  if (loading && !data) return <Skeleton rows={4} />;
  if (error || !data) return <ErrorBox message={error ?? ''} onRetry={reload} />;
  const t = data.totals;
  return (
    <>
      <div className="grid kpis">
        <div className="card kpi"><div className="label">Cobranças vencidas</div><div className="value">{t.count}</div></div>
        <div className="card kpi"><div className="label">Principal em atraso</div><div className="value">{money(t.principalCents)}</div></div>
        <div className="card kpi"><div className="label">Multa + juros acumulados</div><div className="value">{money(t.lateFeeCents + t.interestCents)}</div></div>
        <div className="card kpi"><div className="label">Total a receber hoje</div><div className="value">{money(t.totalCents)}</div></div>
      </div>
      <div className="card table-wrap" style={{ overflow: 'visible' }}>
        {data.items.length === 0 ? <Empty text="Nenhuma inadimplência. Todas as cobranças vencidas foram recebidas." /> : <ChargeTable items={data.items} reload={reload} notify={notify} />}
      </div>
    </>
  );
}

/* ---------- Repasses ---------- */
function Payouts({ notify }: { notify: Notify }) {
  const { data, error, loading, reload } = useApi<{ items: { id: string; landlord_name: string; property_title: string; competence: string; gross_cents: number; admin_fee_cents: number; net_cents: number }[]; totalNetCents: number }>('/api/payouts?status=pending');
  async function pay(id: string) {
    try { await api(`/api/payouts/${id}/pay`, { method: 'POST' }); notify('Repasse marcado como realizado.'); reload(); } catch (e: any) { notify(e.message); }
  }
  if (loading && !data) return <Skeleton rows={4} />;
  if (error || !data) return <ErrorBox message={error ?? ''} onRetry={reload} />;
  return (
    <div className="card table-wrap">
      <p style={{ marginTop: 0 }}>A repassar: <strong>{money(data.totalNetCents)}</strong>. Registro manual: o sistema ainda não executa a transferência bancária.</p>
      {data.items.length === 0 ? <Empty text="Nenhum repasse pendente." /> : (
        <table>
          <thead><tr><th>Proprietário</th><th>Imóvel</th><th>Competência</th><th>Recebido</th><th>Taxa adm.</th><th>Líquido</th><th /></tr></thead>
          <tbody>{data.items.map((p) => (
            <tr key={p.id}><td>{p.landlord_name}</td><td>{p.property_title}</td><td>{p.competence}</td><td>{money(p.gross_cents)}</td><td>{money(p.admin_fee_cents)}</td><td><strong>{money(p.net_cents)}</strong></td>
              <td><button className="btn ghost" onClick={() => pay(p.id)}>Marcar como repassado</button></td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

/* ---------- Reajustes ---------- */
function Adjustments({ notify }: { notify: Notify }) {
  const { data, error, loading, reload } = useApi<{ items: { id: string; property_title: string; renter_name: string; rent_cents: number; due_on: string; adjustment_index: string }[]; today: string }>('/api/adjustments/due');
  const [pct, setPct] = useState<Record<string, string>>({});
  async function apply(id: string, index: string) {
    const n = Number((pct[id] ?? '').replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0 || n > 30) { notify('Informe o percentual do reajuste, entre 0,01 e 30.'); return; }
    try {
      const r = await api<{ previousCents: number; newCents: number }>(`/api/rentals/${id}/adjust`, { method: 'POST', body: JSON.stringify({ percentBps: Math.round(n * 100), indexName: index === 'manual' ? 'Manual' : index }) });
      notify(`Aluguel reajustado de ${money(r.previousCents)} para ${money(r.newCents)}.`); reload();
    } catch (e: any) { notify(e.message); }
  }
  if (loading && !data) return <Skeleton rows={4} />;
  if (error || !data) return <ErrorBox message={error ?? ''} onRetry={reload} />;
  return (
    <div className="card table-wrap">
      <p style={{ marginTop: 0 }}>Informe o percentual do índice (ex.: IGP-M ou IPCA acumulado em 12 meses) conferido na fonte oficial. O sistema não busca índices automaticamente.</p>
      {data.items.length === 0 ? <Empty text="Nenhum contrato com reajuste nos próximos 60 dias." /> : (
        <table>
          <thead><tr><th>Imóvel</th><th>Inquilino</th><th>Aluguel atual</th><th>Aniversário</th><th>Reajuste (%)</th><th>Novo valor</th><th /></tr></thead>
          <tbody>{data.items.map((c) => {
            const n = Number((pct[c.id] ?? '').replace(',', '.'));
            const preview = Number.isFinite(n) && n > 0 ? Math.round(c.rent_cents * (1 + n / 100)) : null;
            return (
              <tr key={c.id}><td>{c.property_title}</td><td>{c.renter_name}</td><td>{money(c.rent_cents)}</td>
                <td>{fmtDate(c.due_on)}{c.due_on < data.today ? ' (atrasado)' : ''}</td>
                <td style={{ maxWidth: 110 }}><input aria-label={`Percentual de reajuste de ${c.renter_name}`} inputMode="decimal" placeholder="4,50" value={pct[c.id] ?? ''} onChange={(e) => setPct({ ...pct, [c.id]: e.target.value })} /></td>
                <td>{preview ? money(preview) : '—'}</td>
                <td><button className="btn gold" onClick={() => apply(c.id, c.adjustment_index)}>Aplicar</button></td></tr>
            );
          })}</tbody>
        </table>
      )}
      <p><Link to="/locacao?aba=contratos">Ver contratos</Link></p>
    </div>
  );
}

/* ---------- Proprietários: acesso ao portal ---------- */
interface OwnerAccess { id: string; name: string; email: string | null; hasUser: boolean; accepted: boolean; inviteExpiresAt: string | null; properties: number }

function Owners({ notify }: { notify: Notify }) {
  const { data, error, loading, reload } = useApi<{ items: OwnerAccess[] }>('/api/portal/access');
  const [emailFor, setEmailFor] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [invite, setInvite] = useState<{ name: string; url: string } | null>(null);

  async function send(o: OwnerAccess, e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ inviteUrl: string }>('/api/portal/invites', { method: 'POST', body: JSON.stringify({ contactId: o.id, email }) });
      const url = r.inviteUrl.startsWith('http') ? r.inviteUrl : `${location.origin}${r.inviteUrl}`;
      setInvite({ name: o.name, url }); setEmailFor(null); reload();
    } catch (err: any) { notify(err.message); }
  }
  async function revoke(o: OwnerAccess) {
    if (!confirm(`Revogar o acesso de ${o.name} ao portal? Ele será desconectado na hora.`)) return;
    try { await api(`/api/portal/access/${o.id}`, { method: 'DELETE' }); notify('Acesso revogado.'); reload(); } catch (err: any) { notify(err.message); }
  }
  if (loading && !data) return <Skeleton rows={4} />;
  if (error || !data) return <ErrorBox message={error ?? ''} onRetry={reload} />;
  return (
    <>
      {invite && (
        <section className="card" style={{ borderColor: 'var(--gold)', marginBottom: 16 }} aria-labelledby="inv">
          <h2 id="inv" style={{ marginTop: 0, fontSize: 16 }}>Link de acesso de {invite.name}</h2>
          <p>Envie este link ao proprietário (WhatsApp ou e-mail). Ele vale por 7 dias, funciona uma única vez e <strong>só é mostrado agora</strong>.</p>
          <code style={{ wordBreak: 'break-all', display: 'block' }}>{invite.url}</code>
          <button className="btn gold" style={{ marginTop: 8 }} onClick={() => navigator.clipboard?.writeText(invite.url).then(() => notify('Link copiado.')).catch(() => notify('Não foi possível copiar automaticamente.'))}>Copiar link</button>{' '}
          <button className="btn ghost" onClick={() => setInvite(null)}>Fechar</button>
        </section>
      )}
      <div className="card table-wrap">
        <p style={{ marginTop: 0 }}>Dê aos proprietários acesso ao portal para acompanharem imóveis, aluguéis e repasses sem precisar ligar.</p>
        {data.items.length === 0 ? <Empty text="Nenhum proprietário cadastrado ainda." /> : (
          <table>
            <thead><tr><th>Proprietário</th><th>Imóveis</th><th>Acesso</th><th /></tr></thead>
            <tbody>{data.items.map((o) => (
              <tr key={o.id}>
                <td>{o.name}{o.email && <><br /><small style={{ color: 'var(--muted)' }}>{o.email}</small></>}</td>
                <td>{o.properties}</td>
                <td>{o.accepted ? 'Ativo' : o.hasUser ? 'Convite pendente' : 'Sem acesso'}</td>
                <td>
                  {emailFor === o.id ? (
                    <form onSubmit={(e) => send(o, e)} style={{ display: 'flex', gap: 6 }}>
                      <input aria-label={`E-mail de ${o.name}`} type="email" required placeholder="e-mail do proprietário" value={email} onChange={(e) => setEmail(e.target.value)} style={{ minHeight: 34 }} />
                      <button className="btn gold" style={{ minHeight: 34 }}>Gerar link</button>
                    </form>
                  ) : (
                    <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button className="btn ghost" onClick={() => { setEmailFor(o.id); setEmail(o.email ?? ''); }}>{o.hasUser ? 'Novo convite' : 'Convidar'}</button>
                      {o.hasUser && <button className="btn ghost" onClick={() => revoke(o)}>Revogar</button>}
                    </span>
                  )}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
