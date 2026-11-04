-- Run in your project's Supabase SQL Editor as the project owner.
-- Also disable Email confirmations in Authentication > Providers > Email.
begin;

create schema if not exists dansk_private;
revoke all on schema dansk_private from public, anon, authenticated;

create table if not exists dansk_private.usernames (
    username text primary key check (username ~ '^[a-z0-9_]{3,24}$'),
    user_id uuid not null unique references auth.users(id) on delete cascade
);
alter table dansk_private.usernames enable row level security;
revoke all on table dansk_private.usernames from public, anon, authenticated;

create or replace function dansk_private.register_username()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    account_name text;
begin
    if tg_op = 'UPDATE' then
        if lower(new.email) is distinct from lower(old.email)
           and exists (select 1 from dansk_private.usernames where user_id = old.id) then
            raise exception 'Username account identities cannot be renamed'
                using errcode = '23514';
        end if;
    end if;

    if lower(new.email) like '%@usernames.danskreader.invalid' then
        account_name := split_part(lower(new.email), '@', 1);
        if account_name !~ '^[a-z0-9_]{3,24}$'
           or lower(new.email) <> account_name || '@usernames.danskreader.invalid' then
            raise exception 'Invalid username' using errcode = '23514';
        end if;
        -- The primary key rejects competing registrations in this transaction.
        -- Metadata is never consulted when reserving an account name.
        insert into dansk_private.usernames (username, user_id)
        values (account_name, new.id)
        on conflict (user_id) do nothing;
    end if;
    return new;
end;
$$;
revoke all on function dansk_private.register_username() from public, anon, authenticated;

-- This trigger also prevents an authenticated user's email-change API from
-- releasing a reserved username or moving its account to another identity.
drop trigger if exists dansk_register_username on auth.users;
create trigger dansk_register_username
    after insert or update of email on auth.users
    for each row execute function dansk_private.register_username();

-- Backfill only matching internal identities, leaving existing email users alone.
insert into dansk_private.usernames (username, user_id)
select split_part(lower(email), '@', 1), id
from auth.users
where lower(email) ~ '^[a-z0-9_]{3,24}@usernames[.]danskreader[.]invalid$'
on conflict (user_id) do nothing;

create or replace function public.username_available(candidate text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select case
        when lower(btrim(candidate)) ~ '^[a-z0-9_]{3,24}$'
        then not exists (
            select 1 from dansk_private.usernames
            where username = lower(btrim(candidate))
        )
        else false
    end;
$$;
revoke all on function public.username_available(text) from public, anon, authenticated;
grant execute on function public.username_available(text) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
