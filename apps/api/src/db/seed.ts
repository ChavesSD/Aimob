import { openDb, type Db } from './client.js';
import { hashPassword } from '../auth.js';
import { scoreLead } from '../domain/scoring.js';
import { config } from '../config.js';
import { payCharge, today } from '../domain/rentalService.js';

const NEIGHBORHOODS = ['Manaíra', 'Tambaú', 'Bessa', 'Cabo Branco', 'Altiplano'];
const TYPES = ['Apartamento', 'Casa', 'Cobertura', 'Terreno'];
const FIRST = ['Maria', 'João', 'Ana', 'Carlos', 'Beatriz', 'Pedro', 'Luiza', 'Rafael', 'Camila', 'Bruno'];
const LAST = ['Silva', 'Souza', 'Lima', 'Oliveira', 'Costa', 'Pereira', 'Almeida'];
const SOURCES = ['portal', 'site', 'whatsapp', 'indicacao', 'manual'];

export async function seedDemo(db: Db, opts: { tenantName: string; password: string; emailPrefix: string; mfaPolicy?: 'off' | 'admins' | 'staff' }) {
  const { rows: [t] } = await db.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [`${opts.tenantName} (DEMONSTRAÇÃO)`]);
  const tid = t.id;
  // Dados de demonstração não exigem MFA por padrão (conveniência de teste e de demo). Imobiliárias reais começam em 'admins'.
  await db.query(`INSERT INTO tenant_settings (tenant_id, mfa_policy) VALUES ($1, $2)`, [tid, opts.mfaPolicy ?? 'off']);
  const pw = hashPassword(opts.password);
  const users: string[] = [];
  for (const [role, name] of [['owner', 'Diretoria Demo'], ['manager', 'Gerente Demo'], ['broker', 'Corretor Demo']] as const) {
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [tid, `${role}@${opts.emailPrefix}.demo`, name, role, pw]);
    users.push(u.id);
  }
  await db.query(
    `INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES ($1,$2,'Financeiro Demo','finance',$3)`,
    [tid, `financeiro@${opts.emailPrefix}.demo`, pw]);
  for (const n of [2, 3]) {
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES ($1,$2,$3,'broker',$4) RETURNING id`,
      [tid, `corretor${n}@${opts.emailPrefix}.demo`, `Corretor Demo ${n}`, pw]);
    users.push(u.id);
  }
  const props: string[] = [];
  for (let i = 1; i <= 40; i++) {
    const n = NEIGHBORHOODS[i % NEIGHBORHOODS.length];
    const { rows: [p] } = await db.query<{ id: string }>(
      `INSERT INTO properties (tenant_id, code, type, purpose, title, description, neighborhood, city, bedrooms, parking, area_m2, price_cents, photos, created_at)
       VALUES ($1,$2,$3,$13,$4,$5,$6,'João Pessoa',$7,$8,$9,$10,$11, now() - ($12 || ' days')::interval) RETURNING id`,
      [tid, String(1000 + i), TYPES[i % TYPES.length], `${TYPES[i % TYPES.length]} em ${n}`,
        i % 4 === 0 ? '' : 'Imóvel bem localizado, com acabamento de qualidade, próximo a comércio, escolas e serviços do bairro.',
        n, 1 + (i % 4), i % 3, 50 + i * 3, (250_000 + i * 12_000) * 100, i % 5 === 0 ? 2 : 6 + (i % 10), String(i * 4), i % 10 === 0 ? 'aluguel' : 'venda']);
    props.push(p.id);
  }
  for (let i = 0; i < 60; i++) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 3) % LAST.length]}`;
    const source = SOURCES[i % SOURCES.length];
    const hoursAgo = 1 + (i * 7) % 240;
    const responded = i % 3 !== 0;
    const lastContactH = responded ? 1 + (i * 11) % 120 : null;
    const stage = i % 6;
    const budget = i % 2 ? (300_000 + i * 8_000) * 100 : null;
    const { score, reasons } = scoreLead({ source, hasBudget: !!budget, hasPhone: true, hasPropertyInterest: i % 3 === 1,
      hoursSinceCreated: hoursAgo, hoursSinceLastContact: lastContactH, visits: i % 7 === 0 ? 1 : 0, stagePosition: stage });
    const { rows: [c] } = await db.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, name, phone) VALUES ($1,$2,$3) RETURNING id`, [tid, name, `8399${String(1000000 + i * 37).slice(0, 7)}`]);
    await db.query(
      `INSERT INTO leads (tenant_id, contact_id, source, stage_position, budget_cents, property_id, score, score_reasons, owner_id,
                          created_at, first_response_at, last_contact_at, next_action_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() - ($10 || ' hours')::interval,
               CASE WHEN $11::boolean THEN now() - ($10 || ' hours')::interval + interval '20 minutes' END,
               CASE WHEN $12::int IS NOT NULL THEN now() - ($12 || ' hours')::interval END,
               CASE WHEN $13::boolean THEN now() + interval '1 day' END)`,
      [tid, c.id, source, stage, budget, i % 3 === 1 ? props[i % props.length] : null, score, JSON.stringify(reasons),
        i < 8 ? null : users[2], String(hoursAgo), responded, lastContactH, i % 4 !== 0]);
  }
  const { rows: leadRows } = await db.query<{ id: string }>(`SELECT id FROM leads WHERE tenant_id = $1 ORDER BY created_at LIMIT 12`, [tid]);
  for (const [i, l] of leadRows.entries()) {
    // 3 passadas sem feedback, 3 já realizadas, 6 futuras
    const day = i < 3 ? -(2 + i) : i < 6 ? -i : 1 + (i - 6);
    const status = i >= 3 && i < 6 ? 'completed' : 'scheduled';
    await db.query(
      `INSERT INTO visits (tenant_id, lead_id, property_id, broker_id, scheduled_at, status, outcome)
       VALUES ($1,$2,$3,$4, date_trunc('day', now()) + ($5 || ' days')::interval + ($6 || ' hours')::interval, $7, $8)`,
      [tid, l.id, props[i], users[2], String(day), String(9 + i), status, status === 'completed' ? 'interessado' : null]);
  }
  await seedRentals(db, tid, props);
  return { tenantId: tid };
}

const shiftMonth = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

/** 4 contratos de locação demo: um com reajuste vencido, um com aluguel em atraso, um quase no aniversário, um em dia. */
async function seedRentals(db: Db, tid: string, props: string[]) {
  const now = await today(db);
  const cur = now.slice(0, 7);
  const specs = [
    { prop: 9, rent: 220_000, dueDay: 5, startBack: 14, owner: 'Helena Prado', renter: 'Gustavo Reis', prev: 'late' },
    { prop: 19, rent: 310_000, dueDay: 5, startBack: 6, owner: 'Otávio Mendes', renter: 'Larissa Duarte', prev: 'open' },
    { prop: 29, rent: 185_000, dueDay: 15, startBack: 11, owner: 'Helena Prado', renter: 'Felipe Nunes', prev: 'ontime' },
    { prop: 39, rent: 450_000, dueDay: 20, startBack: 3, owner: 'Sílvia Cardoso', renter: 'Marcos Teles', prev: 'ontime' },
  ] as const;
  const people = new Map<string, string>();
  const contact = async (name: string, kind: 'owner' | 'renter') => {
    const key = `${kind}:${name}`;
    if (!people.has(key)) {
      const { rows: [c] } = await db.query<{ id: string }>(`INSERT INTO contacts (tenant_id, name, phone, kind) VALUES ($1,$2,$3,$4) RETURNING id`, [tid, name, '83988887777', kind]);
      people.set(key, c.id);
    }
    return people.get(key)!;
  };
  for (const s of specs) {
    const start = `${shiftMonth(cur, -s.startBack)}-10`;
    const end = `${shiftMonth(cur, 24 - s.startBack)}-10`;
    const landlord = await contact(s.owner, 'owner');
    const renter = await contact(s.renter, 'renter');
    const { rows: [c] } = await db.query<{ id: string }>(
      `INSERT INTO rental_contracts (tenant_id, property_id, landlord_id, renter_id, rent_cents, due_day, start_date, end_date, adjustment_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'IGPM') RETURNING id`, [tid, props[s.prop], landlord, renter, s.rent, s.dueDay, start, end]);
    await db.query(`UPDATE properties SET status = 'rented', owner_contact_id = $2 WHERE id = $1`, [props[s.prop], landlord]);
    for (const off of [-2, -1, 0, 1]) {
      const comp = shiftMonth(cur, off);
      if (comp < start.slice(0, 7)) continue;
      const due = `${comp}-${String(s.dueDay).padStart(2, '0')}`;
      const { rows: [ch] } = await db.query<{ id: string }>(
        `INSERT INTO rental_charges (tenant_id, contract_id, competence, due_date, amount_cents) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [tid, c.id, comp, due, s.rent]);
      if (off === -2) await payCharge(db, tid, ch.id, { paidOn: due });
      if (off === -1 && s.prev === 'ontime') await payCharge(db, tid, ch.id, { paidOn: due });
      if (off === -1 && s.prev === 'late') {
        const late = new Date(Date.parse(`${due}T00:00:00Z`) + 4 * 86_400_000).toISOString().slice(0, 10);
        await payCharge(db, tid, ch.id, { paidOn: late > now ? now : late });
      }
    }
  }
}

if (process.argv[1]?.endsWith('seed.ts')) {
  const pw = process.env.SEED_PASSWORD;
  if (!pw || pw.length < 12) throw new Error('Defina SEED_PASSWORD (mín. 12 caracteres) para criar os usuários demo');
  const db = await openDb(config.databaseUrl || config.dataDir);
  const policy = (['off', 'admins', 'staff'] as const).find((x) => x === process.env.SEED_MFA_POLICY);
  const r = await seedDemo(db, { tenantName: 'Imobiliária Exemplo', password: pw, emailPrefix: 'exemplo', mfaPolicy: policy });
  console.log('Seed demo criado. Tenant:', r.tenantId, '— usuários: owner@exemplo.demo, manager@exemplo.demo, broker@exemplo.demo');
  await db.close();
}
