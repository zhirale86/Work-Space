/**
 * Критерий 17: реальный прогон deploy/backup.sh → deploy/restore.sh в чистую базу и каталог,
 * после чего приложение, запущенное на восстановленных данных, отдаёт файл и данные на месте.
 */
import './env';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import type { DocumentDetail } from '../src/api-types';
import { buildApp } from '../src/app';
import { closePool } from '../src/db';
import { TEST_DATABASE_URL } from './env';
import { Client, PASSWORD, config, expectStatus, getApp, makeGpm, makeUser, setup, teardown, xlsx } from './helpers';

const DEPLOY = path.resolve(__dirname, '..', '..', '..', 'deploy');
const RESTORE_DB = 'docflow_restore_test';
const restoreUrl = (() => {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = `/${RESTORE_DB}`;
  return u.toString();
})();

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const tmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

async function admin(sql: string): Promise<void> {
  const p = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await p.query(sql);
  } finally {
    await p.end();
  }
}

before(async () => {
  await setup();
  await admin(`DROP DATABASE IF EXISTS ${RESTORE_DB}`);
  await admin(`CREATE DATABASE ${RESTORE_DB}`);
});

after(async () => {
  await teardown();
  await admin(`DROP DATABASE IF EXISTS ${RESTORE_DB}`);
});

test('Критерий 17: данные и файлы восстанавливаются из резервной копии', async () => {
  // Исходные данные: согласование с двумя версиями файла, решениями и историей.
  const initiator = await makeUser();
  const approver = await makeUser();
  const doc = await makeGpm(initiator, [approver], { title: 'Документ для проверки восстановления' });
  expectStatus(await approver.api.post(`/api/documents/${doc.id}/decision`, { decision: 'rework', comment: 'Нужна версия 2' }), 200);
  const v2content = xlsx(0.77);
  expectStatus(await initiator.api.upload(`/api/files/${doc.files[0].id}/versions`, 'GPM версия 2.xlsx', v2content), 201);
  expectStatus(await initiator.api.post(`/api/documents/${doc.id}/launch`), 200);
  const original = (await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`)).body;
  const history = (await initiator.api.get(`/api/documents/${doc.id}/history`)).body;
  assert.equal(original.files[0].versions.length, 2);

  // Резервная копия.
  const backupRoot = tmp('docflow-backups-');
  const envFile = path.join(tmp('docflow-env-'), '.env');
  fs.writeFileSync(envFile, 'POSTGRES_PASSWORD=secret\nPUBLIC_URL=https://docflow.example\n');
  const out = execFileSync('bash', [path.join(DEPLOY, 'backup.sh'), backupRoot], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, FILES_DIR: config.filesDir, ENV_FILE: envFile },
    encoding: 'utf8',
  });
  const backupDir = out.trim().split('\n').pop()!;
  assert.ok(backupDir.startsWith(backupRoot), `каталог копии: ${backupDir}`);
  assert.match(path.basename(backupDir), /^\d{8}-\d{6}/, 'каталог с меткой времени');
  for (const f of ['db.dump', 'files.tar.gz', 'env', 'manifest.txt', 'SHA256SUMS']) {
    assert.ok(fs.existsSync(path.join(backupDir, f)), `в копии есть ${f}`);
  }
  assert.equal(fs.readFileSync(path.join(backupDir, 'db.dump')).subarray(0, 5).toString(), 'PGDMP', 'формат custom');
  assert.equal(fs.readFileSync(path.join(backupDir, 'env'), 'utf8'), fs.readFileSync(envFile, 'utf8'));

  // Восстановление в чистую базу и чистый каталог.
  const restoredFiles = path.join(tmp('docflow-restore-'), 'files');
  const restoreEnv = { ...process.env, DATABASE_URL: restoreUrl, FILES_DIR: restoredFiles };
  execFileSync('bash', [path.join(DEPLOY, 'restore.sh'), backupDir], { env: restoreEnv, encoding: 'utf8', stdio: 'pipe' });
  // Повторное восстановление в непустую базу без --force отклоняется.
  const again = spawnSync('bash', [path.join(DEPLOY, 'restore.sh'), backupDir], { env: restoreEnv, encoding: 'utf8' });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /не пуст/);
  // Повреждённая копия не восстанавливается.
  const broken = path.join(backupRoot, 'broken');
  fs.cpSync(backupDir, broken, { recursive: true });
  fs.appendFileSync(path.join(broken, 'files.tar.gz'), 'x');
  const bad = spawnSync('bash', [path.join(DEPLOY, 'restore.sh'), broken, '--force'], { env: restoreEnv, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /контрольные суммы/);

  // Исходные данные удаляются — проверка идёт только по восстановленной копии.
  await getApp().close();
  await closePool();
  fs.rmSync(config.filesDir, { recursive: true, force: true });
  const prev = { databaseUrl: config.databaseUrl, filesDir: config.filesDir };
  config.databaseUrl = restoreUrl;
  config.filesDir = restoredFiles;
  const restoredApp = await buildApp();
  try {
    const api = new Client();
    const inject = restoredApp.inject.bind(restoredApp);
    const call = async (method: 'GET' | 'POST', url: string, payload?: object) => {
      const r = await inject({ method, url, payload, headers: { 'x-requested-with': 'docflow', ...(api.cookie ? { cookie: api.cookie } : {}) } });
      const setCookie = r.headers['set-cookie'];
      if (setCookie) api.cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
      return r;
    };
    const login = await call('POST', '/api/auth/login', { login: approver.login, password: PASSWORD });
    assert.equal(login.statusCode, 200, login.body);
    const card = await call('GET', `/api/documents/${doc.id}`);
    assert.equal(card.statusCode, 200, card.body);
    const restored = JSON.parse(card.body) as DocumentDetail;
    assert.equal(restored.number, original.number);
    assert.equal(restored.title, original.title);
    assert.equal(restored.status, 'in_review');
    assert.equal(restored.rounds.length, 2);
    assert.equal(restored.rounds[1].steps[0].comment, 'Нужна версия 2');
    assert.deepEqual(
      restored.files[0].versions.map((v) => v.sha256),
      original.files[0].versions.map((v) => v.sha256),
    );
    // Файлы обеих версий скачиваются и совпадают с исходными.
    for (const v of original.files[0].versions) {
      const dl = await call('GET', v.downloadUrl);
      assert.equal(dl.statusCode, 200);
      assert.equal(sha(dl.rawPayload), v.sha256);
    }
    assert.equal(sha((await call('GET', restored.files[0].currentVersion.downloadUrl)).rawPayload), sha(v2content));
    const h = JSON.parse((await call('GET', `/api/documents/${doc.id}/history`)).body);
    assert.equal(h.total, history.total, 'история карточки на месте');
    assert.deepEqual(
      h.items.map((e: { action: string }) => e.action),
      history.items.map((e: { action: string }) => e.action),
    );
  } finally {
    await restoredApp.close();
    await closePool();
    config.databaseUrl = prev.databaseUrl;
    config.filesDir = prev.filesDir;
  }
});
