import { env } from '../config/env.js';
import { supabaseAdmin } from '../config/supabase.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { SubscriberPublic, SubscriberStatus } from '../types/subscriber.js';
import { decrypt, encrypt } from './crypto.service.js';

// Colunas retornadas na listagem/detail — SEM colunas de senha.
const PUBLIC_COLUMNS = [
  'id',
  'nome',
  'email',
  'telefone',
  'plano',
  'order_bumps',
  'offer_id',
  'product_id',
  'transacao_kirvano_id',
  'sale_type',
  'payment_method',
  'plan_recurrence',
  'next_charge_date',
  'valor_total',
  'valor_total_raw',
  'data_compra',
  'status',
  'usuario',
  'onboard_token',
  'data_envio_email',
  'email_send_attempts',
  'email_error_last',
  'email_scheduled_at',
  'email_retry_count',
  'refunded_at',
  'canceled_at',
  'access_revoked_at',
  'created_at',
  'updated_at',
].join(',');

// Precisa saber se a senha está preenchida sem retorná-la — SELECT boolean derivado.
// Supabase-js não suporta expressões arbitrárias no select facilmente,
// então trazemos um flag calculado à parte.
type Row = Record<string, unknown> & {
  id: string;
  senha_ciphertext?: unknown;
};

function toPublic(row: Row, senhaPreenchida: boolean): SubscriberPublic {
  const onboardToken = (row.onboard_token as string | null) ?? null;
  // mesmo formato do link do email ("Configurar meu acesso")
  const configUrl =
    env.CONFIG_SITE_URL && onboardToken ? `${env.CONFIG_SITE_URL}/?t=${onboardToken}` : null;
  return {
    id: row.id,
    nome: (row.nome as string) ?? '',
    email: (row.email as string) ?? '',
    telefone: (row.telefone as string | null) ?? null,
    plano: (row.plano as string) ?? '',
    order_bumps: Array.isArray(row.order_bumps) ? (row.order_bumps as SubscriberPublic['order_bumps']) : [],
    offer_id: (row.offer_id as string | null) ?? null,
    product_id: (row.product_id as string | null) ?? null,
    transacao_kirvano_id: (row.transacao_kirvano_id as string) ?? '',
    sale_type: (row.sale_type as SubscriberPublic['sale_type']) ?? null,
    payment_method: (row.payment_method as string | null) ?? null,
    plan_recurrence: (row.plan_recurrence as string | null) ?? null,
    next_charge_date: (row.next_charge_date as string | null) ?? null,
    valor_total: (row.valor_total as number | null) ?? null,
    valor_total_raw: (row.valor_total_raw as string | null) ?? null,
    data_compra: (row.data_compra as string) ?? '',
    status: (row.status as SubscriberStatus) ?? 'pendente',
    usuario: (row.usuario as string | null) ?? null,
    senha_preenchida: senhaPreenchida,
    onboard_token: onboardToken,
    config_url: configUrl,
    data_envio_email: (row.data_envio_email as string | null) ?? null,
    email_send_attempts: (row.email_send_attempts as number) ?? 0,
    email_error_last: (row.email_error_last as string | null) ?? null,
    email_scheduled_at: (row.email_scheduled_at as string | null) ?? null,
    email_retry_count: (row.email_retry_count as number) ?? 0,
    refunded_at: (row.refunded_at as string | null) ?? null,
    canceled_at: (row.canceled_at as string | null) ?? null,
    access_revoked_at: (row.access_revoked_at as string | null) ?? null,
    created_at: (row.created_at as string) ?? '',
    updated_at: (row.updated_at as string) ?? '',
  };
}

export interface ListParams {
  search?: string;
  status?: SubscriberStatus | 'agendado';
  page?: number;
  pageSize?: number;
}

export interface ListResult {
  data: SubscriberPublic[];
  page: number;
  pageSize: number;
  total: number;
}

export async function listSubscribers(params: ListParams = {}): Promise<ListResult> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 50));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabaseAdmin
    .from('subscribers')
    // trazemos senha_ciphertext SÓ pra derivar boolean; nunca retornamos
    .select(`${PUBLIC_COLUMNS},senha_ciphertext`, { count: 'exact' })
    .order('data_compra', { ascending: false })
    .order('id', { ascending: false })
    .range(from, to);

  if (params.status === 'agendado') {
    // "agendado" é filtro derivado: tem email_scheduled_at populado e ainda não foi enviado
    query = query
      .not('email_scheduled_at', 'is', null)
      .neq('status', 'email_enviado');
  } else if (params.status) {
    query = query.eq('status', params.status);
    // Ao filtrar "aguardando envio", exclui os que já estão agendados (aparecem na aba própria)
    if (params.status === 'credenciais_preenchidas') {
      query = query.is('email_scheduled_at', null);
    }
  }

  if (params.search && params.search.trim()) {
    const s = params.search.trim().replace(/[%_]/g, '\\$&');
    query = query.or(`nome.ilike.%${s}%,email.ilike.%${s}%`);
  }

  const { data, error, count } = await query;
  if (error) throw error;

  const rows = (data ?? []).map((r) => {
    const row = r as unknown as Row;
    const senhaPreenchida = !!row.senha_ciphertext;
    // remove antes de expor
    delete row.senha_ciphertext;
    return toPublic(row, senhaPreenchida);
  });

  return { data: rows, page, pageSize, total: count ?? rows.length };
}

