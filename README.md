# Sip Squad 💧

Finish a cup of water, snap a photo of the empty cup, and it gets logged with
the time and an approximate amount. Friends who join with the same group code
share a leaderboard (today, this week, all time) and a feed of everyone's cups.

Runs on Vercel, stores data in Supabase, installs to your phone's home screen.

## Use it

1. Open the app URL on your phone.
2. Type your name. That is the whole sign-in.
3. Tap **I finished a cup**. Done, one tap.

A cup counts as your usual cup size, 350 ml unless you change it in settings.
Tap a different size on the card that appears if a particular cup was bigger
or smaller. Adding a photo is optional, through the small link under the
button, and photo-less cups show as a plain tile in the feed.

Everyone shares one board, so there is no group code. Typing the same name
again gets you the same account, from any device.

**Staying signed in.** The session is an HttpOnly cookie that lasts 400 days,
the browser maximum, and every request slides it forward, so an app in regular
use never expires. A copy of the token also sits in local storage as a
fallback. The cookie is what does the work: Safari deletes script-written
storage after seven days of not using a site, but a server-set HttpOnly cookie
survives that, and the app asks the server who you are on every start rather
than trusting local storage. Signing out takes clearing cookies, or tapping
Leave group.

One consequence of name-only sign-in: two people who pick the same name share
an account. Fine for a group of friends with distinct names, and the reason
there is nothing sensitive in here.

**Add to home screen:** iPhone: Safari share button > *Add to Home Screen*.
Android: Chrome menu > *Install app* (or *Add to Home screen*). It opens
full-screen with its own icon.

## How amounts work

The amount comes from, in order:

1. A size you picked yourself (tap a chip on the card that appears after logging).
2. **AI estimate**, only when you attached a photo and `ANTHROPIC_API_KEY` is
   set on Vercel: the photo goes to Claude, which guesses the vessel's
   capacity ("looks like a pint glass, 470 ml"). One tap to override.
3. Your **usual cup size**, which is what a plain tap counts as (350 ml by
   default).

## Streaks

A streak 🔥 is the number of days in a row you hit your daily goal. It shows
next to your name on the leaderboard and under your ring. Today does not
break it until midnight, so a streak of 3 stays 3 while you are still drinking.

## Telegram notifications

Optional. When linked, the bot posts to your Telegram group every time someone
finishes a cup, calls out when someone hits their goal or takes the lead, and
answers `/board` with the current leaderboard.

Setup, once, about five minutes:

1. In Telegram, message **@BotFather**, send `/newbot`, pick a name. Copy the token.
2. In Vercel: Project Settings > Environment Variables, add `TELEGRAM_BOT_TOKEN`
   with that token, then redeploy (Deployments > ... > Redeploy).
3. Open `https://<your app>/api/telegram/setup?token=<the token>` once in a
   browser. It registers the webhook and tells you the bot's username.
4. Add the bot to your friends' Telegram group and send `/link <group code>`
   in that chat. Done. `/unlink` removes it, `/board` shows the leaderboard.

## Push notifications

Free, no third party, and the recommended option. Every time anyone in the
group logs a cup, a notification lands on your phone with who drank, how much,
and their total for the day. Turn it on per device under Settings, and use
"Send a test" to check it works.

Payloads are encrypted (RFC 8291, aes128gcm) and requests are signed with a
VAPID JWT (RFC 8292), using only `node:crypto`. There is no dependency and
nothing to sign up for.

Setup, once:

1. Run `node scripts/vapid.js`. It prints a key pair.
2. On Vercel, add `VAPID_PRIVATE_KEY` from that output, and optionally
   `VAPID_SUBJECT` (a `mailto:` address push services can use to contact you).
   Redeploy.
3. Open the app, go to Settings, and tap Turn on.

Only the private key is needed. The public key is derived from it at runtime,
because a VAPID key is 87 characters of base64url and one character lost while
copying silently breaks every notification. If `VAPID_PUBLIC_KEY` is also set
and disagrees with the private key, the derived value wins and a warning is
logged. Keep the private key out of the repository. Changing it invalidates
every existing subscription, so everyone re-enables notifications.

**On an iPhone the app must be on your home screen first.** Safari only
delivers web push to installed apps. Add to Home Screen, open it from there,
then turn notifications on.

## Text messages (Twilio)

Optional and per person. In Settings you add your number, get a 6-digit code
by text, and confirm it. After that you get one text when a friend overtakes
you on today's board, with a link to the app so you can catch up. Turn it off
with the toggle or remove the number entirely.

Only one kind of text is sent, so a busy day costs a handful of messages
rather than one per cup. Codes are limited to one a minute and five an hour,
expire in ten minutes, and allow five wrong guesses.

To switch it on, set these on Vercel and redeploy:

| Variable | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | starts with `AC`, from the Twilio console |
| `TWILIO_AUTH_TOKEN` | from the Twilio console |
| `TWILIO_FROM` | a number you own, e.g. `+14155551234` |
| `TWILIO_MESSAGING_SERVICE_SID` | alternative to `TWILIO_FROM`, starts with `MG` |
| `APP_URL` | the link put in the text, defaults to the production URL |

Texting US mobile numbers from a Twilio number also requires A2P 10DLC
registration (a Brand and a Campaign) regardless of volume. Unregistered
traffic is filtered by carriers. Web push notifications avoid all of that
and cost nothing; see the notes at the end of this file.

WhatsApp is not built in: it needs a Meta Business account with approved
message templates.

## Architecture

