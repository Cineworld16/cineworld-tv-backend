import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { OutgoingMessage } from '../types/onboarding.js';

const GRAPH_VERSION = 'v21.0';

function apiUrl(): string {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

/** true se o adaptador tem credenciais pra enviar de verdade. */
export function whatsappReady(): boolean {
  return (
    env.ONBOARDING_ENABLED &&
    !!env.WHATSAPP_TOKEN &&
    !!env.WHATSAPP_PHONE_NUMBER_ID
  );
}

// WhatsApp: reply buttons ≤ 3, títulos ≤ 20 chars; list ≤ 10 linhas/seção.
function clampButtonTitle(s: string): string {
  return s.length <= 20 ? s : `${s.slice(0, 19)}…`;
}

function toGraphPayload(to: string, msg: OutgoingMessage): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', to, recipient_type: 'individual' };

  if (msg.kind === 'text') {
    return { ...base, type: 'text', text: { body: msg.text } };
  }

  if (msg.kind === 'buttons') {
    return {
      ...base,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: msg.text },
        action: {
          buttons: msg.buttons.slice(0, 3).map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: clampButtonTitle(b.label) },
          })),
        },
      },
    };
  }

  // list
  return {
    ...base,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: msg.text },
      action: {
        button: clampButtonTitle(msg.buttonLabel),
        sections: msg.sections.map((sec) => ({
          title: sec.title.slice(0, 24),
          rows: sec.rows.slice(0, 10).map((r) => ({
            id: r.id,
            title: r.title.slice(0, 24),
            ...(r.description ? { description: r.description.slice(0, 72) } : {}),
          })),
        })),
      },
    },
  };
}

/**
 * Envia uma OutgoingMessage. Se o WhatsApp não estiver configurado, apenas
 * loga (modo dry-run) — permite testar toda a lógica sem credenciais da Meta.
 */
export async function sendMessage(to: string, msg: OutgoingMessage): Promise<void> {
  const payload = toGraphPayload(to, msg);

  if (!whatsappReady()) {
    logger.info({ to, kind: msg.kind, dryRun: true }, 'whatsapp DRY-RUN (sem credenciais)');
    return;
  }

  try {
    const res = await fetch(apiUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error({ to, status: res.status, body: body.slice(0, 300) }, 'whatsapp send falhou');
      return;
    }
    logger.info({ to, kind: msg.kind }, 'whatsapp enviado');
  } catch (err) {
    logger.error(
      { to, err: err instanceof Error ? err.message : String(err) },
      'whatsapp send erro',
    );
  }
}
