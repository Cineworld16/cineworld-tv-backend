import { supabaseAdmin } from '../config/supabase.js';
import { parseBRL } from '../lib/money.js';

export const PRODUCER_EMAIL = 'admin@seudominio.com';
export const SOCIO_EMAIL = 'eriktizon30@gmail.com';
export const VOCE_KEY = '__voce__';
export const ERIK_KEY = '__erik__';

/** Metas de faturamento gerado (plaquinhas), no espírito das da Kirvano. */
export const AFFILIATE_MILESTONES = [10_000, 50_000, 100_000, 500_000, 1_000_000];

export type RowTipo = 'voce' | 'socio' | 'afiliado';

export interface AffiliateRow {
  key: string;
  label: string;
  tipo: RowTipo;
  vendas: number;
  validas: number;
  canceladas: number;
  receita: number;
  comissao: number; // o que ESSA pessoa recebeu de comissão
}

export interface SalesPoint {
  date: string;
  total: number;
}

export interface PaymentConv {
  method: string;
  attempts: number;
  approved: number;
  rate: number | null;
}

export interface AffiliatesResult {
  affiliates: AffiliateRow[];
  totals: { afiliados: number; validas: number; receita: number; comissao: number };
  resumo: { totalFaturado: number; numVendas: number; ticketMedio: number };
  chart: SalesPoint[];
  conversao: { geral: number | null; porPagamento: PaymentConv[] };
}

