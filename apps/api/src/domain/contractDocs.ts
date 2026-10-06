import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import type { Queryable } from '../db/client.js';
import { scoped } from '../db/client.js';
import { decryptText } from './crypto.js';
import { reaisPorExtenso } from './extenso.js';

export const STARTER_NOTES = 'Modelo inicial de exemplo, SEM validação jurídica. Faça revisar por advogado e marque como "revisado" antes de usar em contratos reais.';

export const STARTER_BODY = `# CONTRATO DE LOCAÇÃO DE IMÓVEL

Pelo presente instrumento particular, de um lado {{locador.nome}}, inscrito(a) no CPF/CNPJ nº {{locador.documento}}, doravante denominado(a) LOCADOR(A), e de outro lado {{locatario.nome}}, inscrito(a) no CPF/CNPJ nº {{locatario.documento}}, doravante denominado(a) LOCATÁRIO(A), com a intermediação de {{imobiliaria.nome}}, têm entre si justo e contratado o seguinte:

## Cláusula 1ª – Do objeto
O LOCADOR dá em locação ao LOCATÁRIO o imóvel {{imovel.titulo}} (código {{imovel.codigo}}), situado no bairro {{imovel.bairro}}, {{imovel.cidade}}.

## Cláusula 2ª – Do prazo
A locação tem prazo de {{contrato.prazo_meses}} meses, com início em {{contrato.inicio}} e término em {{contrato.fim}}.

## Cláusula 3ª – Do aluguel
O aluguel mensal é de {{aluguel.valor}} ({{aluguel.valor_extenso}}), com vencimento todo dia {{aluguel.dia_vencimento}} de cada mês.

## Cláusula 4ª – Do reajuste
O aluguel será reajustado a cada 12 (doze) meses pelo índice: {{contrato.indice_reajuste}}.

## Cláusula 5ª – Do atraso no pagamento
Em caso de atraso no pagamento incidirão multa de {{encargos.multa}} e juros de {{encargos.juros}}.

## Cláusula 6ª – Da administração
A administração do imóvel e a cobrança dos aluguéis ficam a cargo de {{imobiliaria.nome}}, que fará jus à taxa de administração de {{encargos.taxa_administracao}} sobre os valores de aluguel recebidos.

## Cláusula 7ª – Da assinatura eletrônica
As partes reconhecem como válida a assinatura eletrônica deste instrumento, na forma do art. 10, § 2º, da Medida Provisória nº 2.200-2/2001, e declaram que o meio utilizado comprova a autoria e a integridade do documento.

## Cláusula 8ª – Do foro
Fica eleito o foro da comarca em que se situa o imóvel para dirimir quaisquer dúvidas oriundas deste contrato.

{{imobiliaria.nome}}, {{hoje}}.`;

export const contentHash = (text: string) => createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');

const TOKEN = /\{\{\s*([a-z_]+(?:\.[a-z_]+)*)\s*\}\}/g;

/** Variáveis que o sistema conhece. Qualquer outra chave num modelo é erro de digitação e é apontada. */
export const KNOWN_VARIABLES = [
  'locador.nome', 'locador.documento', 'locador.email',
  'locatario.nome', 'locatario.documento', 'locatario.email', 'locatario.telefone',
  'imovel.codigo', 'imovel.titulo', 'imovel.bairro', 'imovel.cidade', 'imovel.finalidade',
  'aluguel.valor', 'aluguel.valor_extenso', 'aluguel.dia_vencimento',
  'contrato.inicio', 'contrato.fim', 'contrato.prazo_meses', 'contrato.indice_reajuste',
  'encargos.multa', 'encargos.juros', 'encargos.taxa_administracao',
  'imobiliaria.nome', 'hoje',
] as const;

export type Vars = Record<string, string | null | undefined>;

export function templateVariables(body: string): string[] {
  return [...new Set([...body.matchAll(TOKEN)].map((m) => m[1]))];
}

export interface Rendered { text: string; unknown: string[]; missing: string[] }

/**
 * Substitui {{variáveis}}. Nada é inventado: chave desconhecida e variável sem valor permanecem no texto como {{chave}}
 * e são listadas, para a pessoa corrigir o cadastro ou o modelo antes de enviar o documento para revisão.
 */
export function renderTemplate(body: string, vars: Vars): Rendered {
  const unknown = new Set<string>(), missing = new Set<string>();
  const text = body.replace(TOKEN, (whole, key: string) => {
    if (!(KNOWN_VARIABLES as readonly string[]).includes(key)) { unknown.add(key); return whole; }
    const v = vars[key];
    if (v == null || v === '') { missing.add(key); return whole; }
    return v;
  });
  return { text, unknown: [...unknown], missing: [...missing] };
}

/** Marcadores {{...}} que ainda restam no texto (documento incompleto). */
export const unresolvedTokens = (text: string) => [...new Set([...text.matchAll(TOKEN)].map((m) => m[1]))];

