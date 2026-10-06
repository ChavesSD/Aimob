import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, brl } from '../api';
import { useApi } from '../hooks';
import { ErrorBox, Skeleton } from '../ui';

interface Detail {
  property: { code: string; title: string; description: string; neighborhood: string; city: string; price_cents: string; photos: number };
  health: { score: number; issues: string[]; diagnosis: string };
  timeline: { kind: string; summary: string; created_at: string }[];
  stats: { leads: number; visits: number };
}

export default function PropertyDetail() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApi<Detail>(`/api/properties/${id}`);
  const [price, setPrice] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  async function savePrice(e: FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(price.replace(/\./g, '').replace(',', '.')) * 100);
    if (!Number.isFinite(cents) || cents < 0) { setMsg('Informe um valor válido.'); return; }
    try { const r = await api<{ summary: string }>(`/api/properties/${id}`, { method: 'PATCH', body: JSON.stringify({ priceCents: cents }) }); setMsg(r.summary); setPrice(''); reload(); }
    catch (err: any) { setMsg(err.message); }
  }

  if (loading) return <Skeleton rows={5} />;
  if (error || !data) return <ErrorBox message={error ?? ''} onRetry={reload} />;
  const { property: p, health, timeline, stats } = data;
  return (
    <>
      <Link to="/imoveis" className="sub">← Imóveis</Link>
      <h1>{p.title} <small style={{ color: 'var(--muted)', fontWeight: 400 }}>#{p.code}</small></h1>
      <p className="sub">{p.neighborhood}{p.city && `, ${p.city}`} · {brl(p.price_cents)} · {stats.leads} lead(s) · {stats.visits} visita(s)</p>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <section className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Saúde do imóvel</h2>
          <div className="score">{health.score}<small style={{ fontSize: 16, color: 'var(--muted)' }}>/100</small></div>
          <p>{health.diagnosis}</p>
          <ul>{health.issues.map((i) => <li key={i}>{i}</li>)}</ul>
          <form onSubmit={savePrice} style={{ marginTop: 16 }}>
            <label htmlFor="price">Alterar preço (R$)</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input id="price" inputMode="decimal" placeholder="680000" value={price} onChange={(e) => setPrice(e.target.value)} />
              <button className="btn gold" disabled={!price}>Salvar</button>
            </div>
            {msg && <p role="status">{msg}</p>}
          </form>
        </section>
        <section className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Vida do imóvel</h2>
          <ul className="timeline">
            {timeline.map((t, i) => <li key={i}>{t.summary}<small>{new Date(t.created_at).toLocaleString('pt-BR')}</small></li>)}
          </ul>
        </section>
      </div>
    </>
  );
}
