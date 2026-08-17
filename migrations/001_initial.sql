-- CineRush TV — schema inicial
-- Rode este arquivo no SQL Editor do Supabase (uma vez por projeto).
-- Idempotente onde possível: pode ser reaplicado sem quebrar.

create extension if not exists "pgcrypto";

-- ============================================================================
-- subscribers
-- ============================================================================
create table if not exists public.subscribers (
  id uuid primary key default gen_random_uuid(),

  -- dados do comprador (kirvano.customer)
  nome text not null,
  email text not null,
  telefone text,

  -- produto / plano
  plano text not null,
  order_bumps jsonb not null default '[]'::jsonb,
  offer_id text,
  product_id text,

  -- transação
  transacao_kirvano_id text not null unique,
  sale_type text check (sale_type in ('ONE_TIME','RECURRING')),
  payment_method text,
  plan_recurrence text,
  next_charge_date timestamptz,
  valor_total numeric(10,2),
  valor_total_raw text,
  data_compra timestamptz not null,

  -- rastreio
  utm jsonb,
  raw_payload jsonb not null,

  -- fluxo
  status text not null default 'pendente'
    check (status in ('pendente','credenciais_preenchidas','email_enviado','cancelado','reembolsado')),

  -- credenciais Havok (AES-256-GCM at-rest — base64)
  usuario text,
  senha_ciphertext text,
  senha_iv text,
  senha_tag text,

  -- envio de email
  data_envio_email timestamptz,
  email_send_attempts int not null default 0,
  email_error_last text,

  -- estados excepcionais
  refunded_at timestamptz,
  canceled_at timestamptz,
  access_revoked_at timestamptz,

  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_subscribers_status on public.subscribers(status);
create index if not exists idx_subscribers_data_compra on public.subscribers(data_compra desc);
create index if not exists idx_subscribers_email on public.subscribers(lower(email));

-- ============================================================================
-- webhook_events (auditoria)
-- ============================================================================
create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  event_type text,
  sale_id text,
  raw_payload jsonb not null,
  processing_status text not null check (processing_status in ('processed','ignored','error')),
  error_message text,
  subscriber_id uuid references public.subscribers(id) on delete set null
);

create index if not exists idx_webhook_events_sale_id on public.webhook_events(sale_id);
create index if not exists idx_webhook_events_received_at on public.webhook_events(received_at desc);

-- ============================================================================
-- trigger updated_at
-- ============================================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_subscribers_updated_at on public.subscribers;
create trigger trg_subscribers_updated_at
before update on public.subscribers
for each row execute function public.set_updated_at();

-- ============================================================================
-- RLS — bloqueada, apenas service_role acessa
-- ============================================================================
alter table public.subscribers enable row level security;
alter table public.webhook_events enable row level security;

-- sem policy para anon/authenticated → toda leitura/escrita passa pelo backend
