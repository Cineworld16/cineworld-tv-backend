import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { supabaseAdmin } from '../config/supabase.js';
import { sendAccessEmail } from './email.service.js';
import { renewHavokCustomer } from './havok.service.js';
import { getCredentials } from './subscribers.service.js';
import type { KirvanoWebhookPayload } from '../types/kirvano.js';

/**
 * Renovação de assinatura recorrente — disparada quando a Kirvano manda
 * SALE_APPROVED com plan.charge_number > 1 (ver kirvano.service).
 *
 * Acha o assinante ATIVO pelo email, renova no Havok (mantém usuário/senha) e
 * reenvia o email de acesso avisando da renovação. Idempotente por sale_id.
 * Fire-and-forget: erros são logados, nunca lançados (não trava o webhook).
 */
export async function handleRenewal(payload: KirvanoWebhookPayload): Promise<void> {
  const saleId = payload.sale_id;
  const email = (payload.customer?.email ?? '').toLowerCase().trim();
  const emailMask = email ? `${email.slice(0, 3)}***` : '(vazio)';
  if (!saleId || !email) {
    logger.warn({ saleId }, 'renovacao: sale_id ou email ausente');
    return;
  }

  // idempotência: essa renovação já foi processada? (retry da Kirvano)
  const { data: dup } = await supabaseAdmin
    .from('subscribers')
    .select('id')
    .eq('last_renewal_sale_id', saleId)
    .maybeSingle();
  if (dup) {
    logger.info({ saleId }, 'renovacao: sale_id ja processado, ignorando');
    return;
  }

  // acha o assinante ativo desse email (mais recente, com usuário e não revogado)
  const { data: subs, error } = await supabaseAdmin
    .from('subscribers')
    .select('id, nome, usuario, renewal_count, onboard_token')
    .eq('email', email)
    .not('usuario', 'is', null)
    .is('access_revoked_at', null)
    .order('data_compra', { ascending: false })
    .limit(1);
  if (error) {
    logger.error({ saleId, err: error.message }, 'renovacao: falha ao buscar assinante');
    return;
  }
  const sub = subs?.[0];
  if (!sub) {
    logger.warn({ saleId, emailMask }, 'renovacao: sem conta ativa pra esse email — ignorando');
    return;
  }
  const subscriberId = sub.id as string;
  const usuario = sub.usuario as string;

  // 1) renova no Havok (mantém usuário/senha)
  if (env.HAVOK_ENABLED) {
    try {
      const r = await renewHavokCustomer(usuario);
      logger.info({ subscriberId, usuario, expiresAt: r.expiresAt }, 'renovacao: Havok renovado');
    } catch (e) {
      logger.error(
        { subscriberId, usuario, err: e instanceof Error ? e.message : String(e) },
        'renovacao: FALHA no Havok — renovar manualmente no painel (nao marcado como renovado)',
      );
      return; // fica pendente pra revisão; não marca renovado
    }
  }

  // 2) registra a renovação (idempotência + histórico) e atualiza próximo vencimento
  const { error: upErr } = await supabaseAdmin
    .from('subscribers')
    .update({
      last_renewal_sale_id: saleId,
      last_renewed_at: new Date().toISOString(),
      renewal_count: ((sub.renewal_count as number | null) ?? 0) + 1,
      next_charge_date: payload.plan?.next_charge_date ?? null,
    })
    .eq('id', subscriberId);
  if (upErr) {
    logger.error(
      { subscriberId, err: upErr.message },
      'renovacao: falha ao gravar registro (Havok ja renovado!)',
    );
    // segue pro email mesmo assim — o acesso foi renovado
  }

  // 3) avisa o cliente por email (o acesso continua o mesmo)
  try {
    const creds = await getCredentials(subscriberId);
    await sendAccessEmail({
      to: email,
      subject: 'Sua assinatura CineWorld foi renovada ✅',
      vars: {
        nome: (sub.nome as string | null) ?? 'cliente',
        usuario: creds.usuario,
        senha: creds.senha,
        accessUrl: env.ACCESS_URL,
        supportUrl: env.SUPPORT_WHATSAPP_URL,
        whatsappIconUrl: `${env.BACKEND_PUBLIC_URL}/assets/whatsapp.png`,
        configUrl:
          env.CONFIG_SITE_URL && sub.onboard_token
            ? `${env.CONFIG_SITE_URL}/?t=${sub.onboard_token as string}`
            : undefined,
      },
    });
    logger.info({ subscriberId }, 'renovacao: email de aviso enviado');
  } catch (e) {
    logger.error(
      { subscriberId, err: e instanceof Error ? e.message : String(e) },
      'renovacao: email falhou (acesso ja foi renovado)',
    );
  }
}