const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (bps: number) => `${(bps / 100).toString().replace('.', ',')}%`;
const dmy = (iso: string) => iso.split('-').reverse().join('/');
const INDEX: Record<string, string> = { IGPM: 'IGP-M (Fundação Getulio Vargas)', IPCA: 'IPCA (IBGE)', manual: 'índice de comum acordo entre as partes' };

/** Monta as variáveis de um contrato de locação (documentos descriptografados só aqui, para entrar no texto do contrato). */
export async function loadContractVars(db: Queryable, tenantId: string, contractId: string): Promise<Vars | null> {
  const s = scoped(db, tenantId);
  const [c] = await s.rows<any>(
    `SELECT c.rent_cents, c.due_day, c.adjustment_index, c.admin_fee_bps, c.late_fee_bps, c.interest_bps_month,
            to_char(c.start_date,'YYYY-MM-DD') start_date, to_char(c.end_date,'YYYY-MM-DD') end_date,
            p.code, p.title, p.neighborhood, p.city, p.purpose,
            l.name l_name, l.email l_email, l.document_enc l_doc, r.name r_name, r.email r_email, r.phone r_phone, r.document_enc r_doc,
            to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date,'YYYY-MM-DD') today
       FROM rental_contracts c JOIN properties p ON p.id = c.property_id AND p.tenant_id = c.tenant_id
       JOIN contacts l ON l.id = c.landlord_id AND l.tenant_id = c.tenant_id JOIN contacts r ON r.id = c.renter_id AND r.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1 AND c.id = $2`, [contractId]);
  if (!c) return null;
  const [co] = await s.rows<{ name: string }>(`SELECT name FROM tenant_company WHERE tenant_id = $1`);
  const t = (await db.query<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [tenantId])).rows[0]; // tabela sem tenant_id: consulta direta, por id
  const [sy, sm] = c.start_date.split('-').map(Number), [ey, em] = c.end_date.split('-').map(Number);
  const rent = Number(c.rent_cents);
  return {
    'locador.nome': c.l_name, 'locador.documento': c.l_doc ? decryptText(c.l_doc) : null, 'locador.email': c.l_email,
    'locatario.nome': c.r_name, 'locatario.documento': c.r_doc ? decryptText(c.r_doc) : null, 'locatario.email': c.r_email, 'locatario.telefone': c.r_phone,
    'imovel.codigo': c.code, 'imovel.titulo': c.title, 'imovel.bairro': c.neighborhood, 'imovel.cidade': c.city, 'imovel.finalidade': c.purpose,
    'aluguel.valor': brl(rent), 'aluguel.valor_extenso': reaisPorExtenso(rent), 'aluguel.dia_vencimento': String(c.due_day),
    'contrato.inicio': dmy(c.start_date), 'contrato.fim': dmy(c.end_date), 'contrato.prazo_meses': String((ey - sy) * 12 + (em - sm)),
    'contrato.indice_reajuste': INDEX[c.adjustment_index] ?? c.adjustment_index,
    'encargos.multa': pct(c.late_fee_bps), 'encargos.juros': `${pct(c.interest_bps_month)} ao mês`, 'encargos.taxa_administracao': pct(c.admin_fee_bps),
    'imobiliaria.nome': co?.name ?? t?.name ?? null, hoje: dmy(c.today),
  };
}

/** PDF do documento aprovado: texto fiel ao aprovado + rodapé com identificação e hash de integridade em todas as páginas. */
export async function renderPdf(opts: { title: string; body: string; documentId: string; hash: string }): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 64, bottom: 72, left: 64, right: 64 }, bufferPages: true,
    info: { Title: opts.title, Producer: 'Aimob', Creator: 'Aimob' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((r) => doc.on('end', () => r()));

  for (const block of opts.body.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const t = block.trim();
    if (!t) continue;
    if (t.startsWith('## ')) doc.moveDown(0.6).font('Helvetica-Bold').fontSize(11.5).text(t.slice(3), { lineGap: 2 }).moveDown(0.2);
    else if (t.startsWith('# ')) doc.font('Helvetica-Bold').fontSize(15).text(t.slice(2), { align: 'center' }).moveDown(0.8);
    else doc.font('Helvetica').fontSize(11).text(t, { align: 'justify', lineGap: 3 }).moveDown(0.5);
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // permite escrever na margem sem abrir página nova
    doc.font('Helvetica').fontSize(7.5).fillColor('#666666').text(
      `Documento ${opts.documentId.slice(0, 8)} · integridade SHA-256 do texto: ${opts.hash.slice(0, 24)}… · página ${i + 1} de ${range.count}`,
      64, doc.page.height - 44, { width: doc.page.width - 128, align: 'center', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  await done;
  return Buffer.concat(chunks);
}
