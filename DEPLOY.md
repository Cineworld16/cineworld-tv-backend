# Deploy — CineRush TV (backend + admin)

Passo a passo curto pra colocar tudo no ar.

## 1. Supabase (5 min)

1. https://supabase.com → New project (nome livre, ex.: `cinerush-tv`). Escolher senha do Postgres — guardar.
2. Abrir **SQL Editor** → colar o conteúdo de `migrations/001_initial.sql` → **Run**.
3. **Authentication → Users → Add user** → email = o do Mateus (o mesmo que vai em `ADMIN_EMAILS`), senha forte, **email confirmado** (marcar).
4. **Project Settings → API**: anotar `Project URL`, `anon public` key e `service_role` key.

## 2. Gmail App Password (2 min)

1. Ativar 2FA em https://myaccount.google.com/security.
2. https://myaccount.google.com/apppasswords → nome `cinerush-tv`, gerar → copiar os 16 chars.

## 3. Gerar `ENCRYPTION_KEY` (10s)

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Guardar no seu gerenciador de senhas. **Se perder, credenciais Havok criptografadas viram lixo.**

## 4. Gerar `KIRVANO_WEBHOOK_TOKEN` (10s)

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 5. Railway — backend

1. Novo projeto no Railway → **Deploy from GitHub repo** → escolher o repo `cinerush-tv-backend`.
2. Aba **Variables** → colar todas as vars de `.env.example` preenchidas:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`
   - `KIRVANO_WEBHOOK_TOKEN` (o hex do passo 4)
   - `ADMIN_EMAILS` (só o seu, ou CSV)
   - `ENCRYPTION_KEY` (o base64 do passo 3)
   - `SMTP_HOST=smtp.gmail.com` `SMTP_PORT=465` `SMTP_USER` `SMTP_PASS` `SMTP_FROM_NAME` `SMTP_FROM_EMAIL`
   - `CINERUSH_TV_ACCESS_URL`
   - `CORS_ALLOWED_ORIGINS` — coloque o domínio final do admin (ex.: `https://admin.cinerush.tv`) + `http://localhost:8081` pra dev
3. **Settings → Networking → Generate Domain** (ou apontar `api.cinerush.tv` via CNAME).
4. Aguardar deploy → checar `https://<seu-domain>/health` = `{"ok":true}`.

## 6. Railway — admin

1. No mesmo projeto → **+ New → GitHub repo** → escolher `cinerush-tv-admin`.
2. **Variables**:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_API_BASE_URL` = URL do backend do passo 5
   - `PORT` (Railway seta auto)
3. **Settings → Networking → Generate Domain** (ou `admin.cinerush.tv`).
4. Testar login com o email criado no Supabase.

## 7. Kirvano

Painel Kirvano → **Extensões → Webhooks → Adicionar**:

- **URL**: `https://<backend-domain>/api/webhooks/kirvano`
- **Token**: mesmo valor de `KIRVANO_WEBHOOK_TOKEN`
- **Eventos**:
  - ✅ `SALE_APPROVED`
  - ✅ `SALE_REFUNDED` (se existir)
  - ✅ `SALE_CHARGEBACK`
  - ✅ `SUBSCRIPTION_CANCELED` (se existir — só pra planos recorrentes)
  - ❌ ignorar `PIX_GENERATED`, `PIX_EXPIRED`, `BANK_SLIP_*`, `SALE_REFUSED`

Se a Kirvano tiver botão "Enviar teste", disparar. Deve aparecer no dashboard admin em segundos.

## 8. Smoke test em produção

```bash
# Health
curl https://<backend-domain>/health

# Webhook fake (usar o mesmo token)
curl -X POST https://<backend-domain>/api/webhooks/kirvano \
  -H "content-type: application/json" \
  -H "x-kirvano-token: $KIRVANO_WEBHOOK_TOKEN" \
  -d @scripts/fixture-approved.json
```

Depois abrir o admin: o assinante fake deve estar lá com status **Pendente**. Preencher usuário/senha teste, clicar Enviar email pra você mesmo, confirmar que o email chegou com as credenciais.

Se algo der errado, olhar:
- **Logs do backend** no Railway (buscar por `webhook processado`, `email enviado`, `SMTP`).
- **Tabela `webhook_events`** no Supabase — mostra tudo que a Kirvano mandou e o resultado.