```
public/          The app: plain HTML, CSS, JS. No build step. PWA manifest + service worker.
api/index.js     One Vercel function for every /api/* route (see vercel.json rewrites).
lib/db.js        Calls Supabase PostgREST RPC functions with the publishable key.
lib/estimate.js  Optional Claude vision call.
sql/001_init.sql The database: tables in schema `sip`, API functions in `public.sip_*`.
sql/002_...sql   Streaks and Telegram linking.
sql/003_sms.sql  Phone numbers, verification, who-got-passed lookup.
sql/004_push.sql Push subscriptions per device.
sql/005_...sql   One shared board and name-only sign-in.
sql/006_...sql   Optional photo, and notifying the group on every cup.
lib/telegram.js  Telegram bot messages and webhook helpers.
lib/sms.js       Twilio client and the two text bodies.
lib/push.js      Web push: aes128gcm payload encryption and VAPID signing.
scripts/vapid.js Generates a VAPID key pair.
test-push.js     Push crypto test: encrypt, decrypt, verify the signature.
dev.js           Local dev server (npm run dev).
test.js          End-to-end API test (npm test).
```

**Security model.** The database tables live in a schema that is not exposed
to the API and have row level security with no policies, so nothing can read
or write them directly. The only way in is through the `public.sip_*`
functions, which run as the table owner and check the caller's token
themselves. That is why the server can use the *publishable* Supabase key
and no secret is needed anywhere. Supabase's linter flags these functions as
"security definer callable by anon"; that is the intended design.

Photos are downscaled on the phone (800 px, JPEG) to roughly 60 to 100 KB and
stored as bytes in Postgres, served back through `/api/photo/:id` with
immutable caching. At the free tier's 500 MB that is several thousand cups.
If the group gets serious, move photos to Supabase Storage or Vercel Blob.

## Local development

```bash
npm install
npm run dev        # http://localhost:3000, talks to the real Supabase project
```

Tests need a scratch database, because everyone now shares one board and a run
against the real project would put test names on it:

```bash
SUPABASE_URL=<scratch project> npm test
```

Environment variables (all optional):

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Enables the AI cup size estimate |
| `TELEGRAM_BOT_TOKEN` | Enables Telegram group notifications |
| `TWILIO_ACCOUNT_SID` `TWILIO_AUTH_TOKEN` | Enable text messages |
| `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID` | Which number the texts come from |
| `APP_URL` | Link included in texts and notifications |
| `VAPID_PRIVATE_KEY` | Enables push notifications (the public key is derived) |
| `VAPID_SUBJECT` | Contact address for push services, optional |
| `SUPABASE_URL` | Override the Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Override the publishable key |

## Database setup

Run the files in `sql/` in order against a Supabase project (SQL
editor or `supabase db push`) and point the app at that project. To remove it
completely:

```sql
drop schema sip cascade;
drop function public.sip_join(text, text), public.sip_me(text), public.sip_update_me(text, int, int),
  public.sip_add_drink(text, date, int, text, text, text, text), public.sip_update_drink(text, bigint, int),
  public.sip_delete_drink(text, bigint), public.sip_board(text, text, date), public.sip_photo(uuid);
```

## API

All JSON. Auth is the `sip` cookie set by `/api/join`, or an `x-token` header.

| Method | Path | What |
|---|---|---|
| POST | `/api/join` | `{name}` -> `{token, user}` and sets the session cookie |
| POST | `/api/logout` | Clears the cookie |
| GET / PATCH | `/api/me` | Read or change `cup_ml`, `goal_ml` |
| POST | `/api/drinks` | `{day: YYYY-MM-DD, ml?, photo?}` -> `{drink}` |
| PATCH / DELETE | `/api/drinks/:id` | Fix the amount or remove (own cups only) |
| GET | `/api/board?range=today\|week\|all&day=YYYY-MM-DD` | Leaderboard, feed, your daily totals |
| GET | `/api/photo/:id` | A cup photo |
| POST | `/api/telegram` | Telegram webhook (`/link <code>`, `/board`, `/unlink`) |
| GET | `/api/telegram/setup?token=` | One-time webhook registration |
| POST | `/api/phone` | `{phone}` texts a verification code |
| POST | `/api/phone/confirm` | `{code}` verifies the number |
| POST | `/api/phone/toggle` | `{enabled}` turns texts on or off |
| DELETE | `/api/phone` | Removes the number |
| GET | `/api/push/key` | The public VAPID key for the browser |
| POST | `/api/push/subscribe` | Registers this device |
| POST | `/api/push/unsubscribe` | Removes this device |
| POST | `/api/push/test` | Sends a test notification to your devices |

Days are counted in each person's local time (the phone sends its local date),
so a cup at 11:30 pm counts for that person's today. Weeks start Monday.

## Assumptions (change any of them)

- One tap = one full cup of your usual size. Drank half? Adjust the ml.
- A photo is optional.
- One shared board, and a name is the whole sign-in.
- Ranking is by ml, not cups.
- Daily goal defaults to 2000 ml, per person. The ring turns green when hit.
- Photos are kept forever and visible to everyone in the group.
- Units are ml.

## Notification options, compared

| Channel | Cost | Setup | Notes |
|---|---|---|---|
| Telegram | free | ~5 min | Group chat feed, every cup plus call-outs. Built in. |
| Web push | free | one key in Vercel | Every cup, on the lock screen of the installed app. Recommended. |
| SMS (Twilio) | number ~$1/mo plus ~$0.008 a text | account, a number, and A2P 10DLC registration | Built in, works on any phone with no app. |
| WhatsApp | per message | Meta Business account, approved templates | Not built. |
