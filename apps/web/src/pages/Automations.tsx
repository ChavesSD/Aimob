import { useState } from 'react';
import { api } from '../api';
import { useApi } from '../hooks';
import { ErrorBox, Skeleton } from '../ui';

interface Rule { id: string; name: string; trigger: string; autonomy: 'automatic' | 'assisted'; enabled: boolean }
interface Run { id: string; status: string; detail: string | null; created_at: string; rule_name: string; lead_name: string | null }
interface Tpl { id: string; name: string; description: string; trigger: string; autonomy: 'automatic' | 'assisted' }
interface Data { rules: Rule[]; runs: Run[]; templates: Tpl[] }

const TRIGGER: Record<string, string> = { 'lead.created': 'Quando um lead chega', 'lead.idle': 'Quando um lead fica parado', 'visit.completed': 'Quando uma visita é concluída', 'lead.stage_changed': 'Quando o lead muda de etapa' };
const STATUS: Record<string, string> = { executed: 'Executada', pending_approval: 'Aguardando aprovação', rejected: 'Rejeitada', failed: 'Falhou', executing: 'Em execução' };
const AUTONOMY: Record<string, string> = { automatic: 'Automática', assisted: 'Assistida (pede aprovação)' };
const fmt = (d: string) => new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export default function Automations() {
  const { data, error, loading, reload } = useApi<Data>('/api/automations');
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); setMsg(ok); reload(); } catch (e: any) { setMsg(e.message); }
  };

  if (loading && !data) return <Skeleton rows={6} />;
  if (error || !data) return <ErrorBox message={error ?? ''} onRetry={reload} />;
  const pending = data.runs.filter((r) => r.status === 'pending_approval');
  const have = new Set(data.rules.map((r) => r.name));

  return (
    <>
      <h1>Automações</h1>
      <p className="sub">Quando → se → então. Toda execução fica registrada e qualquer regra pode ser desligada. Hoje as ações são internas (tarefas, avisos e distribuição); envio de mensagens externas ainda não está disponível.</p>
      {msg && <div className="alert baixa" role="status">{msg}</div>}

      {pending.length > 0 && (
        <section className="card" style={{ marginBottom: 16, borderColor: 'var(--gold)' }} aria-labelledby="apr">
          <h2 id="apr" style={{ marginTop: 0, fontSize: 16 }}>Aguardando sua aprovação ({pending.length})</h2>
          {pending.map((r) => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', flexWrap: 'wrap' }}>
              <div>{r.rule_name}<br /><small style={{ color: 'var(--muted)' }}>{r.lead_name ?? '—'} · {fmt(r.created_at)}</small></div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn gold" onClick={() => run(() => api(`/api/automation-runs/${r.id}/approve`, { method: 'POST' }), 'Execução aprovada.')}>Aprovar</button>
                <button className="btn ghost" onClick={() => run(() => api(`/api/automation-runs/${r.id}/reject`, { method: 'POST' }), 'Execução rejeitada.')}>Rejeitar</button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section style={{ marginBottom: 24 }} aria-labelledby="mod">
        <h2 id="mod" style={{ fontSize: 16 }}>Modelos prontos</h2>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          {data.templates.map((t) => (
            <div className="card" key={t.id}>
              <small style={{ color: 'var(--gold)' }}>{TRIGGER[t.trigger]}</small>
              <h3 style={{ margin: '4px 0', fontSize: 15 }}>{t.name}</h3>
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>{t.description}</p>
              <p style={{ fontSize: 12, color: 'var(--muted)' }}>{AUTONOMY[t.autonomy]}</p>
              <button className="btn" disabled={have.has(t.name)} onClick={() => run(() => api('/api/automations', { method: 'POST', body: JSON.stringify({ templateId: t.id }) }), 'Automação ativada.')}>
                {have.has(t.name) ? 'Já ativada' : 'Ativar'}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="card" style={{ marginBottom: 24 }} aria-labelledby="ativas">
        <h2 id="ativas" style={{ marginTop: 0, fontSize: 16 }}>Suas automações</h2>
        {data.rules.length === 0 ? <p style={{ color: 'var(--muted)' }}>Nenhuma automação ativa ainda. Ative um modelo acima.</p> : data.rules.map((r) => (
          <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
            <div>{r.name}<br /><small style={{ color: 'var(--muted)' }}>{TRIGGER[r.trigger]} · {AUTONOMY[r.autonomy]}</small></div>
            <button className={r.enabled ? 'btn ghost' : 'btn'} onClick={() => run(() => api(`/api/automations/${r.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !r.enabled }) }), r.enabled ? 'Automação desligada.' : 'Automação ligada.')}>
              {r.enabled ? 'Desligar' : 'Ligar'}
            </button>
          </div>
        ))}
        <button className="btn ghost" style={{ marginTop: 12 }} onClick={() => run(async () => { await api('/api/automations/sweep', { method: 'POST' }); }, 'Verificação concluída.')}>Verificar leads parados agora</button>
      </section>

      <section className="card table-wrap" aria-labelledby="log">
        <h2 id="log" style={{ marginTop: 0, fontSize: 16 }}>Histórico de execuções</h2>
        {data.runs.length === 0 ? <p style={{ color: 'var(--muted)' }}>Nenhuma execução ainda.</p> : (
          <table>
            <thead><tr><th>Quando</th><th>Automação</th><th>Lead</th><th>Resultado</th></tr></thead>
            <tbody>{data.runs.map((r) => (
              <tr key={r.id}><td>{fmt(r.created_at)}</td><td>{r.rule_name}</td><td>{r.lead_name ?? '—'}</td><td>{STATUS[r.status] ?? r.status}{r.detail ? ` — ${r.detail}` : ''}</td></tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </>
  );
}
