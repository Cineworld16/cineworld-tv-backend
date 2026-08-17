import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { UnauthorizedError } from '../lib/errors.js';

function extractToken(req: Request): string | null {
  // Kirvano manda em `security-token`. Também aceitamos alternativas comuns.
  const securityToken = req.header('security-token');
  if (securityToken) return securityToken;

  const header = req.header('x-kirvano-token');
  if (header) return header;

  const auth = req.header('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  const q = req.query.token;
  if (typeof q === 'string' && q) return q;

  return null;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifyKirvanoToken(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) {
    return next(new UnauthorizedError('Token do webhook ausente'));
  }
  if (!safeEqual(token, env.KIRVANO_WEBHOOK_TOKEN)) {
    return next(new UnauthorizedError('Token do webhook inválido'));
  }
  next();
}
