-- Onboarding interativo no WhatsApp: estado persistente por assinante.
-- Rode no SQL Editor do Supabase.

create table if not exists public.onboarding_state (
  id uuid primary key default gen_random_uuid(),

  -- telefone E.164 (sem +, formato do WhatsApp: ex 5511999998888) — chave natural
  wa_id text not null unique,
  subscriber_id uuid references public.subscribers(id) on delete set null,

  -- dispositivo escolhido (null até escolher)
  device text check (device in (
    'samsung_lg','androidtv_firestick','tvbox','android','ios','web'
  )),

  current_step int not null default 0,

  status text not null default 'started' check (status in (
    'started','choosing_device','in_progress','completed','handoff'
  )),

  -- último button_reply.id processado (dedup de clique idêntico repetido)
  last_button_id text,

  last_interaction_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_onboarding_status on public.onboarding_state(status);
create index if not exists idx_onboarding_last_interaction
  on public.onboarding_state(last_interaction_at)
  where status not in ('completed','handoff');

-- trigger updated_at (reusa a função criada na migration 001)
drop trigger if exists trg_onboarding_updated_at on public.onboarding_state;
create trigger trg_onboarding_updated_at
before update on public.onboarding_state
for each row execute function public.set_updated_at();

alter table public.onboarding_state enable row level security;
-- sem policy p/ anon/authenticated -> só service_role (backend) acessa
