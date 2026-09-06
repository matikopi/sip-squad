-- Sip Squad schema. Tables live in the `sip` schema (not exposed to the API).
-- The API only ever calls the public.sip_* functions below, which run as the
-- table owner and validate the caller's token themselves.
-- Remove everything with:  drop schema sip cascade; drop function public.sip_* ...

create schema if not exists sip;

create table if not exists sip.groups (
  id          bigint generated always as identity primary key,
  code        text not null unique,
  created_at  timestamptz not null default now()
);

create table if not exists sip.users (
  id          bigint generated always as identity primary key,
  group_id    bigint not null references sip.groups(id),
  name        text not null,
  token       text not null unique,
  cup_ml      int  not null default 350,
  goal_ml     int  not null default 2000,
  created_at  timestamptz not null default now()
);
create unique index if not exists users_group_name on sip.users (group_id, lower(name));

create table if not exists sip.photos (
  id          uuid primary key default gen_random_uuid(),
  media_type  text not null,
  data        bytea not null,
  created_at  timestamptz not null default now()
);

create table if not exists sip.drinks (
  id          bigint generated always as identity primary key,
  user_id     bigint not null references sip.users(id) on delete cascade,
  photo_id    uuid not null references sip.photos(id),
  ml          int  not null,
  source      text not null,          -- 'ai' | 'default' | 'manual'
  label       text,                   -- what the AI thought the cup was
  day         date not null,          -- the drinker's local calendar day
  created_at  timestamptz not null default now()
);
create index if not exists drinks_user_day on sip.drinks (user_id, day);
create index if not exists drinks_day on sip.drinks (day);

alter table sip.groups enable row level security;
alter table sip.users  enable row level security;
alter table sip.photos enable row level security;
alter table sip.drinks enable row level security;
revoke all on schema sip from public;

-- ------------------------------------------------------------------ helpers
create or replace function sip.by_token(p_token text) returns sip.users
language plpgsql security definer set search_path = sip, pg_temp as $$
declare u sip.users;
begin
  select * into u from sip.users where token = p_token;
  if not found then raise exception 'Sign in first' using errcode = '28000'; end if;
  return u;
end $$;

create or replace function sip.user_json(u sip.users) returns json
language sql security definer set search_path = sip, pg_temp as $$
  select json_build_object('id', u.id, 'name', u.name, 'cup_ml', u.cup_ml, 'goal_ml', u.goal_ml,
                           'group', (select code from sip.groups where id = u.group_id));
$$;

create or replace function sip.drink_json(d sip.drinks) returns json
language sql security definer set search_path = sip, pg_temp as $$
  select json_build_object('id', d.id, 'ml', d.ml, 'source', d.source, 'label', d.label,
                           'photo_id', d.photo_id, 'day', d.day, 'created_at', d.created_at,
                           'user_id', d.user_id, 'name', (select name from sip.users where id = d.user_id));
$$;

-- ------------------------------------------------------------------ api
create or replace function public.sip_join(p_name text, p_group text) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare
  v_name text := left(btrim(coalesce(p_name, '')), 24);
  v_code text := left(btrim(regexp_replace(lower(coalesce(p_group, '')), '[^a-z0-9]+', '-', 'g'), '-'), 32);
  g sip.groups; u sip.users;
