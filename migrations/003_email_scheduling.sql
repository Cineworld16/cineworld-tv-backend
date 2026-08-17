-- Reagendamento automatico de envio em caso de soft-bounce/timeout.
-- Janela horaria e maximo de tentativas ficam no codigo (env).

alter table public.subscribers
  add column if not exists email_scheduled_at timestamptz,
  add column if not exists email_retry_count int not null default 0;

create index if not exists idx_subscribers_scheduled
  on public.subscribers(email_scheduled_at)
  where email_scheduled_at is not null;
