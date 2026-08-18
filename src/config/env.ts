import 'dotenv/config';
import { z } from 'zod';

const csv = (raw: string) =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_ANON_KEY: z.string().min(20),

  KIRVANO_WEBHOOK_TOKEN: z.string().min(16, 'use ao menos 16 caracteres'),

  ADMIN_EMAILS: z.string().min(3),

  ENCRYPTION_KEY: z
    .string()
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'deve ser 32 bytes base64 (gere: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))")'),

  BREVO_API_KEY: z.string().min(10),
  SMTP_FROM_NAME: z.string().default('CineWorld'),
  SMTP_FROM_EMAIL: z.string().email(),
  REPLY_TO_EMAIL: z
    .string()
    .email()
    .optional()
    .or(z.literal(''))
    .transform((v) => (v ? v : undefined)),

  ACCESS_URL: z.string().min(1).default('http://seu-dns-de-acesso.exemplo'),
  SUPPORT_WHATSAPP_URL: z
    .string()
    .url()
    .default('https://wa.me/5599999999999'),
  // Site de configuração self-service. Vazio = não renderiza o botão no email.
  CONFIG_SITE_URL: z
    .string()
    .default('')
    .transform((v) => v.replace(/\/+$/, '')), // sem barra final
  BACKEND_PUBLIC_URL: z
    .string()
    .url()
    .default('https://seu-backend.up.railway.app'),

  // Havok (painel IPTV) — criação automática de conta
  HAVOK_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  HAVOK_BASE_URL: z.string().url().default('http://seu-painel-iptv.exemplo'),
  HAVOK_USER: z.string().default(''),
  HAVOK_PASS: z.string().default(''),
  HAVOK_SERVER_ID: z.string().default(''),
  // Proxy pra sessão do Havok (contorna bloqueio do Cloudflare no IP do Railway).
  // Formato: http://user:pass@host:porta (ou socks5://...). Vazio = sem proxy.
  HAVOK_PROXY: z.string().default(''),
  // Opcional. JSON p/ sobrescrever package_ids por duração:
  // { "mensal": {"completo":"..","sem_adultos":".."}, "trimestral": {...}, ... }
  // Se vazio, usa os defaults KYROS baked no código (lib/havok-plans.ts).
  HAVOK_PACKAGES: z
    .string()
    .default('{}')
    .refine((v) => {
      try {
        JSON.parse(v);
        return true;
      } catch {
        return false;
      }
    }, 'HAVOK_PACKAGES deve ser JSON válido'),

  // XCloud (ativação de TV via device key). A conta é COMPARTILHADA com um colega,
  // por isso o serviço só lê e cria — nunca edita nem apaga (ver xcloud.service.ts).
  // Desligado por padrão: com isso off, o site não oferece o fluxo de TV por código.
  XCLOUD_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  XCLOUD_USER: z.string().default(''), // email do painel
  XCLOUD_PASS: z.string().default(''),
  // FALLBACK da duração da ativação. O normal é derivar do plano comprado
  // (mensal→"1 month", anual→"1 year" etc. via periodoDoPlano); este valor só é
  // usado quando o texto do plano não é reconhecido. Formato: "1 month", "1 year"...
  XCLOUD_PERIOD: z.string().default('1 month'),
  // Rollout: separado do ENABLED de propósito. ENABLED = o backend CONSEGUE ativar.
  // PUBLIC = o site oferece a tela nova de TV pra TODOS os clientes. Durante o teste,
  // deixe ENABLED=true e PUBLIC=false: só quem abre o link com ?tvauto vê o fluxo novo
  // (o Mateus testando), e os clientes continuam no passo a passo antigo.
  XCLOUD_PUBLIC: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  CORS_ALLOWED_ORIGINS: z.string().default(''),

  // WhatsApp Business Cloud API (onboarding) — tudo opcional; liga com ONBOARDING_ENABLED
  ONBOARDING_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  WHATSAPP_TOKEN: z.string().default(''), // token permanente da Meta
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  WHATSAPP_VERIFY_TOKEN: z.string().default(''), // segredo p/ verificar o webhook (GET hub.challenge)
  WHATSAPP_APP_SECRET: z.string().default(''), // p/ validar X-Hub-Signature-256
  SUPPORT_ALERT_URL: z.string().default(''), // webhook Discord/etc p/ avisar handoff (opcional)
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Configuração inválida:\n', parsed.error.format());
  process.exit(1);
}

const raw = parsed.data;

export const env = {
  ...raw,
  ADMIN_EMAILS: csv(raw.ADMIN_EMAILS).map((s) => s.toLowerCase()),
  CORS_ALLOWED_ORIGINS: csv(raw.CORS_ALLOWED_ORIGINS),
  ENCRYPTION_KEY_BUFFER: Buffer.from(raw.ENCRYPTION_KEY, 'base64'),
} as const;

export type Env = typeof env;
