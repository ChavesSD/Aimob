import { buildApp } from './app.js';
import { openDb } from './db/client.js';
import { config, productionProblems, requireJwtSecret } from './config.js';
import { sweepIdle } from './domain/automation.js';
import { retryPendingEvents } from './payments/service.js';

if (config.isProduction) {
  const problems = productionProblems();
  if (problems.length) {
    console.error('Configuração de produção inválida:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
}
requireJwtSecret(); // falha na subida se o segredo estiver ausente

const db = await openDb(config.databaseUrl || config.dataDir);
const app = await buildApp(db, { trustProxy: config.trustProxy, logger: config.isProduction });

// Gatilhos por tempo (lead parado): varredura a cada 5 minutos. Idempotente, então repetir é seguro.
const sweep = setInterval(() => { sweepIdle(db).catch((e) => console.error('sweep falhou', e)); }, 5 * 60_000);
sweep.unref();
// Eventos de pagamento gravados e ainda não concluídos (falha transitória): reprocessa a cada minuto.
const events = setInterval(() => { retryPendingEvents(db).catch((e) => console.error('reprocessamento de pagamentos falhou', e)); }, 60_000);
events.unref();

// Encerramento limpo: para de aceitar requisições, espera as em andamento e fecha o banco.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    clearInterval(sweep);
    clearInterval(events);
    await app.close().catch(() => undefined);
    await db.close().catch(() => undefined);
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: process.env.HOST ?? '127.0.0.1' });
console.log(`API ouvindo em http://${process.env.HOST ?? '127.0.0.1'}:${config.port} (${db.kind})`);
