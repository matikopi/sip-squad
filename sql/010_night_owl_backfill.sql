-- A one-off: move cups already logged between midnight and 4am onto the night
-- before, so history reads the same way the app now counts.
--
-- Every cup carries the local calendar date the app sent, so the group's UTC
-- offset falls out of the data: +3 is the only offset that explains the stored
-- dates (89 of 93 rows at the time of writing; the rest were cups added to an
-- earlier day on purpose, which can never match). The rows moved are only the
-- ones logged live, where the stored day equals the date it was logged on, so
-- a deliberately backdated cup is left alone. The classification holds for any
-- offset from +3 to +6, so it does not hinge on the exact one.
--
-- Idempotent: once a row moves, its day no longer equals its logging date, so
-- a second run matches nothing.

do $$
declare v_offset interval := interval '3 hours'; v_moved int;
begin
  with live as (
    select id, (created_at at time zone 'UTC') + v_offset as local_at, day from sip.drinks
  )
  update sip.drinks d set day = d.day - 1
  from live l
  where l.id = d.id
    and l.local_at::date = l.day          -- logged live, not backdated by hand
    and extract(hour from l.local_at) < 4;
  get diagnostics v_moved = row_count;
  raise notice 'moved % cups onto the night before', v_moved;
end $$;
