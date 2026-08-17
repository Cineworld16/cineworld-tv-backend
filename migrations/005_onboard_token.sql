-- 005_onboard_token.sql
-- Token público por assinante para o site de configuração (config.cinerush) pré-preencher
-- as credenciais. É um UUID v4 sem hífens (32 chars hex, ~122 bits de entropia) —
-- inadivinhável na prática. Mesmo nível de exposição do email: quem tem o link vê o acesso.
--
-- Rodar no SQL Editor do Supabase.

alter table public.subscribers
  add column if not exists onboard_token text;

-- backfill dos assinantes que já existem
update public.subscribers
  set onboard_token = replace(gen_random_uuid()::text, '-', '')
  where onboard_token is null;

-- novos inserts ganham token automaticamente
alter table public.subscribers
  alter column onboard_token set default replace(gen_random_uuid()::text, '-', '');

alter table public.subscribers
  alter column onboard_token set not null;

create unique index if not exists subscribers_onboard_token_key
  on public.subscribers (onboard_token);
