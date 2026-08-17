# CineRush TV — Backend

Backend Node/Express/TS que:

1. Recebe webhook da **Kirvano** e cria assinantes no DB (Supabase).
2. Expõe API admin pra o dashboard (`../cinerush-tv-admin`).
3. Envia email de acesso via Gmail SMTP quando o Mateus preenche as credenciais Havok.

## Setup local

```bash
npm install
cp .env.example .env
# preencher .env
npm run dev
```

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | uptime |
| GET | `/health/smtp` | status do `transporter.verify()` |
| POST | `/api/webhooks/kirvano` | webhook Kirvano (token via header `X-Kirvano-Token` ou `?token=`) |
| GET | `/api/admin/subscribers?search=&status=&page=&pageSize=` | listagem paginada (sem senha) |
| GET | `/api/admin/subscribers/:id` | detalhe (sem senha) |
| GET | `/api/admin/subscribers/:id/credentials` | `{ usuario, senha }` descriptografado (leitura logada) |
| PATCH | `/api/admin/subscribers/:id/credentials` | body `{ usuario, senha }` — criptografa e salva, promove status pra `credenciais_preenchidas` |
| POST | `/api/admin/subscribers/:id/send-email?force=true\|false` | dispara email; sem `force` rejeita 409 se já enviado |
| PATCH | `/api/admin/subscribers/:id/revoke` | body `{ revoked: boolean }` — marca acesso revogado no Havok |

Rotas `/api/admin/*` exigem `Authorization: Bearer <supabase-jwt>`. O JWT precisa ser de um usuário do Supabase Auth cujo email está em `ADMIN_EMAILS`.

## Setup Supabase

1. Criar projeto novo em https://supabase.com.
2. SQL Editor → colar `migrations/001_initial.sql` → Run.
3. Authentication → Users → Add user → email = o mesmo do `ADMIN_EMAILS`, senha forte.
4. Copiar `Project URL` → `SUPABASE_URL`, `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`, `anon` key → `SUPABASE_ANON_KEY`.

## Setup Gmail SMTP

1. Ativar 2FA na conta Google.
2. https://myaccount.google.com/apppasswords → gerar App Password → colar em `SMTP_PASS`.
3. `SMTP_USER` e `SMTP_FROM_EMAIL` = o email Gmail.

## Chave de criptografia

`ENCRYPTION_KEY` — 32 bytes base64. Gere uma vez, guarde no gerenciador de senhas:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Se perder a chave, todas as senhas Havok criptografadas viram lixo.** Guarde em backup.

## Configuração no Kirvano

Painel Kirvano → **Extensões → Webhooks → Adicionar**:

- **URL**: `https://api.cinerush.tv/api/webhooks/kirvano` (ou o domínio Railway em prod)
- **Token**: mesmo valor de `KIRVANO_WEBHOOK_TOKEN`
- **Eventos**: `SALE_APPROVED`, `SALE_REFUNDED`, `SALE_CHARGEBACK`, `SUBSCRIPTION_CANCELED`

## Deploy Railway

Nixpacks auto-detecta. Setar todas as envs do `.env.example`. Health check em `/health`.

## Smoke test do webhook

```bash
curl -X POST http://localhost:3000/api/webhooks/kirvano \
  -H "content-type: application/json" \
  -H "x-kirvano-token: $KIRVANO_WEBHOOK_TOKEN" \
  -d @scripts/fixture-approved.json
```
