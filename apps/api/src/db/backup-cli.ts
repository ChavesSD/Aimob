import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './client.js';
import { config } from '../config.js';
import { BackupError, createBackup, decryptBackup, encryptBackup, restoreBackup, verifyBackup } from './backup.js';

// Uso: npm run backup | npm run restore -- <arquivo> | tsx src/db/backup-cli.ts verify <arquivo>
// Requer BACKUP_ENC_KEY (>= 32 caracteres). Com PGlite em disco, pare a API antes (um processo por vez).
const [cmd, file] = process.argv.slice(2);
const key = process.env.BACKUP_ENC_KEY ?? '';

try {
  if (cmd === 'backup') {
    const db = await openDb(config.databaseUrl || config.dataDir);
    const b = await createBackup(db);
    const dir = process.env.BACKUP_DIR ?? './backups';
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `aimob-${b.createdAt.replace(/[:.]/g, '-')}.bak`);
    writeFileSync(out, encryptBackup(b, key), { mode: 0o600 });
    // Prova imediata: o arquivo recém-gravado precisa abrir e conferir.
    verifyBackup(decryptBackup(readFileSync(out), key));
    console.log(`Backup criado e verificado: ${out}`);
    console.log('Linhas por tabela:', b.counts);
    await db.close();
  } else if (cmd === 'verify' && file) {
    const b = decryptBackup(readFileSync(file), key);
    verifyBackup(b);
    console.log(`Backup íntegro (${b.createdAt}). Linhas por tabela:`, b.counts);
  } else if (cmd === 'restore' && file) {
    const db = await openDb(config.databaseUrl || config.dataDir);
    const restored = await restoreBackup(db, decryptBackup(readFileSync(file), key));
    console.log('Restauração concluída e conferida:', restored);
    await db.close();
  } else {
    console.error('Uso: backup | verify <arquivo> | restore <arquivo>');
    process.exit(2);
  }
} catch (e) {
  console.error(e instanceof BackupError ? `Erro: ${e.message}` : e);
  process.exit(1);
}
