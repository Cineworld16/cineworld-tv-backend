import { Router } from 'express';
import { env } from '../config/env.js';
import { listConfiguredOffers } from '../lib/havok-plans.js';
import { getSmtpStatus } from '../services/email.service.js';
import { getHavokStatus } from '../services/havok.service.js';
import { getXcloudStatus } from '../services/xcloud.service.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

router.get('/smtp', (_req, res) => {
  res.json(getSmtpStatus());
});

router.get('/havok', (_req, res) => {
  res.json({
    enabled: env.HAVOK_ENABLED,
    ...getHavokStatus(),
    offers: env.HAVOK_ENABLED ? listConfiguredOffers() : [],
  });
});

router.get('/xcloud', (_req, res) => {
  res.json(getXcloudStatus());
});

// TODO temporario: diagnostico de conectividade Railway -> Supabase Auth (remover apos debug)
router.get('/authcheck', async (req, res) => {
  const token = (req.query.token as string) ?? '';
  try {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
    });
    const body = await r.text();
    res.json({ ok: true, status: r.status, body: body.slice(0, 300), supabaseUrl: env.SUPABASE_URL });
  } catch (err) {
    res.json({
      ok: false,
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage: err instanceof Error ? err.message : String(err),
      cause: err instanceof Error && 'cause' in err ? String((err as { cause?: unknown }).cause) : null,
    });
  }
});

export default router;
