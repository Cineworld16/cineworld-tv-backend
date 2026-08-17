-- 009_recover_affiliate_csv.sql
-- Vendas antigas importadas por CSV guardam o afiliado em
-- raw_payload->csv_row->>'Afiliado (E-mail)'. Recupera pra coluna afiliado_email.

update public.subscribers
set afiliado_email = lower(trim(raw_payload->'csv_row'->>'Afiliado (E-mail)'))
where nullif(trim(afiliado_email), '') is null
  and nullif(trim(raw_payload->'csv_row'->>'Afiliado (E-mail)'), '') is not null;
