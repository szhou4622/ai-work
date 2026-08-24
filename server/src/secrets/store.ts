import {
  createCipheriv, createDecipheriv, randomBytes, createHash,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { MASTER_KEY_FILE, SECRET_STORE_FILE } from '../config.js';

interface StoredSecret {
  name: string;
  iv: string;
  tag: string;
  ct: string;
}

/**
 * Secret Store：AES-256-GCM 加密文件（开发文档 §9.10）
 * - 主密钥 data/.master-key（0600）
 * - 密文 data/secrets.enc，原子写入
 * - 业务侧只持有 secret_ref（随机 id），永不返回明文
 */
export class SecretStore {
  private key: Buffer;
  private data: Record<string, StoredSecret> = {};

  constructor() {
    if (!existsSync(MASTER_KEY_FILE)) {
      mkdirSync(dirname(MASTER_KEY_FILE), { recursive: true });
      this.key = randomBytes(32);
      writeFileSync(MASTER_KEY_FILE, this.key, { mode: 0o600 });
    } else {
      this.key = readFileSync(MASTER_KEY_FILE);
      if (this.key.length !== 32) throw new Error('master key 长度错误');
    }
    if (existsSync(SECRET_STORE_FILE)) {
      this.data = JSON.parse(readFileSync(SECRET_STORE_FILE, 'utf-8'));
    }
  }

  private encrypt(value: string): { iv: string; tag: string; ct: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
    return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ct: ct.toString('hex') };
  }

  private decrypt(s: StoredSecret): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(s.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(s.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(s.ct, 'hex')), decipher.final()]).toString('utf-8');
  }

  private persist(): void {
    const tmp = SECRET_STORE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, SECRET_STORE_FILE);
  }

  create(name: string, value: string): string {
    const id = createHash('sha256').update(name + ':' + Date.now() + ':' + randomBytes(8).toString('hex')).digest('hex').slice(0, 24);
    this.data[id] = { name, ...this.encrypt(value) };
    this.persist();
    return id;
  }

  get(id: string): string | null {
    const s = this.data[id];
    if (!s) return null;
    try {
      return this.decrypt(s);
    } catch {
      return null;
    }
  }

  list(): { id: string; name: string }[] {
    return Object.entries(this.data).map(([id, s]) => ({ id, name: s.name }));
  }

  delete(id: string): boolean {
    if (!this.data[id]) return false;
    delete this.data[id];
    this.persist();
    return true;
  }

  /** 返回所有明文值，供日志脱敏使用 */
  allValues(): string[] {
    return Object.values(this.data).map((s) => this.decrypt(s));
  }
}
