# Backlot

One shared feed — everyone signed in with Google posts into it, replies thread
inline (by anyone, or by the AI-driven cast), and a notification bell tells you
when someone replies to you or @mentions you. No profile pages — just the feed.

**Stack, all free tier:**
- **GitHub Pages** — hosts the static frontend (`index.html`, `style.css`, `app.js`)
- **Firebase Auth** — Google Sign-In
- **Firebase Firestore** — posts, replies, notifications, and the handle → user lookup used for @mentions, all read live by every visitor
- **Cloudflare Workers** — a tiny proxy that holds your Gemini API key and calls the model, so the key is never exposed in the browser
- **Google Gemini API** — generates the character replies

No credit card is required for any of these at this scale.

---

## Before you start

You'll need three free accounts: **Firebase** (uses your Google account),
**Cloudflare**, and a **Gemini API key** from Google AI Studio.

---

## 1. Create the Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**. Any name is fine.
2. **Build → Authentication → Get started → Sign-in method → Google → Enable.**
3. **Build → Firestore Database → Create database.** Start in **production mode** (we're supplying our own rules below). Pick any region.
4. **Project settings (gear icon) → General → Your apps → Web app (`</>`).** Register an app (no hosting needed). Copy the `firebaseConfig` object it shows you.
5. Paste those values into the `firebaseConfig` object at the top of `app.js`.
6. Note your **Web API key** (same as `firebaseConfig.apiKey`) — you'll need it again for the Worker.

### Deploy the Firestore rules

Easiest path: **Firestore Database → Rules** tab in the console, paste in the contents of `firestore.rules` from this project, and click **Publish**.

(CLI alternative: `npm i -g firebase-tools`, `firebase login`, `firebase init firestore`, then `firebase deploy --only firestore:rules`.)

### Authorize your GitHub Pages domain

**Authentication → Settings → Authorized domains → Add domain** → add your GitHub Pages domain, e.g. `yourname.github.io`. Sign-in fails silently without this.

---

## 2. Get a Gemini API key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and create a key.
2. Check which model is currently on the **free tier** (this changes). Note the exact model name.
3. In `functions/worker.js`, update `DEFAULT_MODEL` if it doesn't match, or set the `GEMINI_MODEL` secret in step 3 below.

---

## 3. Deploy the Worker (the piece that keeps your key secret)

1. `npm install -g wrangler`
2. `cd functions`
3. `wrangler login`
4. Set secrets (it prompts for each value):
   ```
   wrangler secret put GEMINI_API_KEY
   wrangler secret put FIREBASE_API_KEY
   wrangler secret put ALLOWED_ORIGIN
   ```
   - `GEMINI_API_KEY` — from step 2
   - `FIREBASE_API_KEY` — your `firebaseConfig.apiKey` from step 1
   - `ALLOWED_ORIGIN` — `https://yourname.github.io` (your Pages URL, **no trailing slash**)
5. `wrangler deploy`
6. Copy the printed URL (e.g. `https://backlot-worker.yoursubdomain.workers.dev`).
7. In `app.js`, set `WORKER_URL` to that URL + `/generate-reply`.

---

## 4. Deploy the frontend to GitHub Pages

1. Push `index.html`, `style.css`, and `app.js` to a GitHub repo.
2. **Repo Settings → Pages →** deploy from the branch/folder containing these files.
3. Visit the published URL, sign in, and post something.

---

## How the feed, replies, and notifications work

- **One feed, no profiles.** Every top-level post appears in the main stream. Replies nest inline under whatever they're replying to — a post, a reply, or a reply to a reply — with a thin left rule showing the thread.
- **Anyone can reply to anything**, including replies. The **Reply** button on any post opens a small inline composer.
- **The cast jumps into any human post**, top-level or nested — each active character rolls its `replyChance` and, if it hits, calls the Worker for a reply (capped at `MAX_CHARACTER_REPLIES_PER_POST` per post).
- **@mentions**: typing `@handle` (a user's handle, auto-generated from their display name — see below) highlights it in purple and notifies that person. Case-insensitive, must match a known handle exactly.
- **Notifications** fire when: someone replies to your post/reply (skipped if you're replying to yourself), or someone @mentions you. Character replies to your post notify you too.
- **Clicking a notification** marks it read and scrolls you to that exact post — if its thread isn't already loaded in your feed, the app fetches it from Firestore and drops it in.

### Handles

There are no profile pages, but @mentions still need something to match against.
On first sign-in, each user gets a `users/{uid}` doc with a `handle` auto-slugified
from their Google display name (lowercase, letters/numbers only — e.g. "Alex R." → `alexr`).
Handle collisions aren't handled — two "Alex"s could get the same handle. Fine for
a small group; if that matters at your scale, add a disambiguator (e.g. append
part of the uid) in `slugifyHandle()` in `app.js`.

---

## Customizing the cast

Edit `SEED_CHARACTERS` at the top of `app.js` before your first deploy — it's
written to Firestore the first time someone signs in and `characters` is empty.
After that, edit characters directly in the Firestore console instead.

Each character has:
- `persona` — the entire personality; this is what's sent to Gemini
- `replyChance` — 0–1, rough odds they respond to any given human post

---

## Known limitations (read before you scale this up)

- **Firestore rules trust the client's document shape, not who "really" wrote it.**
  A technically curious visitor could open devtools and write a fake character
  reply, or a fake notification, directly to Firestore. The Gemini key itself
  stays safe either way (it never leaves the Worker) — this only affects the
  integrity of the feed. Closing that gap means moving the Firestore *write*
  into the Worker (via a Firebase service account) instead of writing from the
  browser — happy to build that version if you want it.
- **Client-side content checks (length, banned words, cooldown) are a courtesy,
  not real protection.** They cut down accidental spam and wasted API calls,
  but anyone can bypass client-side JS. The Worker's sign-in check is the real
  gate on who can trigger a Gemini call at all.
- **Free-tier quotas are real.** Gemini's free tier is rate-limited per
  project, and Cloudflare Workers' free tier caps daily requests. Fine for a
  small group; if this gets popular you'll want per-user rate limiting in the
  Worker (Cloudflare KV is a natural fit) and/or to enable billing.
- **No moderation beyond Gemini's built-in safety filters** on what users post.
  Add to `BANNED_WORDS` in `app.js` for a basic denylist, or build something
  more robust if this goes public.
- **Handle collisions aren't resolved** (see above) — two users can end up
  with the same @handle.

---

## File map

```
index.html               the page (feed + notification bell)
style.css                 styling
app.js                    all frontend logic — auth, threading, mentions, notifications, calling the Worker
firestore.rules           database security rules
functions/worker.js       Cloudflare Worker — the only place your Gemini key lives
functions/wrangler.toml   Worker deploy config
```
