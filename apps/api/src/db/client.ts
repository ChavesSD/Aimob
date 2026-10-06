import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { SCHEMA } from './schema.js';

export type Db = PGlite;

/** dir undefined => memória (testes). Em produção trocar por Postgres real mantendo o SQL. */
export async function openDb(dir?: string): Promise<Db> {
  if (dir) mkdirSync(dirname(dir), { recursive: true });
  const db = new PGlite(dir);
  await db.waitReady;
  await db.exec(SCHEMA);
  return db;
}

/** Único ponto de acesso a dados de negócio: tenant_id é sempre o primeiro parâmetro ($1). */
export function scoped(db: Db, tenantId: string) {
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
