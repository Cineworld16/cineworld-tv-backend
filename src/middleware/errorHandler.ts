import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
  logger.error({ err }, 'unhandled error');
  // Não vaza detalhe interno (mensagem do Postgres/Supabase etc.) pro cliente em prod.
  const message =
    env.NODE_ENV === 'production'
      ? 'erro interno'
      : err instanceof Error
        ? err.message
        : 'erro desconhecido';
  return res.status(500).json({ error: 'internal_error', message });
}
