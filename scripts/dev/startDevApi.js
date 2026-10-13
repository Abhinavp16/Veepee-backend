// Starts the API against the local development database.
//   node scripts/dev/startDevApi.js            (port 5055)
require('./devEnv');
const app = require('../../src/app');

const port = Number(process.env.PORT) || 5055;
app.listen(port, '0.0.0.0', () => {
  console.log(`Dev API on http://localhost:${port}/api/v1 (database ${process.env.MONGODB_URI})`);
});
