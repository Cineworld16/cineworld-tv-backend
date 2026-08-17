import { Router } from 'express';
import { requireAffiliate } from '../middleware/requireAffiliate.js';
import { getAffiliatePortalData, getLeaderboard } from '../services/affiliates.service.js';

// Portal self-service do afiliado. Diferente de /api/admin/affiliates (que é
// visão do Mateus): aqui o afiliado logado vê SÓ as próprias vendas, sem PII.
const router = Router();

router.use(requireAffiliate);

router.get('/me', async (req, res, next) => {
  try {
    const data = await getAffiliatePortalData(req.affiliate!.email);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Ranking (Fase 2): ?period=geral|mes. "mes" = competição do mês atual.
router.get('/leaderboard', async (req, res, next) => {
  try {
    const period = req.query.period === 'mes' ? 'mes' : 'geral';
    const data = await getLeaderboard(req.affiliate!.email, period);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
