import { env } from '../config/env.js';
import type { KirvanoWebhookPayload } from '../types/kirvano.js';

/**
 * Resolve o package_id Havok a partir da oferta Kirvano.
 *
 * Estratégia robusta: detecta a DURAÇÃO por palavra-chave no nome da oferta
 * (mensal/trimestral/semestral/anual), independente do prefixo. Assim funciona
 * com "PLANO MENSAL", "CINE RUSH TV Mensal", "Plano Mensal", etc.
 *
 * Package IDs padrão = servidor KYROS (SEU_SERVER_ID). Podem ser sobrescritos
 * via env HAVOK_PACKAGES (JSON: { "mensal": {"completo":"..","sem_adultos":".."}, ... }).
 */

interface Variants {
  completo: string; // com adulto (bump Triplo X)
  sem_adultos: string; // padrão
}

export type Duration = 'mensal' | 'trimestral' | 'semestral' | 'anual';

// Defaults KYROS (confirmados no painel seu-painel-iptv.exemplo)
const DEFAULT_PACKAGES: Record<Duration, Variants> = {
  mensal: { completo: 'PKG_MENSAL_A', sem_adultos: 'PKG_MENSAL_B' },
  trimestral: { completo: 'PKG_TRIMESTRAL_A', sem_adultos: 'PKG_TRIMESTRAL_B' },
  semestral: { completo: 'PKG_SEMESTRAL_A', sem_adultos: 'PKG_SEMESTRAL_B' },
  anual: { completo: 'PKG_ANUAL_A', sem_adultos: 'PKG_ANUAL_B' },
};

let packagesCache: Record<Duration, Variants> | null = null;

function getPackages(): Record<Duration, Variants> {
  if (packagesCache) return packagesCache;
  const merged = { ...DEFAULT_PACKAGES };
  try {
    const override = JSON.parse(env.HAVOK_PACKAGES) as Partial<Record<Duration, Variants>>;
    for (const [k, v] of Object.entries(override)) {
      if (v && (k === 'mensal' || k === 'trimestral' || k === 'semestral' || k === 'anual')) {
        merged[k] = v;
      }
    }
  } catch {
    // env vazio ou inválido -> usa defaults
  }
  packagesCache = merged;
  return merged;
}

// Detecta duração pelo texto da oferta/plano
export function detectDuration(text: string): Duration | null {
  const t = text.toLowerCase();
  if (/\banual\b|\bano\b|12\s*mes|1\s*ano/.test(t)) return 'anual';
  if (/\bsemestral\b|\b6\s*mes|semestre/.test(t)) return 'semestral';
  if (/\btrimestral\b|\b3\s*mes|trimestre/.test(t)) return 'trimestral';
  if (/\bmensal\b|\b1\s*mes|\bmes\b/.test(t)) return 'mensal';
  return null;
}

const ADULT_BUMP_KEYWORDS = ['triplo x', 'adulto', '+18', 'xxx'];

function hasAdultBump(payload: KirvanoWebhookPayload): boolean {
  const bumps = (payload.products ?? []).filter((p) => p.is_order_bump === true);
  return bumps.some((b) => {
    const name = (b.name ?? '').toLowerCase();
    return ADULT_BUMP_KEYWORDS.some((k) => name.includes(k));
  });
}

/** Nome da oferta principal (não-bump), tolerante a variações de campo. */
export function extractOfferName(payload: KirvanoWebhookPayload): string {
  const main = payload.products?.find((p) => !p.is_order_bump) ?? payload.products?.[0];
  const m = main as (typeof main & { offer_name?: string; checkout_name?: string }) | undefined;
  const offer = (m?.offer_name ?? m?.checkout_name ?? m?.name ?? '').trim();
  // se a oferta vier genérica (só "CINE RUSH TV"), tenta o plan.name que tem a duração
  const planName = (payload.plan?.name ?? '').trim();
  return offer || planName;
}

export interface ResolvedPackage {
  packageId: string;
  duration: Duration;
  variant: 'completo' | 'sem_adultos';
  offerName: string;
}

export function resolveHavokPackage(payload: KirvanoWebhookPayload): ResolvedPackage | null {
  const offerName = extractOfferName(payload);
  const planName = payload.plan?.name ?? '';
  // procura duração na oferta OU no plan.name
  const duration = detectDuration(offerName) ?? detectDuration(planName);
  if (!duration) return null;

  const variant: 'completo' | 'sem_adultos' = hasAdultBump(payload) ? 'completo' : 'sem_adultos';
  const packageId = getPackages()[duration][variant];
  if (!packageId) return null;

  return { packageId, duration, variant, offerName: offerName || planName };
}

/** Lista as durações configuradas (pra /health/havok). */
export function listConfiguredOffers(): string[] {
  return Object.keys(getPackages());
}
