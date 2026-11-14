import { TEST_DATABASE_URL } from './env';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DocumentDetail, SystemRole } from '../src/api-types';
import { createUser } from '../src/admin/service';
import { buildApp } from '../src/app';
import { processBitrixQueue } from '../src/bitrix/sync';
import type { Actor } from '../src/common';
import { config } from '../src/config';
import { closePool, getPool, one, rows } from '../src/db';
import { samplePdf, sampleXlsx } from '../src/files/samples';
import { runMigrations } from '../src/migrate';
import { seedReference } from '../src/seed';

export { samplePdf, sampleXlsx, config, getPool, one, rows };

export const PASSWORD = 'Test12345!';

let app: FastifyInstance | null = null;

/** Очистка тестовой базы: схема пересоздаётся, применяются миграции и справочники. */
export async function resetDb(): Promise<void> {
  // Защита: конфигурация должна быть прочитана после test/env.ts (первый импорт в файле теста).
  if (config.databaseUrl !== TEST_DATABASE_URL) {
    throw new Error(`Тест подключён не к тестовой базе (${config.databaseUrl}): импортируйте './env' первым`);
  }
  const db = getPool();
  await db.query('DROP SCHEMA IF EXISTS public CASCADE');
  await db.query('CREATE SCHEMA public');
  await runMigrations();
  await seedReference();
}

/** Подготовка файла тестов: чистая база и экземпляр приложения. */
export async function setup(): Promise<FastifyInstance> {
  await resetDb();
  app = await buildApp();
  await app.ready();
  return app;
}

export async function teardown(): Promise<void> {
  if (app) await app.close().catch(() => {});
  app = null;
  await closePool();
}

export function getApp(): FastifyInstance {
  if (!app) throw new Error('Приложение не запущено: вызовите setup()');
  return app;
}

// ───────────── HTTP-клиент поверх fastify.inject ─────────────

export interface Res<T = any> {
  status: number;
  body: T;
  raw: Buffer;
  headers: Record<string, string | string[] | number | undefined>;
}

export class Client {
  constructor(public cookie: string | null = null) {}

  async request<T = any>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Res<T>> {
    const headers: Record<string, string> = { 'x-requested-with': 'docflow', ...extraHeaders };
    if (this.cookie) headers.cookie = this.cookie;
    const r = await getApp().inject({
      method,
      url,
      headers,
      payload: payload === undefined ? undefined : Buffer.isBuffer(payload) ? payload : (payload as object),
    });
    const ct = String(r.headers['content-type'] ?? '');
    const body = ct.includes('application/json') && r.body ? JSON.parse(r.body) : r.body;
    const setCookie = r.headers['set-cookie'];
    if (setCookie) {
      const c = (Array.isArray(setCookie) ? setCookie : [setCookie]).find((x) => x.startsWith('docflow_session='));
      if (c) {
        const v = c.split(';')[0];
        this.cookie = v === 'docflow_session=' ? null : v;
      }
    }
    return { status: r.statusCode, body, raw: r.rawPayload, headers: r.headers };
  }

  get<T = any>(url: string) {
    return this.request<T>('GET', url);
  }
  post<T = any>(url: string, body: unknown = {}) {
    return this.request<T>('POST', url, body);
  }
  put<T = any>(url: string, body: unknown = {}) {
    return this.request<T>('PUT', url, body);
  }
  patch<T = any>(url: string, body: unknown = {}) {
    return this.request<T>('PATCH', url, body);
  }
  del<T = any>(url: string) {
    return this.request<T>('DELETE', url);
  }

