import { openDb, type Db } from '../src/db/client.js';

let n = 0;
/**
 * Banco de teste isolado. Por padrão PGlite em memória; com TEST_DATABASE_URL (definido pelo
 * `npm run test:pg`) usa PostgreSQL real, com um schema novo por arquivo de teste.
 */
export async function makeTestDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return openDb();
  return openDb({ target: url, schema: `t_${process.pid}_${Date.now()}_${n++}`, poolMax: 8 });
}
