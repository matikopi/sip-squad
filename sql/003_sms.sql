-- SMS notifications (Twilio). Per person, opt-in, verified phone only.
-- The only text sent is "someone passed you on today's board", so a busy day
-- costs a handful of messages rather than one per cup.

alter table sip.users add column if not exists phone           text,
                      add column if not exists phone_verified  boolean not null default false,
                      add column if not exists sms_enabled     boolean not null default true,
                      add column if not exists verify_code     text,
                      add column if not exists verify_expires  timestamptz,
                      add column if not exists verify_sent_at  timestamptz,
                      add column if not exists verify_count    int not null default 0,
                      add column if not exists verify_tries    int not null default 0;

create unique index if not exists users_phone on sip.users (phone) where phone_verified;

create or replace function sip.user_json(u sip.users) returns json
language sql security definer set search_path = sip, pg_temp as $$
  select json_build_object('id', u.id, 'name', u.name, 'cup_ml', u.cup_ml, 'goal_ml', u.goal_ml,
                           'group', g.code, 'telegram_linked', g.telegram_chat_id is not null,
                           -- never expose the whole number back to the browser
                           'phone_last4', case when u.phone_verified then right(u.phone, 4) end,
                           'phone_pending', u.phone is not null and not u.phone_verified,
                           'sms_enabled', u.sms_enabled)
  from sip.groups g where g.id = u.group_id;
$$;

-- Step 1 of adding a phone: store an E.164 number plus a code for the API to text.
create or replace function public.sip_start_phone_verify(p_token text, p_phone text) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare
  u sip.users := sip.by_token(p_token);
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  v_code text;
begin
  if v_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Use the full international format, e.g. +14155551234' using errcode = 'P0001';
  end if;
  if exists (select 1 from sip.users where phone = v_phone and phone_verified and id <> u.id) then
    raise exception 'That number is already used by someone else' using errcode = 'P0001';
  end if;
  -- Texting costs money and lands on someone's phone: throttle hard.
  if u.verify_sent_at is not null and u.verify_sent_at > now() - interval '60 seconds' then
    raise exception 'Wait a minute before asking for another code' using errcode = 'P0001';
  end if;
  if u.verify_count >= 5 and u.verify_sent_at > now() - interval '1 hour' then
    raise exception 'Too many codes requested. Try again in an hour.' using errcode = 'P0001';
  end if;

  v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
  update sip.users set
    phone = v_phone, phone_verified = false, verify_code = v_code,
    verify_expires = now() + interval '10 minutes', verify_sent_at = now(),
    verify_count = case when verify_sent_at > now() - interval '1 hour' then verify_count + 1 else 1 end,
    verify_tries = 0
  where id = u.id;
  return json_build_object('phone', v_phone, 'code', v_code, 'name', u.name);
end $$;

create or replace function public.sip_confirm_phone(p_token text, p_code text) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare u sip.users := sip.by_token(p_token);
begin
  if u.phone is null or u.verify_code is null then raise exception 'Add a number first' using errcode = 'P0001'; end if;
  if u.verify_expires < now() then raise exception 'That code expired. Send a new one.' using errcode = 'P0001'; end if;
  if u.verify_tries >= 5 then raise exception 'Too many wrong codes. Send a new one.' using errcode = 'P0001'; end if;
  if regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g') <> u.verify_code then
    update sip.users set verify_tries = verify_tries + 1 where id = u.id;
    raise exception 'Wrong code' using errcode = 'P0001';
  end if;
  update sip.users set phone_verified = true, verify_code = null, verify_expires = null, verify_tries = 0
  where id = u.id returning * into u;
  return sip.user_json(u);
end $$;

create or replace function public.sip_remove_phone(p_token text) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare u sip.users := sip.by_token(p_token);
begin
  update sip.users set phone = null, phone_verified = false, verify_code = null,
                       verify_expires = null, verify_tries = 0
  where id = u.id returning * into u;
  return sip.user_json(u);
end $$;

create or replace function public.sip_set_sms(p_token text, p_enabled boolean) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare u sip.users := sip.by_token(p_token);
begin
  update sip.users set sms_enabled = coalesce(p_enabled, sms_enabled) where id = u.id returning * into u;
  return sip.user_json(u);
end $$;

-- Who did this cup overtake on today's board? Only friends who opted in and
-- verified a number, so at most a few texts per day.
create or replace function public.sip_sms_passed(p_token text, p_drink_id bigint) returns json
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
    select json_agg(json_build_object('phone', t.phone, 'name', t.name, 'their_ml', t.ml,
                                      'passer', u.name, 'passer_ml', v_after))
    from (
      select m.name, m.phone, r.ml
      from sip.users m
      join lateral (select coalesce(sum(ml), 0)::int as ml from sip.drinks
                    where user_id = m.id and day = d.day) r on true
      where m.group_id = u.group_id and m.id <> u.id
        and m.phone_verified and m.sms_enabled
        and r.ml > v_before and r.ml < v_after      -- strictly overtaken by this cup
    ) t), '[]'::json);
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
