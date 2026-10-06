import { useState } from 'react';
import { brl, downloadFile } from '../api';
import { useApi } from '../hooks';
import { Empty, ErrorBox, Skeleton } from '../ui';

// Portal do proprietário: só leitura, só o que é dele. Valores sempre com centavos.
const money = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');

interface Summary { properties: number; rentedProperties: number; monthlyRentCents: number; payoutPendingCents: number; payoutPendingCount: number; payoutReceived12mCents: number; overdueCharges: number }
interface Charge { id: string; competence: string; due_date: string; paid_on: string | null; amount_cents: number; property_title: string; status: string }
const CHARGE_STATUS: Record<string, string> = { paid: 'Pago pelo inquilino', open: 'A vencer', overdue: 'Em atraso' };

export function PortalHome() {
  const sum = useApi<Summary>('/api/portal/summary');
  const ch = useApi<{ items: Charge[] }>('/api/portal/charges');
  if (sum.loading && !sum.data) return <Skeleton rows={4} />;
  if (sum.error || !sum.data) return <ErrorBox message={sum.error ?? ''} onRetry={sum.reload} />;
  const s = sum.data;
  const kpis: [string, string, string?][] = [
    ['Imóveis', String(s.properties), `${s.rentedProperties} alugado(s)`],
    ['Aluguéis por mês', money(s.monthlyRentCents), 'soma dos contratos ativos'],
    ['Repasses a receber', money(s.payoutPendingCents), `${s.payoutPendingCount} repasse(s)`],
    ['Recebido em 12 meses', money(s.payoutReceived12mCents), 'repasses já realizados'],
  ];
  return (
    <>
      <h1>Seu patrimônio</h1>
      <p className="sub">Acompanhe seus imóveis, aluguéis e repasses. Se algo não estiver certo, fale com a imobiliária.</p>
      {s.overdueCharges > 0 && <div className="alert media" role="note"><div>{s.overdueCharges} aluguel(is) em atraso nos seus imóveis. A imobiliária já está cuidando da cobrança.</div></div>}
      <div className="grid kpis">
        {kpis.map(([l, v, h]) => <div className="card kpi" key={l}><div className="label">{l}</div><div className="value">{v}</div>{h && <div className="hint">{h}</div>}</div>)}
      </div>
      <section className="card table-wrap" aria-labelledby="alug">
        <h2 id="alug" style={{ marginTop: 0, fontSize: 16 }}>Aluguéis dos seus imóveis</h2>
        {ch.loading && !ch.data ? <Skeleton rows={3} /> : ch.error || !ch.data ? <ErrorBox message={ch.error ?? ''} onRetry={ch.reload} /> :
          ch.data.items.length === 0 ? <Empty text="Nenhum aluguel registrado ainda." /> : (
            <table>
              <thead><tr><th>Competência</th><th>Imóvel</th><th>Vencimento</th><th>Valor</th><th>Situação</th></tr></thead>
              <tbody>{ch.data.items.slice(0, 20).map((c) => (
                <tr key={c.id}><td>{c.competence}</td><td>{c.property_title}</td><td>{fmtDate(c.due_date)}</td><td>{money(c.amount_cents)}</td>
                  <td>{CHARGE_STATUS[c.status] ?? c.status}{c.paid_on ? ` em ${fmtDate(c.paid_on)}` : ''}</td></tr>
              ))}</tbody>
            </table>
          )}
      </section>
    </>
  );
}

interface Prop {
  id: string; code: string; title: string; neighborhood: string; city: string; status: string; priceCents: number; photos: number; daysOnMarket: number;
  health: { score: number; diagnosis: string }; interest: { contacts90d: number; visitsDone90d: number; visitsUpcoming: number };
  lease: { rentCents: number; endsOn: string; renterName: string } | null;
}