export async function getSubscriber(id: string): Promise<SubscriberPublic> {
  const { data, error } = await supabaseAdmin
    .from('subscribers')
    .select(`${PUBLIC_COLUMNS},senha_ciphertext`)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('Assinante não encontrado');

  const row = data as unknown as Row;
  const senhaPreenchida = !!row.senha_ciphertext;
  delete row.senha_ciphertext;
  return toPublic(row, senhaPreenchida);
}

export async function getCredentials(id: string): Promise<{ usuario: string; senha: string }> {
  const { data, error } = await supabaseAdmin
    .from('subscribers')
    .select('usuario,senha_ciphertext,senha_iv,senha_tag')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('Assinante não encontrado');

  const usuario = (data.usuario as string | null) ?? null;
  const ciphertext = (data.senha_ciphertext as string | null) ?? null;
  const iv = (data.senha_iv as string | null) ?? null;
  const tag = (data.senha_tag as string | null) ?? null;
  if (!usuario || !ciphertext || !iv || !tag) {
    throw new NotFoundError('Credenciais ainda não preenchidas');
  }
  const senha = decrypt({ ciphertext, iv, tag });
  return { usuario, senha };
}

export interface OnboardingData {
  status: 'ready' | 'pending';
  nome: string;
  usuario?: string;
  senha?: string;
}

/**
 * Busca pública pelo token de onboarding (usado pelo site de configuração).
 * Só devolve usuário/senha se as credenciais já foram preenchidas; caso
 * contrário devolve status 'pending' (compra aprovada mas acesso ainda sendo
 * gerado). Retorna null se o token não existe.
 */
export async function getOnboardingByToken(token: string): Promise<OnboardingData | null> {
  const { data, error } = await supabaseAdmin
    .from('subscribers')
    .select('nome,usuario,senha_ciphertext,senha_iv,senha_tag,status')
    .eq('onboard_token', token)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const nome = (data.nome as string | null) ?? '';
  const usuario = (data.usuario as string | null) ?? null;
  const ciphertext = (data.senha_ciphertext as string | null) ?? null;
  const iv = (data.senha_iv as string | null) ?? null;
  const tag = (data.senha_tag as string | null) ?? null;

  if (usuario && ciphertext && iv && tag) {
    const senha = decrypt({ ciphertext, iv, tag });
    return { status: 'ready', nome, usuario, senha };
  }
  return { status: 'pending', nome };
}

export async function saveCredentials(
  id: string,
  usuario: string,
  senha: string,
  updatedBy: string,
): Promise<SubscriberPublic> {
  const encrypted = encrypt(senha);

  // promove status se ainda pendente; se já enviou email, mantém.
  const current = await getSubscriber(id);
  const newStatus: SubscriberStatus =
    current.status === 'pendente' ? 'credenciais_preenchidas' : current.status;

  const { error } = await supabaseAdmin
    .from('subscribers')
    .update({
      usuario,
      senha_ciphertext: encrypted.ciphertext,
      senha_iv: encrypted.iv,
      senha_tag: encrypted.tag,
      status: newStatus,
      updated_by: updatedBy,
    })
    .eq('id', id);
  if (error) throw error;

  logger.info({ subscriberId: id, updatedBy }, 'credenciais salvas');
  return getSubscriber(id);
}

/**
 * Marca envio de email. Atômico: só promove se status ainda não é email_enviado
 * (ou se `force=true`).
 *
 * Retorna null se conflito (impede clique-duplo).
 */
export async function tryMarkEmailSending(
  id: string,
  force: boolean,
): Promise<{ locked: boolean; current: SubscriberPublic }> {
  const current = await getSubscriber(id);

  if (!force && current.status === 'email_enviado') {
    return { locked: false, current };
  }

  if (
    current.status !== 'credenciais_preenchidas' &&
    current.status !== 'email_enviado'
  ) {
    throw new ConflictError(
      'invalid_status',
      `Não é possível enviar email com status ${current.status}. Preencha as credenciais primeiro.`,
    );
  }

  return { locked: true, current };
}

export async function markEmailSent(id: string, updatedBy: string): Promise<SubscriberPublic> {
  const { error } = await supabaseAdmin
    .from('subscribers')
    .update({
      status: 'email_enviado',
      data_envio_email: new Date().toISOString(),
      email_error_last: null,
      updated_by: updatedBy,
    })
    .eq('id', id);
  if (error) throw error;
  return getSubscriber(id);
}

export async function incrementEmailAttempts(id: string, errorMessage: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from('subscribers')
    .select('email_send_attempts')
    .eq('id', id)
    .maybeSingle();
  const current = (data?.email_send_attempts as number | undefined) ?? 0;
  await supabaseAdmin
    .from('subscribers')
    .update({
      email_send_attempts: current + 1,
      email_error_last: errorMessage,
    })
    .eq('id', id);
}

export async function bumpEmailAttempts(id: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from('subscribers')
    .select('email_send_attempts')
    .eq('id', id)
    .maybeSingle();
  const current = (data?.email_send_attempts as number | undefined) ?? 0;
  await supabaseAdmin
    .from('subscribers')
    .update({ email_send_attempts: current + 1 })
    .eq('id', id);
}
