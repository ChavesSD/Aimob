import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/** Porta livre escolhida pelo sistema: evita colidir com um PostgreSQL de teste que tenha sobrado. */
const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address() as { port: number }; srv.close(() => resolve(port)); });
});

/** Inicia um PostgreSQL real e descartável (binários oficiais, sem Docker) para a suíte de testes. */
export default async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aimob-pg-'));
  const port = await freePort();
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'aimob', password: 'aimob', port, persistent: false, onLog: () => undefined, onError: () => undefined });
  await server.initialise();
  await server.start();
  process.env.TEST_DATABASE_URL = `postgres://aimob:aimob@localhost:${port}/postgres`;
  return async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
