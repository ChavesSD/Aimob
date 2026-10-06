import { buildApp } from './app.js';
import { openDb } from './db/client.js';
import { config, requireJwtSecret } from './config.js';
import { sweepIdle } from './domain/automation.js';

requireJwtSecret(); // falha na subida se o segredo estiver ausente
const db = await openDb(config.dataDir);
const app = await buildApp(db);
// Gatilhos por tempo (lead parado): varredura a cada 5 minutos. Idempotente, então repetir é seguro.
setInterval(() => { sweepIdle(db).catch((e) => console.error('sweep falhou', e)); }, 5 * 60_000).unref();
await app.listen({ port: config.port, host: '127.0.0.1' });
console.log(`API ouvindo em http://127.0.0.1:${config.port}`);
