import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { nextEmailSlot, RETRY_MAX_ATTEMPTS } from '../lib/scheduling.js';
import { supabaseAdmin } from '../config/supabase.js';
import { sendAccessEmail } from './email.service.js';
import { getCredentials, getSubscriber } from './subscribers.service.js';

export type SendOutcome =
  | { kind: 'sent'; messageId: string }
  | { kind: 'scheduled'; nextAt: string; retryCount: number; error: string }
  | { kind: 'gave_up'; error: string };

/**
 * Fluxo completo de envio: pega credenciais, monta vars, envia via Brevo.
 * Se sucesso: marca email_enviado, zera scheduled_at e retry_count.
 * Se falha: reagenda na próxima janela válida — ou desiste se passou de RETRY_MAX_ATTEMPTS.
 *
 * `updatedBy` é o id do admin quando o disparo veio do dashboard; null quando veio do worker.
 */
export async function attemptSendCredentials(
  subscriberId: string,
  updatedBy: string | null,
): Promise<SendOutcome> {
  const current = await getSubscriber(subscriberId);
  const creds = await getCredentials(subscriberId);

  try {
    const result = await sendAccessEmail({
      to: current.email,
      vars: {
        nome: current.nome,
        usuario: creds.usuario,
        senha: creds.senha,
        accessUrl: env.ACCESS_URL,
        supportUrl: env.SUPPORT_WHATSAPP_URL,
        whatsappIconUrl: `${env.BACKEND_PUBLIC_URL}/assets/whatsapp.png`,
        configUrl:
          env.CONFIG_SITE_URL && current.onboard_token
            ? `${env.CONFIG_SITE_URL}/?t=${current.onboard_token}`
            : undefined,
      },
    });

    await supabaseAdmin
      .from('subscribers')
      .update({
        status: 'email_enviado',
        data_envio_email: new Date().toISOString(),
        email_error_last: null,
        email_scheduled_at: null,
        email_retry_count: 0,
        email_send_attempts: current.email_send_attempts + 1,
        updated_by: updatedBy,
      })
      .eq('id', subscriberId);

    logger.info(
      { subscriberId, adminEmail: updatedBy ?? 'worker', messageId: result.messageId },
      'email enviado',
    );
    return { kind: 'sent', messageId: result.messageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const nextRetryCount = current.email_retry_count + 1;

    if (nextRetryCount > RETRY_MAX_ATTEMPTS) {
      await supabaseAdmin
        .from('subscribers')
        .update({
          email_error_last: msg,
          email_scheduled_at: null,
          email_retry_count: nextRetryCount,
          email_send_attempts: current.email_send_attempts + 1,
        })
        .eq('id', subscriberId);
      logger.error(
        { subscriberId, err: msg, retryCount: nextRetryCount },
        'desistindo de reenviar apos max tentativas',
      );
      return { kind: 'gave_up', error: msg };
    }

    const nextAt = nextEmailSlot(new Date());
    await supabaseAdmin
      .from('subscribers')
      .update({
        email_error_last: msg,
        email_scheduled_at: nextAt.toISOString(),
        email_retry_count: nextRetryCount,
        email_send_attempts: current.email_send_attempts + 1,
      })
      .eq('id', subscriberId);

    logger.warn(
      { subscriberId, err: msg, nextAt: nextAt.toISOString(), retryCount: nextRetryCount },
      'envio falhou, reagendando',
    );
    return {
      kind: 'scheduled',
      nextAt: nextAt.toISOString(),
      retryCount: nextRetryCount,
      error: msg,
    };
  }
}

/** Marca hard bounce como erro final (nunca reagenda). */
export async function markHardBounce(subscriberId: string, reason: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from('subscribers')
    .select('email_send_attempts')
    .eq('id', subscriberId)
    .maybeSingle();
  const attempts = (data?.email_send_attempts as number | undefined) ?? 0;
  await supabaseAdmin
    .from('subscribers')
    .update({
      email_error_last: `hard bounce: ${reason}`,
      email_scheduled_at: null,
      email_retry_count: RETRY_MAX_ATTEMPTS + 1, // trava reenvio
      email_send_attempts: attempts + 1,
    })
    .eq('id', subscriberId);
  logger.error({ subscriberId, reason }, 'hard bounce, sem reagendamento');
}
