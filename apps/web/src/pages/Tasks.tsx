import { useState } from 'react';
import { api, getSession } from '../api';
import { useApi } from '../hooks';
import { Empty, ErrorBox, Skeleton } from '../ui';

interface Task { id: string; title: string; due_at: string | null; source: string; lead_name: string | null; assignee_name: string | null }
interface Notes { items: { id: string; message: string; read_at: string | null; created_at: string; count: number }[]; unread: number }
const fmt = (d: string) => new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export default function Tasks() {
  const isManager = ['owner', 'manager'].includes(getSession()?.user.role ?? '');
  const [scope, setScope] = useState<'minhas' | 'todas'>('minhas');
  const tasks = useApi<{ items: Task[] }>(`/api/tasks?escopo=${scope}`);
  const notes = useApi<Notes>('/api/notifications');
  const [msg, setMsg] = useState<string | null>(null);

  async function complete(id: string) {
    try { await api(`/api/tasks/${id}/complete`, { method: 'POST' }); setMsg('Tarefa concluída.'); tasks.reload(); }
    catch (e: any) { setMsg(e.message); }
  }
  async function markRead() { await api('/api/notifications/read', { method: 'POST' }); notes.reload(); }

  return (
    <>
      <h1>Minha operação</h1>
      <p className="sub">Tarefas e avisos, inclusive os criados pelas automações.</p>
      {msg && <div className="alert baixa" role="status">{msg}</div>}

      <section className="card" style={{ marginBottom: 16 }} aria-labelledby="avisos">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 id="avisos" style={{ margin: 0, fontSize: 16 }}>Avisos {notes.data && notes.data.unread > 0 && <span className="badge muito_quente">{notes.data.unread} novos</span>}</h2>
          {notes.data && notes.data.unread > 0 && <button className="btn ghost" onClick={markRead}>Marcar como lidos</button>}
        </div>
        {notes.loading ? <Skeleton rows={2} /> : notes.error ? <ErrorBox message={notes.error} onRetry={notes.reload} /> :
          !notes.data?.items.length ? <Empty text="Nenhum aviso por enquanto." /> : (
            <ul style={{ margin: '12px 0 0', paddingLeft: 18 }}>
              {notes.data.items.slice(0, 8).map((n) => <li key={n.id} style={{ fontWeight: n.read_at ? 400 : 600 }}>{n.message}{n.count > 1 ? ` (${n.count} ocorrências)` : ''} <small style={{ color: 'var(--muted)' }}>{fmt(n.created_at)}</small></li>)}
            </ul>
          )}
      </section>

      <section className="card" aria-labelledby="tarefas">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h2 id="tarefas" style={{ margin: 0, fontSize: 16 }}>Tarefas abertas</h2>
          {isManager && (
            <select aria-label="Escopo das tarefas" value={scope} onChange={(e) => setScope(e.target.value as any)} style={{ width: 'auto' }}>
              <option value="minhas">Minhas</option><option value="todas">Da equipe</option>
            </select>
          )}
        </div>
        {tasks.loading ? <Skeleton rows={4} /> : tasks.error || !tasks.data ? <ErrorBox message={tasks.error ?? ''} onRetry={tasks.reload} /> :
          tasks.data.items.length === 0 ? <Empty text="Nenhuma tarefa aberta. Tudo em dia." /> : tasks.data.items.map((t) => {
            const late = t.due_at && new Date(t.due_at) < new Date();
            return (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                <div>
                  <strong>{t.title}</strong>{t.source === 'automation' && <> <span className="badge">automação</span></>}
                  <br /><small style={{ color: late ? 'var(--danger)' : 'var(--muted)' }}>
                    {t.lead_name ?? 'sem lead'}{scope === 'todas' && t.assignee_name ? ` · ${t.assignee_name}` : ''}{t.due_at ? ` · ${late ? 'atrasada desde' : 'até'} ${fmt(t.due_at)}` : ''}
                  </small>
                </div>
                <button className="btn ghost" onClick={() => complete(t.id)}>Concluir</button>
              </div>
            );
          })}
      </section>
    </>
  );
}
