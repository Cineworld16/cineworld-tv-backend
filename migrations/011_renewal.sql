-- 011_renewal.sql — renovação automática de assinatura recorrente.
-- A Kirvano reenvia SALE_APPROVED com plan.charge_number > 1 nas renovações.
-- Guardamos o sale_id da renovação processada (idempotência) + histórico.

alter table subscribers
  add column if not exists last_renewal_sale_id text,
  add column if not exists last_renewed_at timestamptz,
  add column if not exists renewal_count int not null default 0;

-- backstop de idempotência: um sale_id de renovação nunca é gravado 2x.
create unique index if not exists subscribers_last_renewal_sale_id_key
  on subscribers (last_renewal_sale_id)
  where last_renewal_sale_id is not null;
