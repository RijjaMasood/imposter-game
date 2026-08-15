const app = require('./app');

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
});
