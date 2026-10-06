import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { brl } from '../api';
import { useApi } from '../hooks';
import { Empty, ErrorBox, Skeleton } from '../ui';

interface P { id: string; code: string; type: string; title: string; neighborhood: string; bedrooms: number; price_cents: string; photos: number }

export default function Properties() {
  const [params] = useSearchParams();
  const filtro = params.get('filtro');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const { data, error, loading, reload } = useApi<{ items: P[]; total: number; limit: number }>(
    `/api/properties?page=${page}&limit=20&search=${encodeURIComponent(search)}${filtro ? `&filtro=${encodeURIComponent(filtro)}` : ''}`);

  return (
    <>
      <h1>Imóveis</h1>
      <p className="sub">{data ? `${data.total} imóveis` : 'Carregando…'}</p>
      {filtro && <p>Filtro ativo: <strong>menos de 5 fotos</strong> · <Link to="/imoveis">limpar filtro</Link></p>}
      <div style={{ maxWidth: 360, marginBottom: 16 }}>
        <label htmlFor="q">Buscar por código, título ou bairro</label>
        <input id="q" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
      </div>
      {loading ? <Skeleton rows={6} /> : error || !data ? <ErrorBox message={error ?? ''} onRetry={reload} /> : data.items.length === 0 ? (
        <Empty text="Nenhum imóvel encontrado." />
      ) : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Código</th><th>Imóvel</th><th>Bairro</th><th>Quartos</th><th>Preço</th><th>Fotos</th></tr></thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id}>
                  <td>{p.code}</td><td><Link to={`/imoveis/${p.id}`}>{p.title}</Link></td><td>{p.neighborhood}</td>
                  <td>{p.bedrooms}</td><td>{brl(p.price_cents)}</td><td>{p.photos}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > data.limit && (
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>Anterior</button>
          <button className="btn ghost" disabled={page * data.limit >= data.total} onClick={() => setPage(page + 1)}>Próxima</button>
        </div>
      )}
    </>
  );
}
