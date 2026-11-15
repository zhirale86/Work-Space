import fs from 'node:fs';
import path from 'node:path';

function str(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function num(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}
function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const serverRoot = path.resolve(__dirname, '..', '..');

// Настройки из server/.env; переменные, уже заданные в окружении, имеют приоритет.
const envFile = path.join(serverRoot, '.env');
if (!process.env.DOCFLOW_NO_ENV_FILE && fs.existsSync(envFile)) process.loadEnvFile(envFile);

export const config = {
  databaseUrl: str('DATABASE_URL', 'postgres://docflow:docflow@127.0.0.1:5432/docflow'),
  port: num('PORT', 3000),
  host: str('HOST', '0.0.0.0'),
  filesDir: path.resolve(str('FILES_DIR', path.join(serverRoot, 'data', 'files'))),
  publicUrl: str('PUBLIC_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  bitrixMode: (str('BITRIX_MODE', 'mock') === 'rest' ? 'rest' : 'mock') as 'mock' | 'rest',
  bitrixWebhookUrl: str('BITRIX_WEBHOOK_URL', ''),
  bitrixPortalUrl: str('BITRIX_PORTAL_URL', '').replace(/\/+$/, ''),
  bitrixResponsibleId: num('BITRIX_RESPONSIBLE_ID', 1),
  bitrixTimeoutMs: num('BITRIX_TIMEOUT_MS', 10000),
  maxFileMb: num('MAX_FILE_MB', 50),
  maxFilesPerCard: num('MAX_FILES_PER_CARD', 20),
  maxCardTotalMb: num('MAX_CARD_TOTAL_MB', 200),
  allowedExtensions: str('ALLOWED_EXTENSIONS', 'xlsx,xls,docx,doc,pdf,jpg,jpeg,png')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean),
  sessionTtlHours: num('SESSION_TTL_HOURS', 12),
  cookieSecure: bool('COOKIE_SECURE', false),
  trustProxy: bool('TRUST_PROXY', false),
  jobsEnabled: bool('JOBS_ENABLED', true),
  seedPassword: str('SEED_PASSWORD', 'Test12345!'),
  webDist: path.resolve(str('WEB_DIST', path.join(serverRoot, '..', 'web', 'dist'))),
  migrationsDir: path.join(serverRoot, 'migrations'),
  logLevel: str('LOG_LEVEL', 'info'),
};

export type Config = typeof config;