export interface DateRange {
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Só aceita YYYY-MM-DD; ignora lixo. */
function normRange(opts?: DateRange): { from?: string; to?: string } {
  const from = opts?.from && DATE_RE.test(opts.from) ? opts.from : undefined;
  const to = opts?.to && DATE_RE.test(opts.to) ? opts.to : undefined;
  return { from, to };
}

type SubRow = {
  afiliado_email: string | null;
  afiliado_comissao: number | null; // coproductionCommission (Erik)
  pcom: string | null; // commission (você, produtor) — vendas via webhook
  acom: string | null; // affiliateCommission (afiliado externo) — vendas via webhook
  ccom: string | null; // csv_row->Comissão (= sua comissão de produtor) — vendas antigas do CSV
  valor_total: number | null;
  data_compra: string | null;
  status: string;
};

const isInvalid = (s: string) => s === 'cancelado' || s === 'reembolsado';

function emptyRow(key: string, label: string, tipo: RowTipo): AffiliateRow {
  return { key, label, tipo, vendas: 0, validas: 0, canceladas: 0, receita: 0, comissao: 0 };
}

/** Conversão de pagamento (aprovadas ÷ checkouts iniciados) a partir dos eventos. */
async function paymentConversion(range: {
  from?: string;
  to?: string;
}): Promise<{ geral: number | null; porPagamento: PaymentConv[] }> {
  let q = supabaseAdmin
    .from('webhook_events')
    .select('event_type, sale_id, pm:raw_payload->payment->>method')
    .limit(20000);
  if (range.from) q = q.gte('received_at', `${range.from}T00:00:00`);
  if (range.to) q = q.lte('received_at', `${range.to}T23:59:59.999`);
  const { data, error } = await q;
  if (error) throw error;

  const byMethod = new Map<string, { att: Set<string>; ap: Set<string> }>();
  const allAtt = new Set<string>();
  const allAp = new Set<string>();
  for (const e of data ?? []) {
    const r = e as { event_type: string; sale_id: string | null; pm: string | null };
    if (!r.sale_id) continue;
    const method = (r.pm || 'OUTRO').toUpperCase();
    let x = byMethod.get(method);
    if (!x) {
      x = { att: new Set(), ap: new Set() };
      byMethod.set(method, x);
    }
    x.att.add(r.sale_id);
    allAtt.add(r.sale_id);
    if (r.event_type === 'SALE_APPROVED') {
      x.ap.add(r.sale_id);
      allAp.add(r.sale_id);
    }
  }

  const porPagamento: PaymentConv[] = [...byMethod.entries()]
    .map(([method, x]) => ({
      method,
      attempts: x.att.size,
      approved: x.ap.size,
      rate: x.att.size ? x.ap.size / x.att.size : null,
    }))
    .sort((a, b) => b.attempts - a.attempts);

  return { geral: allAtt.size ? allAp.size / allAtt.size : null, porPagamento };
}

/**
 * Ranking de vendas por PESSOA (atribuição): você (vendas diretas) + Erik (as
 * dele) + afiliados externos (por email). Cada venda entra em UMA linha só. A
 * comissão é o total que cada um recebe (você/Erik são coprodutores em tudo).
 */
export async function listAffiliates(opts?: DateRange): Promise<AffiliatesResult> {
  const { from, to } = normRange(opts);

  let query = supabaseAdmin
    .from('subscribers')
    .select(
      'afiliado_email, afiliado_comissao, pcom:raw_payload->>commission, acom:raw_payload->>affiliateCommission, ccom:raw_payload->csv_row->>Comissão, valor_total, data_compra, status',
    )
    .limit(20000);
  if (from) query = query.gte('data_compra', `${from}T00:00:00`);
  if (to) query = query.lte('data_compra', `${to}T23:59:59.999`);
  const { data, error } = await query;
  if (error) throw error;

  const you = emptyRow(VOCE_KEY, PRODUCER_EMAIL, 'voce');
  const erik = emptyRow(ERIK_KEY, SOCIO_EMAIL, 'socio');
  const ext = new Map<string, AffiliateRow>();
  let voceComm = 0;
  let erikComm = 0;
  let totalReceita = 0;
  let totalValidas = 0;
  const byDate = new Map<string, number>();

  // cast via unknown: o parser de tipos do supabase-js não engole a chave "Comissão" (acento)
  for (const r of (data ?? []) as unknown as SubRow[]) {
    const invalid = isInvalid(r.status);
    const valor = Number(r.valor_total ?? 0);
    const eff = r.afiliado_email?.trim().toLowerCase() || null;
    // nas vendas antigas (CSV) a comissão vem em csv_row->Comissão (= a SUA parte de produtor)
    const csvComis = parseBRL(r.ccom) ?? 0;

    // comissão dos sócios (você/Erik) = coprodução em TODA venda válida
    if (!invalid) {
      voceComm += r.pcom != null ? Number(r.pcom) : csvComis;
      erikComm += r.afiliado_comissao != null ? Number(r.afiliado_comissao) : csvComis;
      totalReceita += valor;
      totalValidas += 1;
      const day = (r.data_compra ?? '').slice(0, 10);
      if (day) byDate.set(day, (byDate.get(day) ?? 0) + valor);
    }

    // atribuição da VENDA a uma pessoa só
    let row: AffiliateRow;
    if (!eff) row = you;
    else if (eff === SOCIO_EMAIL) row = erik;
    else {
      row = ext.get(eff) ?? emptyRow(eff, eff, 'afiliado');
      ext.set(eff, row);
    }
    row.vendas++;
    if (invalid) row.canceladas++;
    else {
      row.validas++;
      row.receita += valor;
      // o que o AFILIADO externo ganhou nessa venda:
      // webhook → affiliateCommission; CSV antigo → 2× a comissão do produtor
      // (afiliado leva 50% do bolo; produtor e coprodutor 25% cada)
      if (row.tipo === 'afiliado') {
        row.comissao += r.acom != null ? Number(r.acom) : r.ccom != null ? 2 * csvComis : 0;
      }
    }
  }

  // você/Erik: comissão = total de produtor/coprodutor recebido em todas as vendas
  you.comissao = voceComm;
  erik.comissao = erikComm;

  // só aparece quem vendeu algum produto (tem ao menos 1 venda)
  const affiliates = [you, erik, ...ext.values()]
    .filter((a) => a.vendas > 0)
    .sort((x, y) => y.comissao - x.comissao || y.validas - x.validas || y.vendas - x.vendas);

  const totals = [...ext.values()].reduce(
    (acc, a) => ({
      afiliados: acc.afiliados + 1,
      validas: acc.validas + a.validas,
      receita: acc.receita + a.receita,
      comissao: acc.comissao + a.comissao,
    }),
    { afiliados: 0, validas: 0, receita: 0, comissao: 0 },
  );

  // eixo X: respeita o filtro escolhido (from/to); senão usa o intervalo real das vendas
  const chart: SalesPoint[] = [];
  const days = [...byDate.keys()].sort();
  if (days.length) {
    const startKey = from ?? days[0];
    const endKey = to ?? days[days.length - 1];
    const cursor = new Date(`${startKey}T12:00:00Z`);
    const end = new Date(`${endKey}T12:00:00Z`);
    let guard = 0;
    while (cursor <= end && guard < 400) {
      const key = cursor.toISOString().slice(0, 10);
      chart.push({ date: key, total: Number((byDate.get(key) ?? 0).toFixed(2)) });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      guard++;
    }
  }

  // resumo = a operação inteira (todas as vendas válidas), não só as diretas
  const resumo = {
    totalFaturado: Number(totalReceita.toFixed(2)),
    numVendas: totalValidas,
    ticketMedio: totalValidas > 0 ? Number((totalReceita / totalValidas).toFixed(2)) : 0,
  };

  const conversao = await paymentConversion({ from, to });

  return { affiliates, totals, resumo, chart, conversao };
}

export interface AffiliateSale {
  sale_id: string;
  data_compra: string;
  nome: string;
  plano: string;
  valor_total: number | null;
  status: string;
  payment_method: string | null;
  comissao: number | null;
}

export interface AffiliateDetail {
  key: string;
  label: string;
  tipo: RowTipo;
  totals: {
    vendas: number;
    validas: number;
    canceladas: number;
    receita: number;
    comissao: number;
    ticketMedio: number;
  };
  conversion: { attempts: number; approved: number; rate: number | null };
  paymentMethods: { method: string; count: number }[];
  sales: AffiliateSale[];
}

/** Detalhe: você = vendas diretas; Erik = as dele; afiliado = as que referiu. */
export async function getAffiliateDetail(key: string): Promise<AffiliateDetail> {
  const tipo: RowTipo = key === VOCE_KEY ? 'voce' : key === ERIK_KEY ? 'socio' : 'afiliado';
  const label = tipo === 'voce' ? PRODUCER_EMAIL : tipo === 'socio' ? SOCIO_EMAIL : key;

  let subQuery = supabaseAdmin
    .from('subscribers')
    .select(
      'sale_id:transacao_kirvano_id, data_compra, nome, plano, valor_total, afiliado_comissao, pcom:raw_payload->>commission, acom:raw_payload->>affiliateCommission, ccom:raw_payload->csv_row->>Comissão, status, payment_method',
    )
    .order('data_compra', { ascending: false })
    .limit(5000);
  if (tipo === 'voce') subQuery = subQuery.is('afiliado_email', null);
  else if (tipo === 'socio') subQuery = subQuery.eq('afiliado_email', SOCIO_EMAIL);
  else subQuery = subQuery.eq('afiliado_email', key.trim().toLowerCase());

  const { data: subs, error: subErr } = await subQuery;
  if (subErr) throw subErr;

  // comissão recebida por esta pessoa em cada venda (webhook OU csv antigo)
  const comOf = (r: Record<string, unknown>): number => {
    const pcom = r.pcom as string | null;
    const acom = r.acom as string | null;
    const ccom = r.ccom as string | null;
    const csvComis = parseBRL(ccom) ?? 0;
    if (tipo === 'voce') return pcom != null ? Number(pcom) : csvComis;
    if (tipo === 'socio')
      return r.afiliado_comissao != null ? Number(r.afiliado_comissao) : csvComis;
    // afiliado externo: webhook → affiliateCommission; csv → 2× a comissão do produtor
    return acom != null ? Number(acom) : ccom != null ? 2 * csvComis : 0;
  };

  const sales: AffiliateSale[] = ((subs ?? []) as unknown[]).map((s) => {
    const r = s as Record<string, unknown>;
    return {
      sale_id: (r.sale_id as string) ?? '',
      data_compra: (r.data_compra as string) ?? '',
      nome: (r.nome as string) ?? '',
      plano: (r.plano as string) ?? '',
      valor_total: (r.valor_total as number | null) ?? null,
      status: (r.status as string) ?? '',
      payment_method: (r.payment_method as string | null) ?? null,
      comissao: comOf(r),
    };
  });

  let vendas = 0,
    validas = 0,
    canceladas = 0,
    receita = 0,
    comissao = 0;
  const payMap = new Map<string, number>();
  for (const s of sales) {
    vendas++;
    if (isInvalid(s.status)) canceladas++;
    else {
      validas++;
      receita += Number(s.valor_total ?? 0);
      comissao += Number(s.comissao ?? 0);
    }
    const pm = s.payment_method || 'desconhecido';
    payMap.set(pm, (payMap.get(pm) ?? 0) + 1);
  }
  const paymentMethods = [...payMap.entries()]
    .map(([method, count]) => ({ method, count }))
    .sort((a, b) => b.count - a.count);

  const { data: evts, error: evtErr } = await supabaseAdmin
    .from('webhook_events')
    .select('event_type, sale_id, aff:raw_payload->>affiliateEmail')
    .limit(20000);
  if (evtErr) throw evtErr;

  const attempts = new Set<string>();
  const approved = new Set<string>();
  for (const e of evts ?? []) {
    const row = e as { event_type: string; sale_id: string | null; aff: string | null };
    if (!row.sale_id) continue;
    const a = (row.aff ?? '').trim().toLowerCase();
    const belongs =
      tipo === 'voce' ? !a : tipo === 'socio' ? a === SOCIO_EMAIL : a === key.trim().toLowerCase();
    if (!belongs) continue;
    attempts.add(row.sale_id);
    if (row.event_type === 'SALE_APPROVED') approved.add(row.sale_id);
  }
  const rate = attempts.size > 0 ? approved.size / attempts.size : null;

  return {
    key,
    label,
    tipo,
    totals: {
      vendas,
      validas,
      canceladas,
      receita,
      comissao,
      ticketMedio: validas > 0 ? receita / validas : 0,
    },
    conversion: { attempts: attempts.size, approved: approved.size, rate },
    paymentMethods,
    sales,
  };
}

// ————————————————————————————————————————————————————————————
// Portal do afiliado (self-service): o próprio afiliado logado vê SÓ os
// dados dele. NUNCA expõe PII do comprador (nome/email/telefone).
// ————————————————————————————————————————————————————————————

export interface AffiliatePortalSale {
  data_compra: string;
  plano: string;
  valor_total: number | null;
  status: string;
  payment_method: string | null;
  comissao: number | null;
}

export interface AffiliateMilestones {
  metric: 'faturamento';
  current: number; // faturamento gerado (receita das vendas válidas)
  tiers: { value: number; reached: boolean }[];
  prev: number; // maior meta já batida (ou 0)
  next: number | null; // próxima meta a bater (null = bateu todas)
  progress: number; // 0..1 rumo à próxima meta, a partir da anterior
}

export interface AffiliatePortalData {
  totals: {
    validas: number;
    canceladas: number;
    receita: number;
    comissao: number;
    ticketMedio: number;
  };
  conversion: { attempts: number; approved: number; rate: number | null };
  paymentMethods: { method: string; count: number }[];
  sales: AffiliatePortalSale[];
  milestones: AffiliateMilestones;
}

/** Dados do portal pro afiliado logado — escopo é sempre o email do JWT. */
export async function getAffiliatePortalData(email: string): Promise<AffiliatePortalData> {
  const d = await getAffiliateDetail(email.trim().toLowerCase());

  // remove qualquer PII do comprador — afiliado só vê data/plano/valor/status/comissão
  const sales: AffiliatePortalSale[] = d.sales.map((s) => ({
    data_compra: s.data_compra,
    plano: s.plano,
    valor_total: s.valor_total,
    status: s.status,
    payment_method: s.payment_method,
    comissao: s.comissao,
  }));

  const current = d.totals.receita;
  const tiers = AFFILIATE_MILESTONES.map((value) => ({ value, reached: current >= value }));
  const next = AFFILIATE_MILESTONES.find((v) => current < v) ?? null;
  const prev = [...AFFILIATE_MILESTONES].reverse().find((v) => current >= v) ?? 0;
  const progress = next ? Math.max(0, Math.min(1, (current - prev) / (next - prev))) : 1;

  return {
    totals: {
      validas: d.totals.validas,
      canceladas: d.totals.canceladas,
      receita: d.totals.receita,
      comissao: d.totals.comissao,
      ticketMedio: d.totals.ticketMedio,
    },
    conversion: d.conversion,
    paymentMethods: d.paymentMethods,
    sales,
    milestones: { metric: 'faturamento', current, tiers, prev, next, progress },
  };
}

// ————————————————————————————————————————————————————————————
// Ranking / competição (Fase 2). Todos os afiliados com faturamento
// aparecem: cadastrados pelo apelido, não-cadastrados como "Afiliado #N".
// Nunca expõe email nem PII — só apelido + faturamento agregado.
// ————————————————————————————————————————————————————————————

export interface LeaderboardEntry {
  rank: number;
  name: string; // apelido do cadastro, ou "Afiliado #N" pra quem não se cadastrou
  registered: boolean;
  faturamento: number;
  validas: number;
  isMe: boolean;
}

export interface LeaderboardResult {
  period: 'geral' | 'mes';
  you: { rank: number | null; faturamento: number; registered: boolean };
  entries: LeaderboardEntry[];
}

/** email (lowercase) -> apelido, a partir dos usuários confirmados do Auth. */
async function getApelidoMap(): Promise<Map<string, string>> {
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  const map = new Map<string, string>();
  for (const u of data?.users ?? []) {
    const email = (u.email ?? '').trim().toLowerCase();
    const apelido = ((u.user_metadata?.apelido as string | undefined) ?? '').trim();
    if (email && apelido) map.set(email, apelido);
  }
  return map;
}

/** Início do mês atual (UTC) como YYYY-MM-DD. */
function monthStartUTC(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** email -> nome completo do afiliado (só as vendas antigas de CSV trazem nome; webhook não). */
async function getAffiliateNameMap(): Promise<Map<string, string>> {
  const { data, error } = await supabaseAdmin
    .from('subscribers')
    .select('afiliado_email, csv:raw_payload->csv_row')
    .not('afiliado_email', 'is', null)
    .limit(20000);
  if (error) throw error;
  const map = new Map<string, string>();
  for (const r of (data ?? []) as Array<{ afiliado_email: string | null; csv: unknown }>) {
    const email = (r.afiliado_email ?? '').trim().toLowerCase();
    const csv = r.csv as Record<string, unknown> | null;
    const nome = csv && typeof csv === 'object' ? String(csv['Afiliado (Nome)'] ?? '').trim() : '';
    if (email && nome && !map.has(email)) map.set(email, nome);
  }
  return map;
}

/** "CAIO COSTA MAGALHAES" -> "Caio" */
function primeiroNome(full: string): string {
  const first = full.trim().split(/\s+/)[0] ?? '';
  return first ? first[0].toUpperCase() + first.slice(1).toLowerCase() : '';
}

/** Sem nome no cadastro nem no CSV: deriva do email (ex.: kaynan5363 -> "Kaynan"). */
function nomeDoEmail(email: string): string {
  const local = (email.split('@')[0] ?? '').trim();
  const letters = local.match(/^[a-zA-Z]+/)?.[0] ?? local;
  return letters ? letters[0].toUpperCase() + letters.slice(1).toLowerCase() : 'Afiliado';
}

export async function getLeaderboard(
  meEmail: string,
  period: 'geral' | 'mes',
  now: Date = new Date(),
): Promise<LeaderboardResult> {
  const me = meEmail.trim().toLowerCase();
  const range: DateRange | undefined =
    period === 'mes' ? { from: monthStartUTC(now), to: now.toISOString().slice(0, 10) } : undefined;

  const [{ affiliates }, apelidos, nomes] = await Promise.all([
    listAffiliates(range),
    getApelidoMap(),
    getAffiliateNameMap(),
  ]);

  const ranked = affiliates
    .filter((a) => a.tipo === 'afiliado' && a.receita > 0)
    .sort((a, b) => b.receita - a.receita || b.validas - a.validas);

  const entries: LeaderboardEntry[] = ranked.map((a, i) => {
    const apelido = apelidos.get(a.key);
    const nomeCompleto = nomes.get(a.key);
    // cadastrado → apelido escolhido; senão → primeiro nome (CSV) ou derivado do email
    const name = apelido || (nomeCompleto ? primeiroNome(nomeCompleto) : nomeDoEmail(a.key));
    return {
      rank: i + 1,
      name,
      registered: !!apelido,
      faturamento: Number(a.receita.toFixed(2)),
      validas: a.validas,
      isMe: a.key === me,
    };
  });

  const meEntry = entries.find((e) => e.isMe);
  return {
    period,
    you: {
      rank: meEntry?.rank ?? null,
      faturamento: meEntry?.faturamento ?? 0,
      registered: apelidos.has(me),
    },
    entries,
  };
}
