import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors, { type CorsOptionsDelegate } from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import affiliateRoutes from './routes/affiliate.routes.js';
import affiliatesRoutes from './routes/affiliates.routes.js';
import healthRoutes from './routes/health.routes.js';
import onboardRoutes from './routes/onboard.routes.js';
import subscribersRoutes from './routes/subscribers.routes.js';
import webhookRoutes from './routes/webhook.routes.js';
import whatsappRoutes from './routes/whatsapp.routes.js';
import { startBrevoSyncLoop } from './services/brevo-sync.service.js';
import { verifySmtp } from './services/email.service.js';
import { startHavokKeepAlive, warmHavokSession } from './services/havok.service.js';
import { startRetryLoop } from './services/retry.service.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Security headers centralizados: HSTS, X-Frame-Options DENY, X-Content-Type nosniff,
// Referrer-Policy, Cross-Origin-Resource-Policy, etc. (mesma base do CineRush.)
app.use(helmet());

// Backstop de rate-limit nas rotas autenticadas: sem ele, um JWT forjado (formato
// válido, exp futuro) passa o decode local e bate no Supabase a cada request.
const authLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// A rota pública /api/onboard é gated por token e consumida pelo site de config
// (origem variável) → liberada p/ qualquer origem. As demais rotas seguem o allowlist.
const corsDelegate: CorsOptionsDelegate<express.Request> = (req, cb) => {
  if (req.path.startsWith('/api/onboard')) {
    return cb(null, { origin: true, credentials: false });
  }
  const origin = req.header('origin');
  if (!origin) return cb(null, { origin: true, credentials: true });
  if (env.CORS_ALLOWED_ORIGINS.includes(origin)) {
    return cb(null, { origin: true, credentials: true });
  }
  return cb(new Error(`origin não permitida: ${origin}`), { origin: false });
};

app.use(cors(corsDelegate));

app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      // guarda o corpo cru p/ validar X-Hub-Signature-256 do WhatsApp
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(pinoHttp({ logger }));

// arquivos estáticos (public/) — usados pelo template de email pra imagens
// __dirname em runtime = <root>/dist  → sobe 1 nível pra alcançar <root>/public
app.use(
  '/assets',
  (_req, res, next) => {
    // helmet põe CORP same-origin globalmente; imagens de email são buscadas
    // cross-origin (proxies do Gmail/Outlook), então liberamos só aqui.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  },
  express.static(join(__dirname, '..', 'public'), {
    maxAge: '30d',
    immutable: true,
  }),
);

app.use('/health', healthRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/webhooks/whatsapp', whatsappRoutes);
app.use('/api/onboard', onboardRoutes);
app.use('/api/admin/subscribers', authLimiter, subscribersRoutes);
app.use('/api/admin/affiliates', authLimiter, affiliatesRoutes);
app.use('/api/affiliate', authLimiter, affiliateRoutes);

app.use(errorHandler);

const port = env.PORT;
app.listen(port, '0.0.0.0', () => {
  logger.info({ port, env: env.NODE_ENV }, 'CineRush TV backend online');
  void verifySmtp();
  startBrevoSyncLoop();
  startRetryLoop();
  if (env.HAVOK_ENABLED) {
    void warmHavokSession();
    startHavokKeepAlive();
  }
});
