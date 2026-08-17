import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { isBusinessHour, PROVISION_RETRY_WINDOW_HOURS } from '../lib/scheduling.js';
import { supabaseAdmin } from '../config/supabase.js';
import { attemptSendCredentials } from './send-credentials.service.js';
import { provisionSubscriberById } from './provision.service.js';

async function fetchDueSubscribers(): Promise<Array<{ id: string; email: string }>> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('subscribers')
    .select('id,email')
    .neq('status', 'email_enviado')
    .neq('status', 'reembolsado')
    .neq('status', 'cancelado')
    .not('email_scheduled_at', 'is', null)
    .lte('email_scheduled_at', nowIso)
    .limit(20);
  if (error) {
    logger.warn({ err: error.message }, 'retry worker: query falhou');
    return [];
  }
  return (data as Array<{ id: string; email: string }>) ?? [];
}

/**
 * Assinantes que falharam no provisionamento Havok (ainda pendentes, com erro
 * "Havok falhou") dentro da janela de reprocessamento. Reprocessa a cada rodada
 * do worker (sem contar tentativas) — Cloudflare é transitório, então autocura
 * quando liberar. Passada a janela, fica manual pro Mateus.
 */
async function fetchFailedProvisions(): Promise<Array<{ id: string; nome: string }>> {
  const windowStart = new Date(
    Date.now() - PROVISION_RETRY_WINDOW_HOURS * 3600 * 1000,
  ).toISOString();
  const { data, error } = await supabaseAdmin
    .from('subscribers')
    .select('id,nome')
    .eq('status', 'pendente')
    .like('email_error_last', 'Havok falhou:%')
    .gt('data_compra', windowStart)
    .limit(10);
  if (error) {
    logger.warn({ err: error.message }, 'retry worker: query provisions falhou');
    return [];
  }
  return (data as Array<{ id: string; nome: string }>) ?? [];
}

async function runOnce(): Promise<void> {
  // (1) reprocessa provisionamentos Havok falhados — a QUALQUER hora
  // (criar conta não depende de horário; o email interno se agenda sozinho)
  if (env.HAVOK_ENABLED) {
    const failed = await fetchFailedProvisions();
    if (failed.length > 0) {
      logger.info({ count: failed.length }, 'retry worker: reprocessando provisionamentos Havok');
      for (const sub of failed) {
        try {
          await provisionSubscriberById(sub.id);
        } catch (err) {
          logger.error(
            { err: err instanceof Error ? err.message : String(err), subscriberId: sub.id },
            'retry worker: reprovision falhou',
          );
        }
      }
    }
  }

  // (2) reenvios de email agendados — só na janela comercial
  if (!isBusinessHour(new Date())) return;
  const due = await fetchDueSubscribers();
  if (due.length === 0) return;
  logger.info({ count: due.length }, 'retry worker: processando reenvios');
  for (const sub of due) {
    try {
      await attemptSendCredentials(sub.id, null);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), subscriberId: sub.id },
        'retry worker: attempt falhou',
      );
    }
  }
}

export function startRetryLoop(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  logger.info({ intervalMs }, 'iniciando retry worker');
  setTimeout(() => void runOnce(), 60_000);
  return setInterval(() => void runOnce(), intervalMs);
}