  /** Загрузка файла (multipart/form-data, поле «file»). */
  upload<T = any>(url: string, filename: string, content: Buffer) {
    const boundary = '----docflowtest' + randomBytes(8).toString('hex');
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
    );
    const payload = Buffer.concat([head, content, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return this.request<T>('POST', url, payload, { 'content-type': `multipart/form-data; boundary=${boundary}` });
  }
}

/** Проверка кода ответа с выводом тела при несовпадении. */
export function expectStatus(res: Res, status: number, note = ''): void {
  assert.equal(res.status, status, `${note} Ожидался код ${status}, получен ${res.status}: ${JSON.stringify(res.body).slice(0, 800)}`);
}

// ───────────── Пользователи ─────────────

export interface TestUser {
  id: number;
  login: string;
  fullName: string;
  roles: SystemRole[];
  departmentId: number | null;
  actor: Actor;
  api: Client;
}

let seq = 0;
const NAMES = ['Абрамов', 'Белова', 'Голубев', 'Денисова', 'Ершов', 'Жукова', 'Зуев', 'Ильина', 'Комаров', 'Лаптева'];

export async function departmentId(name: string): Promise<number> {
  const d = await one<{ id: number }>(getPool(), 'SELECT id FROM departments WHERE name = $1', [name]);
  if (!d) throw new Error(`Подразделение ${name} не найдено`);
  return d.id;
}

/** Создаёт сотрудника и выполняет вход (если не указано `login: false`). */
export async function makeUser(
  opts: { roles?: SystemRole[]; department?: string; name?: string; login?: boolean } = {},
): Promise<TestUser> {
  seq++;
  const login = `u${seq}_${randomBytes(3).toString('hex')}`;
  const fullName = opts.name ?? `${NAMES[seq % NAMES.length]} Тест ${seq}`;
  const depId = await departmentId(opts.department ?? 'Sales');
  const u = await createUser(null, {
    login,
    fullName,
    position: 'Тестовая должность',
    departmentId: depId,
    roles: opts.roles ?? ['employee'],
    password: PASSWORD,
    mustChangePassword: false,
  });
  const api = new Client();
  if (opts.login !== false) {
    const r = await api.post('/api/auth/login', { login, password: PASSWORD });
    expectStatus(r, 200, 'Вход тестового пользователя.');
  }
  return {
    id: u.id,
    login,
    fullName,
    roles: u.roles,
    departmentId: depId,
    actor: { id: u.id, login, fullName, roles: u.roles, departmentId: depId },
    api,
  };
}

export async function makeUsers(n: number, opts: Parameters<typeof makeUser>[0] = {}): Promise<TestUser[]> {
  const list: TestUser[] = [];
  for (let i = 0; i < n; i++) list.push(await makeUser(opts));
  return list;
}

// ───────────── Справочники и документы ─────────────

export async function typeId(code: 'GPM' | 'APPROVAL' | 'ORDER'): Promise<number> {
  const t = await one<{ id: number }>(getPool(), 'SELECT id FROM doc_types WHERE code = $1', [code]);
  return t!.id;
}

export async function dealIds(): Promise<string[]> {
  return (await rows<{ id: number }>(getPool(), 'SELECT id FROM mock_deals ORDER BY id')).map((r) => String(r.id));
}

export const xlsx = (gpm = 0.3): Buffer => sampleXlsx([['GPM', gpm]]);
export const inDays = (n: number): string => new Date(Date.now() + n * 24 * 3600 * 1000).toISOString();

/** Черновик GPM-согласования со сделкой и Excel-файлом; при `launch` — запущенный. */
export async function makeGpm(
  initiator: TestUser,
  approvers: TestUser[],
  opts: { mode?: 'sequential' | 'parallel'; dealId?: string; title?: string; launch?: boolean; file?: boolean; observers?: TestUser[] } = {},
): Promise<DocumentDetail> {
  const deal = opts.dealId ?? (await dealIds())[0];
  const created = await initiator.api.post<DocumentDetail>('/api/documents', {
    typeId: await typeId('GPM'),
    title: opts.title ?? `GPM тест ${randomBytes(3).toString('hex')}`,
    description: 'Тестовое согласование',
    dealId: deal,
    routeMode: opts.mode ?? 'sequential',
    dueAt: inDays(5),
    approverIds: approvers.map((a) => a.id),
    observerIds: (opts.observers ?? []).map((o) => o.id),
  });
  expectStatus(created, 201, 'Создание GPM.');
  if (opts.file !== false) {
    const up = await initiator.api.upload(`/api/documents/${created.body.id}/files?role=main`, 'GPM.xlsx', xlsx());
    expectStatus(up, 201, 'Загрузка Excel.');
  }
  if (opts.launch === false) return (await initiator.api.get(`/api/documents/${created.body.id}`)).body;
  const launched = await initiator.api.post<DocumentDetail>(`/api/documents/${created.body.id}/launch`, {});
  expectStatus(launched, 200, 'Запуск GPM.');
  return launched.body;
}

/** Другое согласование без сделки и без обязательного файла. */
export async function makeApproval(
  initiator: TestUser,
  approvers: TestUser[],
  opts: { mode?: 'sequential' | 'parallel'; title?: string; launch?: boolean; dealId?: string } = {},
): Promise<DocumentDetail> {
  const created = await initiator.api.post<DocumentDetail>('/api/documents', {
    typeId: await typeId('APPROVAL'),
    title: opts.title ?? `Согласование ${randomBytes(3).toString('hex')}`,
    routeMode: opts.mode ?? 'sequential',
    approverIds: approvers.map((a) => a.id),
    ...(opts.dealId ? { dealId: opts.dealId } : {}),
  });
  expectStatus(created, 201, 'Создание согласования.');
  if (opts.launch === false) return created.body;
  const launched = await initiator.api.post<DocumentDetail>(`/api/documents/${created.body.id}/launch`, {});
  expectStatus(launched, 200, 'Запуск согласования.');
  return launched.body;
}

/** Фоновое задание синхронизации с Битрикс24 (в тестах выполняется явно). */
export async function syncBitrix(documentId?: number) {
  return processBitrixQueue({ documentId, force: true });
}

export async function mockTasksOf(documentId: number) {
  return rows<{ id: number; deal_id: number; title: string; description: string; status: string; marker: string }>(
    getPool(),
    'SELECT * FROM mock_tasks WHERE marker = $1 ORDER BY id',
    [`DOCFLOW-${documentId}`],
  );
}

export async function notificationsOf(userId: number, type?: string) {
  return rows<{ id: number; type: string; title: string; body: string; entity_id: number | null }>(
    getPool(),
    `SELECT * FROM notifications WHERE user_id = $1 ${type ? 'AND type = $2' : ''} ORDER BY id`,
    type ? [userId, type] : [userId],
  );
}

export async function auditOf(entityType: string, entityId: number, action?: string) {
  return rows<{ id: number; action: string; summary: string; actor_id: number | null; details: any }>(
    getPool(),
    `SELECT * FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ${action ? 'AND action = $3' : ''} ORDER BY id`,
    action ? [entityType, entityId, action] : [entityType, entityId],
  );
}

export async function setMockUnavailable(value: boolean): Promise<void> {
  await getPool().query(
    `INSERT INTO settings (key, value) VALUES ('bitrix_mock_unavailable', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(value)],
  );
}
