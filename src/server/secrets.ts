import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.RAPHAEL_DB_PATH || path.join(__dirname, '../../data/raphael.db');
const DATA_DIR = path.dirname(DB_PATH);
const KEY_FILE = path.join(DATA_DIR, 'raphael.secret');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getMasterKey(): Buffer {
  const fromEnv = process.env.RAPHAEL_SECRET;
  if (fromEnv && fromEnv.trim()) {
    return crypto.createHash('sha256').update(fromEnv).digest();
  }

  ensureDataDir();
  if (fs.existsSync(KEY_FILE)) {
    return fs.readFileSync(KEY_FILE);
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return key;
}

type EnvelopeV1 = { v: 1; alg: 'aes-256-gcm'; iv: string; tag: string; data: string };

export function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const env: EnvelopeV1 = {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64'),
  };

  return `v1:${Buffer.from(JSON.stringify(env), 'utf8').toString('base64')}`;
}

export function decryptSecret(value: string): string {
  const trimmed = (value ?? '').toString();
  if (!trimmed) return '';
  if (!trimmed.startsWith('v1:')) return trimmed;

  const raw = Buffer.from(trimmed.slice(3), 'base64').toString('utf8');
  const env = JSON.parse(raw) as EnvelopeV1;
  if (env.v !== 1 || env.alg !== 'aes-256-gcm') throw new Error('Unsupported secret envelope');

  const key = getMasterKey();
  const iv = Buffer.from(env.iv, 'base64');
  const tag = Buffer.from(env.tag, 'base64');
  const data = Buffer.from(env.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

