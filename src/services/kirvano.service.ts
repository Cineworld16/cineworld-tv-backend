import { supabaseAdmin } from '../config/supabase.js';
import { logger } from '../lib/logger.js';
import { parseBRL } from '../lib/money.js';
import type { KirvanoProduct, KirvanoWebhookPayload } from '../types/kirvano.js';
import { autoProvision } from './provision.service.js';
import { handleRenewal } from './renewal.service.js';
import { revokeAccess } from './revoke.service.js';

export type ProcessingStatus = 'processed' | 'ignored' | 'error';

export interface ProcessResult {
  status: ProcessingStatus;
  subscriberId?: string;
  reason?: string;
}

function extractPlan(payload: KirvanoWebhookPayload): string {
  if (payload.plan?.name) return payload.plan.name;
  const main = payload.products?.find((p) => !p.is_order_bump);
  if (main?.name) return main.name;
  if (payload.products?.[0]?.name) return payload.products[0].name;
  return 'Desconhecido';
}

function extractOrderBumps(payload: KirvanoWebhookPayload): KirvanoProduct[] {
  return (payload.products ?? []).filter((p) => p.is_order_bump === true);
}

function extractMainProduct(payload: KirvanoWebhookPayload): KirvanoProduct | undefined {
  return payload.products?.find((p) => !p.is_order_bump) ?? payload.products?.[0];
}

async function logEvent(
  payload: KirvanoWebhookPayload,
  processingStatus: ProcessingStatus,
  opts: { errorMessage?: string; subscriberId?: string } = {},
): Promise<void> {
  const { error } = await supabaseAdmin.from('webhook_events').insert({
    event_type: payload.event,
    sale_id: payload.sale_id ?? null,
    raw_payload: payload as unknown as Record<string, unknown>,
    processing_status: processingStatus,
    error_message: opts.errorMessage ?? null,
    subscriber_id: opts.subscriberId ?? null,
  });
  if (error) {
    logger.error({ err: error }, 'falha ao gravar webhook_events');
  }
}

/**
 * SALE_APPROVED — cria assinante se ainda não existe.
 * Idempotente por `transacao_kirvano_id` (UNIQUE constraint no schema).
 */
async function handleApproved(payload: KirvanoWebhookPayload): Promise<ProcessResult> {
  if (!payload.sale_id) {
    await logEvent(payload, 'error', { errorMessage: 'sale_id ausente' });
    return { status: 'error', reason: 'sale_id ausente' };
  }

  // Renovação de assinatura recorrente: a Kirvano reenvia SALE_APPROVED com
  // plan.charge_number > 1. NÃO cria assinante novo — renova o existente.
  // Por decisão do Mateus, automatizamos só o plano MENSAL.
  const chargeNumber = payload.plan?.charge_number ?? 1;
  if (typeof chargeNumber === 'number' && chargeNumber > 1) {
    const freq = (payload.plan?.charge_frequency ?? '').toUpperCase();
    if (freq === 'MONTHLY') {
      await logEvent(payload, 'processed', {});
      void handleRenewal(payload).catch((err) =>
        logger.error(
          { err: err instanceof Error ? err.message : String(err), sale_id: payload.sale_id },
          'renovacao: erro nao tratado',
        ),
      );
      return { status: 'processed', reason: `renovacao mensal (charge #${chargeNumber})` };
    }
    await logEvent(payload, 'ignored', {
      errorMessage: `renovacao nao-mensal (${freq || '??'}) charge #${chargeNumber} — tratar manual`,
    });
    return { status: 'ignored', reason: `renovacao nao-mensal (${freq})` };
  }

  const mainProduct = extractMainProduct(payload);
  const insertRow = {
    nome: payload.customer?.name ?? 'Sem nome',
    email: (payload.customer?.email ?? '').toLowerCase(),
    telefone: payload.customer?.phone_number ?? null,
    plano: extractPlan(payload),
    order_bumps: extractOrderBumps(payload) as unknown as Record<string, unknown>[],
    offer_id: mainProduct?.offer_id ?? null,
    product_id: mainProduct?.id ?? null,
    transacao_kirvano_id: payload.sale_id,
    sale_type: (payload.type === 'ONE_TIME' || payload.type === 'RECURRING') ? payload.type : null,
    payment_method: payload.payment_method ?? payload.payment?.method ?? null,
    plan_recurrence: payload.plan?.charge_frequency ?? null,
    next_charge_date: payload.plan?.next_charge_date ?? null,
    valor_total: parseBRL(payload.total_price),
    valor_total_raw: payload.total_price ?? null,
    data_compra: payload.payment?.finished_at ?? payload.created_at ?? new Date().toISOString(),
    utm: payload.utm ?? null,
    afiliado_email: (payload.affiliateEmail ?? '').toLowerCase().trim() || null,
    // Comissão exibida = a de COPRODUÇÃO (a affiliateCommission vem 0 nas vendas).
    afiliado_comissao:
      typeof payload.coproductionCommission === 'number' ? payload.coproductionCommission : null,
    raw_payload: payload as unknown as Record<string, unknown>,
    status: 'pendente' as const,
  };

  // ON CONFLICT DO NOTHING via ignoreDuplicates
  const { data, error } = await supabaseAdmin
    .from('subscribers')
    .upsert(insertRow, { onConflict: 'transacao_kirvano_id', ignoreDuplicates: true })
    .select('id')
    .maybeSingle();

  if (error) {
    logger.error({ err: error, sale_id: payload.sale_id }, 'insert subscriber falhou');
    await logEvent(payload, 'error', { errorMessage: error.message });
    return { status: 'error', reason: error.message };
  }

  if (!data) {
    // já existia — idempotente
    const { data: existing } = await supabaseAdmin
      .from('subscribers')
      .select('id')
      .eq('transacao_kirvano_id', payload.sale_id)
      .maybeSingle();
    await logEvent(payload, 'ignored', {
      subscriberId: existing?.id,
      errorMessage: 'sale_id duplicado',
    });
    return { status: 'ignored', subscriberId: existing?.id, reason: 'duplicado' };
  }

  await logEvent(payload, 'processed', { subscriberId: data.id });

  // Provisionamento automático em background (Havok + email).
  // Não bloqueia o retorno do webhook; falhas deixam o assinante pendente.
  void autoProvision(data.id, payload).catch((err) => {
    logger.error(
      { subscriberId: data.id, err: err instanceof Error ? err.message : String(err) },
      'auto-provision: erro nao tratado',
    );
  });

  return { status: 'processed', subscriberId: data.id };
}

