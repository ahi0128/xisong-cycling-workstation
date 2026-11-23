-- Run in the Supabase SQL editor before connecting the workstation.
-- One private ledger per Auth user. Each write must supply the revision it read.
begin;

create table public.workstation_ledger (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 1,
  content jsonb not null,
  updated_at timestamptz not null default now(),
  constraint workstation_ledger_shape check (
    jsonb_typeof(content) = 'object'
    and coalesce(jsonb_typeof(content -> 'opening') = 'number', false)
    and coalesce(jsonb_typeof(content -> 'rows') = 'array', false)
  )
);

alter table public.workstation_ledger enable row level security;
revoke all on public.workstation_ledger from public, anon, authenticated;
grant select on public.workstation_ledger to authenticated;

create policy workstation_ledger_read on public.workstation_ledger
  for select to authenticated using (owner_id = (select auth.uid()));

create function public.save_workstation_ledger(expected_revision bigint, ledger_content jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  saved_revision bigint;
begin
  if caller is null then
    raise exception 'Sign-in required' using errcode = '42501';
  end if;

  if expected_revision = 0 then
    insert into public.workstation_ledger (owner_id, content)
      values (caller, ledger_content)
      on conflict (owner_id) do nothing
      returning revision into saved_revision;
  else
    update public.workstation_ledger
      set content = ledger_content, revision = revision + 1, updated_at = now()
      where owner_id = caller and revision = expected_revision
      returning revision into saved_revision;
  end if;

  if saved_revision is null then
    raise exception 'Ledger revision conflict' using errcode = '40001';
  end if;
  return saved_revision;
end;
$$;

revoke all on function public.save_workstation_ledger(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.save_workstation_ledger(bigint, jsonb) to authenticated;

commit;
