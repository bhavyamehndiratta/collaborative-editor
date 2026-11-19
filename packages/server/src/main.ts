import { loadConfig } from './config.js';
import { startServer } from './server.js';

const config = loadConfig();
const server = await startServer(config);
console.log(`collab server ${config.instanceId} listening on :${server.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
