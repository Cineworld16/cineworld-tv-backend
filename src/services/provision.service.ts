import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { extractOfferName, listConfiguredOffers, resolveHavokPackage } from '../lib/havok-plans.js';
import { supabaseAdmin } from '../config/supabase.js';
import { encrypt } from './crypto.service.js';
import { createHavokCustomer } from './havok.service.js';
import { attemptSendCredentials } from './send-credentials.service.js';
import type { KirvanoWebhookPayload } from '../types/kirvano.js';

export interface ProvisionResult {
  ok: boolean;
  error?: string;
}

/**
 * Core do provisionamento:
 *   1. Resolve o package Havok a partir da oferta + bumps
 *   2. Cria a conta no painel Havok (Playwright)
 *   3. Salva usuário/senha criptografados, status = credenciais_preenchidas
 *   4. Dispara o email de acesso (com retry/agendamento na janela horária)
 */
async function runProvision(
  subscriberId: string,
  payload: KirvanoWebhookPayload,
): Promise<ProvisionResult> {
  if (!env.HAVOK_ENABLED) {
    return { ok: false, error: 'Havok desabilitado (HAVOK_ENABLED=false)' };
  }

  const resolved = resolveHavokPackage(payload);
  if (!resolved) {
    logger.warn(
      {
        subscriberId,
        sale_id: payload.sale_id,
        offerNameRecebido: extractOfferName(payload),
        duracoesConfiguradas: listConfiguredOffers(),
      },
      'provision: nao consegui detectar a duracao/oferta, deixando manual',
    );
    return { ok: false, error: `oferta nao reconhecida: "${extractOfferName(payload)}"` };
  }

  logger.info(
    { subscriberId, offer: resolved.offerName, duration: resolved.duration, variant: resolved.variant },
    'provision: criando conta Havok',
  );

  let usuario: string;
  let senha: string;
  try {
    const cred = await createHavokCustomer(resolved.packageId);
    usuario = cred.usuario;
    senha = cred.senha;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // NÃO conta contra email_retry_count: falha de Cloudflare/sessão é infra
    // transitória, não problema do cliente. O worker reprocessa por
    // PROVISION_RETRY_WINDOW_HOURS (janela de tempo), então autocura sozinho.
    logger.error({ subscriberId, err: msg }, 'provision: criacao Havok falhou');
    await supabaseAdmin
      .from('subscribers')
      .update({ email_error_last: `Havok falhou: ${msg}` })
      .eq('id', subscriberId);
    return { ok: false, error: `Havok falhou: ${msg}` };
  }

  const enc = encrypt(senha);
  const { error } = await supabaseAdmin
    .from('subscribers')
    .update({
      usuario,
      senha_ciphertext: enc.ciphertext,
      senha_iv: enc.iv,
      senha_tag: enc.tag,
      status: 'credenciais_preenchidas',
    })
    .eq('id', subscriberId);
  if (error) {
    logger.error({ subscriberId, err: error.message }, 'provision: salvar cred falhou');
    return { ok: false, error: error.message };
  }

  const outcome = await attemptSendCredentials(subscriberId, null);
  logger.info({ subscriberId, outcome: outcome.kind }, 'provision: fluxo completo');
  if (outcome.kind === 'gave_up') {
    return { ok: false, error: `email falhou: ${outcome.error}` };
  }
  return { ok: true };
}

/**
 * Chamado do webhook em background — não bloqueia a resposta.
 * Falha deixa o assinante pendente pro Mateus resolver.
 */
export async function autoProvision(
  subscriberId: string,
  payload: KirvanoWebhookPayload,
): Promise<void> {
  await runProvision(subscriberId, payload);
}

/**
 * Chamado do dashboard (botão "Provisionar automático") — síncrono, retorna resultado.
 * Reconstrói o payload a partir do raw_payload salvo no DB.
 */
export async function provisionSubscriberById(subscriberId: string): Promise<ProvisionResult> {
  const { data, error } = await supabaseAdmin
    .from('subscribers')
    .select('raw_payload')
    .eq('id', subscriberId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: 'assinante nao encontrado' };

  const payload = (data.raw_payload ?? {}) as KirvanoWebhookPayload;
  return runProvision(subscriberId, payload);
}
