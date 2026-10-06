import { beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { makeTestDb } from './helpers.js';
import { seedDemo } from '../src/db/seed.js';
import { BACKUP_TABLES, BackupError, createBackup, decryptBackup, encryptBackup, restoreBackup, verifyBackup } from '../src/db/backup.js';
import { MIGRATIONS, runMigrations } from '../src/db/migrations.js';
import { verifyPassword } from '../src/auth.js';

const KEY = 'chave-de-backup-para-testes-com-32+chars!';
let src: Db;

beforeAll(async () => {
  src = await makeTestDb();
  await seedDemo(src, { tenantName: 'A', password: 'senha-de-teste-123', emailPrefix: 'a' });
  await seedDemo(src, { tenantName: 'B', password: 'senha-de-teste-123', emailPrefix: 'b' });
  await src.query(`INSERT INTO landing_events (session_id, event) VALUES ('sess-0001', 'pageview'), ('sess-0001', 'cta_click')`);
}, 120_000);

const count = async (db: Db, t: string) => Number((await db.query<any>(`SELECT count(*)::int n FROM ${t}`)).rows[0].n);

describe('backup e restauração', () => {
  it('cobre todas as tabelas do esquema (nenhuma esquecida)', async () => {
    const { rows } = await src.query<{ t: string }>(
      `SELECT table_name t FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'`);
    const missing = rows.map((r) => r.t).filter((t) => !(BACKUP_TABLES as readonly string[]).includes(t));
    expect(missing).toEqual([]);
  });

  it('backup -> arquivo criptografado -> restauração em banco novo reproduz os dados', async () => {
    const original = await createBackup(src);
    const file = encryptBackup(original, KEY);
    expect(file.toString('utf8')).not.toContain('owner@a.demo'); // nada em texto claro
    const opened = decryptBackup(file, KEY);
    verifyBackup(opened);

    const dst = await makeTestDb();
    const restored = await restoreBackup(dst, opened);
    for (const t of BACKUP_TABLES) expect(restored[t]).toBe(await count(src, t));

    // dados idênticos, inclusive tipos delicados (dinheiro, jsonb, datas, uuid)
    const same = async (sql: string) => expect((await dst.query(sql)).rows).toEqual((await src.query(sql)).rows);
    await same(`SELECT id, amount_cents, status, to_char(due_date,'YYYY-MM-DD') d, paid_principal_cents, late_fee_cents, interest_cents FROM rental_charges ORDER BY id`);
    await same(`SELECT id, gross_cents, admin_fee_cents, net_cents, status FROM rental_payouts ORDER BY id`);
    await same(`SELECT id, score, score_reasons, owner_id, status FROM leads ORDER BY id`);
    await same(`SELECT id, tenant_id, email, role, password_hash FROM users ORDER BY id`);
    await same(`SELECT id, action, summary, before, after FROM audit_log ORDER BY id`);
    // senha continua funcionando no banco restaurado
    const u = (await dst.query<any>(`SELECT password_hash FROM users WHERE email = 'owner@a.demo'`)).rows[0];
    expect(verifyPassword('senha-de-teste-123', u.password_hash)).toBe(true);
    // sequência de landing_events foi reposicionada: novo insert não colide
    await dst.query(`INSERT INTO landing_events (session_id, event) VALUES ('sess-0002', 'pageview')`);
    expect(await count(dst, 'landing_events')).toBe((await count(src, 'landing_events')) + 1);
    await dst.close();
  });

  it('recusa chave errada e arquivo adulterado', async () => {
    const file = encryptBackup(await createBackup(src), KEY);
    expect(() => decryptBackup(file, 'outra-chave-qualquer-com-mais-de-32-caracteres')).toThrow(BackupError);
    const tampered = Buffer.from(file);
    tampered[tampered.length - 5] ^= 0xff;
    expect(() => decryptBackup(tampered, KEY)).toThrow(/chave incorreta ou arquivo adulterado/);
    expect(() => decryptBackup(Buffer.from('lixo qualquer que não é backup'.repeat(5)), KEY)).toThrow(/não é um backup/);
    expect(() => encryptBackup({} as any, 'curta')).toThrow(/32 caracteres/);
  });

  it('detecta conteúdo alterado dentro do backup (checksum) e contagem incompatível', async () => {
    const b = await createBackup(src);
    const altered = JSON.parse(JSON.stringify(b));
    altered.tables.rental_charges[0].amount_cents = 1;
    expect(() => verifyBackup(altered)).toThrow(/checksum/);
    const truncated = JSON.parse(JSON.stringify(b));
    truncated.tables.leads.pop();
    truncated.checksum = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(truncated.tables)).digest('hex');
    expect(() => verifyBackup(truncated)).toThrow(/incompleto/);
    const future = { ...b, migrations: [...b.migrations, 999] };
    expect(() => verifyBackup(future)).toThrow(/versão mais nova/);
  });

  it('recusa restaurar em banco com dados (não mistura tenants)', async () => {
    const b = await createBackup(src);
    await expect(restoreBackup(src, b)).rejects.toThrow(/não está vazio/);
  });

  it('é tudo ou nada: falha no meio não deixa dados parciais', async () => {
    const b = JSON.parse(JSON.stringify(await createBackup(src)));
    // referência quebrada em tabela tardia: a FK falha depois de tenants/users/leads já terem entrado
    b.tables.rental_payouts[0].charge_id = '00000000-0000-0000-0000-000000000000';
    b.checksum = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(b.tables)).digest('hex');
    const dst = await makeTestDb();
    await expect(restoreBackup(dst, b)).rejects.toThrow();
    for (const t of BACKUP_TABLES) expect(await count(dst, t)).toBe(0); // rollback total
    await dst.close();
  });
});

describe('migrações', () => {
  it('são aplicadas uma vez e reaplicar não faz nada', async () => {
    const db = await makeTestDb();
    const { rows } = await db.query<any>(`SELECT version FROM schema_migrations ORDER BY version`);
    expect(rows.map((r) => Number(r.version))).toEqual(MIGRATIONS.map((m) => m.version));
    expect(await runMigrations(db)).toEqual([]);
    const next = { version: 999, name: 'teste', sql: 'CREATE TABLE migracao_teste (id int)' };
    expect(await runMigrations(db, [...MIGRATIONS, next])).toEqual([999]);
    expect(await runMigrations(db, [...MIGRATIONS, next])).toEqual([]);
    await db.close();
  });

  it('migração com erro desfaz tudo (transacional) e não fica registrada', async () => {
    const db = await makeTestDb();
    const bad = { version: 998, name: 'quebrada', sql: 'CREATE TABLE ok_antes (id int); SELECT coluna_inexistente FROM tabela_inexistente;' };
    await expect(runMigrations(db, [...MIGRATIONS, bad])).rejects.toThrow();
    const t = await db.query<any>(`SELECT to_regclass('ok_antes') r`);
    expect(t.rows[0].r).toBeNull();
    const v = await db.query<any>(`SELECT 1 FROM schema_migrations WHERE version = 998`);
    expect(v.rows).toHaveLength(0);
    await db.close();
  });
});
