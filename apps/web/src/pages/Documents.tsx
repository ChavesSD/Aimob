import { useState, type FormEvent } from 'react';
import { api, downloadFile, uploadFile } from '../api';
import { useApi } from '../hooks';
import { Empty, ErrorBox, Skeleton } from '../ui';

const STATUS: Record<string, string> = { draft: 'Rascunho', in_review: 'Em revisão', approved: 'Aprovado', sent: 'Enviado para assinatura', signed: 'Assinado', cancelled: 'Cancelado' };
const LEVEL: Record<string, string> = { simples: 'Assinatura simples', avancada: 'Assinatura avançada', qualificada: 'Assinatura qualificada (ICP-Brasil)' };
const ROLE: Record<string, string> = { locador: 'Locador', locatario: 'Locatário', fiador: 'Fiador', testemunha: 'Testemunha', imobiliaria: 'Imobiliária' };
const fmt = (d: string) => new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

interface Row { id: string; title: string; status: string; signature_level: string; current_version: number; updated_at: string; signers: number; signed: number }
interface Detail {
  id: string; title: string; status: string; signature_level: string; body: string; pendingVariables: string[]; current_version: number; content_hash: string;
  template_reviewed: boolean; pdf_key: string | null; registrationWarning: string | null; cancel_reason: string | null;
  signers: { id: string; role: string; name: string; email: string | null; status: string; signed_at: string | null; evidence: string | null }[];
  files: { id: string; filename: string; size: number; sha256: string; created_at: string }[];
  versions: { version: number; content_hash: string; note: string | null; created_at: string }[];
}
type Notify = (m: string) => void;

export default function Documents({ notify }: { notify: Notify }) {
  const list = useApi<{ items: Row[] }>('/api/documents');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  if (open) return <DocumentDetail id={open} onBack={() => { setOpen(null); list.reload(); }} notify={notify} />;
  return (
    <>
      <button className="btn gold" onClick={() => setCreating(!creating)} aria-expanded={creating}>{creating ? 'Fechar' : 'Novo documento'}</button>
      {creating && <NewDocument notify={notify} onCreated={(id) => { setCreating(false); setOpen(id); }} />}
      <div className="card table-wrap" style={{ marginTop: 16 }}>
        {list.loading && !list.data ? <Skeleton rows={4} /> : list.error || !list.data ? <ErrorBox message={list.error ?? ''} onRetry={list.reload} /> :
          list.data.items.length === 0 ? <Empty text="Nenhum documento ainda. Crie o primeiro a partir de um modelo e de um contrato de locação." /> : (
            <table>
              <thead><tr><th>Documento</th><th>Situação</th><th>Assinaturas</th><th>Versão</th><th>Atualizado</th><th /></tr></thead>
              <tbody>{list.data.items.map((r) => (
                <tr key={r.id}><td>{r.title}</td><td>{STATUS[r.status] ?? r.status}</td><td>{r.signers ? `${r.signed}/${r.signers}` : '—'}</td><td>{r.current_version}</td><td>{fmt(r.updated_at)}</td>
                  <td><button className="btn ghost" onClick={() => setOpen(r.id)}>Abrir</button></td></tr>
              ))}</tbody>
            </table>
          )}
      </div>
    </>
  );
}

function NewDocument({ onCreated, notify }: { onCreated: (id: string) => void; notify: Notify }) {
  const tpls = useApi<{ items: { id: string; name: string; reviewed: boolean; notes: string | null }[] }>('/api/document-templates');
  const contracts = useApi<{ items: { id: string; property_title: string; renter_name: string; status: string }[] }>('/api/rentals');
  const [templateId, setTemplateId] = useState('');
  const [contractId, setContractId] = useState('');
  const [level, setLevel] = useState('avancada');
  const [title, setTitle] = useState('');
  async function installStarter() {
    try { await api('/api/document-templates/starter', { method: 'POST' }); tpls.reload(); notify('Modelo inicial instalado. Faça-o revisar por um advogado antes de usar.'); } catch (e: any) { notify(e.message); }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ id: string }>('/api/documents', { method: 'POST', body: JSON.stringify({ templateId, rentalContractId: contractId || undefined, title: title || undefined, signatureLevel: level }) });
      onCreated(r.id);
    } catch (err: any) { notify(err.message); }
  }
  const t = tpls.data?.items.find((x) => x.id === templateId);
  return (
    <form className="card" onSubmit={submit} style={{ marginTop: 16 }}>
      {tpls.data && tpls.data.items.length === 0 && <p>Você ainda não tem modelos. <button type="button" className="btn ghost" onClick={installStarter}>Instalar modelo inicial de locação</button></p>}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        <div><label htmlFor="d-tpl">Modelo</label><select id="d-tpl" required value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">Selecione…</option>{tpls.data?.items.map((x) => <option key={x.id} value={x.id}>{x.name}{x.reviewed ? ' (revisado)' : ' (sem revisão jurídica)'}</option>)}</select></div>
        <div><label htmlFor="d-ct">Contrato de locação (preenche os dados)</label><select id="d-ct" value={contractId} onChange={(e) => setContractId(e.target.value)}>
          <option value="">Sem contrato (preencher à mão)</option>{contracts.data?.items.filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{c.property_title} · {c.renter_name}</option>)}</select></div>
        <div><label htmlFor="d-lv">Assinatura pretendida</label><select id="d-lv" value={level} onChange={(e) => setLevel(e.target.value)}>{Object.entries(LEVEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div><label htmlFor="d-ti">Título (opcional)</label><input id="d-ti" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
      </div>
      {t && !t.reviewed && t.notes && <p role="note" style={{ color: 'var(--warn)' }}>{t.notes}</p>}
      <button className="btn gold" style={{ marginTop: 12 }}>Criar documento</button>
    </form>
  );
}

