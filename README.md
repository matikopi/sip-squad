# Sip Squad 💧

Finish a cup of water, snap a photo of the empty cup, and it gets logged with
the time and an approximate amount. Friends who join with the same group code
share a leaderboard (today, this week, all time) and a feed of everyone's cups.

Runs on Vercel, stores data in Supabase, installs to your phone's home screen.

## Use it

1. Open the app URL on your phone.
2. Enter a name and a group code. Share the code with friends.
3. Tap **I finished a cup**, take a photo of the empty cup. Done.

You stay signed in: the session is a long-lived cookie (400 days, the browser
maximum) plus a copy in local storage. Same name + same group code signs you
back in from any device. There are no passwords. This is a toy for friends.

**Add to home screen:** iPhone: Safari share button > *Add to Home Screen*.
Android: Chrome menu > *Install app* (or *Add to Home screen*). It opens
full-screen with its own icon.

## How amounts work

Every log needs a photo. The amount comes from, in order:

1. A size you picked yourself (tap a chip on the card that appears after logging).
2. **AI estimate** if the `ANTHROPIC_API_KEY` environment variable is set on
   Vercel: the photo goes to Claude, which guesses the vessel's capacity
   ("looks like a pint glass, 470 ml"). One tap to override.
3. Your **default cup size** (350 ml unless you change it in settings).

Without an API key the app still works and uses your default cup.

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

WhatsApp and SMS are not built in: WhatsApp needs a Meta Business account
with approved message templates, SMS needs a paid provider such as Twilio.
Both are possible later behind the same notification hook.

## Architecture

```
public/          The app: plain HTML, CSS, JS. No build step. PWA manifest + service worker.
api/index.js     One Vercel function for every /api/* route (see vercel.json rewrites).
lib/db.js        Calls Supabase PostgREST RPC functions with the publishable key.
lib/estimate.js  Optional Claude vision call.
sql/001_init.sql The database: tables in schema `sip`, API functions in `public.sip_*`.
sql/002_...sql   Streaks and Telegram linking.
lib/telegram.js  Telegram bot messages and webhook helpers.
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
npm test           # end-to-end API test using a throwaway group
```

Environment variables (all optional):

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Enables the AI cup size estimate |
| `TELEGRAM_BOT_TOKEN` | Enables Telegram group notifications |
| `SUPABASE_URL` | Override the Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Override the publishable key |

## Database setup

Run `sql/001_init.sql` then `sql/002_streaks_telegram.sql` against a Supabase project (SQL
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
| POST | `/api/join` | `{name, group}` -> `{token, user}` and sets the cookie |
| POST | `/api/logout` | Clears the cookie |
| GET / PATCH | `/api/me` | Read or change `cup_ml`, `goal_ml` |
| POST | `/api/drinks` | `{photo: dataURL, day: YYYY-MM-DD, ml?}` -> `{drink}` |
| PATCH / DELETE | `/api/drinks/:id` | Fix the amount or remove (own cups only) |
| GET | `/api/board?range=today\|week\|all&day=YYYY-MM-DD` | Leaderboard, feed, your daily totals |
| GET | `/api/photo/:id` | A cup photo |
| POST | `/api/telegram` | Telegram webhook (`/link <code>`, `/board`, `/unlink`) |
| GET | `/api/telegram/setup?token=` | One-time webhook registration |

Days are counted in each person's local time (the phone sends its local date),
so a cup at 11:30 pm counts for that person's today. Weeks start Monday.

## Assumptions (change any of them)

- One photo = one full cup. Drank half? Adjust the ml.
- A photo is required. That is the whole game.
- Groups are open: anyone with the code can join.
- Ranking is by ml, not cups.
- Daily goal defaults to 2000 ml, per person. The ring turns green when hit.
- Photos are kept forever and visible to everyone in the group.
- Units are ml.
