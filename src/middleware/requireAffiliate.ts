import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../lib/errors.js';
import { verifyBearer } from '../services/auth.service.js';

declare module 'express-serve-static-core' {
  interface Request {
    affiliate?: { id: string; email: string };
  }
}

/**
 * Autentica um AFILIADO (usuário Supabase confirmado) — qualquer conta logada,
 * sem allowlist. Os dados são sempre escopados pelo email do JWT, então o
 * afiliado só enxerga as próprias vendas.
 *
 * IMPORTANTE: a segurança depende de "Confirm email" estar LIGADO no Supabase
 * (só assim ninguém consegue token com o email de outra pessoa).
 */
export async function requireAffiliate(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) {
    return next(new UnauthorizedError('Authorization ausente'));
  }
  const token = header.slice(7).trim();
  const user = await verifyBearer(token);
  if (!user || !user.email) return next(new UnauthorizedError('JWT inválido ou expirado'));

  req.affiliate = { id: user.id, email: user.email.toLowerCase() };
  next();
}
