import type { ReactNode } from 'react';

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div className="grid" aria-busy="true" aria-label="Carregando">{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" />)}</div>;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <strong>Não conseguimos carregar estes dados.</strong>
      <div>{message}</div>
      {onRetry && <button className="btn ghost" style={{ marginTop: 8 }} onClick={onRetry}>Tentar novamente</button>}
    </div>
  );
}

export function Empty({ text, cta }: { text: string; cta?: ReactNode }) {
  return <div className="empty"><p>{text}</p>{cta}</div>;
}
