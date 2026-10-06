import { useState } from 'react';
import { api, brl } from '../api';
import { useApi } from '../hooks';
import { ErrorBox, Skeleton } from '../ui';

interface Card { id: string; name: string; score: number; budget_cents: string | null }
interface Board { stages: { position: number; label: string; leads: Card[] }[] }

export default function Pipeline() {
  const { data, error, loading, reload } = useApi<Board>('/api/pipeline/venda');
  const [msg, setMsg] = useState<string | null>(null);

  async function move(id: string, position: number) {
    try {
      const r = await api<{ stage: string; won: boolean }>(`/api/leads/${id}/stage`, { method: 'POST', body: JSON.stringify({ position }) });
      setMsg(r.won ? 'Negócio fechado. Parabéns!' : `Movido para "${r.stage}".`);
      reload();
    } catch (e: any) { setMsg(e.message); }
  }

  return (
    <>
      <h1>Pipeline de vendas</h1>
      <p className="sub">Mova cada oportunidade pelas etapas. Cada mudança é registrada na auditoria.</p>
      {msg && <div className="alert baixa" role="status">{msg}</div>}
      {loading && !data ? <Skeleton rows={5} /> : error || !data ? <ErrorBox message={error ?? ''} onRetry={reload} /> : (
        <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 12 }}>
          {data.stages.map((st) => (
            <section key={st.position} aria-label={st.label} style={{ minWidth: 230, flex: '0 0 230px' }}>
              <h2 style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{st.label} · {st.leads.length}</h2>
              <div className="grid" style={{ gap: 8 }}>
                {st.leads.slice(0, 15).map((c) => (
                  <div className="card" key={c.id} style={{ padding: 12 }}>
                    <strong>{c.name}</strong>
                    <div style={{ color: 'var(--muted)', fontSize: 13 }}>{brl(c.budget_cents)} · score {c.score}</div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <button className="btn ghost" disabled={st.position === 0} aria-label={`Voltar ${c.name} uma etapa`} onClick={() => move(c.id, st.position - 1)}>←</button>
                      <button className="btn ghost" aria-label={`Avançar ${c.name} uma etapa`} onClick={() => move(c.id, st.position + 1)}>→</button>
                    </div>
                  </div>
                ))}
                {st.leads.length > 15 && <small style={{ color: 'var(--muted)' }}>+ {st.leads.length - 15} oportunidades</small>}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
