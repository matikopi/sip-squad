-- Streaks (consecutive days hitting the daily goal) and Telegram group notifications.

alter table sip.groups add column if not exists telegram_chat_id bigint unique;

-- Consecutive goal-hit days ending today or yesterday (today does not have to be done yet).
create or replace function sip.streak(p_user bigint, p_goal int, p_day date) returns int
language sql stable security definer set search_path = sip, pg_temp as $$
  with hit as (
    select day from sip.drinks where user_id = p_user and day <= p_day
    group by day having sum(ml) >= p_goal
  ), anchor as (
    select max(day) as d from hit where day >= p_day - 1
  ), islands as (
    select day, day + (row_number() over (order by day desc))::int as key from hit
  )
  select coalesce((select count(*)::int from islands, anchor where anchor.d is not null and islands.key = anchor.d + 1), 0);
$$;

create or replace function sip.user_json(u sip.users) returns json
language sql security definer set search_path = sip, pg_temp as $$
  select json_build_object('id', u.id, 'name', u.name, 'cup_ml', u.cup_ml, 'goal_ml', u.goal_ml,
                           'group', g.code, 'telegram_linked', g.telegram_chat_id is not null)
  from sip.groups g where g.id = u.group_id;
$$;

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
        select m.id, m.name, m.goal_ml, coalesce(sum(d.ml), 0)::int as ml, count(d.id)::int as cups,
               max(d.created_at) as last_at, sip.streak(m.id, m.goal_ml, v_day) as streak
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

-- Telegram: link a chat to a group with "/link <code>" sent in that chat.
create or replace function public.sip_link_telegram(p_code text, p_chat_id bigint) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare
  v_code text := left(btrim(regexp_replace(lower(coalesce(p_code, '')), '[^a-z0-9]+', '-', 'g'), '-'), 32);
  g sip.groups;
begin
  select * into g from sip.groups where code = v_code;
  if not found then raise exception 'No group called "%". Create it in the app first.', v_code using errcode = 'P0002'; end if;
  update sip.groups set telegram_chat_id = null where telegram_chat_id = p_chat_id and id <> g.id;
  update sip.groups set telegram_chat_id = p_chat_id where id = g.id;
  return json_build_object('code', g.code, 'members', (select count(*) from sip.users where group_id = g.id));
end $$;

create or replace function public.sip_unlink_telegram(p_chat_id bigint) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare v_code text;
begin
  update sip.groups set telegram_chat_id = null where telegram_chat_id = p_chat_id returning code into v_code;
  return json_build_object('code', v_code);
end $$;

-- Everything the API needs to write a notification after a cup is logged.
create or replace function public.sip_notify_context(p_token text, p_drink_id bigint) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare
  u sip.users := sip.by_token(p_token);
  g sip.groups; d sip.drinks;
  v_today int; v_cups int; v_leader_now bigint; v_leader_before bigint; v_leader_name text; v_leader_ml int; v_rivals int;
begin
  select * into g from sip.groups where id = u.group_id;
  if g.telegram_chat_id is null then return null; end if;
  select * into d from sip.drinks where id = p_drink_id and user_id = u.id;
  if not found then return null; end if;

  select coalesce(sum(ml), 0), count(*) into v_today, v_cups from sip.drinks where user_id = u.id and day = d.day;
  select m.id, m.name, t.ml into v_leader_now, v_leader_name, v_leader_ml from sip.users m
    join lateral (select coalesce(sum(ml), 0)::int as ml from sip.drinks where user_id = m.id and day = d.day) t on true
    where m.group_id = g.id order by t.ml desc, m.name limit 1;
  select m.id into v_leader_before from sip.users m
    join lateral (select coalesce(sum(ml), 0)::int as ml from sip.drinks where user_id = m.id and day = d.day and id <> d.id) t on true
    where m.group_id = g.id and t.ml > 0 order by t.ml desc, m.name limit 1;
  select count(*) into v_rivals from sip.users where group_id = g.id and id <> u.id;

  return json_build_object(
    'chat_id', g.telegram_chat_id, 'code', g.code, 'name', u.name, 'ml', d.ml,
    'cups_today', v_cups, 'today_ml', v_today, 'goal_ml', u.goal_ml,
    'streak', sip.streak(u.id, u.goal_ml, d.day),
    'goal_hit_now', v_today >= u.goal_ml and v_today - d.ml < u.goal_ml,
    'took_lead', v_rivals > 0 and v_leader_now = u.id and v_leader_before is not null and v_leader_before <> u.id,
    'leader_name', v_leader_name, 'leader_ml', v_leader_ml);
end $$;

-- "/board" in the Telegram chat.
create or replace function public.sip_board_by_chat(p_chat_id bigint, p_day date) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare g sip.groups; v_day date := coalesce(p_day, current_date);
begin
  select * into g from sip.groups where telegram_chat_id = p_chat_id;
  if not found then return null; end if;
  return json_build_object('code', g.code, 'day', v_day, 'board', coalesce((
    select json_agg(t order by t.ml desc, t.cups desc, t.name) from (
      select m.name, m.goal_ml, coalesce(sum(d.ml), 0)::int as ml, count(d.id)::int as cups,
             sip.streak(m.id, m.goal_ml, v_day) as streak
      from sip.users m left join sip.drinks d on d.user_id = m.id and d.day = v_day
      where m.group_id = g.id group by m.id) t), '[]'::json));
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
