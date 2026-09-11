-- Per-day totals for everyone on the board, so the history can be a chart
-- instead of a list. `my_days` stays for clients still running the old code.

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
    -- One row per person per day: the bars of the chart. Newest day first, and
    -- capped so a long history cannot return an unbounded payload.
    'days', coalesce((
      select json_agg(t order by t.day desc, t.ml desc) from (
        select d.day, d.user_id, sum(d.ml)::int as ml, count(*)::int as cups
        from sip.drinks d join sip.users m on m.id = d.user_id
        where m.group_id = u.group_id and d.day >= v_since and d.day <= v_day
        group by d.day, d.user_id
        order by d.day desc limit 2000) t), '[]'::json),
    -- Your own totals per day, kept for older clients.
    'my_days', coalesce((
      select json_agg(t order by t.day desc) from (
        select day, sum(ml)::int as ml, count(*)::int as cups from sip.drinks
        where user_id = u.id group by day order by day desc limit 400) t), '[]'::json)
  );
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
