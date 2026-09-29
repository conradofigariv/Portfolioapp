-- Choosing and changing your address (/<username>).
--
-- 1. profiles.username_confirmed: false until the owner has seen their address
--    and kept or changed it. A new account's address is derived from its
--    Google name ("ana-perez-2"), so the editor asks once. Every account that
--    exists already has an address it may have shared, so they start confirmed.
--
-- 2. username_redirects: an address someone moved away from keeps leading to
--    them for 90 days, then it's free for anyone. Chosen by the product owner
--    over keeping old addresses reserved forever; the UI warns at change time
--    that links shared with the old address stop working after that.
--
-- 3. change_username(new_name): the whole change in one transaction, so two
--    people can't take the same name at once and a half-applied change can't
--    leave someone without an address. Runs as definer because it has to read
--    and clean up redirects that belong to other people; it only ever acts for
--    auth.uid(). Returns a short code the app turns into a message.
--
-- Run by hand in the Supabase SQL editor, like every migration here. The app
-- tolerates it not having run yet: no "choose your address" prompt, no
-- redirects, and changing the address says the migration is missing.

-- Only the first run marks existing accounts confirmed: re-running this file
-- later must not silently confirm accounts created since.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'username_confirmed'
  ) then
    alter table public.profiles add column username_confirmed boolean not null default false;
    update public.profiles set username_confirmed = true;
  end if;
end $$;

create table if not exists public.username_redirects (
  old_username text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists username_redirects_user_idx on public.username_redirects (user_id);

alter table public.username_redirects enable row level security;

-- Which address an old one leads to is public, same as profiles themselves.
-- There are no insert/update/delete policies: only change_username() writes.
drop policy if exists "Username redirects are readable by everyone" on public.username_redirects;
create policy "Username redirects are readable by everyone"
  on public.username_redirects for select
  using (true);

create or replace function public.change_username(new_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  current_name text;
  candidate text := lower(btrim(coalesce(new_name, '')));
begin
  if uid is null then
    return 'not_signed_in';
  end if;

  select username into current_name from public.profiles where id = uid;
  if current_name is null then
    return 'no_profile';
  end if;

  -- Keeping the address you have is just confirming it.
  if candidate = current_name then
    update public.profiles set username_confirmed = true where id = uid;
    return 'ok';
  end if;

  -- Same rules as the profiles table's own checks, tested first so a bad name
  -- never gets as far as touching anything.
  if candidate !~ '^[a-z0-9][a-z0-9-]{2,29}$' then
    return 'invalid';
  end if;
  if public.is_reserved_username(candidate) then
    return 'reserved';
  end if;

  if exists (select 1 from public.profiles where username = candidate) then
    return 'taken';
  end if;
  if exists (
    select 1 from public.username_redirects
    where old_username = candidate and user_id <> uid and expires_at > now()
  ) then
    return 'taken';
  end if;

  -- Free to take: your own old address back, or someone's that expired.
  delete from public.username_redirects where old_username = candidate;

  begin
    update public.profiles
      set username = candidate, username_confirmed = true
      where id = uid;
  exception
    when unique_violation then return 'taken';
    when check_violation then return 'invalid';
  end;

  insert into public.username_redirects (old_username, user_id, expires_at)
  values (current_name, uid, now() + interval '90 days')
  on conflict (old_username) do update
    set user_id = excluded.user_id,
        expires_at = excluded.expires_at,
        created_at = now();

  -- Housekeeping: nothing reads an expired row.
  delete from public.username_redirects where expires_at <= now();

  return 'ok';
end;
$$;

revoke all on function public.change_username(text) from public;
grant execute on function public.change_username(text) to authenticated;
