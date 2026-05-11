import path from 'path';

function resolveFromCwd(value: string) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

export const DATA_DIR = resolveFromCwd(process.env.RAPHAEL_DATA_DIR || './data');

export const DB_PATH = resolveFromCwd(process.env.RAPHAEL_DB_PATH || path.join(DATA_DIR, 'raphael.db'));

