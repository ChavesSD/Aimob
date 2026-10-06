import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Armazenamento de arquivos fora do banco (PDFs de contratos). Endereçado pelo conteúdo (SHA-256) e separado por imobiliária:
 * o mesmo arquivo nunca ocupa espaço duas vezes e uma imobiliária jamais alcança o arquivo de outra.
 * Implementação local em disco; para produção em vários servidores, trocar por um armazenamento de objetos
 * (S3 ou equivalente) atrás desta mesma interface. Os arquivos NÃO entram no backup lógico do banco: ver docs/OPERACAO.md.
 */
export interface FileStore {
  put(tenantId: string, data: Buffer): Promise<{ key: string; sha256: string; size: number }>;
  /** Lê e confere a integridade (o conteúdo precisa ter o hash da chave); lança se o arquivo sumiu ou foi alterado. */
  get(tenantId: string, key: string): Promise<Buffer>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;

export class FileIntegrityError extends Error {}

export class LocalFileStore implements FileStore {
  constructor(private root: string) {}

  private path(tenantId: string, key: string) {
    // Só ids e hashes validados chegam ao caminho: nada de ".." vindo de fora.
    if (!UUID.test(tenantId) || !HEX64.test(key)) throw new Error('Chave de arquivo inválida');
    return join(this.root, tenantId, key.slice(0, 2), key.slice(2, 4), key);
  }

  async put(tenantId: string, data: Buffer) {
    const sha256 = createHash('sha256').update(data).digest('hex');
    const dest = this.path(tenantId, sha256);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, dest); // gravação atômica: ninguém lê arquivo pela metade
    return { key: sha256, sha256, size: data.length };
  }

  async get(tenantId: string, key: string) {
    const data = await readFile(this.path(tenantId, key));
    if (createHash('sha256').update(data).digest('hex') !== key) throw new FileIntegrityError('O arquivo armazenado foi alterado ou está corrompido.');
    return data;
  }
}

let store: FileStore | null = null;
export function getFileStore(): FileStore {
  return (store ??= new LocalFileStore(process.env.FILES_DIR ?? './data/files'));
}
/** Troca o armazenamento (testes). */
export function setFileStore(s: FileStore | null) { store = s; }
