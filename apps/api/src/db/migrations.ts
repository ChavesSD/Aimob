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
  { version: 3, name: 'pagamentos (gateway)', sql: `
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS document_enc text;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS document_last2 text;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS gateway_customer_id text;
    CREATE TABLE IF NOT EXISTS payment_accounts (
      tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
      provider text NOT NULL DEFAULT 'asaas',
      environment text NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox','production')),
      api_key_enc text NOT NULL,
      webhook_token_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE rental_charges ADD COLUMN IF NOT EXISTS gateway_id text;
    ALTER TABLE rental_charges ADD COLUMN IF NOT EXISTS gateway_status text;
    ALTER TABLE rental_charges ADD COLUMN IF NOT EXISTS gateway_url text;
    ALTER TABLE rental_charges ADD COLUMN IF NOT EXISTS gateway_boleto_url text;
    ALTER TABLE rental_charges ADD COLUMN IF NOT EXISTS gateway_pix_payload text;
    ALTER TABLE rental_charges ADD COLUMN IF NOT EXISTS gateway_claimed_at timestamptz;
    ALTER TABLE rental_charges ADD COLUMN IF NOT EXISTS gateway_stale boolean NOT NULL DEFAULT false;
    ALTER TABLE rental_charges ADD COLUMN IF NOT EXISTS reconciliation text;
    CREATE UNIQUE INDEX IF NOT EXISTS rental_charges_gateway_idx ON rental_charges (tenant_id, gateway_id) WHERE gateway_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS payment_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      provider text NOT NULL,
      event_id text NOT NULL,
      event text NOT NULL,
      payment_id text,
      payload jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      detail text,
      attempts int NOT NULL DEFAULT 0,
      received_at timestamptz NOT NULL DEFAULT now(),
      processed_at timestamptz,
      UNIQUE (tenant_id, provider, event_id)
    );
    CREATE INDEX IF NOT EXISTS payment_events_idx ON payment_events (tenant_id, status, received_at DESC);
  ` },
  { version: 4, name: 'conta de recebimento (subconta Asaas + split)', sql: `
    ALTER TABLE payment_accounts ALTER COLUMN api_key_enc DROP NOT NULL;
    ALTER TABLE payment_accounts ALTER COLUMN webhook_token_hash DROP NOT NULL;
    ALTER TABLE payment_accounts ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'own_key' CHECK (mode IN ('own_key','platform_split'));
    ALTER TABLE payment_accounts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','provisioning'));
    ALTER TABLE payment_accounts ADD COLUMN IF NOT EXISTS wallet_id text;
    ALTER TABLE payment_accounts ADD COLUMN IF NOT EXISTS gateway_account_id text;
    CREATE TABLE IF NOT EXISTS tenant_company (
      tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
      name text NOT NULL,
      document_enc text NOT NULL,
      document_last2 text NOT NULL,
      email text NOT NULL,
      phone text,
      birth_date date,
      monthly_revenue_cents bigint NOT NULL CHECK (monthly_revenue_cents > 0),
      street text, number text, complement text, neighborhood text, cep text,
      updated_at timestamptz NOT NULL DEFAULT now()
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
