import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useApi } from '../hooks';
import { Empty, ErrorBox, Skeleton } from '../ui';

// Chamados de manutenção: inquilino (abre e conversa), proprietário (acompanha) e equipe (trata).
const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const STATUS: Record<string, string> = { open: 'Aberto', in_progress: 'Em andamento', waiting_tenant: 'Aguardando o inquilino', resolved: 'Resolvido', canceled: 'Cancelado' };
const CATEGORY: Record<string, string> = { hydraulic: 'Hidráulica', electrical: 'Elétrica', structural: 'Estrutura', appliance: 'Equipamento', other: 'Outro' };
const URGENCY: Record<string, string> = { low: 'Pode esperar', normal: 'Normal', urgent: 'Urgente' };

interface Item {
  id: string; title: string; description: string; category: string; urgency: string; status: string;
  property: { title: string; code: string }; createdAt: string; updatedAt: string; resolvedAt: string | null;
}
interface Msg { id: string; from: 'renter' | 'staff'; body: string; at: string; internal?: boolean }
interface Detail extends Item { messages: Msg[]; renterName?: string }

const Urgent = ({ u }: { u: string }) => (u === 'urgent' ? <span className="badge quente">Urgente</span> : null);
const isActive = (s: string) => ['open', 'in_progress', 'waiting_tenant'].includes(s);

function Thread({ messages, mineIs }: { messages: Msg[]; mineIs: 'renter' | 'staff' }) {
  if (!messages.length) return <p style={{ color: 'var(--muted)' }}>Nenhuma mensagem ainda.</p>;
  return (
    <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }} aria-label="Conversa">
      {messages.map((m) => (
        <li key={m.id} className="card" style={{ padding: 12, borderColor: m.internal ? 'var(--warn)' : undefined, marginLeft: m.from === mineIs ? 24 : 0 }}>
          <small style={{ color: 'var(--muted)' }}>{m.internal ? 'Nota interna (só a equipe vê)' : m.from === 'renter' ? 'Inquilino' : 'Imobiliária'} · {fmtDateTime(m.at)}</small>
          <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
        </li>
      ))}
    </ul>
  );
}

function Reply({ onSend, internalOption, disabled }: { onSend: (body: string, internal: boolean) => Promise<void>; internalOption?: boolean; disabled?: boolean }) {
  const [body, setBody] = useState(''); const [internal, setInternal] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await onSend(body.trim(), internal); setBody(''); } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  }
  if (disabled) return <p style={{ color: 'var(--muted)' }}>Este chamado está encerrado.</p>;
  return (
    <form onSubmit={submit} style={{ marginTop: 12 }}>
      <label htmlFor="reply">Mensagem</label>
      <textarea id="reply" rows={3} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} required />
      {internalOption && <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Nota interna (o inquilino não vê)</label>}
      {err && <div className="error-box" role="alert">{err}</div>}
      <button className="btn" disabled={busy || !body.trim()} style={{ marginTop: 8 }}>{busy ? 'Enviando…' : internal ? 'Salvar nota' : 'Enviar'}</button>
    </form>
  );
}

/* ---------- Inquilino ---------- */
export function RenterMaintenance() {
  const list = useApi<{ items: Item[] }>('/api/renter/maintenance');
  const sum = useApi<{ contracts: { id: string; status: string; property: { title: string; code: string } }[] }>('/api/renter/summary');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  if ((list.loading && !list.data) || (sum.loading && !sum.data)) return <Skeleton rows={4} />;
  if (list.error || !list.data) return <ErrorBox message={list.error ?? ''} onRetry={list.reload} />;
  const contracts = sum.data?.contracts.filter((c) => c.status === 'active') ?? [];
  return (
    <>
      <h1>Chamados</h1>
      <p className="sub">Algo quebrou ou precisa de reparo? Abra um chamado e acompanhe aqui. Em risco imediato (vazamento de gás, incêndio), ligue para os serviços de emergência antes.</p>
      {contracts.length > 0 && !creating && <button className="btn gold" onClick={() => setCreating(true)} style={{ marginBottom: 16 }}>Abrir chamado</button>}
      {creating && <NewRequest contracts={contracts} onDone={() => { setCreating(false); list.reload(); }} onCancel={() => setCreating(false)} />}
      {list.data.items.length === 0 ? <Empty text="Você ainda não abriu nenhum chamado." /> : list.data.items.map((i) => (
        <section className="card" key={i.id} style={{ marginBottom: 12 }}>
          <button className="btn ghost row-btn" aria-expanded={open === i.id} onClick={() => setOpen(open === i.id ? null : i.id)}>
            <strong>{i.title}</strong> <span className="badge">{STATUS[i.status]}</span> <Urgent u={i.urgency} />
            <br /><small style={{ color: 'var(--muted)' }}>#{i.property.code} · {CATEGORY[i.category]} · aberto em {fmtDateTime(i.createdAt)}</small>
          </button>
          {open === i.id && <RenterDetail id={i.id} onChanged={list.reload} />}
        </section>
      ))}
    </>
  );
}

