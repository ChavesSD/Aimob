import { useState } from 'react';
import { downloadFile } from '../api';
import { useApi } from '../hooks';
import { Empty, ErrorBox, Skeleton } from '../ui';

// Portal do inquilino: somente leitura, só o contrato dele. Valores sempre com centavos.
const money = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');

interface Summary {
  contracts: { id: string; status: string; rentCents: number; dueDay: number; startsOn: string; endsOn: string; property: { title: string; code: string; neighborhood: string; city: string } }[];
  nextCharge: { competence: string; dueOn: string; amountCents: number } | null;
  overdue: { count: number; principalCents: number };
}
interface Charge {
  id: string; competence: string; property: string; dueOn: string; amountCents: number; status: string; paidOn: string | null; paidCents: number | null;
  lateEstimate: { daysLate: number; lateFeeCents: number; interestCents: number; totalCents: number } | null;
  payment: { url: string | null; boletoUrl: string | null; pixPayload: string | null } | null;
}
const STATUS: Record<string, string> = { open: 'A vencer', overdue: 'Em atraso', paid: 'Pago' };

export function RenterHome() {
  const { data, error, loading, reload } = useApi<Summary>('/api/renter/summary');
  if (loading && !data) return <Skeleton rows={4} />;
  if (error || !data) return <ErrorBox message={error ?? ''} onRetry={reload} />;
  const active = data.contracts.filter((c) => c.status === 'active');
  return (
    <>
      <h1>Seu aluguel</h1>
      <p className="sub">Acompanhe o contrato, as cobranças e como pagar. Qualquer dúvida, fale com a imobiliária.</p>
      {data.overdue.count > 0 && <div className="alert alta" role="alert"><div>Você tem {data.overdue.count} aluguel(is) em atraso ({money(data.overdue.principalCents)} sem multa e juros). Veja como regularizar em <strong>Pagamentos</strong>.</div></div>}
      {data.nextCharge && (
        <section className="card" style={{ marginBottom: 16 }} aria-labelledby="prox">
          <h2 id="prox" style={{ marginTop: 0, fontSize: 16 }}>Próximo vencimento</h2>
          <div className="kpi"><div className="value">{money(data.nextCharge.amountCents)}</div><div className="hint">vence em {fmtDate(data.nextCharge.dueOn)} · competência {data.nextCharge.competence}</div></div>
        </section>
      )}
      {active.length === 0 ? <Empty text="Nenhum contrato ativo no seu cadastro." /> : active.map((c) => (
        <section className="card" key={c.id} style={{ marginBottom: 16 }}>
          <small style={{ color: 'var(--muted)' }}>#{c.property.code} · {c.property.neighborhood}{c.property.city ? `, ${c.property.city}` : ''}</small>
          <h2 style={{ margin: '4px 0 8px', fontSize: 16 }}>{c.property.title}</h2>
          <p style={{ margin: 0 }}>Aluguel de <strong>{money(c.rentCents)}</strong> por mês, vencimento todo dia {c.dueDay}. Contrato de {fmtDate(c.startsOn)} a {fmtDate(c.endsOn)}.</p>
        </section>
      ))}
    </>
  );
}

function CopyPix({ payload }: { payload: string }) {
  const [ok, setOk] = useState(false);
  return <button type="button" className="btn ghost" onClick={async () => { try { await navigator.clipboard.writeText(payload); setOk(true); setTimeout(() => setOk(false), 1600); } catch { /* sem permissão */ } }}>{ok ? 'Copiado' : 'Copiar Pix'}</button>;
}

export function RenterPayments() {
  const { data, error, loading, reload } = useApi<{ items: Charge[] }>('/api/renter/charges');
  if (loading && !data) return <Skeleton rows={5} />;
  if (error || !data) return <ErrorBox message={error ?? ''} onRetry={reload} />;
  return (
    <>
      <h1>Pagamentos</h1>
      <p className="sub">Boleto e Pix emitidos pela imobiliária aparecem aqui. Se uma cobrança não tiver as opções de pagamento, peça a emissão à imobiliária.</p>
      {data.items.length === 0 ? <Empty text="Nenhuma cobrança ainda." /> : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Competência</th><th>Vencimento</th><th>Valor</th><th>Situação</th><th>Como pagar</th></tr></thead>
            <tbody>{data.items.map((c) => (
              <tr key={c.id}>
                <td>{c.competence}<br /><small style={{ color: 'var(--muted)' }}>{c.property}</small></td>
                <td>{fmtDate(c.dueOn)}</td>
                <td>{money(c.amountCents)}</td>
                <td>{STATUS[c.status] ?? c.status}{c.paidOn ? ` em ${fmtDate(c.paidOn)}` : ''}{c.paidCents ? <><br /><small style={{ color: 'var(--muted)' }}>pago {money(c.paidCents)}</small></> : null}
                  {c.lateEstimate && <><br /><small style={{ color: 'var(--danger)' }}>{c.lateEstimate.daysLate} dia(s) de atraso: multa {money(c.lateEstimate.lateFeeCents)} + juros {money(c.lateEstimate.interestCents)} = cerca de {money(c.lateEstimate.totalCents)} (valor final no boleto ou Pix emitido)</small></>}</td>
                <td>{c.payment ? (
                  <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {c.payment.url && <a className="btn gold" href={c.payment.url} target="_blank" rel="noopener noreferrer">Pagar agora</a>}
                    {c.payment.boletoUrl && <a className="btn ghost" href={c.payment.boletoUrl} target="_blank" rel="noopener noreferrer">Boleto (PDF)</a>}
                    {c.payment.pixPayload && <CopyPix payload={c.payment.pixPayload} />}
                  </span>
                ) : c.status === 'paid' ? '—' : <small style={{ color: 'var(--muted)' }}>Ainda não emitido</small>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

interface Doc { id: string; title: string; status: string; signedAt: string | null; hasPdf: boolean; files: { id: string; filename: string; size: number }[] }

export function RenterContract() {
  const { data, error, loading, reload } = useApi<{ items: Doc[] }>('/api/renter/documents');
  const [msg, setMsg] = useState<string | null>(null);
  const dl = (path: string, name: string) => downloadFile(path, name).catch((e) => setMsg(e.message));
  if (loading && !data) return <Skeleton rows={3} />;
  if (error || !data) return <ErrorBox message={error ?? ''} onRetry={reload} />;
  return (
    <>
      <h1>Contrato</h1>
      <p className="sub">Seu contrato de locação, para leitura e guarda.</p>
      {msg && <div className="error-box" role="alert">{msg}</div>}
      {data.items.length === 0 ? <Empty text="Nenhum contrato disponível ainda. Ele aparece aqui quando a imobiliária o envia para assinatura." /> : data.items.map((d) => (
        <section className="card" key={d.id} style={{ marginBottom: 16 }}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>{d.title} <span className="badge">{d.status === 'signed' ? 'Assinado' : 'Aguardando assinaturas'}</span></h2>
          {d.signedAt && <p style={{ color: 'var(--muted)' }}>Assinado em {fmtDate(d.signedAt)}.</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {d.hasPdf && <button className="btn ghost" onClick={() => dl(`/api/renter/documents/${d.id}/pdf`, `${d.title}.pdf`)}>Baixar contrato (PDF)</button>}
            {d.files.map((f) => <button key={f.id} className="btn gold" onClick={() => dl(`/api/renter/documents/${d.id}/files/${f.id}`, f.filename)}>Baixar assinado ({(f.size / 1024).toFixed(0)} KB)</button>)}
          </div>
        </section>
      ))}
    </>
  );
}
