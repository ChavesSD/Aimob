import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { scoped } from '../db/client.js';
import { audit } from '../audit.js';
import { guard } from '../guard.js';
import { adjustContract, generateCharges, nextAdjustmentDate, payCharge, today } from '../domain/rentalService.js';
import { daysLate, lateCharges } from '../domain/money.js';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Data inválida');
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function registerRentalRoutes(app: FastifyInstance, db: Db) {
  // ---- Proprietários e inquilinos ----
  app.get('/api/contacts', { preHandler: guard('rentals', 'view') }, async (req) => {
    const q = z.object({ kind: z.enum(['owner', 'renter']) }).parse(req.query);
    const items = await scoped(db, req.session!.tid).rows(
      `SELECT id, name, phone, email, kind FROM contacts WHERE tenant_id = $1 AND kind = $2 AND deleted_at IS NULL ORDER BY name LIMIT 500`, [q.kind]);
    return { items };
  });

  app.post('/api/contacts', { preHandler: guard('rentals', 'create') }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(2).max(120), phone: z.string().max(30).optional(), email: z.string().email().optional(), kind: z.enum(['owner', 'renter']) }).parse(req.body);
    const [c] = await scoped(db, req.session!.tid).rows(
      `INSERT INTO contacts (tenant_id, name, phone, email, kind) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, kind`, [b.name, b.phone ?? null, b.email ?? null, b.kind]);
    await audit(db, req, { action: 'contact.create', resource: 'contact', resourceId: c.id, summary: `${b.kind === 'owner' ? 'Proprietário' : 'Inquilino'} ${b.name} cadastrado` });
    return reply.code(201).send(c);
  });

  // ---- Contratos ----
  const contractInput = z.object({
    propertyId: uuid, landlordId: uuid, renterId: uuid,
    rentCents: z.number().int().positive().max(100_000_000_00),
    dueDay: z.number().int().min(1).max(28),
    startDate: isoDate, endDate: isoDate,
    adjustmentIndex: z.enum(['manual', 'IGPM', 'IPCA']).default('manual'),
    adminFeeBps: z.number().int().min(0).max(5000).default(1000),
    lateFeeBps: z.number().int().min(0).max(2000).default(200),
    interestBpsMonth: z.number().int().min(0).max(1000).default(100),
  }).refine((v) => v.endDate > v.startDate, { message: 'O fim do contrato deve ser depois do início.', path: ['endDate'] });

  app.post('/api/rentals', { preHandler: guard('rentals', 'create') }, async (req, reply) => {
    const b = contractInput.parse(req.body);
    const tid = req.session!.tid;
    const s = scoped(db, tid);
    const [prop] = await s.rows<any>(`SELECT purpose, title FROM properties WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [b.propertyId]);
    const [landlord] = await s.rows(`SELECT id FROM contacts WHERE tenant_id = $1 AND id = $2 AND kind = 'owner'`, [b.landlordId]);
    const [renter] = await s.rows(`SELECT id FROM contacts WHERE tenant_id = $1 AND id = $2 AND kind = 'renter'`, [b.renterId]);
    if (!prop || !landlord || !renter) return reply.code(404).send({ error: 'Imóvel, proprietário ou inquilino não encontrado.' });
    if (prop.purpose === 'venda') return reply.code(400).send({ error: 'Este imóvel está cadastrado apenas para venda. Altere a finalidade para aluguel antes.' });
    try {
      const [c] = await s.rows(
        `INSERT INTO rental_contracts (tenant_id, property_id, landlord_id, renter_id, rent_cents, due_day, start_date, end_date, adjustment_index, admin_fee_bps, late_fee_bps, interest_bps_month, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [b.propertyId, b.landlordId, b.renterId, b.rentCents, b.dueDay, b.startDate, b.endDate, b.adjustmentIndex, b.adminFeeBps, b.lateFeeBps, b.interestBpsMonth, req.session!.sub]);
      await s.rows(`UPDATE properties SET owner_contact_id = $2, status = 'rented', updated_at = now() WHERE tenant_id = $1 AND id = $3 RETURNING id`, [b.landlordId, b.propertyId]);
      await s.rows(`INSERT INTO property_events (tenant_id, property_id, kind, summary, actor_id) VALUES ($1,$2,'contrato',$3,$4)`,
        [b.propertyId, `Contrato de locação criado: ${brl(b.rentCents)}/mês`, req.session!.sub]);
      const generated = await generateCharges(db, tid, c.id, 2);
      await audit(db, req, { action: 'rental.create', resource: 'rental', resourceId: c.id, after: b, summary: `Contrato de locação de "${prop.title}" criado (${brl(b.rentCents)}/mês)` });
      return reply.code(201).send({ id: c.id, chargesGenerated: generated });
    } catch (e: any) {
      if (/one_active_contract|unique/i.test(e.message)) return reply.code(409).send({ error: 'Este imóvel já tem um contrato de locação ativo.' });
      throw e;
    }
  });

  app.get('/api/rentals', { preHandler: guard('rentals', 'view') }, async (req) => {
    const rows = await scoped(db, req.session!.tid).rows<any>(
      `SELECT c.id, c.rent_cents, c.due_day, c.status, c.adjustment_index, c.admin_fee_bps, c.late_fee_bps, c.interest_bps_month,
              to_char(c.start_date,'YYYY-MM-DD') start_date, to_char(c.end_date,'YYYY-MM-DD') end_date,
              p.title property_title, p.code property_code, l.name landlord_name, r.name renter_name,
              (SELECT to_char(max(applied_on),'YYYY-MM-DD') FROM rental_adjustments a WHERE a.tenant_id = c.tenant_id AND a.contract_id = c.id) last_adj
         FROM rental_contracts c JOIN properties p ON p.id = c.property_id AND p.tenant_id = c.tenant_id
         JOIN contacts l ON l.id = c.landlord_id AND l.tenant_id = c.tenant_id JOIN contacts r ON r.id = c.renter_id AND r.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1 ORDER BY c.status, c.created_at DESC LIMIT 300`);
    return { items: rows.map(({ last_adj, ...c }) => ({ ...c, next_adjustment: nextAdjustmentDate(c.start_date, last_adj) })) };
  });

  app.post('/api/rentals/:id/charges/generate', { preHandler: guard('rentals', 'edit') }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ monthsAhead: z.number().int().min(1).max(12).default(3) }).parse(req.body ?? {});
    const [c] = await scoped(db, req.session!.tid).rows(`SELECT id FROM rental_contracts WHERE tenant_id = $1 AND id = $2`, [id]);
    if (!c) return reply.code(404).send({ error: 'Contrato não encontrado.' });
    const created = await generateCharges(db, req.session!.tid, id, b.monthsAhead);
    await audit(db, req, { action: 'rental.charges', resource: 'rental', resourceId: id, summary: `${created} cobrança(s) gerada(s)` });
    return { created };
  });

  app.post('/api/rentals/:id/terminate', { preHandler: guard('rentals', 'admin') }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const s = scoped(db, req.session!.tid);
    const now = await today(db);
    const [c] = await s.rows<any>(`UPDATE rental_contracts SET status = 'ended', terminated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'active' RETURNING id, property_id`, [id]);
    if (!c) return reply.code(404).send({ error: 'Contrato ativo não encontrado.' });
    const cancelled = await s.rows(`UPDATE rental_charges SET status = 'canceled' WHERE tenant_id = $1 AND contract_id = $2 AND status = 'open' AND due_date > $3::date RETURNING id`, [id, now]);
    await s.rows(`UPDATE properties SET status = 'active', updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING id`, [c.property_id]);
    await audit(db, req, { action: 'rental.terminate', resource: 'rental', resourceId: id, summary: `Contrato encerrado; ${cancelled.length} cobrança(s) futura(s) cancelada(s). Cobranças vencidas permanecem em aberto.` });
    return { ok: true, cancelled: cancelled.length };
  });

  // ---- Cobranças ----
  const chargeSelect = `
    SELECT ch.id, ch.competence, ch.amount_cents, ch.status, to_char(ch.due_date,'YYYY-MM-DD') due_date, to_char(ch.paid_on,'YYYY-MM-DD') paid_on,
           ch.late_fee_cents, ch.interest_cents, c.late_fee_bps, c.interest_bps_month, p.title property_title, p.code property_code, r.name renter_name,
           CASE WHEN ch.status = 'open' AND ch.due_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN 'overdue' ELSE ch.status END AS effective_status
      FROM rental_charges ch JOIN rental_contracts c ON c.id = ch.contract_id AND c.tenant_id = ch.tenant_id
      JOIN properties p ON p.id = c.property_id AND p.tenant_id = ch.tenant_id JOIN contacts r ON r.id = c.renter_id AND r.tenant_id = ch.tenant_id`;

  async function enrich(rows: any[]) {
    const now = await today(db);
    return rows.map((r) => {
      const days = r.effective_status === 'overdue' ? daysLate(r.due_date, now) : 0;
      const calc = lateCharges(Number(r.amount_cents), days, { lateFeeBps: r.late_fee_bps, interestBpsMonth: r.interest_bps_month });
      return { id: r.id, competence: r.competence, due_date: r.due_date, paid_on: r.paid_on, status: r.effective_status, amount_cents: Number(r.amount_cents),
        property_title: r.property_title, property_code: r.property_code, renter_name: r.renter_name, days_late: days,
        late_fee_cents: r.status === 'paid' ? Number(r.late_fee_cents) : calc.lateFeeCents, interest_cents: r.status === 'paid' ? Number(r.interest_cents) : calc.interestCents,
        total_due_cents: calc.totalCents };
    });
  }

  app.get('/api/charges', { preHandler: guard('finance', 'view') }, async (req) => {
    const q = z.object({ status: z.enum(['open', 'overdue', 'paid']).optional() }).parse(req.query);
    const where = q.status === 'overdue' ? "AND ch.status = 'open' AND ch.due_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date"
      : q.status === 'open' ? "AND ch.status = 'open' AND ch.due_date >= (now() AT TIME ZONE 'America/Sao_Paulo')::date"
      : q.status === 'paid' ? "AND ch.status = 'paid'" : "AND ch.status <> 'canceled'";
    const rows = await scoped(db, req.session!.tid).rows<any>(`${chargeSelect} WHERE ch.tenant_id = $1 ${where} ORDER BY ch.due_date DESC LIMIT 300`);
    return { items: await enrich(rows) };
  });

  app.post('/api/charges/:id/pay', { preHandler: guard('finance', 'edit') }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ paidOn: isoDate.optional(), waiveLateFees: z.boolean().default(false) }).parse(req.body ?? {});
    const r = await payCharge(db, req.session!.tid, id, b);
    if (!r.ok) {
      const map = { not_found: [404, 'Cobrança não encontrada.'], already_paid: [409, 'Esta cobrança já foi baixada ou cancelada.'], future_date: [400, 'A data do pagamento não pode ser futura.'] } as const;
      return reply.code(map[r.error][0]).send({ error: map[r.error][1] });
    }
    await audit(db, req, { action: 'charge.pay', resource: 'charge', resourceId: id, after: { ...b, ...r },
      summary: `Cobrança baixada: ${brl(r.totalCents)} recebidos${r.daysLate ? ` (${r.daysLate} dia(s) de atraso)` : ''}${b.waiveLateFees ? '; multa e juros dispensados' : ''}` });
    return r;
  });

  // ---- Inadimplência ----
  app.get('/api/delinquency', { preHandler: guard('finance', 'view') }, async (req) => {
    const rows = await scoped(db, req.session!.tid).rows<any>(
      `${chargeSelect} WHERE ch.tenant_id = $1 AND ch.status = 'open' AND ch.due_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date ORDER BY ch.due_date ASC LIMIT 500`);
    const items = await enrich(rows);
    const sum = (f: (i: any) => number) => items.reduce((a, i) => a + f(i), 0);
    return { items, totals: { count: items.length, principalCents: sum((i) => i.amount_cents), lateFeeCents: sum((i) => i.late_fee_cents),
      interestCents: sum((i) => i.interest_cents), totalCents: sum((i) => i.total_due_cents) } };
  });

  // ---- Repasses ----
  app.get('/api/payouts', { preHandler: guard('finance', 'view') }, async (req) => {
    const q = z.object({ status: z.enum(['pending', 'paid']).default('pending') }).parse(req.query);
    const items = await scoped(db, req.session!.tid).rows<any>(
      `SELECT po.id, po.gross_cents, po.admin_fee_cents, po.net_cents, po.status, po.paid_at, l.name landlord_name, p.title property_title, ch.competence
         FROM rental_payouts po JOIN contacts l ON l.id = po.landlord_id AND l.tenant_id = po.tenant_id
         JOIN rental_contracts c ON c.id = po.contract_id AND c.tenant_id = po.tenant_id JOIN properties p ON p.id = c.property_id AND p.tenant_id = po.tenant_id
         JOIN rental_charges ch ON ch.id = po.charge_id AND ch.tenant_id = po.tenant_id
        WHERE po.tenant_id = $1 AND po.status = $2 ORDER BY po.created_at DESC LIMIT 300`, [q.status]);
    const totalNet = items.reduce((a: number, i: any) => a + Number(i.net_cents), 0);
    return { items: items.map((i: any) => ({ ...i, gross_cents: Number(i.gross_cents), admin_fee_cents: Number(i.admin_fee_cents), net_cents: Number(i.net_cents) })), totalNetCents: totalNet };
  });

  app.post('/api/payouts/:id/pay', { preHandler: guard('finance', 'edit') }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const [po] = await scoped(db, req.session!.tid).rows<any>(
      `UPDATE rental_payouts SET status = 'paid', paid_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'pending' RETURNING net_cents`, [id]);
    if (!po) return reply.code(409).send({ error: 'Repasse não encontrado ou já realizado.' });
    await audit(db, req, { action: 'payout.pay', resource: 'payout', resourceId: id, summary: `Repasse de ${brl(Number(po.net_cents))} marcado como realizado` });
    return { ok: true };
  });

  // ---- Reajustes ----
  app.get('/api/adjustments/due', { preHandler: guard('rentals', 'view') }, async (req) => {
    const now = await today(db);
    const rows = await scoped(db, req.session!.tid).rows<any>(
      `SELECT c.id, c.rent_cents, c.adjustment_index, to_char(c.start_date,'YYYY-MM-DD') start_date, p.title property_title, r.name renter_name,
              (SELECT to_char(max(applied_on),'YYYY-MM-DD') FROM rental_adjustments a WHERE a.tenant_id = c.tenant_id AND a.contract_id = c.id) last_adj
         FROM rental_contracts c JOIN properties p ON p.id = c.property_id AND p.tenant_id = c.tenant_id JOIN contacts r ON r.id = c.renter_id AND r.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1 AND c.status = 'active'`);
    const limit = new Date(Date.parse(`${now}T00:00:00Z`) + 60 * 86_400_000).toISOString().slice(0, 10);
    const items = rows.map(({ last_adj, ...c }) => ({ ...c, rent_cents: Number(c.rent_cents), due_on: nextAdjustmentDate(c.start_date, last_adj) }))
      .filter((c) => c.due_on <= limit).sort((a, b) => a.due_on.localeCompare(b.due_on));
    return { items, today: now };
  });

  app.post('/api/rentals/:id/adjust', { preHandler: guard('rentals', 'admin') }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ percentBps: z.number().int().min(1).max(3000), indexName: z.string().trim().min(2).max(30), note: z.string().max(300).optional() }).parse(req.body);
    const r = await adjustContract(db, req.session!.tid, id, b.percentBps, b.indexName, b.note ?? null, req.session!.sub);
    if (!r.ok) {
      return r.error === 'too_early'
        ? reply.code(409).send({ error: `O reajuste só pode ser aplicado a partir de 60 dias antes do aniversário do contrato (${r.dueOn}).` })
        : reply.code(404).send({ error: 'Contrato ativo não encontrado.' });
    }
    await audit(db, req, { action: 'rental.adjust', resource: 'rental', resourceId: id, after: b,
      summary: `Aluguel reajustado de ${brl(r.previousCents)} para ${brl(r.newCents)} (+${(b.percentBps / 100).toFixed(2)}% ${b.indexName})` });
    return r;
  });
}
