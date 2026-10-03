-- One tap logs your usual cup, so the usual cup is what that tap is worth.
-- 250 ml is the size this group actually drinks; 350 was a guess from before
-- anyone had used the app. Existing people already chose 250 for themselves,
-- so this only changes what a new sign-in starts at.

alter table sip.users alter column cup_ml set default 250;
