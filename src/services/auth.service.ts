import { supabaseAuth } from '../config/supabase.js';

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

  const { data, error } = await supabaseAuth.auth.getUser(token);
  if (error || !data.user) return null;

  const email = data.user.email ?? '';
  cache.set(token, {
    userId: data.user.id,
    email,
    cachedAt: Date.now(),
    jwtExp: decoded.exp,
  });

  return { id: data.user.id, email };
}
