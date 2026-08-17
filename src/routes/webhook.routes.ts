import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { BadRequestError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { verifyKirvanoToken } from '../middleware/verifyKirvanoToken.js';
import { processKirvanoWebhook } from '../services/kirvano.service.js';
import type { KirvanoWebhookPayload } from '../types/kirvano.js';

const webhookLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

const payloadSchema = z.object({
  event: z.string(),
}).passthrough();

const router = Router();

router.post('/kirvano', webhookLimiter, verifyKirvanoToken, async (req, res, next) => {
  try {
    const parsed = payloadSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError('Payload inválido', parsed.error.format());
    }

    const payload = parsed.data as unknown as KirvanoWebhookPayload;
    const result = await processKirvanoWebhook(payload);

    logger.info(
      { event: payload.event, sale_id: payload.sale_id, result: result.status },
      'webhook processado',
    );

    // Sempre 200 para eventos idempotentes — evita retry infinito
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

export default router;
