import { Router } from 'express';
import { z } from 'zod';
import { BadRequestError, ConflictError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import {
  getCredentials,
  getSubscriber,
  listSubscribers,
  saveCredentials,
  tryMarkEmailSending,
} from '../services/subscribers.service.js';
import { attemptSendCredentials } from '../services/send-credentials.service.js';
import { provisionSubscriberById } from '../services/provision.service.js';
import { env } from '../config/env.js';

const router = Router();

router.use(requireAdmin);

const listQuery = z.object({
  search: z.string().optional(),
  status: z
    .enum([
      'pendente',
      'credenciais_preenchidas',
      'email_enviado',
      'cancelado',
      'reembolsado',
      'agendado',
    ])
    .optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

router.get('/', async (req, res, next) => {
  try {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) throw new BadRequestError('Query inválida', parsed.error.format());
    const result = await listSubscribers(parsed.data);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const sub = await getSubscriber(req.params.id);
    res.json(sub);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/credentials', async (req, res, next) => {
  try {
    const creds = await getCredentials(req.params.id);
    logger.info(
      { subscriberId: req.params.id, adminEmail: req.admin?.email },
      'leitura de credenciais',
    );
    res.json(creds);
  } catch (err) {
    next(err);
  }
});

const patchCredsBody = z.object({
  usuario: z.string().min(1).max(200),
  senha: z.string().min(1).max(200),
});

router.patch('/:id/credentials', async (req, res, next) => {
  try {
    const parsed = patchCredsBody.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('Body inválido', parsed.error.format());
    const updated = await saveCredentials(
      req.params.id,
      parsed.data.usuario,
      parsed.data.senha,
      req.admin!.id,
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

const sendEmailQuery = z.object({
  force: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
});

router.post('/:id/send-email', async (req, res, next) => {
  try {
    const parsed = sendEmailQuery.safeParse(req.query);
    if (!parsed.success) throw new BadRequestError('Query inválida', parsed.error.format());
    const force = parsed.data.force ?? false;

    const { locked, current } = await tryMarkEmailSending(req.params.id, force);
    if (!locked) {
      throw new ConflictError('email_already_sent', 'Email já foi enviado anteriormente.', {
        can_force: true,
        data_envio_email: current.data_envio_email,
      });
    }

    const outcome = await attemptSendCredentials(req.params.id, req.admin!.id);
    if (outcome.kind !== 'sent') {
      return res.status(502).json({
        error: 'smtp_failed',
        message: outcome.error,
        ...(outcome.kind === 'scheduled'
          ? { rescheduled_at: outcome.nextAt, retry_count: outcome.retryCount }
          : { gave_up: true }),
      });
    }
    const updated = await getSubscriber(req.params.id);
    logger.info(
      { subscriberId: req.params.id, adminEmail: req.admin?.email, force },
      'email enviado',
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

const revokeBody = z.object({ revoked: z.boolean() });

router.patch('/:id/revoke', async (req, res, next) => {
  try {
    const parsed = revokeBody.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('Body inválido', parsed.error.format());
    const { supabaseAdmin } = await import('../config/supabase.js');
    const { error } = await supabaseAdmin
      .from('subscribers')
      .update({
        access_revoked_at: parsed.data.revoked ? new Date().toISOString() : null,
        updated_by: req.admin!.id,
      })
      .eq('id', req.params.id);
    if (error) throw error;
    const updated = await getSubscriber(req.params.id);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// Dispara a automação Havok (cria conta + salva cred + envia email) manualmente.
router.post('/:id/provision', async (req, res, next) => {
  try {
    if (!env.HAVOK_ENABLED) {
      throw new ConflictError('havok_disabled', 'Automação Havok está desligada (HAVOK_ENABLED=false).');
    }
    const current = await getSubscriber(req.params.id);
    if (current.status === 'email_enviado') {
      throw new ConflictError('already_sent', 'Esse assinante já recebeu o acesso.');
    }
    logger.info(
      { subscriberId: req.params.id, adminEmail: req.admin?.email },
      'provision manual disparado pelo dashboard',
    );
    const result = await provisionSubscriberById(req.params.id);
    if (!result.ok) {
      return res.status(422).json({ error: 'provision_failed', message: result.error });
    }
    const updated = await getSubscriber(req.params.id);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
