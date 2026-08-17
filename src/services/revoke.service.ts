import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { supabaseAdmin } from '../config/supabase.js';
import { deleteHavokCustomer } from './havok.service.js';
import { deleteXcloudDevice } from './xcloud.service.js';

/**
 * Revoga o acesso de um assinante que cancelou/pediu reembolso:
 *   1) exclui a conta no Havok (se tiver `usuario`)
 *   2) exclui o device na TV no XCloud (se tiver `xcloud_device_key`)
 *   3) marca `access_revoked_at` — só se tudo deu certo (senão fica pendente pro Mateus).
 *
 * Idempotente: se já revogado, sai. Chamada em fire-and-forget pelos handlers de
 * webhook (não trava a resposta pra Kirvano). Erros são logados, não lançados.
 */
export async function revokeAccess(subscriberId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('subscribers')
    .select('usuario, xcloud_device_key, access_revoked_at')
    .eq('id', subscriberId)
    .maybeSingle();
  if (error) {
    logger.error({ subscriberId, err: error.message }, 'revoke: falha ao ler assinante');
    return;
  }
  if (!data) return;
  if (data.access_revoked_at) {
    logger.info({ subscriberId }, 'revoke: já revogado, ignorando');
    return;
  }

  const usuario = data.usuario as string | null;
  const deviceKey = data.xcloud_device_key as string | null;
  const erros: string[] = [];

  // 1) Havok — só se houver conta e o Havok estiver ligado
  if (usuario && env.HAVOK_ENABLED) {
    try {
      const r = await deleteHavokCustomer(usuario);
      logger.info({ subscriberId, usuario, ...r }, 'revoke: Havok processado');
    } catch (e) {
      erros.push('havok: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // 2) XCloud — só se a TV foi ativada e o XCloud estiver ligado
  if (deviceKey && env.XCLOUD_ENABLED) {
    try {
      await deleteXcloudDevice(deviceKey);
      logger.info({ subscriberId, deviceKey }, 'revoke: XCloud device excluído');
    } catch (e) {
      erros.push('xcloud: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  if (erros.length) {
    // não marca revogado: fica pendente pra revisão manual no painel
    logger.error({ subscriberId, erros }, 'revoke: FALHA parcial — revogar manualmente no painel');
    return;
  }

  await supabaseAdmin
    .from('subscribers')
    .update({ access_revoked_at: new Date().toISOString() })
    .eq('id', subscriberId);
  logger.info({ subscriberId }, 'revoke: acesso revogado com sucesso');
}
