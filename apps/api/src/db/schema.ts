export const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  email text NOT NULL,
  name text NOT NULL,
  role text NOT NULL,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pipeline text NOT NULL,
  position int NOT NULL,
  name text NOT NULL,
  UNIQUE (tenant_id, pipeline, position)
);
CREATE TABLE IF NOT EXISTS properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  type text NOT NULL,
  purpose text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  neighborhood text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  bedrooms int NOT NULL DEFAULT 0,
  parking int NOT NULL DEFAULT 0,
  area_m2 numeric,
  price_cents bigint NOT NULL DEFAULT 0,
  photos int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS properties_tenant_idx ON properties (tenant_id, status);
CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  phone text,
  email text,
  kind text NOT NULL DEFAULT 'lead',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  contact_id uuid NOT NULL REFERENCES contacts(id),
  pipeline text NOT NULL DEFAULT 'venda',
  stage_position int NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'manual',
  owner_id uuid REFERENCES users(id),
  budget_cents bigint,
  desired_neighborhood text,
  property_id uuid REFERENCES properties(id),
  score int NOT NULL DEFAULT 0,
  score_reasons jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'open',
  first_response_at timestamptz,
  last_contact_at timestamptz,
  next_action_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_tenant_idx ON leads (tenant_id, status);
CREATE TABLE IF NOT EXISTS visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  lead_id uuid NOT NULL REFERENCES leads(id),
  property_id uuid NOT NULL REFERENCES properties(id),
  broker_id uuid REFERENCES users(id),
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  feedback text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE visits ADD COLUMN IF NOT EXISTS outcome text;
CREATE INDEX IF NOT EXISTS visits_tenant_idx ON visits (tenant_id, scheduled_at);
ALTER TABLE users ADD COLUMN IF NOT EXISTS accepts_leads boolean NOT NULL DEFAULT true;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_at timestamptz;
CREATE TABLE IF NOT EXISTS diagnostics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  company text NOT NULL,
  phone text NOT NULL,
  email text NOT NULL,
  brokers text,
  properties text,
  sells boolean NOT NULL DEFAULT false,
  rents boolean NOT NULL DEFAULT false,
  current_system text,
  pains jsonb NOT NULL DEFAULT '[]',
  diagnosis text NOT NULL,
  consent_at timestamptz NOT NULL,
  utm jsonb NOT NULL DEFAULT '{}',
  page text,
  device text,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS landing_events (
  id bigserial PRIMARY KEY,
  session_id text NOT NULL,
  event text NOT NULL,
  detail text,
  utm jsonb NOT NULL DEFAULT '{}',
  page text,
  device text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS landing_events_idx ON landing_events (event, created_at);
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  lead_id uuid REFERENCES leads(id),
  assignee_id uuid REFERENCES users(id),
  title text NOT NULL,
  due_at timestamptz,
  status text NOT NULL DEFAULT 'open',
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS tasks_tenant_idx ON tasks (tenant_id, assignee_id, status);
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  message text NOT NULL,
  href text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS count int NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS notifications_idx ON notifications (tenant_id, user_id, read_at);
CREATE TABLE IF NOT EXISTS automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  trigger text NOT NULL,
  conditions jsonb NOT NULL DEFAULT '[]',
  actions jsonb NOT NULL DEFAULT '[]',
  autonomy text NOT NULL DEFAULT 'automatic',
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  rule_id uuid NOT NULL REFERENCES automation_rules(id),
  lead_id uuid REFERENCES leads(id),
  dedupe_key text NOT NULL,
  status text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  UNIQUE (rule_id, lead_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS automation_runs_idx ON automation_runs (tenant_id, status, created_at DESC);
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  distribution_mode text NOT NULL DEFAULT 'manual',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS property_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  property_id uuid NOT NULL REFERENCES properties(id),
  kind text NOT NULL,
  summary text NOT NULL,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  actor_id uuid,
  ip text,
  action text NOT NULL,
  resource text,
  resource_id text,
  before jsonb,
  after jsonb,
  summary text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_tenant_idx ON audit_log (tenant_id, created_at DESC);
`;
