import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { runMigrations } from './migrations.js';

/** O mínimo que o código de negócio usa: serve para o banco, para uma transação ou para uma conexão. */
export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  readonly kind: 'pglite' | 'postgres';
  /** Executa `fn` numa transação: confirma se resolver, desfaz se lançar erro. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// int8 (bigint) vira number: valores em centavos cabem com folga em 2^53. numeric continua string.
pg.types.setTypeParser(20, (v) => Number(v));

export interface OpenOptions {
  /** postgres://... para PostgreSQL; caminho de pasta para PGlite em disco; omitido = PGlite em memória. */
  target?: string;
  /** Schema isolado (usado nos testes contra PostgreSQL real). */
  schema?: string;
  poolMax?: number;
}

type LiteRunner = Pick<PGlite, 'query' | 'exec'>;
/** Sem parâmetros usa o protocolo simples (aceita várias instruções, como as migrações), igual ao driver pg. */
async function runLite(r: LiteRunner, sql: string, params?: unknown[]): Promise<{ rows: any[] }> {
  if (params === undefined) {
    const results = await r.exec(sql);
    return { rows: (results[results.length - 1]?.rows as any[]) ?? [] };
  }
  return r.query<any>(sql, params as any[]);
}

function pgliteDb(dir?: string): Db {
  if (dir) mkdirSync(dirname(dir), { recursive: true });
  const lite = new PGlite(dir);
  return {
    kind: 'pglite',
    query: (sql, params) => runLite(lite, sql, params),
    transaction: (fn) => lite.transaction((tx) => fn({ query: (sql, params) => runLite(tx, sql, params) })),
    close: () => lite.close(),
  };
}

function postgresDb(url: string, schema?: string, max = 10): Db {
  // search_path é definido na própria conexão (parâmetro de startup), então vale para todas as conexões do pool.
  const pool = new pg.Pool({ connectionString: url, max, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
  return {
    kind: 'postgres',
    query: (sql, params) => pool.query(sql, params as any[]) as Promise<{ rows: any[] }>,
    async transaction(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn({ query: (sql, params) => c.query(sql, params as any[]) as Promise<{ rows: any[] }> });
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function openDb(target?: string | OpenOptions): Promise<Db> {
  const o: OpenOptions = typeof target === 'string' || target === undefined ? { target } : target;
  const isPg = !!o.target && /^postgres(ql)?:\/\//.test(o.target);
  if (isPg && o.schema) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(o.schema)) throw new Error('Nome de schema inválido');
    const admin = new pg.Pool({ connectionString: o.target, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS "${o.schema}"`);
    await admin.end();
  }
  const db = isPg ? postgresDb(o.target!, o.schema, o.poolMax) : pgliteDb(o.target);
  if (db.kind === 'pglite') await db.query('SELECT 1'); // espera o WASM ficar pronto
  await runMigrations(db);
  return db;
}

/** Único ponto de acesso a dados de negócio: tenant_id é sempre o primeiro parâmetro ($1). */
export function scoped(db: Queryable, tenantId: string) {
  return {
    async rows<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const isInsert = /^\s*insert\s/i.test(sql);
      const ok = isInsert
        ? /tenant_id/.test(sql) && /\$1\b/.test(sql)
        : /tenant_id\s*=\s*\$1\b/.test(sql);
      if (!ok) throw new Error('Query sem escopo de tenant (tenant_id = $1)');
      const r = await db.query<T>(sql, [tenantId, ...params]);
      return r.rows;
    },
  };
}
