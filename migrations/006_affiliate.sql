-- 006_affiliate.sql
-- Afiliados: a Kirvano manda `affiliateEmail` + `affiliateCommission` no payload
-- (não estava tipado, mas está no raw_payload). Extraímos pra colunas próprias
-- pra agregar "quanto cada afiliado vendeu" no dashboard.

alter table public.subscribers
  add column if not exists afiliado_email text,
  add column if not exists afiliado_comissao numeric(10,2);

-- Backfill a partir dos payloads já recebidos.
update public.subscribers
set
  afiliado_email = nullif(lower(trim(raw_payload->>'affiliateEmail')), ''),
  afiliado_comissao = case
    when raw_payload->>'affiliateCommission' ~ '^-?[0-9]+(\.[0-9]+)?$'
      then (raw_payload->>'affiliateCommission')::numeric
    else null
  end
where raw_payload is not null;

create index if not exists idx_subscribers_afiliado_email on public.subscribers (afiliado_email);