async function handleRefundOrChargeback(
  payload: KirvanoWebhookPayload,
): Promise<ProcessResult> {
  if (!payload.sale_id) {
    await logEvent(payload, 'error', { errorMessage: 'sale_id ausente' });
    return { status: 'error' };
  }

  const { data, error } = await supabaseAdmin
    .from('subscribers')
    .update({
      status: 'reembolsado',
      refunded_at: new Date().toISOString(),
    })
    .eq('transacao_kirvano_id', payload.sale_id)
    .select('id')
    .maybeSingle();

  if (error) {
    await logEvent(payload, 'error', { errorMessage: error.message });
    return { status: 'error', reason: error.message };
  }
  if (!data) {
    await logEvent(payload, 'error', { errorMessage: 'sale_id não encontrado no DB' });
    return { status: 'error', reason: 'sale_id não encontrado' };
  }
  await logEvent(payload, 'processed', { subscriberId: data.id });
  // revoga acesso (Havok + XCloud) sem travar a resposta pra Kirvano
  void revokeAccess(data.id);
  return { status: 'processed', subscriberId: data.id };
}

async function handleSubscriptionCanceled(
  payload: KirvanoWebhookPayload,
): Promise<ProcessResult> {
  if (!payload.sale_id) {
    await logEvent(payload, 'error', { errorMessage: 'sale_id ausente' });
    return { status: 'error' };
  }
  const { data, error } = await supabaseAdmin
    .from('subscribers')
    .update({
      status: 'cancelado',
      canceled_at: new Date().toISOString(),
    })
    .eq('transacao_kirvano_id', payload.sale_id)
    .select('id')
    .maybeSingle();
  if (error) {
    await logEvent(payload, 'error', { errorMessage: error.message });
    return { status: 'error', reason: error.message };
  }
  if (!data) {
    await logEvent(payload, 'error', { errorMessage: 'sale_id não encontrado no DB' });
    return { status: 'error', reason: 'sale_id não encontrado' };
  }
  await logEvent(payload, 'processed', { subscriberId: data.id });
  // revoga acesso (Havok + XCloud) sem travar a resposta pra Kirvano
  void revokeAccess(data.id);
  return { status: 'processed', subscriberId: data.id };
}

export async function processKirvanoWebhook(
  payload: KirvanoWebhookPayload,
): Promise<ProcessResult> {
  switch (payload.event) {
    case 'SALE_APPROVED':
      return handleApproved(payload);
    case 'SALE_REFUNDED':
    case 'SALE_CHARGEBACK':
      return handleRefundOrChargeback(payload);
    case 'SUBSCRIPTION_CANCELED':
      return handleSubscriptionCanceled(payload);
    default:
      await logEvent(payload, 'ignored', { errorMessage: `evento não tratado: ${payload.event}` });
      return { status: 'ignored', reason: `evento não tratado: ${payload.event}` };
  }
}