begin
  if length(v_name) < 1 then raise exception 'Pick a name' using errcode = 'P0001'; end if;
  if length(v_code) < 2 then raise exception 'Pick a group code (2+ characters)' using errcode = 'P0001'; end if;
  insert into sip.groups (code) values (v_code) on conflict (code) do nothing;
  select * into g from sip.groups where code = v_code;
  select * into u from sip.users where group_id = g.id and lower(name) = lower(v_name);
  if not found then
    insert into sip.users (group_id, name, token)
    values (g.id, v_name, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
    returning * into u;
  end if;
  -- Same name in the same group = same person. Friends only, no passwords.
  return json_build_object('token', u.token, 'user', sip.user_json(u));
end $$;

create or replace function public.sip_me(p_token text) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
begin
  return sip.user_json(sip.by_token(p_token));
end $$;

create or replace function public.sip_update_me(p_token text, p_cup_ml int, p_goal_ml int) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare u sip.users := sip.by_token(p_token);
begin
  update sip.users set
    -- note: greatest()/least() ignore nulls, so guard explicitly
    cup_ml  = case when p_cup_ml  is null then cup_ml  else least(3000,  greatest(30,  p_cup_ml))  end,
    goal_ml = case when p_goal_ml is null then goal_ml else least(10000, greatest(250, p_goal_ml)) end
  where id = u.id returning * into u;
  return sip.user_json(u);
end $$;

create or replace function public.sip_add_drink(p_token text, p_day date, p_ml int, p_source text,
                                                p_label text, p_media_type text, p_photo_b64 text) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare
  u sip.users := sip.by_token(p_token);
  v_bytes bytea; v_photo uuid; d sip.drinks; v_ml int; v_source text;
begin
  if p_media_type not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'A photo of the empty cup is required' using errcode = 'P0001';
  end if;
  v_bytes := decode(p_photo_b64, 'base64');
  if octet_length(v_bytes) < 500 then raise exception 'Photo looks empty' using errcode = 'P0001'; end if;
  if octet_length(v_bytes) > 2000000 then raise exception 'Photo too large' using errcode = 'P0001'; end if;
  if p_ml is null then v_ml := u.cup_ml; v_source := 'default';
  else v_ml := least(3000, greatest(30, p_ml)); v_source := coalesce(p_source, 'manual'); end if;

  insert into sip.photos (media_type, data) values (p_media_type, v_bytes) returning id into v_photo;
  insert into sip.drinks (user_id, photo_id, ml, source, label, day)
  values (u.id, v_photo, v_ml, v_source, left(p_label, 60), coalesce(p_day, current_date))
  returning * into d;
  return sip.drink_json(d);
end $$;

create or replace function public.sip_update_drink(p_token text, p_id bigint, p_ml int) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare u sip.users := sip.by_token(p_token); d sip.drinks;
begin
  if p_ml is null then raise exception 'Pick a size' using errcode = 'P0001'; end if;
  update sip.drinks set ml = least(3000, greatest(30, p_ml)), source = 'manual'
  where id = p_id and user_id = u.id returning * into d;
  if not found then raise exception 'Not your cup' using errcode = 'P0002'; end if;
  return sip.drink_json(d);
end $$;

create or replace function public.sip_delete_drink(p_token text, p_id bigint) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare u sip.users := sip.by_token(p_token); d sip.drinks;
begin
  delete from sip.drinks where id = p_id and user_id = u.id returning * into d;
  if not found then raise exception 'Not your cup' using errcode = 'P0002'; end if;
  delete from sip.photos where id = d.photo_id;
  return json_build_object('ok', true);
end $$;

create or replace function public.sip_board(p_token text, p_range text, p_day date) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare
  u sip.users := sip.by_token(p_token);
  v_day date := coalesce(p_day, current_date);
  v_since date := case p_range when 'week' then date_trunc('week', v_day)::date
                               when 'all'  then date '1970-01-01'
                               else v_day end;
begin
  return json_build_object(
    'day', v_day, 'range', coalesce(p_range, 'today'),
    'board', coalesce((
      select json_agg(t order by t.ml desc, t.cups desc, t.name) from (
        select m.id, m.name, m.goal_ml, coalesce(sum(d.ml), 0)::int as ml, count(d.id)::int as cups, max(d.created_at) as last_at
        from sip.users m left join sip.drinks d on d.user_id = m.id and d.day >= v_since
        where m.group_id = u.group_id group by m.id) t), '[]'::json),
    'feed', coalesce((
      select json_agg(sip.drink_json(d) order by d.created_at desc) from (
        select d.* from sip.drinks d join sip.users m on m.id = d.user_id
        where m.group_id = u.group_id and d.day >= v_since
        order by d.created_at desc limit 100) d), '[]'::json),
    'my_days', coalesce((
      select json_agg(t order by t.day desc) from (
        select day, sum(ml)::int as ml from sip.drinks where user_id = u.id
        group by day order by day desc limit 60) t), '[]'::json)
  );
end $$;

create or replace function public.sip_photo(p_id uuid) returns json
language sql security definer set search_path = sip, pg_temp as $$
  select json_build_object('media_type', media_type, 'data', encode(data, 'base64'))
  from sip.photos where id = p_id;
$$;

-- Only the API role may call these; the helpers in `sip` are not reachable at all.
do $$
declare fn text;
begin
  for fn in select oid::regprocedure::text from pg_proc
            where pronamespace = 'public'::regnamespace and proname like 'sip\_%' loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to anon, authenticated, service_role', fn);
  end loop;
end $$;
