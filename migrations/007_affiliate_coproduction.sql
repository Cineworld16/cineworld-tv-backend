-- 007_affiliate_coproduction.sql
-- A comissão relevante é a de COPRODUÇÃO (coproductionCommission), não a
-- affiliateCommission (que vinha 0 nas vendas). Re-backfill do afiliado_comissao.

update public.subscribers
set afiliado_comissao = case
  when raw_payload->>'coproductionCommission' ~ '^-?[0-9]+(\.[0-9]+)?$'
    then (raw_payload->>'coproductionCommission')::numeric
  else null
end
where raw_payload is not null;
