-- Web push subscriptions. One row per browser/device that opted in.
create table if not exists sip.push_subs (
  id          bigint generated always as identity primary key,
  user_id     bigint not null references sip.users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists push_subs_user on sip.push_subs (user_id);
alter table sip.push_subs enable row level security;

create or replace function sip.user_json(u sip.users) returns json
language sql security definer set search_path = sip, pg_temp as $$
  select json_build_object('id', u.id, 'name', u.name, 'cup_ml', u.cup_ml, 'goal_ml', u.goal_ml,
                           'group', g.code, 'telegram_linked', g.telegram_chat_id is not null,
                           'phone_last4', case when u.phone_verified then right(u.phone, 4) end,
                           'phone_pending', u.phone is not null and not u.phone_verified,
                           'sms_enabled', u.sms_enabled,
                           'push_devices', (select count(*) from sip.push_subs where user_id = u.id))
  from sip.groups g where g.id = u.group_id;
$$;

create or replace function public.sip_push_subscribe(p_token text, p_endpoint text, p_p256dh text, p_auth text) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare u sip.users := sip.by_token(p_token);
begin
  if coalesce(p_endpoint, '') !~ '^https://' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'Bad subscription' using errcode = 'P0001';
  end if;
  -- The same browser re-subscribing replaces its old row, and a shared device
  -- moves to whoever signed in last.
  insert into sip.push_subs (user_id, endpoint, p256dh, auth) values (u.id, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh,
                                       auth = excluded.auth, created_at = now();
  return sip.user_json(u);
end $$;

create or replace function public.sip_push_unsubscribe(p_token text, p_endpoint text) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare u sip.users := sip.by_token(p_token);
begin
  if p_endpoint is null then delete from sip.push_subs where user_id = u.id;
  else delete from sip.push_subs where user_id = u.id and endpoint = p_endpoint; end if;
  return sip.user_json(u);
end $$;

-- Drop a subscription the push service says is dead. No token: the endpoint is
-- the secret, and it is only ever called with one the push service rejected.
create or replace function public.sip_push_drop(p_endpoint text) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
begin
  delete from sip.push_subs where endpoint = p_endpoint;
  return json_build_object('dropped', true);
end $$;

-- Devices belonging to the friends this cup just overtook.
create or replace function public.sip_push_passed(p_token text, p_drink_id bigint) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare
  u sip.users := sip.by_token(p_token);
  d sip.drinks; v_after int; v_before int;
begin
  select * into d from sip.drinks where id = p_drink_id and user_id = u.id;
  if not found then return '[]'::json; end if;
  select coalesce(sum(ml), 0) into v_after from sip.drinks where user_id = u.id and day = d.day;
  v_before := v_after - d.ml;

  return coalesce((
    select json_agg(json_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
                                      'name', t.name, 'their_ml', t.ml,
                                      'passer', u.name, 'passer_ml', v_after))
    from (
      select m.id, m.name, r.ml
      from sip.users m
      join lateral (select coalesce(sum(ml), 0)::int as ml from sip.drinks
                    where user_id = m.id and day = d.day) r on true
      where m.group_id = u.group_id and m.id <> u.id
        and r.ml > v_before and r.ml < v_after
    ) t
    join sip.push_subs s on s.user_id = t.id), '[]'::json);
end $$;

do $$
declare fn text;
begin
  for fn in select oid::regprocedure::text from pg_proc
            where pronamespace = 'public'::regnamespace and proname like 'sip\_%' loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to anon, authenticated, service_role', fn);
  end loop;
end $$;

-- The caller's own devices, for the "send me a test" button.
create or replace function public.sip_push_mine(p_token text) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare u sip.users := sip.by_token(p_token);
begin
  return coalesce((select json_agg(json_build_object('endpoint', endpoint, 'p256dh', p256dh, 'auth', auth))
                   from sip.push_subs where user_id = u.id), '[]'::json);
end $$;

revoke all on function public.sip_push_mine(text) from public;
grant execute on function public.sip_push_mine(text) to anon, authenticated, service_role;
