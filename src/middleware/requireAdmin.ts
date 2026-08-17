import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import { verifyBearer } from '../services/auth.service.js';

declare module 'express-serve-static-core' {
  interface Request {
    admin?: { id: string; email: string };
  }
}

export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) {
    return next(new UnauthorizedError('Authorization ausente'));
  }
  const token = header.slice(7).trim();
  const user = await verifyBearer(token);
  if (!user) return next(new UnauthorizedError('JWT inválido ou expirado'));

  const email = user.email.toLowerCase();
  if (!env.ADMIN_EMAILS.includes(email)) {
    return next(new ForbiddenError('Este usuário não é admin'));
  }

  req.admin = { id: user.id, email };
  next();
}
