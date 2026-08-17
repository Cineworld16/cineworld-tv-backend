/**
 * Regras de reagendamento de envio de email:
 * - Só envia entre 08:00 e 20:00 (America/Sao_Paulo).
 * - Ao falhar, agenda pra `RETRY_DELAY_HOURS` depois; se cair fora da janela,
 *   empurra pra próxima 08:00 válida.
 * - Máximo `RETRY_MAX_ATTEMPTS` reagendamentos consecutivos.
 */

export const RETRY_DELAY_HOURS = 2;
export const RETRY_MAX_ATTEMPTS = 3;
// Provisionamento Havok: falha de Cloudflare/sessão é infra transitória, não do
// cliente. Reprocessamos a cada rodada do worker por esta janela após a compra,
// em vez de contar tentativas — assim autocura quando o Cloudflare libera.
export const PROVISION_RETRY_WINDOW_HOURS = 12;
export const BUSINESS_START_HOUR = 8; // BRT
export const BUSINESS_END_HOUR = 20; // BRT (exclusivo)

const BRT_TZ = 'America/Sao_Paulo';

/** hora local em BRT como número 0-23 */
function hourInBRT(d: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: BRT_TZ,
    hour: 'numeric',
    hour12: false,
  });
  return Number.parseInt(fmt.format(d), 10);
}

/** monta um Date em UTC representando `year-month-day HH:MM:SS` em BRT */
function fromBRT(year: number, month: number, day: number, hour: number): Date {
  // BRT = UTC-3 (sem DST desde 2019). Aplicamos +3h pra converter BRT→UTC.
  return new Date(Date.UTC(year, month - 1, day, hour + 3, 0, 0));
}

/** extrai ano/mês/dia em BRT do Date passado */
function ymdInBRT(d: Date): { y: number; m: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BRT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = Number.parseInt(parts.find((p) => p.type === 'year')!.value, 10);
  const m = Number.parseInt(parts.find((p) => p.type === 'month')!.value, 10);
  const day = Number.parseInt(parts.find((p) => p.type === 'day')!.value, 10);
  return { y, m, day };
}

/**
 * Retorna o próximo slot válido pra enviar, começando de `base` + delay.
 * Se cair fora da janela BRT 08-20, empurra pra próximo 08:00.
 */
export function nextEmailSlot(base: Date, delayHours = RETRY_DELAY_HOURS): Date {
  const target = new Date(base.getTime() + delayHours * 3600 * 1000);
  const hour = hourInBRT(target);

  if (hour >= BUSINESS_START_HOUR && hour < BUSINESS_END_HOUR) {
    return target;
  }

  const { y, m, day } = ymdInBRT(target);

  if (hour < BUSINESS_START_HOUR) {
    // hoje mesmo às 08:00 BRT
    return fromBRT(y, m, day, BUSINESS_START_HOUR);
  }

  // >= 20h BRT → 08:00 do dia seguinte (BRT)
  const nextDay = new Date(fromBRT(y, m, day, BUSINESS_START_HOUR));
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return nextDay;
}

/** true se `now` cai dentro da janela permitida (usado pelo worker pra saber se pode enviar) */
export function isBusinessHour(now: Date): boolean {
  const h = hourInBRT(now);
  return h >= BUSINESS_START_HOUR && h < BUSINESS_END_HOUR;
}
