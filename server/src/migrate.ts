import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { closePool, getPool } from './db';

/**
 * Простой исполнитель миграций: пронумерованные SQL-файлы из каталога migrations,
 * каждая — в своей транзакции; применённые фиксируются в таблице schema_migrations.
 */
export async function runMigrations(log: (msg: string) => void = () => {}): Promise<string[]> {
  const pool = getPool();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // Блокировка от одновременного запуска несколькими процессами.
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs
      .readdirSync(config.migrationsDir)
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(config.migrationsDir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Миграция ${file} не применена: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`Применена миграция ${file}`);
    }
    if (!applied.length) log('Новых миграций нет');
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

if (require.main === module) {
  runMigrations((m) => console.log(m))
    .then(() => closePool())
    .catch(async (err) => {
      console.error(err.message);
      await closePool();
      process.exit(1);
    });
}
