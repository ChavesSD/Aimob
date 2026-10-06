import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, brl, getSession } from '../api';
import { useApi } from '../hooks';
import { Empty, ErrorBox, Skeleton } from '../ui';

interface Lead {
  id: string; name: string; phone: string | null; source: string; stage_position: number; score: number;
  score_reasons: string[]; budget_cents: string | null; owner_id: string | null; owner_name: string | null;
}
interface Team { items: { id: string; name: string; role: string; accepts_leads: boolean; open_leads: number }[]; distributionMode: 'manual' | 'roundrobin' }

const FILTER_LABELS: Record<string, string> = {
  'sem-atendimento': 'sem primeiro atendimento', paradas: 'sem contato há mais de 3 dias',
  'sem-proxima-acao': 'sem próxima ação', 'sem-responsavel': 'sem corretor responsável',
};
const heat = (s: number) => (s >= 75 ? 'muito_quente' : s >= 55 ? 'quente' : s >= 30 ? 'morno' : 'frio');
const heatLabel: Record<string, string> = { muito_quente: 'Muito quente', quente: 'Quente', morno: 'Morno', frio: 'Frio' };

export default function Leads() {
  const [params] = useSearchParams();
  const filtro = params.get('filtro');
  const isManager = ['owner', 'manager'].includes(getSession()?.user.role ?? '');
  const { data, error, loading, reload } = useApi<{ items: Lead[] }>(`/api/leads?limit=50${filtro ? `&filtro=${encodeURIComponent(filtro)}` : ''}`);
  const team = useApi<Team>('/api/team');
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function run(fn: () => Promise<string>) {
    try { setMsg(await fn()); reload(); team.reload(); } catch (e: any) { setMsg(e.message); }
  }
  const contacted = (id: string) => run(async () => { await api(`/api/leads/${id}/contact`, { method: 'POST' }); return 'Contato registrado.'; });
  const assign = (id: string, ownerId: string) => run(async () => {
    const r = await api<{ ownerName: string }>(`/api/leads/${id}/assign`, { method: 'POST', body: JSON.stringify({ ownerId }) });
    return `Lead atribuído a ${r.ownerName}.`;
  });
  const distribute = () => run(async () => {
    const r = await api<{ distributed: number }>('/api/leads/distribute', { method: 'POST' });
    return `${r.distributed} lead(s) distribuído(s) entre os corretores.`;
  });
  const setMode = (mode: string) => run(async () => {
    await api('/api/settings/distribution', { method: 'PUT', body: JSON.stringify({ mode }) });
    return mode === 'roundrobin' ? 'Rodízio ativado para leads de site, portal, WhatsApp e indicação.' : 'Distribuição automática desligada.';
  });
  const brokers = team.data?.items.filter((u) => u.role === 'broker' && u.accepts_leads) ?? [];

  return (
    <>
      <h1>CRM</h1>
      <p className="sub">Leads ordenados por prioridade. Clique no score para ver o porquê.</p>

      {isManager && team.data && (
        <section className="card" style={{ marginBottom: 16 }} aria-labelledby="dist">
          <h2 id="dist" style={{ marginTop: 0, fontSize: 16 }}>Distribuição de leads</h2>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'end' }}>
            <div style={{ minWidth: 260 }}>
              <label htmlFor="mode">Leads que chegam por canal</label>
              <select id="mode" value={team.data.distributionMode} onChange={(e) => setMode(e.target.value)}>
                <option value="manual">Manual (a gestão atribui)</option>
                <option value="roundrobin">Rodízio entre corretores ativos</option>
              </select>
            </div>
            <button className="btn gold" onClick={distribute}>Distribuir leads sem responsável</button>
            <Link className="btn ghost" to="/crm?filtro=sem-responsavel">Ver sem responsável</Link>
          </div>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 0 }}>
            Recebem leads: {brokers.length ? brokers.map((b) => `${b.name} (${b.open_leads} abertos)`).join(', ') : 'nenhum corretor ativo'}.
            Leads cadastrados à mão ficam com quem os cadastrou.
          </p>
        </section>
      )}

      {filtro && <p>Filtro ativo: <strong>{FILTER_LABELS[filtro] ?? filtro}</strong> · <Link to="/crm">limpar filtro</Link></p>}
      {msg && <div className="alert baixa" role="status">{msg}</div>}
      {loading ? <Skeleton rows={6} /> : error || !data ? <ErrorBox message={error ?? ''} onRetry={reload} /> : data.items.length === 0 ? (
        <Empty text="Nenhum lead encontrado." />
      ) : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Lead</th><th>Origem</th><th>Faixa de preço</th><th>Responsável</th><th>Score</th><th /></tr></thead>
            <tbody>
              {data.items.map((l) => (
                <Fragment key={l.id}>
                  <tr>
                    <td>{l.name}<br /><small style={{ color: 'var(--muted)' }}>{l.phone ?? 'sem telefone'}</small></td>
                    <td>{l.source}</td>
                    <td>{brl(l.budget_cents)}</td>
                    <td>
                      {isManager ? (
                        <select aria-label={`Responsável por ${l.name}`} value={l.owner_id ?? ''} onChange={(e) => e.target.value && assign(l.id, e.target.value)} style={{ minWidth: 150 }}>
                          <option value="">Sem responsável</option>
                          {team.data?.items.filter((u) => u.role === 'broker' || u.id === l.owner_id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                      ) : (l.owner_name ?? 'Sem responsável')}
                    </td>
                    <td><button className={`badge ${heat(l.score)}`} style={{ cursor: 'pointer', font: 'inherit' }} aria-expanded={open === l.id}
                      onClick={() => setOpen(open === l.id ? null : l.id)}>{l.score} · {heatLabel[heat(l.score)]}</button></td>
                    <td><button className="btn ghost" onClick={() => contacted(l.id)}>Registrar contato</button></td>
                  </tr>
                  {open === l.id && (
                    <tr><td colSpan={6}><ul style={{ margin: 0 }}>{l.score_reasons.map((r) => <li key={r}>{r}</li>)}</ul></td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
