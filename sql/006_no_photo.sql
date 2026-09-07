-- A cup is one tap. The photo is optional now, so logging is instant and a
-- cup counts as your usual cup size unless you say otherwise.
-- Also: notify the whole group on every cup, not only on overtakes.

alter table sip.drinks alter column photo_id drop not null;

create or replace function public.sip_add_drink(p_token text, p_day date, p_ml int, p_source text,
                                                p_label text, p_media_type text, p_photo_b64 text) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare
  u sip.users := sip.by_token(p_token);
  v_bytes bytea; v_photo uuid; d sip.drinks; v_ml int; v_source text;
begin
  -- A photo is welcome but no longer required.
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
  values (u.id, v_photo, v_ml, v_source, left(p_label, 60), coalesce(p_day, current_date))
  returning * into d;
  return sip.drink_json(d);
end $$;

-- Only remove the photo when there is one.
create or replace function public.sip_delete_drink(p_token text, p_id bigint) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare u sip.users := sip.by_token(p_token); d sip.drinks;
begin
  delete from sip.drinks where id = p_id and user_id = u.id returning * into d;
  if not found then raise exception 'Not your cup' using errcode = 'P0002'; end if;
  if d.photo_id is not null then delete from sip.photos where id = d.photo_id; end if;
  return json_build_object('ok', true);
end $$;

-- Everyone else in the group who turned notifications on, plus what to say.
create or replace function public.sip_push_everyone(p_token text, p_drink_id bigint) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare
  u sip.users := sip.by_token(p_token);
  d sip.drinks; v_today int; v_leader text; v_leader_ml int;
begin
  select * into d from sip.drinks where id = p_drink_id and user_id = u.id;
  if not found then return '[]'::json; end if;
  select coalesce(sum(ml), 0) into v_today from sip.drinks where user_id = u.id and day = d.day;
  select m.name, t.ml into v_leader, v_leader_ml from sip.users m
    join lateral (select coalesce(sum(ml), 0)::int as ml from sip.drinks
                  where user_id = m.id and day = d.day) t on true
    where m.group_id = u.group_id order by t.ml desc, m.name limit 1;

  return coalesce((
    select json_agg(json_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
                                      'name', u.name, 'ml', d.ml, 'today_ml', v_today,
                                      'goal_ml', u.goal_ml, 'leader', v_leader, 'leader_ml', v_leader_ml))
    from sip.push_subs s
    join sip.users m on m.id = s.user_id
    where m.group_id = u.group_id and m.id <> u.id), '[]'::json);
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
