-- Sign in with just a name. Everyone shares one board, so there is no group
-- code to remember or mistype. The group plumbing stays in place in case the
-- board is ever split again.

insert into sip.groups (code) values ('everyone') on conflict (code) do nothing;

-- Move anyone who joined an older, separate group onto the shared board, and
-- carry any Telegram link with them.
do $$
declare v_all bigint; v_chat bigint;
begin
  select id into v_all from sip.groups where code = 'everyone';
  select telegram_chat_id into v_chat from sip.groups
    where telegram_chat_id is not null and id <> v_all limit 1;
  update sip.users set group_id = v_all where group_id <> v_all;
  if v_chat is not null then
    update sip.groups set telegram_chat_id = null where id <> v_all;
    update sip.groups set telegram_chat_id = v_chat where id = v_all;
  end if;
  delete from sip.groups where id <> v_all;
end $$;

-- p_group is now optional: leave it out and you land on the shared board.
create or replace function public.sip_join(p_name text, p_group text default null) returns json
language plpgsql security definer set search_path = sip, pg_temp as $$
declare
  v_name text := left(btrim(coalesce(p_name, '')), 24);
  v_code text := left(btrim(regexp_replace(lower(coalesce(p_group, '')), '[^a-z0-9]+', '-', 'g'), '-'), 32);
  g sip.groups; u sip.users;
begin
  if length(v_name) < 1 then raise exception 'Pick a name' using errcode = 'P0001'; end if;
  if length(v_code) < 2 then v_code := 'everyone'; end if;
  insert into sip.groups (code) values (v_code) on conflict (code) do nothing;
  select * into g from sip.groups where code = v_code;
  select * into u from sip.users where group_id = g.id and lower(name) = lower(v_name);
  if not found then
    insert into sip.users (group_id, name, token)
    values (g.id, v_name, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
    returning * into u;
  end if;
  -- Same name = same person. Friends only, no passwords.
  return json_build_object('token', u.token, 'user', sip.user_json(u));
end $$;

revoke all on function public.sip_join(text, text) from public;
grant execute on function public.sip_join(text, text) to anon, authenticated, service_role;
