import type { Db } from './client.js';
import { SCHEMA } from './schema.js';

export interface Migration { version: number; name: string; sql: string }

/**
 * Migrações versionadas e aplicadas uma única vez, em ordem. Nunca edite uma migração já publicada:
 * crie a próxima (version + 1). A 001 é o esquema inicial e é idempotente (IF NOT EXISTS), então
 * bancos de desenvolvimento criados antes deste mecanismo a recebem sem problemas.
 */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'esquema inicial', sql: SCHEMA },
  { version: 2, name: 'mfa totp', sql: `
    ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_enc text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled boolean NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_step bigint NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_failed int NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_locked_until timestamptz;
    CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      user_id uuid NOT NULL REFERENCES users(id),
      code_hash text NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, code_hash)
    );
  ` },
];

export async function runMigrations(db: Db, migrations: Migration[] = MIGRATIONS): Promise<number[]> {
  const applied: number[] = [];
  await db.transaction(async (tx) => {
    // Lock consultivo: duas instâncias subindo juntas não aplicam a mesma migração duas vezes.
    await tx.query(`SELECT pg_advisory_xact_lock(727001)`);
    await tx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await tx.query<{ version: number }>(`SELECT version FROM schema_migrations`);
    const done = new Set(rows.map((r) => Number(r.version)));
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (done.has(m.version)) continue;
      await tx.query(m.sql);
      await tx.query(`INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`, [m.version, m.name]);
      applied.push(m.version);
    }
  });
  return applied;
}
