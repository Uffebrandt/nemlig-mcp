import { config, InvalidPathSecretError, requirePathSecret } from './config.js';
import { login } from './nemlig/login.js';
import { createHttpServer } from './server.js';
import { SessionManager } from './sessions.js';
import { SessionStore } from './store.js';

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

// Refuse to start rather than serve the endpoint unguarded on the internet.
try {
  requirePathSecret(config.mcpPathSecret);
} catch (error) {
  if (!(error instanceof InvalidPathSecretError)) throw error;
  console.error(`nemlig-mcp: refusing to start. ${error.message}`);
  process.exit(1);
}

const store = await SessionStore.open(config.dataDir);
const sessions = new SessionManager({
  store,
  login,
  ttlMs: config.sessionTtlMs,
  maxConcurrentLogins: config.login.maxConcurrent,
});

const app = createHttpServer(sessions);

const prune = setInterval(() => {
  void sessions.prune().then((removed) => {
    if (removed) app.log.info(`pruned ${removed} expired session(s)`);
  });
}, PRUNE_INTERVAL_MS);
prune.unref();

await app.listen({ host: config.host, port: config.port });
app.log.info(
  `nemlig-mcp listening on http://${config.host}:${config.port}/mcp/<MCP_PATH_SECRET> ` +
    `(credentials: ${config.defaultCredentials ? 'from environment' : 'from client headers only'})`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(prune);
    void app.close().then(() => process.exit(0));
  });
}
