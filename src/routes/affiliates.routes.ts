import { Router } from 'express';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { getAffiliateDetail, listAffiliates } from '../services/affiliates.service.js';

const router = Router();

router.use(requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const result = await listAffiliates({ from, to });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// :key = email do afiliado (URL-encoded) ou "__direto__" pras vendas diretas.
router.get('/:key', async (req, res, next) => {
  try {
    const detail = await getAffiliateDetail(req.params.key);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

export default router;
