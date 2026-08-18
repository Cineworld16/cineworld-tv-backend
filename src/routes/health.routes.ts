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

export default router;
