import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { handleButtonClick, type HandoffSignal } from '../services/onboarding.service.js';
import { sendMessage } from '../services/whatsapp.service.js';

const router = Router();

// ── Verificação do webhook (GET) — Meta chama uma vez ao configurar ────────
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN && env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('whatsapp webhook verificado');
    return res.status(200).send(String(challenge ?? ''));
  }
  return res.sendStatus(403);
});

// ── Validação de assinatura ────────────────────────────────────────────────
function validSignature(req: Request): boolean {
  if (!env.WHATSAPP_APP_SECRET) {
    // fail-closed: sem secret NÃO aceitamos origem não verificada em produção.
    // Só liberamos em dev (facilita testar o webhook sem assinar).
    return env.NODE_ENV !== 'production';
  }
  const sig = req.header('x-hub-signature-256');
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!sig || !raw) return false;
  const expected =
    'sha256=' + createHmac('sha256', env.WHATSAPP_APP_SECRET).update(raw).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Notificação de handoff (opcional, via Discord/webhook) ─────────────────
async function notifySupport(s: HandoffSignal): Promise<void> {
  logger.info({ waId: s.waId, step: s.step, device: s.device }, 'HANDOFF: atendente solicitado');
  if (!env.SUPPORT_ALERT_URL) return;
  try {
    await fetch(env.SUPPORT_ALERT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `🆘 Onboarding: cliente pediu atendente.\nWhatsApp: ${s.waId}\nDispositivo: ${s.device ?? '—'} · passo ${s.step}`,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'notifySupport falhou');
  }
}

// ── Tipos mínimos do payload da Meta ───────────────────────────────────────
interface WaInteractive {
  type?: string;
  button_reply?: { id?: string; title?: string };
  list_reply?: { id?: string; title?: string };
}
interface WaMessage {
  from?: string;
  type?: string;
  interactive?: WaInteractive;
  button?: { payload?: string; text?: string };
}

function extractClicks(body: unknown): Array<{ from: string; buttonId: string }> {
  const out: Array<{ from: string; buttonId: string }> = [];
  const entries = (body as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes ?? [];
    for (const change of changes) {
      const value = (change as { value?: { messages?: WaMessage[] } })?.value;
      const messages = value?.messages ?? [];
      for (const m of messages) {
        if (!m.from) continue;
        const inter = m.interactive;
        const id = inter?.button_reply?.id ?? inter?.list_reply?.id ?? m.button?.payload;
        if (id) out.push({ from: m.from, buttonId: id });
      }
    }
  }
  return out;
}

// ── Recebimento (POST) ─────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  // sempre responde 200 rápido (a Meta reenvia se não receber 200)
  if (!validSignature(req)) {
    logger.warn('whatsapp webhook: assinatura invalida');
    return res.sendStatus(403);
  }
  res.sendStatus(200);

  if (!env.ONBOARDING_ENABLED) return;

  try {
    const clicks = extractClicks(req.body);
    for (const { from, buttonId } of clicks) {
      const next = await handleButtonClick(from, buttonId, notifySupport);
      if (next) await sendMessage(from, next);
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'whatsapp webhook: erro processando',
    );
  }
});

export default router;
