-- 010: ativação de TV via XCloud (device key)
--
-- Guarda a chave do aparelho que o cliente ativou pelo site de configuração.
-- Existe principalmente por SEGURANÇA DE CRÉDITO: a conta XCloud é compartilhada
-- com um colega, e cada ativação gasta crédito dele. Sem isso, um cliente que
-- atualizasse a página ativaria de novo e queimaria crédito à toa.

alter table public.subscribers
  add column if not exists xcloud_device_key text,
  add column if not exists xcloud_activated_at timestamptz;

-- A mesma chave não pode ser ativada por dois assinantes diferentes.
create unique index if not exists subscribers_xcloud_device_key_uidx
  on public.subscribers (xcloud_device_key)
  where xcloud_device_key is not null;

comment on column public.subscribers.xcloud_device_key is
  'Device key do app XCloud na TV do cliente. Preenchido pelo site de config. Null = nunca ativou.';
comment on column public.subscribers.xcloud_activated_at is
  'Quando a ativação no painel XCloud foi concluída com sucesso.';
