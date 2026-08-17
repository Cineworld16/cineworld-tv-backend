import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { nextEmailSlot, RETRY_MAX_ATTEMPTS } from '../lib/scheduling.js';
import { supabaseAdmin } from '../config/supabase.js';

interface BrevoEvent {
  event: string;
  email: string;
  date: string;
  subject?: string;
  reason?: string;
}

const BREVO_EVENTS_URL = 'https://api.brevo.com/v3/smtp/statistics/events?limit=200';

async function fetchRecentEvents(): Promise<BrevoEvent[]> {
  try {
    const res = await fetch(BREVO_EVENTS_URL, {
      headers: { 'api-key': env.BREVO_API_KEY, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Brevo events fetch falhou');
      return [];
    }
    const data = (await res.json()) as { events?: BrevoEvent[] };
    return data.events ?? [];
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Brevo events fetch erro');
    return [];
  }
}

interface Subscriber {
  id: string;
  email: string;
  status: string;
  email_scheduled_at: string | null;
  email_retry_count: number;
  email_send_attempts: number;
  data_envio_email: string | null;
}

async function findSubscriberByEmail(email: string): Promise<Subscriber | null> {
  const { data } = await supabaseAdmin
    .from('subscribers')
    .select('id,email,status,email_scheduled_at,email_retry_count,email_send_attempts,data_envio_email')
    .eq('email', email.toLowerCase())
    .maybeSingle();
  return (data as Subscriber | null) ?? null;
}

async function handleDelivered(sub: Subscriber, when: string): Promise<void> {
  if (sub.status === 'email_enviado') return; // já ok
  await supabaseAdmin
    .from('subscribers')
    .update({
      status: 'email_enviado',
      data_envio_email: sub.data_envio_email ?? when,
      email_scheduled_at: null,
      email_error_last: null,
    })
    .eq('id', sub.id);
  logger.info({ subscriberId: sub.id, email: sub.email }, 'Brevo confirmou entrega');
}

async function handleSoftBounce(sub: Subscriber, reason: string): Promise<void> {
  const nextCount = sub.email_retry_count + 1;
  if (nextCount > RETRY_MAX_ATTEMPTS) {
    await supabaseAdmin
      .from('subscribers')
      .update({
        email_error_last: `soft bounce (max tentativas): ${reason}`,
        email_scheduled_at: null,
        email_retry_count: nextCount,
      })
      .eq('id', sub.id);
    logger.warn({ subscriberId: sub.id, reason }, 'soft bounce, max tentativas, desistindo');
    return;
  }
  const nextAt = nextEmailSlot(new Date());
  await supabaseAdmin
    .from('subscribers')
    .update({
      email_error_last: `soft bounce: ${reason}`,
      email_scheduled_at: nextAt.toISOString(),
      email_retry_count: nextCount,
      // volta pro status de "aguardando envio" pra sair da aba Enviados
      status: 'credenciais_preenchidas',
      data_envio_email: null,
    })
    .eq('id', sub.id);
  logger.info(
    { subscriberId: sub.id, nextAt: nextAt.toISOString() },
    'soft bounce, reagendado',
  );
}

async function handleHardBounce(sub: Subscriber, reason: string): Promise<void> {
  await supabaseAdmin
    .from('subscribers')
    .update({
      email_error_last: `hard bounce: ${reason}`,
      email_scheduled_at: null,
      email_retry_count: RETRY_MAX_ATTEMPTS + 1,
      status: 'credenciais_preenchidas',
      data_envio_email: null,
    })
    .eq('id', sub.id);
  logger.error({ subscriberId: sub.id, email: sub.email, reason }, 'hard bounce, sem reagendamento');
}

/**
 * Percorre eventos recentes da Brevo e aplica no DB.
 * Idempotente: chamar múltiplas vezes só reprocessa o mesmo estado (ex.: se já é
 * email_enviado, não faz nada).
 */
export async function syncBrevoEvents(): Promise<{ processed: number }> {
  const events = await fetchRecentEvents();
  let processed = 0;

  for (const evt of events) {
    const email = (evt.email ?? '').toLowerCase();
    if (!email) continue;

    const sub = await findSubscriberByEmail(email);
    if (!sub) continue;

    const type = evt.event.toLowerCase();
    try {
      if (type === 'delivered') {
        await handleDelivered(sub, evt.date);
      } else if (type === 'soft_bounces' || type === 'softbounces' || type === 'soft_bounce') {
        await handleSoftBounce(sub, evt.reason ?? 'sem detalhe');
      } else if (type === 'hard_bounces' || type === 'hardbounces' || type === 'hard_bounce') {
        await handleHardBounce(sub, evt.reason ?? 'sem detalhe');
      } else if (type === 'blocked' || type === 'invalid') {
        await handleHardBounce(sub, `${type}: ${evt.reason ?? ''}`);
      } else {
        continue; // opened, clicks, requests — ignora
      }
      processed++;
    } catch (err) {
      logger.error({ err, event: evt }, 'falha processando evento Brevo');
    }
  }

  return { processed };
}

export function startBrevoSyncLoop(intervalMs = 10 * 60 * 1000): NodeJS.Timeout {
  logger.info({ intervalMs }, 'iniciando Brevo sync loop');
  // primeira execução imediata (após 30s pra dar tempo do boot completar)
  setTimeout(() => {
    void syncBrevoEvents().then((r) =>
      logger.info({ processed: r.processed }, 'Brevo sync completo'),
    );
  }, 30_000);
  return setInterval(() => {
    void syncBrevoEvents().then((r) => {
      if (r.processed > 0) {
        logger.info({ processed: r.processed }, 'Brevo sync completo');
      }
    });
  }, intervalMs);
}
