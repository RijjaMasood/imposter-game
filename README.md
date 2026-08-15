# 🕵️ Imposter

A dead-simple party game for people sitting in the same room.

Everyone joins a room with a 4-letter code. Everyone gets **the same word** — except the
imposter, who gets nothing. You talk it out in person. The room admin hits **Open voting**,
everyone votes, and the app shows the result.

No accounts, no database, no build step.

## Deploy

### Render (recommended — one click, zero config)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

Point it at this repo. `render.yaml` is already here, so it just works: rooms live in the
server's memory, which is exactly what a single always-on server is good at.

> On Render's free plan the service sleeps after ~15 min idle and wakes with empty memory —
> any room open at that moment is gone. Fine for a game night; upgrade if you care.

### Vercel

Import the repo — `vercel.json` is already here. But Vercel is serverless, so every request
can hit a fresh instance with its own memory. **Add a Redis store or rooms will vanish
mid-game:**

1. Vercel dashboard → **Storage** → create an **Upstash Redis** database → connect it to the project.
2. Redeploy.

That's it — the app picks up `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (or
`KV_REST_API_URL` / `KV_REST_API_TOKEN`) automatically and stores rooms there instead.
Check which one is live at `/api/health`.

### Anywhere else (Railway, Fly, a VPS, your laptop)

```bash
npm install
npm start
```

Serves on `PORT` (default 3000).

## How a round goes

1. One person taps **Create a room** and reads the 4-letter code out loud. They're the admin.
2. Everyone else taps **Join room** with that code.
3. Admin taps **Start round**. Everyone holds their card to see the word — the imposter sees
   "YOU'RE THE IMPOSTER" instead.
4. Talk. Describe the word without saying it. The imposter bluffs and tries to work it out.
5. Admin taps **Open voting**. Everyone picks someone. Results show as soon as the last
   vote lands (or the admin closes voting early).
6. **Next round** deals again, **Back to lobby** lets new people join.

3–20 players. The admin can switch to 2 imposters once there are 4+ people, and can remove
anyone from the player list.

## Layout

```
app.js           Express app — all game rules and API routes
server.js        node server.js (Render, Railway, local)
api/index.js     same app, as a Vercel function
lib/store.js     rooms in memory, or Redis over REST if env vars are present
lib/words.js     the word list — edit freely
public/          the whole client: index.html, style.css, game.js
```

The client never receives anything it shouldn't: mid-round the API only tells you your own
role and word. The imposter list is sent to nobody until results.
