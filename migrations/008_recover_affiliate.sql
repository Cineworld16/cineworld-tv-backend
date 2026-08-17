-- 008_recover_affiliate.sql
-- Vendas antigas (formato antigo) perderam o affiliateEmail na coluna afiliado_email,
-- caindo em "direto". Recupera puxando do log de eventos (webhook_events) por sale_id.

update public.subscribers s
set afiliado_email = lower(trim(w.aff))
from (
  select distinct on (sale_id) sale_id, raw_payload->>'affiliateEmail' as aff
  from public.webhook_events
  where nullif(trim(raw_payload->>'affiliateEmail'), '') is not null
  order by sale_id, received_at desc
) w
where s.transacao_kirvano_id = w.sale_id
  and nullif(trim(s.afiliado_email), '') is null;
