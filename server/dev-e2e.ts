import { resolve } from 'node:path';
import { createServer } from 'vite';

const { closeHttpServer } = await import('./index.js');
const vite = await createServer({
  configFile: resolve(process.cwd(), 'vite.config.ts'),
  server: { host: '127.0.0.1', port: Number(process.env.VITE_PORT ?? 5174), strictPort: true },
});
await vite.listen();
console.info(`Gather E2E UI listening on http://127.0.0.1:${process.env.VITE_PORT ?? 5174}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void Promise.all([vite.close(), closeHttpServer()]).finally(() => process.exit(0)); });
}