export function PortalProperties() {
  const { data, error, loading, reload } = useApi<{ items: Prop[] }>('/api/portal/properties');
  if (loading && !data) return <Skeleton rows={4} />;
  if (error || !data) return <ErrorBox message={error ?? ''} onRetry={reload} />;
  return (
    <>
      <h1>Seus imóveis</h1>
      <p className="sub">Situação de cada imóvel e o interesse que ele vem recebendo, sem identificar ninguém.</p>
      {data.items.length === 0 ? <Empty text="Nenhum imóvel vinculado ao seu cadastro ainda." /> : (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
          {data.items.map((p) => (
            <article className="card" key={p.id}>
              <small style={{ color: 'var(--muted)' }}>#{p.code} · {p.neighborhood}{p.city ? `, ${p.city}` : ''}</small>
              <h2 style={{ margin: '4px 0 8px', fontSize: 16 }}>{p.title}</h2>
              {p.lease ? (
                <p style={{ margin: '0 0 8px' }}><span className="badge muito_quente">Alugado</span> {money(p.lease.rentCents)}/mês · inquilino {p.lease.renterName} · contrato até {fmtDate(p.lease.endsOn)}</p>
              ) : <p style={{ margin: '0 0 8px' }}><span className="badge">Disponível</span> {brl(p.priceCents)} · {p.daysOnMarket} dia(s) no mercado</p>}
              {!p.lease && (
                <ul style={{ margin: '0 0 8px', paddingLeft: 18, color: 'var(--muted)', fontSize: 14 }}>
                  <li>{p.interest.contacts90d} contato(s) de interessados em 90 dias</li>
                  <li>{p.interest.visitsDone90d} visita(s) realizada(s) e {p.interest.visitsUpcoming} agendada(s)</li>
                </ul>
              )}
              <div style={{ fontSize: 14 }}>Qualidade do anúncio: <strong>{p.health.score}/100</strong><br /><span style={{ color: 'var(--muted)' }}>{p.health.diagnosis}</span></div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

interface Payout { id: string; competence: string; property_title: string; gross_cents: number; admin_fee_cents: number; net_cents: number; status: string; paid_at: string | null }

export function PortalPayouts() {
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const qs = new URLSearchParams({ ...(status && { status }), ...(from && { from }), ...(to && { to }) }).toString();
  const { data, error, loading, reload } = useApi<{ items: Payout[]; totals: { grossCents: number; adminFeeCents: number; netCents: number } }>(`/api/portal/payouts${qs ? `?${qs}` : ''}`);
  async function csv() {
    try { await downloadFile(`/api/portal/statement.csv${qs ? `?${qs}` : ''}`, 'extrato-repasses.csv'); setMsg('Extrato baixado.'); }
    catch (e: any) { setMsg(e.message); }
  }
  return (
    <>
      <h1>Repasses e extrato</h1>
      <p className="sub">Quanto o inquilino pagou, a taxa de administração e o valor que é seu.</p>
      {msg && <div className="alert baixa" role="status">{msg}</div>}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', marginBottom: 16 }}>
        <div><label htmlFor="ps">Situação</label><select id="ps" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todos</option><option value="pending">A receber</option><option value="paid">Já repassados</option></select></div>
        <div><label htmlFor="pf">De (mês)</label><input id="pf" type="month" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label htmlFor="pt">Até (mês)</label><input id="pt" type="month" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <button className="btn gold" onClick={csv}>Baixar extrato (CSV)</button>
      </div>
      {loading && !data ? <Skeleton rows={4} /> : error || !data ? <ErrorBox message={error ?? ''} onRetry={reload} /> : data.items.length === 0 ? <Empty text="Nenhum repasse neste período." /> : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Competência</th><th>Imóvel</th><th>Recebido do inquilino</th><th>Taxa de administração</th><th>Líquido</th><th>Situação</th></tr></thead>
            <tbody>{data.items.map((p) => (
              <tr key={p.id}><td>{p.competence}</td><td>{p.property_title}</td><td>{money(p.gross_cents)}</td><td>{money(p.admin_fee_cents)}</td><td><strong>{money(p.net_cents)}</strong></td>
                <td>{p.status === 'paid' ? `Repassado em ${fmtDate(p.paid_at)}` : 'A repassar'}</td></tr>
            ))}</tbody>
            <tfoot><tr><td colSpan={2}><strong>Total do período</strong></td><td>{money(data.totals.grossCents)}</td><td>{money(data.totals.adminFeeCents)}</td><td><strong>{money(data.totals.netCents)}</strong></td><td /></tr></tfoot>
          </table>
        </div>
      )}
    </>
  );
}

