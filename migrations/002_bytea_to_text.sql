-- Migração corretiva: bytea → text (base64)
-- Motivo: supabase-js REST serializa Buffer como JSON literal antes de mandar pro Postgres,
-- o que corrompia bytea. Guardando como base64 em text é portátil e sem surpresas.
--
-- Rode UMA VEZ no SQL Editor. As linhas existentes ficam com senha corrompida — descarte.

alter table public.subscribers
  alter column senha_ciphertext type text using null,
  alter column senha_iv type text using null,
  alter column senha_tag type text using null;

-- limpa credenciais corrompidas pra evitar 500 no decrypt
update public.subscribers
set usuario = null,
    senha_ciphertext = null,
    senha_iv = null,
    senha_tag = null,
    status = case
      when status in ('credenciais_preenchidas','email_enviado') then 'pendente'
      else status
    end
where senha_ciphertext is not null;
