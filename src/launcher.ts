/**
 * RelayPlane Proxy Launcher
 *
 * Entry point spawned as a child process by ProcessManager.
 * Starts a standalone HTTP server with /health endpoint.
 *
 * @packageDocumentation
 */

import { startProxy } from './standalone-proxy.js';

const port = parseInt(process.env['RELAYPLANE_PROXY_PORT'] ?? '4100', 10);
const host = process.env['RELAYPLANE_PROXY_HOST'] ?? '127.0.0.1';
const verbose = process.env['RELAYPLANE_VERBOSE'] === '1' || process.env['RELAYPLANE_VERBOSE'] === 'true';

async function main() {
  await startProxy({ port, host, verbose });
  console.log(`RelayPlane proxy launcher listening on http://${host}:${port}`);
}

main().catch((err) => {
  console.error('RelayPlane proxy launcher failed:', err);
  process.exit(1);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