function NewRequest({ contracts, onDone, onCancel }: { contracts: { id: string; property: { title: string; code: string } }[]; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ contractId: contracts[0]?.id ?? '', title: '', description: '', category: 'other', urgency: 'normal' });
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api('/api/renter/maintenance', { method: 'POST', body: JSON.stringify(f) }); onDone(); } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  }
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="card" onSubmit={submit} style={{ marginBottom: 16, display: 'grid', gap: 12 }} aria-label="Novo chamado">
      {contracts.length > 1 && <div><label htmlFor="mc">Imóvel</label><select id="mc" value={f.contractId} onChange={set('contractId')}>{contracts.map((c) => <option key={c.id} value={c.id}>#{c.property.code} {c.property.title}</option>)}</select></div>}
      <div><label htmlFor="mt">O que aconteceu?</label><input id="mt" value={f.title} maxLength={120} required onChange={set('title')} placeholder="Ex.: vazamento na pia da cozinha" /></div>
      <div><label htmlFor="md">Detalhes</label><textarea id="md" rows={4} maxLength={2000} required value={f.description} onChange={set('description')} /></div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div><label htmlFor="mk">Tipo</label><select id="mk" value={f.category} onChange={set('category')}>{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div><label htmlFor="mu">Urgência</label><select id="mu" value={f.urgency} onChange={set('urgency')}>{Object.entries(URGENCY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
      </div>
      {err && <div className="error-box" role="alert">{err}</div>}
      <div style={{ display: 'flex', gap: 8 }}><button className="btn gold" disabled={busy || !f.title.trim() || !f.description.trim()}>{busy ? 'Enviando…' : 'Enviar chamado'}</button><button type="button" className="btn ghost" onClick={onCancel}>Cancelar</button></div>
    </form>
  );
}

function RenterDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { data, error, loading, reload } = useApi<Detail>(`/api/renter/maintenance/${id}`);
  const [err, setErr] = useState<string | null>(null);
  if (loading && !data) return <Skeleton rows={2} />;
  if (error || !data) return <ErrorBox message={error ?? ''} onRetry={reload} />;
  async function cancel() {
    if (!confirm('Cancelar este chamado? Esta ação não pode ser desfeita.')) return;
    try { await api(`/api/renter/maintenance/${id}/cancel`, { method: 'POST' }); reload(); onChanged(); } catch (x: any) { setErr(x.message); }
  }
  return (
    <div style={{ marginTop: 12 }}>
      <p style={{ whiteSpace: 'pre-wrap' }}>{data.description}</p>
      <Thread messages={data.messages} mineIs="renter" />
      {err && <div className="error-box" role="alert">{err}</div>}
      <Reply disabled={!isActive(data.status)} onSend={async (body) => { await api(`/api/renter/maintenance/${id}/messages`, { method: 'POST', body: JSON.stringify({ body }) }); reload(); onChanged(); }} />
      {isActive(data.status) && <button className="btn ghost" style={{ marginTop: 8 }} onClick={cancel}>Cancelar chamado</button>}
    </div>
  );
}

/* ---------- Proprietário ---------- */
export function PortalMaintenance() {
  const { data, error, loading, reload } = useApi<{ items: Item[] }>('/api/portal/maintenance');
  if (loading && !data) return <Skeleton rows={4} />;
  if (error || !data) return <ErrorBox message={error ?? ''} onRetry={reload} />;
  return (
    <>
      <h1>Manutenção</h1>
      <p className="sub">Chamados abertos pelos inquilinos nos seus imóveis. A conversa com o inquilino fica com a imobiliária.</p>
      {data.items.length === 0 ? <Empty text="Nenhum chamado nos seus imóveis." /> : (
        <div className="card table-wrap"><table>
          <thead><tr><th>Imóvel</th><th>Problema</th><th>Situação</th><th>Aberto em</th></tr></thead>
          <tbody>{data.items.map((i) => (
            <tr key={i.id}><td>#{i.property.code}<br /><small style={{ color: 'var(--muted)' }}>{i.property.title}</small></td>
              <td>{i.title} <Urgent u={i.urgency} /><br /><small style={{ color: 'var(--muted)' }}>{CATEGORY[i.category]}</small></td>
              <td>{STATUS[i.status]}{i.resolvedAt ? <><br /><small style={{ color: 'var(--muted)' }}>em {fmtDateTime(i.resolvedAt)}</small></> : null}</td>
              <td>{fmtDateTime(i.createdAt)}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}

/* ---------- Equipe (aba de Locação) ---------- */
interface StaffItem { id: string; title: string; category: string; urgency: string; status: string; createdAt: string; property: { title: string; code: string }; renterName: string; messages: number }

export function StaffMaintenance({ notify }: { notify: (m: string) => void }) {
  const [only, setOnly] = useState(true);
  const { data, error, loading, reload } = useApi<{ items: StaffItem[] }>(`/api/maintenance${only ? '?active=1' : ''}`);
  const [open, setOpen] = useState<string | null>(null);
  if (loading && !data) return <Skeleton rows={4} />;
  if (error || !data) return <ErrorBox message={error ?? ''} onRetry={reload} />;
  return (
    <>
      <label className="check" style={{ marginBottom: 12 }}><input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> Mostrar só os em andamento</label>
      {data.items.length === 0 ? <Empty text="Nenhum chamado de manutenção." /> : data.items.map((i) => (
        <section className="card" key={i.id} style={{ marginBottom: 12 }}>
          <button className="btn ghost row-btn" aria-expanded={open === i.id} onClick={() => setOpen(open === i.id ? null : i.id)}>
            <strong>{i.title}</strong> <span className="badge">{STATUS[i.status]}</span> <Urgent u={i.urgency} />
            <br /><small style={{ color: 'var(--muted)' }}>#{i.property.code} · {i.renterName} · {CATEGORY[i.category]} · {fmtDateTime(i.createdAt)} · {i.messages} mensagem(ns)</small>
          </button>
          {open === i.id && <StaffDetail id={i.id} onChanged={reload} notify={notify} />}
        </section>
      ))}
    </>
  );
}

function StaffDetail({ id, onChanged, notify }: { id: string; onChanged: () => void; notify: (m: string) => void }) {
  const { data, error, loading, reload } = useApi<Detail>(`/api/maintenance/${id}`);
  const [err, setErr] = useState<string | null>(null);
  if (loading && !data) return <Skeleton rows={2} />;
  if (error || !data) return <ErrorBox message={error ?? ''} onRetry={reload} />;
  async function setStatus(status: string) {
    setErr(null);
    try { await api(`/api/maintenance/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); notify(`Chamado marcado como "${STATUS[status].toLowerCase()}".`); reload(); onChanged(); } catch (x: any) { setErr(x.message); }
  }
  const canceled = data.status === 'canceled';
  return (
    <div style={{ marginTop: 12 }}>
      <p style={{ whiteSpace: 'pre-wrap' }}>{data.description}</p>
      {!canceled && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }} role="group" aria-label="Alterar situação">
          {['open', 'in_progress', 'waiting_tenant', 'resolved'].map((s) => <button key={s} className={data.status === s ? 'btn' : 'btn ghost'} aria-pressed={data.status === s} disabled={data.status === s} onClick={() => setStatus(s)}>{STATUS[s]}</button>)}
        </div>
      )}
      {err && <div className="error-box" role="alert">{err}</div>}
      <Thread messages={data.messages} mineIs="staff" />
      <Reply internalOption disabled={canceled} onSend={async (body, internal) => { await api(`/api/maintenance/${id}/messages`, { method: 'POST', body: JSON.stringify({ body, internal }) }); reload(); onChanged(); }} />
    </div>
  );
}
