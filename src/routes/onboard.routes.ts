import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { supabaseAdmin } from '../config/supabase.js';
import { getOnboardingByToken } from '../services/subscribers.service.js';
import {
  ativarDispositivo,
  montarPlaylistUrl,
  validarDeviceKey,
} from '../services/xcloud.service.js';

const router = Router();

// Público, mas gated pelo token (UUID). Rate limit defensivo contra brute-force.
const limiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// A ativação gasta crédito da conta (compartilhada com um colega), então é bem
// mais restrita que a leitura: poucas tentativas por minuto por IP.
const limiterAtivacao = rateLimit({
  windowMs: 60_000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
});

const TOKEN_RE = /^[a-f0-9]{32}$/;

// GET /api/onboard/:token → dados p/ o site de configuração pré-preencher.
router.get('/:token', limiter, async (req, res, next) => {
  try {
    const token = String(req.params.token ?? '').trim();
    // formato do token (32 hex). Rejeita lixo sem tocar no banco.
    if (!/^[a-f0-9]{32}$/.test(token)) {
      return res.status(404).json({ status: 'not_found' });
    }

    const data = await getOnboardingByToken(token);
    if (!data) {
      logger.info({ tokenPrefix: token.slice(0, 6) }, 'onboard: token nao encontrado');
      return res.status(404).json({ status: 'not_found' });
    }

    return res.status(200).json({
      status: data.status,
      nome: data.nome,
      usuario: data.usuario ?? null,
      senha: data.senha ?? null,
      access_url: env.ACCESS_URL,
      support_url: env.SUPPORT_WHATSAPP_URL,
      // Diz ao site se ele deve oferecer a ativação automática de TV (XCloud) PRA TODOS.
      // Controlado por XCLOUD_PUBLIC (não ENABLED): durante o teste isto fica false e só
      // quem abre com ?tvauto vê o fluxo novo. Cliente comum segue no IBO Player / 9Xtream.
      tv_auto: env.XCLOUD_PUBLIC,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Busca o assinante pelo token, já com a credencial decifrada e o estado da TV.
 * Retorna null se o token não existe.
 */
async function carregarAssinante(token: string) {
  const dados = await getOnboardingByToken(token);
  if (!dados) return null;

  const { data, error } = await supabaseAdmin
    .from('subscribers')
    .select('id,status,plano,xcloud_device_key,xcloud_activated_at')
    .eq('onboard_token', token)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  return {
    id: data.id as string,
    status: data.status as string,
    plano: (data.plano as string | null) ?? null,
    deviceKeyAtivo: (data.xcloud_device_key as string | null) ?? null,
    onboarding: dados,
  };
}

/**
 * POST /api/onboard/:token/tv/validar  { device_key }
 * Só confere se a chave existe no XCloud. NÃO gasta crédito.
 * Serve pra avisar "código errado, confere na TV" antes de tentar ativar.
 */
router.post('/:token/tv/validar', limiterAtivacao, async (req, res, next) => {
  try {
    if (!env.XCLOUD_ENABLED) return res.status(503).json({ erro: 'xcloud_desligado' });

    const token = String(req.params.token ?? '').trim();
    if (!TOKEN_RE.test(token)) return res.status(404).json({ erro: 'nao_encontrado' });

    const assinante = await carregarAssinante(token);
    if (!assinante) return res.status(404).json({ erro: 'nao_encontrado' });

    const chave = String((req.body as { device_key?: string })?.device_key ?? '').trim();
    if (!chave) return res.status(400).json({ erro: 'device_key_ausente' });

    const info = await validarDeviceKey(chave);
    return res.status(200).json({ valido: info.existe, plataforma: info.plataforma ?? null });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/onboard/:token/tv/ativar  { device_key }
 * Cria o dispositivo no XCloud apontando pra playlist DESTE assinante.
 *
 * ⚠️ GASTA CRÉDITO da conta compartilhada. Por isso:
 *  - só roda com XCLOUD_ENABLED ligado (ou seja, quando o site oferece o fluxo de TV);
 *  - exige que o assinante já tenha usuário/senha (linha criada no Havok);
 *  - é IDEMPOTENTE: se este assinante já ativou, devolve o resultado anterior sem
 *    chamar o painel de novo (cliente que atualiza a página não queima crédito);
 *  - a chave é gravada com índice único, então a mesma TV não é ativada 2x.
 */
router.post('/:token/tv/ativar', limiterAtivacao, async (req, res, next) => {
  try {
    if (!env.XCLOUD_ENABLED) return res.status(503).json({ erro: 'xcloud_desligado' });

    const token = String(req.params.token ?? '').trim();
    if (!TOKEN_RE.test(token)) return res.status(404).json({ erro: 'nao_encontrado' });

    const assinante = await carregarAssinante(token);
    if (!assinante) return res.status(404).json({ erro: 'nao_encontrado' });

    const chave = String((req.body as { device_key?: string })?.device_key ?? '')
      .trim()
      .toUpperCase();
    if (!chave) return res.status(400).json({ erro: 'device_key_ausente' });

    // já ativou antes → não gasta crédito de novo
    if (assinante.deviceKeyAtivo) {
      const mesma = assinante.deviceKeyAtivo === chave;
      return res.status(200).json({
        ok: true,
        ja_ativado: true,
        device_key: assinante.deviceKeyAtivo,
        aviso: mesma ? null : 'ja_existe_outra_tv_ativada',
      });
    }

    const { onboarding } = assinante;
    if (onboarding.status !== 'ready' || !onboarding.usuario || !onboarding.senha) {
      return res.status(409).json({ erro: 'acesso_ainda_nao_pronto' });
    }

    const playlistUrl = montarPlaylistUrl(onboarding.usuario, onboarding.senha);
    const r = await ativarDispositivo({
      deviceKey: chave,
      playlistUrl,
      subscriberId: assinante.id,
      plano: assinante.plano, // a validade da TV segue o plano comprado
    });

    const { error } = await supabaseAdmin
      .from('subscribers')
      .update({ xcloud_device_key: chave, xcloud_activated_at: new Date().toISOString() })
      .eq('id', assinante.id)
      .is('xcloud_device_key', null); // corrida: só grava se ainda estiver vazio
    if (error) {
      // o dispositivo já foi criado lá; não dá pra desfazer. Loga alto pra auditoria.
      logger.error(
        { subscriberId: assinante.id, deviceKey: chave, err: error.message },
        'XCloud: ativou mas FALHOU ao gravar no banco — risco de ativar 2x',
      );
    }

    logger.info({ subscriberId: assinante.id, deviceKey: chave }, 'XCloud: TV ativada');
    return res.status(200).json({ ok: true, device_key: r.deviceKey, expira_em: r.expiraEm ?? null });
  } catch (err) {
    next(err);
  }
});

export default router;
