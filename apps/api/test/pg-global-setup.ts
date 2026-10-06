import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/** Inicia um PostgreSQL real e descartável (binários oficiais, sem Docker) para a suíte de testes. */
export default async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aimob-pg-'));
  const port = 54330;
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'aimob', password: 'aimob', port, persistent: false, onLog: () => undefined, onError: () => undefined });
  await server.initialise();
  await server.start();
  process.env.TEST_DATABASE_URL = `postgres://aimob:aimob@localhost:${port}/postgres`;
  return async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
