import { Pool, type PoolClient, type QueryResultRow, types } from 'pg';
import { config } from './config';

// bigint (счётчики, размеры файлов) и numeric возвращаем числами: значения заведомо в пределах 2^53.
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));
// date — строкой ГГГГ-ММ-ДД без преобразования в местное время.
types.setTypeParser(1082, (v) => v);

/** Пул или соединение внутри транзакции. */
export interface Db {
  query<R extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config.databaseUrl, max: 20, idleTimeoutMillis: 30_000 });
    pool.on('error', (err) => {
      // Ошибка простаивающего соединения не должна ронять процесс.
      console.error('Ошибка соединения с базой данных:', err.message);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

export async function rows<R extends QueryResultRow = any>(db: Db, text: string, params: unknown[] = []): Promise<R[]> {
  return (await db.query<R>(text, params)).rows;
}

export async function one<R extends QueryResultRow = any>(db: Db, text: string, params: unknown[] = []): Promise<R | null> {
  return (await db.query<R>(text, params)).rows[0] ?? null;
}

/** Действия, выполняемые после успешной фиксации транзакции (например, запуск синхронизации). */
const afterCommit = new WeakMap<object, Array<() => void>>();

export function onCommit(db: Db, fn: () => void): void {
  const list = afterCommit.get(db as object);
  if (list) list.push(fn);
  else fn();
}

export async function tx<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const hooks: Array<() => void> = [];
  afterCommit.set(client, hooks);
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    afterCommit.delete(client);
    for (const h of hooks) {
      try {
        h();
      } catch {
        /* действия после фиксации не влияют на результат */
      }
    }
    return result;
  } catch (err) {
    afterCommit.delete(client);
    try {
      await client.query('ROLLBACK');
    } catch {
      /* соединение уже неработоспособно */
    }
    throw err;
  } finally {
    client.release();
  }
}
