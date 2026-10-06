import { useState, type FormEvent } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api } from '../api';
import { useApi } from '../hooks';
import { Empty, ErrorBox, Skeleton } from '../ui';

interface Visit { id: string; scheduled_at: string; status: string; outcome: string | null; lead_name: string; property_title: string; property_code: string; broker_name: string | null }
const OUTCOMES: [string, string][] = [['gostou', 'Gostou'], ['interessado', 'Interessado'], ['nao_gostou', 'Não gostou'], ['nao_compareceu', 'Não compareceu']];
const STATUS_LABEL: Record<string, string> = { scheduled: 'Agendada', completed: 'Realizada', no_show: 'Não compareceu' };
const fmt = (d: string) => new Date(d).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function NewVisit({ onDone }: { onDone: () => void }) {
  const leads = useApi<{ items: { id: string; name: string }[] }>('/api/leads?limit=100');
  const props = useApi<{ items: { id: string; code: string; title: string }[] }>('/api/properties?limit=100');
  const [leadId, setLeadId] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [when, setWhen] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api('/api/visits', { method: 'POST', body: JSON.stringify({ leadId, propertyId, scheduledAt: new Date(when).toISOString() }) });
      setLeadId(''); setPropertyId(''); setWhen(''); onDone();
    } catch (err: any) { setMsg(err.message); }
  }

  return (
    <form className="card" onSubmit={submit} style={{ marginBottom: 24 }}>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>Agendar visita</h2>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <div><label htmlFor="v-lead">Lead</label>
          <select id="v-lead" required value={leadId} onChange={(e) => setLeadId(e.target.value)}>
            <option value="">Selecione…</option>{leads.data?.items.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select></div>
        <div><label htmlFor="v-prop">Imóvel</label>
          <select id="v-prop" required value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
            <option value="">Selecione…</option>{props.data?.items.map((p) => <option key={p.id} value={p.id}>#{p.code} · {p.title}</option>)}
          </select></div>
        <div><label htmlFor="v-when">Data e hora</label><input id="v-when" type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} /></div>
      </div>
      {msg && <div className="error-box" role="alert" style={{ marginTop: 12 }}>{msg}</div>}
      <button className="btn gold" style={{ marginTop: 12 }}>Agendar</button>
    </form>
  );
}

function Feedback({ id, onDone }: { id: string; onDone: () => void }) {
  const [outcome, setOutcome] = useState('interessado');
  const [notes, setNotes] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try { await api(`/api/visits/${id}/feedback`, { method: 'POST', body: JSON.stringify({ outcome, notes }) }); onDone(); }
    catch (err: any) { setMsg(err.message); }
  }
  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', marginTop: 8 }}>
      <div style={{ minWidth: 160 }}><label htmlFor={`o-${id}`}>Resultado</label>
        <select id={`o-${id}`} value={outcome} onChange={(e) => setOutcome(e.target.value)}>{OUTCOMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
      <div style={{ flex: 1, minWidth: 200 }}><label htmlFor={`n-${id}`}>Observação (objeção, próximo passo)</label>
        <input id={`n-${id}`} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      <button className="btn">Registrar</button>
      {msg && <span role="alert" style={{ color: 'var(--danger)' }}>{msg}</span>}
    </form>
  );
}

export default function Agenda() {
  const [params] = useSearchParams();
  const filtro = params.get('filtro');
  const { data, error, loading, reload } = useApi<{ items: Visit[] }>(`/api/visits${filtro === 'sem-feedback' ? '?filtro=sem-feedback' : ''}`);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <h1>Agenda de visitas</h1>
      <p className="sub">Visitas passadas sem resultado alimentam o score e o matching quando registradas.</p>
      <NewVisit onDone={reload} />
      {filtro && <p>Filtro ativo: <strong>visitas sem feedback</strong> · <Link to="/agenda">limpar filtro</Link></p>}
      {loading ? <Skeleton rows={4} /> : error || !data ? <ErrorBox message={error ?? ''} onRetry={reload} /> : data.items.length === 0 ? (
        <Empty text="Nenhuma visita encontrada." />
      ) : (
        <div className="card">
          {data.items.map((v) => {
            const overdue = v.status === 'scheduled' && new Date(v.scheduled_at) < new Date();
            return (
              <div key={v.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div><strong>{v.lead_name}</strong> · #{v.property_code} {v.property_title}
                    <br /><small style={{ color: 'var(--muted)' }}>{fmt(v.scheduled_at)}{v.broker_name ? ` · ${v.broker_name}` : ''}</small></div>
                  <div>
                    <span className="badge">{STATUS_LABEL[v.status] ?? v.status}{v.outcome ? ` · ${OUTCOMES.find(([k]) => k === v.outcome)?.[1]}` : ''}</span>{' '}
                    {overdue && <button className="btn ghost" aria-expanded={open === v.id} onClick={() => setOpen(open === v.id ? null : v.id)}>Registrar resultado</button>}
                  </div>
                </div>
                {open === v.id && <Feedback id={v.id} onDone={() => { setOpen(null); reload(); }} />}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
