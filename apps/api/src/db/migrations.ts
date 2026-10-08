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
  { version: 5, name: 'portal do proprietario', sql: `
    ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES contacts(id);
    CREATE UNIQUE INDEX IF NOT EXISTS users_contact_idx ON users (contact_id) WHERE contact_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS user_invites (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      user_id uuid NOT NULL REFERENCES users(id),
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS user_invites_user_idx ON user_invites (user_id);
  ` },
  { version: 6, name: 'contratos em documento', sql: `
    CREATE TABLE IF NOT EXISTS contract_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      name text NOT NULL,
      kind text NOT NULL DEFAULT 'locacao',
      body text NOT NULL,
      notes text,
      version int NOT NULL DEFAULT 1,
      reviewed boolean NOT NULL DEFAULT false,
      reviewed_by uuid,
      reviewed_at timestamptz,
      active boolean NOT NULL DEFAULT true,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS contract_documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      rental_contract_id uuid REFERENCES rental_contracts(id),
      template_id uuid REFERENCES contract_templates(id),
      template_version int,
      template_reviewed boolean NOT NULL DEFAULT false,
      title text NOT NULL,
      kind text NOT NULL DEFAULT 'locacao',
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','sent','signed','cancelled')),
      body_enc text NOT NULL,
      content_hash text NOT NULL,
      current_version int NOT NULL DEFAULT 1,
      signature_level text NOT NULL DEFAULT 'avancada' CHECK (signature_level IN ('simples','avancada','qualificada')),
      created_by uuid,
      approved_by uuid,
      approved_at timestamptz,
      approved_hash text,
      pdf_key text,
      pdf_sha256 text,
      sent_at timestamptz,
      signed_at timestamptz,
      cancelled_at timestamptz,
      cancel_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS contract_documents_idx ON contract_documents (tenant_id, status, created_at DESC);
    CREATE TABLE IF NOT EXISTS contract_document_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      document_id uuid NOT NULL REFERENCES contract_documents(id),
      version int NOT NULL,
      body_enc text NOT NULL,
      content_hash text NOT NULL,
      author_id uuid,
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (document_id, version)
    );
    CREATE TABLE IF NOT EXISTS contract_signers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      document_id uuid NOT NULL REFERENCES contract_documents(id),
      role text NOT NULL,
      name text NOT NULL,
      email text,
      position int NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','signed')),
      signed_at timestamptz,
      evidence text,
      declared_by uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS contract_files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      document_id uuid NOT NULL REFERENCES contract_documents(id),
      kind text NOT NULL DEFAULT 'signed',
      filename text NOT NULL,
      mime text NOT NULL,
      size bigint NOT NULL,
      sha256 text NOT NULL,
      storage_key text NOT NULL,
      uploaded_by uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  ` },
  { version: 7, name: 'politica de mfa e revogacao de sessoes (epoca de sessao)', sql: `
    ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS mfa_policy text NOT NULL DEFAULT 'admins' CHECK (mfa_policy IN ('off','admins','staff'));
    ALTER TABLE users ADD COLUMN IF NOT EXISTS session_epoch int NOT NULL DEFAULT 0;
  ` },
  { version: 8, name: 'chamados de manutencao (portal do inquilino)', sql: `
    CREATE TABLE IF NOT EXISTS maintenance_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      contract_id uuid NOT NULL REFERENCES rental_contracts(id),
      property_id uuid NOT NULL REFERENCES properties(id),
      requester_contact_id uuid NOT NULL REFERENCES contacts(id),
      title text NOT NULL,
      description text NOT NULL,
      category text NOT NULL DEFAULT 'other' CHECK (category IN ('hydraulic','electrical','structural','appliance','other')),
      urgency text NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low','normal','urgent')),
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','waiting_tenant','resolved','canceled')),
      resolved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS maintenance_requests_tenant_idx ON maintenance_requests (tenant_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS maintenance_requests_requester_idx ON maintenance_requests (tenant_id, requester_contact_id);
    CREATE TABLE IF NOT EXISTS maintenance_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      request_id uuid NOT NULL REFERENCES maintenance_requests(id),
      author_kind text NOT NULL CHECK (author_kind IN ('renter','staff')),
      author_user_id uuid,
      body text NOT NULL,
      internal boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS maintenance_messages_request_idx ON maintenance_messages (tenant_id, request_id, created_at);
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
