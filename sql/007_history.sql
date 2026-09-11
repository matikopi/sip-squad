-- A month range on the board, per-day history, and editing earlier days.

create or replace function public.sip_board(p_token text, p_range text, p_day date) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare
  u sip.users := sip.by_token(p_token);
  v_day date := coalesce(p_day, current_date);
  v_since date := case p_range
                    when 'week'  then date_trunc('week', v_day)::date
                    when 'month' then date_trunc('month', v_day)::date
                    when 'all'   then date '1970-01-01'
                    else v_day end;
begin
  return json_build_object(
    'day', v_day, 'range', coalesce(p_range, 'today'), 'since', v_since,
    'board', coalesce((
      select json_agg(t order by t.ml desc, t.cups desc, t.name) from (
        select m.id, m.name, m.goal_ml, coalesce(sum(d.ml), 0)::int as ml, count(d.id)::int as cups,
               max(d.created_at) as last_at, sip.streak(m.id, m.goal_ml, v_day) as streak
        from sip.users m left join sip.drinks d on d.user_id = m.id and d.day >= v_since and d.day <= v_day
        where m.group_id = u.group_id group by m.id) t), '[]'::json),
    'feed', coalesce((
      select json_agg(sip.drink_json(d) order by d.created_at desc) from (
        select d.* from sip.drinks d join sip.users m on m.id = d.user_id
        where m.group_id = u.group_id and d.day >= v_since and d.day <= v_day
        order by d.created_at desc limit 100) d), '[]'::json),
    -- Your own totals per day, newest first, for the history list.
    'my_days', coalesce((
      select json_agg(t order by t.day desc) from (
        select day, sum(ml)::int as ml, count(*)::int as cups from sip.drinks
        where user_id = u.id group by day order by day desc limit 400) t), '[]'::json)
  );
end $$;

-- Your cups on one day, so a past day can be reviewed and corrected.
create or replace function public.sip_my_day(p_token text, p_day date) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare u sip.users := sip.by_token(p_token); v_day date := coalesce(p_day, current_date);
begin
  return json_build_object('day', v_day, 'goal_ml', u.goal_ml,
    'cups', coalesce((
      select json_agg(json_build_object('id', id, 'ml', ml, 'source', source, 'label', label,
                                        'photo_id', photo_id, 'created_at', created_at)
                      order by created_at)
      from sip.drinks where user_id = u.id and day = v_day), '[]'::json));
end $$;

-- Logging is allowed for today and earlier, never the future. The extra day of
-- slack covers phones whose local date is ahead of the server's.
create or replace function public.sip_add_drink(p_token text, p_day date, p_ml int, p_source text,
                                                p_label text, p_media_type text, p_photo_b64 text) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare
  u sip.users := sip.by_token(p_token);
  v_bytes bytea; v_photo uuid; d sip.drinks; v_ml int; v_source text;
  v_day date := coalesce(p_day, current_date);
begin
  if v_day > current_date + 1 then raise exception 'That day has not happened yet' using errcode = 'P0001'; end if;
  if v_day < current_date - 365 then raise exception 'That day is too far back' using errcode = 'P0001'; end if;

  if coalesce(p_photo_b64, '') <> '' then
    if p_media_type not in ('image/jpeg', 'image/png', 'image/webp') then
      raise exception 'That is not a photo we can read' using errcode = 'P0001';
    end if;
    v_bytes := decode(p_photo_b64, 'base64');
    if octet_length(v_bytes) < 500 then raise exception 'Photo looks empty' using errcode = 'P0001'; end if;
    if octet_length(v_bytes) > 2000000 then raise exception 'Photo too large' using errcode = 'P0001'; end if;
    insert into sip.photos (media_type, data) values (p_media_type, v_bytes) returning id into v_photo;
  end if;

  if p_ml is null then v_ml := u.cup_ml; v_source := 'default';
  else v_ml := least(3000, greatest(30, p_ml)); v_source := coalesce(p_source, 'manual'); end if;

  insert into sip.drinks (user_id, photo_id, ml, source, label, day)
  values (u.id, v_photo, v_ml, v_source, left(p_label, 60), v_day)
  returning * into d;
  return sip.drink_json(d);
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
