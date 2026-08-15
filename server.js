const app = require('./app');
const { liveRoomCount, USE_REDIS } = require('./lib/store');

// A crash here means every open room disappears and everyone gets kicked to
// the home screen. Log loudly, but never take the process down for it.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Imposter running on http://localhost:${port}`);
  startKeepAlive();
});

/**
 * Free hosts put a service to sleep after ~15 minutes without an inbound
 * request, and it wakes up with empty memory — every open room gone. While a
 * game is actually in progress, ping ourselves through the public URL so that
 * never happens. Idle with no rooms, we let it sleep as normal.
 */
function startKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL || process.env.KEEPALIVE_URL;
  if (!url || USE_REDIS) return;

  const timer = setInterval(async () => {
    if (liveRoomCount() === 0) return;
    try {
      await fetch(`${url.replace(/\/$/, '')}/api/health`);
    } catch (err) {
      console.error('Keep-alive ping failed:', err.message);
    }
  }, 10 * 60 * 1000);

  timer.unref();
  console.log(`Keep-alive enabled while rooms are open (${url})`);
}
