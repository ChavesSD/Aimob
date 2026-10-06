import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type Db } from '../src/db/client.js';
import { buildApp } from '../src/app.js';
import { buildDiagnosis } from '../src/domain/diagnosis.js';
import { config } from '../src/config.js';

let db: Db;
let app: FastifyInstance;

const valid = {
  name: 'Maria Souza', company: 'Imobiliária Exemplo', phone: '(83) 99999-0000', email: 'Maria@Exemplo.com.br',
  brokers: '6-15', properties: '51-200', sells: true, rents: false, currentSystem: 'planilhas',
  pains: ['leads_perdidos', 'financeiro'], consent: true,
  utm: { source: 'google', campaign: 'teste' }, page: '/', device: 'desktop',
};
const post = (url: string, payload: unknown, ip = '10.0.0.1') =>
  app.inject({ method: 'POST', url, payload: payload as any, remoteAddress: ip });

beforeAll(async () => {
  config.jwtSecret = 'z'.repeat(40);
  db = await openDb();
  app = await buildApp(db);
});

describe('diagnóstico público', () => {
  it('grava lead, normaliza dados e devolve diagnóstico sem prometer o que não existe', async () => {
    const r = await post('/api/public/diagnostico', valid);
    expect(r.statusCode).toBe(201);
    const { diagnosis } = r.json();
    expect(diagnosis).toMatch(/recuperação de leads/);
    expect(diagnosis).toMatch(/Também já podemos ajudar em: financeiro da locação/);
    expect(diagnosis).toMatch(/registrados manualmente/); // a ressalva acompanha a menção, mesmo como dor secundária
    expect(diagnosis).not.toMatch(/Em desenvolvimento/);
    const { rows } = await db.query<any>('SELECT phone, email, utm, ip_hash, consent_at FROM diagnostics');
    expect(rows).toHaveLength(1);
    expect(rows[0].phone).toBe('83999990000');
    expect(rows[0].email).toBe('maria@exemplo.com.br');
    expect(rows[0].utm.source).toBe('google');
    expect(rows[0].consent_at).toBeTruthy();
    expect(rows[0].ip_hash).not.toContain('10.0.0.1'); // IP nunca em claro
  });

  it('exige consentimento LGPD e dados válidos', async () => {
    expect((await post('/api/public/diagnostico', { ...valid, consent: false }, '10.0.0.2')).statusCode).toBe(400);
    expect((await post('/api/public/diagnostico', { ...valid, consent: undefined }, '10.0.0.2')).statusCode).toBe(400);
    expect((await post('/api/public/diagnostico', { ...valid, email: 'invalido' }, '10.0.0.2')).statusCode).toBe(400);
    expect((await post('/api/public/diagnostico', { ...valid, phone: '123' }, '10.0.0.2')).statusCode).toBe(400);
    expect((await post('/api/public/diagnostico', { ...valid, pains: ['inventada'] }, '10.0.0.2')).statusCode).toBe(400);
    const { rows } = await db.query('SELECT 1 FROM diagnostics');
    expect(rows).toHaveLength(1); // nenhuma tentativa inválida gravou
  });

  it('honeypot preenchido responde sucesso mas não grava', async () => {
    const r = await post('/api/public/diagnostico', { ...valid, website: 'http://spam.example' }, '10.0.0.3');
    expect(r.statusCode).toBe(200);
    expect((await db.query('SELECT 1 FROM diagnostics')).rows).toHaveLength(1);
  });

  it('limita envios por IP (anti-spam)', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await post('/api/public/diagnostico', valid, '10.0.0.9')).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 201)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it('diagnóstico de locação declara o que é manual e o que está só no roadmap', () => {
    const d = buildDiagnosis(['visitas'], { sells: false, rents: true });
    expect(d).toMatch(/registro manual/);
    expect(d).toMatch(/boleto\/Pix.*roadmap/);
  });
  it('dor de transparência para o proprietário continua marcada como indisponível', () => {
    expect(buildDiagnosis(['leads_perdidos', 'transparencia_proprietario'], { sells: true, rents: false })).toMatch(/Em desenvolvimento \(ainda indisponível\).*proprietário/);
  });
});

describe('eventos da landing', () => {
  it('registra eventos anônimos e rejeita eventos desconhecidos', async () => {
    const ok = await post('/api/public/evento', { sessionId: 'abc12345-xyz', event: 'cta_click', detail: 'hero', utm: { source: 'x' }, device: 'mobile' }, '10.0.1.1');
    expect(ok.statusCode).toBe(204);
    expect((await post('/api/public/evento', { sessionId: 'abc12345-xyz', event: 'hack' }, '10.0.1.1')).statusCode).toBe(400);
    expect((await post('/api/public/evento', { sessionId: 'x y', event: 'pageview' }, '10.0.1.1')).statusCode).toBe(400);
    const { rows } = await db.query('SELECT event FROM landing_events');
    expect(rows).toHaveLength(1);
  });
});

describe('leitura dos diagnósticos (plataforma)', () => {
  const TOKEN = 'token-de-plataforma-para-testes-123';
  it('fica desligada sem token configurado e recusa token errado', async () => {
    delete process.env.PLATFORM_ADMIN_TOKEN;
    expect((await app.inject({ url: '/api/platform/diagnosticos', headers: { 'x-platform-token': TOKEN } })).statusCode).toBe(404);
    process.env.PLATFORM_ADMIN_TOKEN = TOKEN;
    expect((await app.inject({ url: '/api/platform/diagnosticos' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/platform/diagnosticos', headers: { 'x-platform-token': 'errado' } })).statusCode).toBe(404);
  });
  it('com o token correto lista os leads captados; token de tenant não serve', async () => {
    process.env.PLATFORM_ADMIN_TOKEN = TOKEN;
    const r = await app.inject({ url: '/api/platform/diagnosticos', headers: { 'x-platform-token': TOKEN } });
    expect(r.statusCode).toBe(200);
    expect(r.json().items.length).toBeGreaterThan(0);
    expect(r.json().items[0].email).toBeTruthy();
    expect((await app.inject({ url: '/api/platform/diagnosticos', headers: { authorization: 'Bearer qualquer' } })).statusCode).toBe(404);
    delete process.env.PLATFORM_ADMIN_TOKEN;
  });
});

describe('rotas privadas continuam protegidas', () => {
  it('caminhos disfarçados de /api/public não escapam da autenticação', async () => {
    for (const url of ['/api/public/../dashboard', '/api/public/%2e%2e/dashboard', '/api/dashboard?/api/public/x', '/api/public/diagnostico/../../leads']) {
      const r = await app.inject({ method: 'GET', url });
      expect([401, 404, 400]).toContain(r.statusCode);
    }
    expect((await app.inject({ url: '/api/dashboard' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/leads' })).statusCode).toBe(401);
  });
});
