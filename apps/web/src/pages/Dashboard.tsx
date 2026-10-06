import { Link } from 'react-router-dom';
import { useApi } from '../hooks';
import { brl } from '../api';
import { Empty, ErrorBox, Skeleton } from '../ui';
import { getSession } from '../api';

interface Insight { id: string; severity: 'alta' | 'media' | 'baixa'; title: string; amountCents?: number; action: { label: string; href: string } }
interface Dash {
  kpis: { openLeads: number; hotLeads: number; activeProperties: number; upcomingVisits: number; pipelineCents: number; avgFirstResponseMin: number | null };
  attention: Insight[];
}

export default function Dashboard() {
  const { data, error, loading, reload } = useApi<Dash>('/api/dashboard');
  const me = useApi<{ mfaEnabled: boolean }>('/api/me');
  const admin = ['owner', 'manager'].includes(getSession()?.user.role ?? '');
  if (loading) return <Skeleton rows={6} />;
  if (error || !data) return <ErrorBox message={error ?? 'Sem resposta do servidor.'} onRetry={reload} />;
  const k = data.kpis;
  const kpis: [string, string, string?][] = [
    ['Leads em aberto', String(k.openLeads)],
    ['Leads quentes', String(k.hotLeads), 'pontuação 55 ou mais'],
    ['Imóveis ativos', String(k.activeProperties)],
    ['Visitas agendadas', String(k.upcomingVisits)],
    ['Valor em negociação', brl(k.pipelineCents), 'soma das faixas de preço informadas'],
    ['1ª resposta (média)', k.avgFirstResponseMin === null ? '—' : `${k.avgFirstResponseMin} min`],
  ];
  return (
    <>
      <h1>O que está acontecendo agora</h1>
      <p className="sub">Resumo da operação e o que precisa da sua atenção.</p>
      {admin && me.data && !me.data.mfaEnabled && (
        <div className="alert media" role="note"><div>Sua conta administra dados da imobiliária e ainda não tem verificação em duas etapas.</div><Link className="btn ghost" to="/seguranca">Proteger minha conta</Link></div>
      )}
      <div className="grid kpis">
        {kpis.map(([label, value, hint]) => (
          <div className="card kpi" key={label}><div className="label">{label}</div><div className="value">{value}</div>{hint && <div className="hint">{hint}</div>}</div>
        ))}
      </div>
      <section className="card" aria-labelledby="attn">
        <h2 id="attn" style={{ marginTop: 0, fontSize: 18 }}>O que precisa da sua atenção?</h2>
        {data.attention.length === 0 && <Empty text="Nada pendente no momento. Sua operação está em dia." />}
        {data.attention.map((a) => (
          <div className={`alert ${a.severity}`} key={a.id}>
            <div>{a.title}{a.amountCents ? <small>{brl(a.amountCents)} em oportunidades envolvidas</small> : null}</div>
            <Link className="btn ghost" to={a.action.href}>{a.action.label}</Link>
          </div>
        ))}
      </section>
    </>
  );
}