function DocumentDetail({ id, onBack, notify }: { id: string; onBack: () => void; notify: Notify }) {
  const { data: d, error, loading, reload } = useApi<Detail>(`/api/documents/${id}`);
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [signer, setSigner] = useState({ role: 'locador', name: '', email: '' });
  const [preview, setPreview] = useState<{ version: number; body: string } | null>(null);

  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); notify(ok); setDraft(null); reload(); } catch (e: any) { notify(e.message); } };
  if (loading && !d) return <Skeleton rows={6} />;
  if (error || !d) return <ErrorBox message={error ?? ''} onRetry={reload} />;

  const editable = d.status === 'draft' || d.status === 'in_review';
  const text = draft ?? d.body;
  const post = (path: string, body?: unknown) => api(`/api/documents/${id}/${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });

  async function approve() {
    try { await post('approve', {}); notify('Documento aprovado e PDF gerado.'); reload(); }
    catch (e: any) {
      if (e.message.includes('não foi revisado pelo jurídico') && confirm(`${e.message}\n\nAprovar mesmo assim?`)) await act(() => post('approve', { acknowledgeUnreviewed: true }), 'Documento aprovado e PDF gerado.');
      else notify(e.message);
    }
  }
  const cancel = () => { const reason = prompt('Motivo do cancelamento:'); if (reason) act(() => post('cancel', { reason }), 'Documento cancelado.'); };

  return (
    <>
      <button className="btn ghost" onClick={onBack}>← Documentos</button>
      <h2 style={{ marginBottom: 4 }}>{d.title} <span className="badge">{STATUS[d.status]}</span></h2>
      <p className="sub" style={{ margin: '0 0 8px' }}>Versão {d.current_version} · {LEVEL[d.signature_level]} · integridade SHA-256 {d.content_hash.slice(0, 16)}…</p>
      {d.registrationWarning && <div className="alert media" role="note"><div>{d.registrationWarning}</div></div>}
      {!d.template_reviewed && <div className="alert media" role="note"><div>O modelo usado não tem revisão jurídica registrada.</div></div>}
      {d.cancel_reason && <div className="error-box">Cancelado: {d.cancel_reason}</div>}
      {d.pendingVariables.length > 0 && <p role="alert" style={{ color: 'var(--warn)' }}>Campos sem preencher: {d.pendingVariables.map((v) => `{{${v}}}`).join(', ')}. Cadastre o dado no sistema ou escreva direto no texto.</p>}

      <section className="card" style={{ marginBottom: 16 }} aria-labelledby="txt">
        <h3 id="txt" style={{ marginTop: 0 }}>Texto do contrato</h3>
        <textarea aria-label="Texto do contrato" readOnly={!editable} value={text} onChange={(e) => setDraft(e.target.value)} rows={18}
          style={{ width: '100%', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 13, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: 12 }} />
        {editable && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <input aria-label="Observação da alteração" placeholder="O que mudou? (opcional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ maxWidth: 320 }} />
            <button className="btn" disabled={draft === null || draft === d.body} onClick={() => act(() => api(`/api/documents/${id}`, { method: 'PUT', body: JSON.stringify({ body: text, note: note || undefined }) }), 'Nova versão salva.')}>Salvar nova versão</button>
          </div>
        )}
      </section>

      <section className="card" style={{ marginBottom: 16 }} aria-labelledby="acoes">
        <h3 id="acoes" style={{ marginTop: 0 }}>Ações</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {d.status === 'draft' && <button className="btn gold" disabled={draft !== null && draft !== d.body} onClick={() => act(() => post('submit'), 'Enviado para revisão.')}>Enviar para revisão</button>}
          {d.status === 'in_review' && <button className="btn gold" onClick={approve}>Aprovar e gerar PDF</button>}
          {d.status === 'approved' && <><button className="btn ghost" onClick={() => act(() => post('reopen'), 'Documento reaberto para edição.')}>Reabrir para edição</button>
            <button className="btn gold" onClick={() => act(() => post('send'), 'Liberado para coleta de assinaturas.')}>Enviar para assinatura</button></>}
          {d.pdf_key && <button className="btn ghost" onClick={() => downloadFile(`/api/documents/${id}/pdf`, `${d.title}.pdf`).catch((e) => notify(e.message))}>Baixar PDF</button>}
          {!['signed', 'cancelled'].includes(d.status) && <button className="btn ghost" onClick={cancel}>Cancelar documento</button>}
        </div>
        {d.status === 'in_review' && <p style={{ color: 'var(--muted)', fontSize: 13 }}>Quem redigiu o documento não pode aprová-lo (exceto a diretoria).</p>}
      </section>

      <section className="card" style={{ marginBottom: 16 }} aria-labelledby="sig">
        <h3 id="sig" style={{ marginTop: 0 }}>Signatários</h3>
        {d.status === 'sent' && <p style={{ color: 'var(--muted)', fontSize: 13 }}>Modo manual: a assinatura acontece fora do Aimob (por exemplo, gov.br ou presencial). Registre quem assinou, com a observação de como foi feito, e anexe o PDF assinado. O sistema não assina por ninguém.</p>}
        {d.signers.length === 0 ? <p style={{ color: 'var(--muted)' }}>Nenhum signatário. Cadastre ao menos dois (locador e locatário) antes de enviar.</p> : (
          <ul style={{ paddingLeft: 18 }}>{d.signers.map((s) => (
            <li key={s.id}>{ROLE[s.role] ?? s.role}: <strong>{s.name}</strong>{s.email ? ` (${s.email})` : ''} — {s.status === 'signed' ? `assinou em ${fmt(s.signed_at!)} · ${s.evidence}` : 'pendente'}{' '}
              {d.status === 'sent' && s.status === 'pending' && <button className="btn ghost" style={{ minHeight: 28 }} onClick={() => { const n = prompt('Como foi assinado? (ex.: "assinou pelo gov.br em 06/10")'); if (n) act(() => post(`signers/${s.id}/signed`, { note: n }), 'Assinatura registrada.'); }}>Registrar assinatura</button>}
              {['draft', 'in_review', 'approved'].includes(d.status) && <button className="btn ghost" style={{ minHeight: 28 }} onClick={() => act(() => api(`/api/documents/${id}/signers/${s.id}`, { method: 'DELETE' }), 'Signatário removido.')}>Remover</button>}
            </li>
          ))}</ul>
        )}
        {['draft', 'in_review', 'approved'].includes(d.status) && (
          <form onSubmit={(e) => { e.preventDefault(); act(() => post('signers', { role: signer.role, name: signer.name, email: signer.email || undefined }), 'Signatário adicionado.').then(() => setSigner({ ...signer, name: '', email: '' })); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
            <div><label htmlFor="s-r">Papel</label><select id="s-r" value={signer.role} onChange={(e) => setSigner({ ...signer, role: e.target.value })}>{Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div><label htmlFor="s-n">Nome</label><input id="s-n" required value={signer.name} onChange={(e) => setSigner({ ...signer, name: e.target.value })} /></div>
            <div><label htmlFor="s-e">E-mail (opcional)</label><input id="s-e" type="email" value={signer.email} onChange={(e) => setSigner({ ...signer, email: e.target.value })} /></div>
            <button className="btn">Adicionar</button>
          </form>
        )}
      </section>

      {(d.status === 'sent' || d.files.length > 0) && (
        <section className="card" style={{ marginBottom: 16 }} aria-labelledby="arq">
          <h3 id="arq" style={{ marginTop: 0 }}>Arquivos assinados</h3>
          {d.files.map((f) => <div key={f.id} style={{ padding: '4px 0' }}>{f.filename} · {(f.size / 1024).toFixed(0)} KB · <code>{f.sha256.slice(0, 12)}…</code>{' '}
            <button className="btn ghost" style={{ minHeight: 28 }} onClick={() => downloadFile(`/api/documents/${id}/files/${f.id}`, f.filename).catch((e) => notify(e.message))}>Baixar</button></div>)}
          {d.status === 'sent' && (
            <div style={{ marginTop: 8 }}>
              <label htmlFor="up">Anexar PDF assinado (até 15 MB)</label>
              <input id="up" type="file" accept="application/pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) act(() => uploadFile(`/api/documents/${id}/files`, f), 'Arquivo anexado.'); e.target.value = ''; }} />
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>O documento só vira "Assinado" quando todos os signatários estiverem registrados e houver um PDF assinado anexado.</p>
            </div>
          )}
        </section>
      )}

      <section className="card" aria-labelledby="ver">
        <h3 id="ver" style={{ marginTop: 0 }}>Histórico de versões</h3>
        <ul style={{ paddingLeft: 18 }}>{d.versions.map((v) => (
          <li key={v.version}>Versão {v.version} · {fmt(v.created_at)} · {v.note ?? 'sem observação'} · <code>{v.content_hash.slice(0, 10)}…</code>{' '}
            <button className="btn ghost" style={{ minHeight: 28 }} onClick={async () => { try { const r = await api<{ body: string }>(`/api/documents/${id}/versions/${v.version}`); setPreview({ version: v.version, body: r.body }); } catch (e: any) { notify(e.message); } }}>Ver</button></li>
        ))}</ul>
        {preview && <><h4>Versão {preview.version} (somente leitura)</h4><pre style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-2)', padding: 12, borderRadius: 6 }}>{preview.body}</pre><button className="btn ghost" onClick={() => setPreview(null)}>Fechar</button></>}
      </section>
    </>
  );
}
