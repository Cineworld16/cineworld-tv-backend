import { env } from '../config/env.js';

interface CacheEntry {
  userId: string;
  email: string;
  cachedAt: number;
  jwtExp: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

interface JwtPayload {
  exp?: number;
  sub?: string;
  email?: string;
}

function decodeJwtUnsafe(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
}

export interface AuthedUser {
  id: string;
  email: string;
}

export async function verifyBearer(token: string): Promise<AuthedUser | null> {
  const nowSec = Math.floor(Date.now() / 1000);

  const decoded = decodeJwtUnsafe(token);
  if (!decoded || !decoded.exp || decoded.exp < nowSec) return null;

  const cached = cache.get(token);
  if (
    cached &&
    Date.now() - cached.cachedAt < TTL_MS &&
    cached.jwtExp > nowSec
  ) {
    return { id: cached.userId, email: cached.email };
  }

  // Chamada REST direta (em vez do SDK supabase-js) — o SDK 2.45.x falha em
  // validar tokens assinados com as chaves JWT assimetricas (ES256) que
  // projetos Supabase novos usam por padrao, mesmo o endpoint REST aceitando
  // o token normalmente.
  let user: { id: string; email?: string } | null = null;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
    });
    if (res.ok) user = (await res.json()) as { id: string; email?: string };
  } catch {
    return null;
  }
  if (!user) return null;

  const email = user.email ?? '';
  cache.set(token, {
    userId: user.id,
    email,
    cachedAt: Date.now(),
    jwtExp: decoded.exp,
  });

  return { id: user.id, email };
}
