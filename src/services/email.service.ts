import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { EmailVars } from '../templates/access-email.html.js';
import { renderAccessEmailHtml } from '../templates/access-email.html.js';
import { renderAccessEmailText } from '../templates/access-email.text.js';

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

let smtpReady: 'unknown' | 'ok' | 'error' = 'unknown';
let smtpError: string | null = null;

export async function verifySmtp(): Promise<{ ok: boolean; error?: string }> {
  if (!env.BREVO_API_KEY) {
    smtpReady = 'error';
    smtpError = 'BREVO_API_KEY ausente';
    logger.warn('BREVO_API_KEY ausente — envio não vai funcionar');
    return { ok: false, error: smtpError };
  }
  // Brevo tem endpoint /v3/account que valida a chave. Usa timeout curto.
  try {
    const res = await fetch('https://api.brevo.com/v3/account', {
      headers: { 'api-key': env.BREVO_API_KEY, accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Brevo /account ${res.status}: ${body.slice(0, 200)}`);
    }
    smtpReady = 'ok';
    smtpError = null;
    logger.info('Brevo API key validada');
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    smtpReady = 'error';
    smtpError = msg;
    logger.warn({ err: msg }, 'Brevo verify falhou — envio pode não funcionar');
    return { ok: false, error: msg };
  }
}

export function getSmtpStatus() {
  return { status: smtpReady, error: smtpError, provider: 'brevo' };
}

export interface SendAccessEmailInput {
  to: string;
  vars: EmailVars;
  /** Assunto custom (ex.: renovação). Sem isto, usa o assunto padrão de 1º acesso. */
  subject?: string;
}

export interface SendResult {
  ok: true;
  messageId: string;
}

interface BrevoResponse {
  messageId?: string;
  message?: string;
  code?: string;
}

export async function sendAccessEmail(input: SendAccessEmailInput): Promise<SendResult> {
  const html = renderAccessEmailHtml(input.vars);
  const text = renderAccessEmailText(input.vars);

  const body = {
    sender: { name: env.SMTP_FROM_NAME, email: env.SMTP_FROM_EMAIL },
    to: [{ email: input.to, name: input.vars.nome }],
    replyTo: { email: env.REPLY_TO_EMAIL ?? env.SMTP_FROM_EMAIL },
    subject: input.subject ?? 'Seu acesso CineWorld está pronto',
    htmlContent: html,
    textContent: text,
  };

  const res = await fetch(BREVO_ENDPOINT, {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  const data = (await res.json().catch(() => ({}))) as BrevoResponse;

  if (!res.ok) {
    throw new Error(
      `Brevo ${res.status}: ${data.code ?? ''} ${data.message ?? 'erro desconhecido'}`,
    );
  }
  if (!data.messageId) {
    throw new Error('Brevo: resposta sem messageId');
  }

  return { ok: true, messageId: data.messageId };
}
