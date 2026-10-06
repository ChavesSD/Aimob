import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Db } from './client.js';
import { MIGRATIONS } from './migrations.js';

/**
 * Backup lógico portátil (PGlite e PostgreSQL), consistente (um único snapshot) e criptografado.
 * Complementa, não substitui, o backup físico do provedor de PostgreSQL (PITR). Ver docs/OPERACAO.md.
 */

// Ordem de dependência (chaves estrangeiras): pais antes dos filhos.
export const BACKUP_TABLES = [
  'tenants', 'users', 'contacts', 'properties', 'leads', 'visits', 'property_events', 'pipeline_stages', 'tenant_settings',
  'mfa_recovery_codes', 'tasks', 'notifications', 'automation_rules', 'automation_runs',
  'rental_contracts', 'rental_charges', 'rental_payouts', 'rental_adjustments', 'payment_accounts', 'payment_events', 'tenant_company',
  'audit_log', 'diagnostics', 'landing_events',
] as const;
const SERIAL_TABLES: Record<string, string> = { landing_events: 'id' };

export interface BackupFile {
  format: 'aimob-backup';
  version: 1;
  createdAt: string;
  migrations: number[];
  counts: Record<string, number>;
  checksum: string; // sha256 do JSON das tabelas
  tables: Record<string, unknown[]>;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createBackup(db: Db): Promise<BackupFile> {
  return db.transaction(async (tx) => {
    // Snapshot único: todas as tabelas vêm do mesmo instante, mesmo com a API escrevendo.
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const tables: Record<string, unknown[]> = {};
    const counts: Record<string, number> = {};
    for (const t of BACKUP_TABLES) {
      const { rows } = await tx.query<{ j: unknown[] }>(`SELECT coalesce(json_agg(t), '[]'::json) AS j FROM ${t} t`);
      tables[t] = rows[0].j;
      counts[t] = tables[t].length;
    }
    const { rows: mig } = await tx.query<{ version: number }>(`SELECT version FROM schema_migrations ORDER BY version`);
    return { format: 'aimob-backup', version: 1, createdAt: new Date().toISOString(), migrations: mig.map((m) => Number(m.version)), counts, checksum: sha(JSON.stringify(tables)), tables };
  });
}

export class BackupError extends Error {}

export function verifyBackup(b: BackupFile): void {
  if (b?.format !== 'aimob-backup' || b.version !== 1) throw new BackupError('Arquivo de backup desconhecido.');
  if (sha(JSON.stringify(b.tables)) !== b.checksum) throw new BackupError('Backup corrompido: checksum não confere.');
  for (const t of BACKUP_TABLES) {
    if (!Array.isArray(b.tables[t]) || b.tables[t].length !== b.counts[t]) throw new BackupError(`Backup incompleto na tabela ${t}.`);
  }
  const known = new Set(MIGRATIONS.map((m) => m.version));
  const newer = b.migrations.filter((v) => !known.has(v));
  if (newer.length) throw new BackupError(`O backup é de uma versão mais nova do esquema (migrações ${newer.join(', ')}). Atualize o sistema antes de restaurar.`);
}

/** Restaura num banco VAZIO, em uma única transação: ou tudo entra, ou nada. */
export async function restoreBackup(db: Db, b: BackupFile): Promise<Record<string, number>> {
  verifyBackup(b);
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int n FROM tenants`);
    if (rows[0].n > 0) throw new BackupError('O banco de destino não está vazio. Restaure em um banco novo para não misturar dados.');
    for (const t of BACKUP_TABLES) {
      if (b.tables[t].length === 0) continue;
      await tx.query(`INSERT INTO ${t} SELECT * FROM json_populate_recordset(null::${t}, $1::json)`, [JSON.stringify(b.tables[t])]);
    }
    for (const [t, col] of Object.entries(SERIAL_TABLES)) {
      await tx.query(`SELECT setval(pg_get_serial_sequence('${t}', '${col}'), greatest((SELECT coalesce(max(${col}), 0) FROM ${t}), 1))`);
    }
    // Conferência final: o que entrou tem que ser exatamente o que o arquivo declara.
    const restored: Record<string, number> = {};
    for (const t of BACKUP_TABLES) {
      const { rows: c } = await tx.query<{ n: number }>(`SELECT count(*)::int n FROM ${t}`);
      restored[t] = Number(c[0].n);
      if (restored[t] !== b.counts[t]) throw new BackupError(`Contagem divergente em ${t}: esperado ${b.counts[t]}, restaurado ${restored[t]}.`);
    }
    return restored;
  });
}

// ---- Criptografia do arquivo (AES-256-GCM, chave derivada com scrypt) ----
const MAGIC = Buffer.from('AIMOBBK1');

export function encryptBackup(b: BackupFile, passphrase: string): Buffer {
  if (passphrase.length < 32) throw new BackupError('BACKUP_ENC_KEY deve ter ao menos 32 caracteres.');
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(gzipSync(Buffer.from(JSON.stringify(b)))), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), ct]);
}

export function decryptBackup(file: Buffer, passphrase: string): BackupFile {
  if (file.length < 8 + 16 + 12 + 16 || !file.subarray(0, 8).equals(MAGIC)) throw new BackupError('Arquivo não é um backup do Aimob.');
  const salt = file.subarray(8, 24), iv = file.subarray(24, 36), tag = file.subarray(36, 52), ct = file.subarray(52);
  try {
    const d = createDecipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32), iv);
    d.setAuthTag(tag);
    const json = gunzipSync(Buffer.concat([d.update(ct), d.final()])).toString('utf8');
    return JSON.parse(json) as BackupFile;
  } catch {
    throw new BackupError('Não foi possível abrir o backup: chave incorreta ou arquivo adulterado.');
  }
}
