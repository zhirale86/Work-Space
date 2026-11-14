/** Синхронизация с Битрикс24 через эмулятор: идемпотентность, сбои, восстановление. */
import './env';
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import type { DocumentDetail, MockDealDetail } from '../src/api-types';
import { SETTING_FAIL_AFTER_CREATE, setSetting } from '../src/bitrix/mock';
import { kickBitrixSync } from '../src/bitrix/sync';
import {
  auditOf,
  config,
  dealIds,
  expectStatus,
  getPool,
  makeGpm,
  makeUser,
  makeUsers,
  mockTasksOf,
  one,
  setMockUnavailable,
  setup,
  syncBitrix,
  teardown,
  xlsx,
} from './helpers';

before(setup);
after(teardown);
afterEach(async () => {
  await setMockUnavailable(false);
  await setSetting(getPool(), SETTING_FAIL_AFTER_CREATE, false);
});

describe('Интеграция с Битрикс24', () => {
  test('недоступность при трёх сменах статуса — после восстановления одна задача с последним статусом', async () => {
    const initiator = await makeUser();
    const [a1, a2] = await makeUsers(2);
    const doc = await makeGpm(initiator, [a1, a2], { launch: false, title: 'Три смены статуса' });
    await setMockUnavailable(true);

    // 1) запуск → «На согласовании»
    expectStatus(await initiator.api.post(`/api/documents/${doc.id}/launch`), 200);
    await syncBitrix();
    // 2) возврат → «На доработке»
    expectStatus(await a1.api.post(`/api/documents/${doc.id}/decision`, { decision: 'rework', comment: 'Исправить' }), 200);
    await syncBitrix();
    // 3) повторный запуск и согласование всеми → «Согласовано»
    expectStatus(await initiator.api.upload(`/api/files/${doc.files[0].id}/versions`, 'GPM2.xlsx', xlsx(0.33)), 201);
    expectStatus(await initiator.api.post(`/api/documents/${doc.id}/launch`), 200);
    expectStatus(await a1.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 200);
    expectStatus(await a2.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 200);
    await syncBitrix();

    assert.equal((await mockTasksOf(doc.id)).length, 0, 'пока связь недоступна, записи нет');
    const link = await one(getPool(), 'SELECT * FROM bitrix_links WHERE document_id = $1', [doc.id]);
    assert.equal(link.state, 'error');
    assert.ok(link.attempts >= 3);
    assert.ok((await auditOf('document', doc.id, 'bitrix.error')).length >= 3, 'каждая ошибка записана в журнал');
    const card = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    assert.equal(card.body.status, 'approved', 'статус документа не зависит от Битрикс24');

    await setMockUnavailable(false);
    const stats = await syncBitrix();
    assert.equal(stats.synced, 1);
    const tasks = await mockTasksOf(doc.id);
    assert.equal(tasks.length, 1, 'одна запись');
    assert.equal(tasks[0].title, '[Согласовано] Три смены статуса');
    assert.equal(tasks[0].status, 'completed');
    const after = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    assert.equal(after.body.bitrix?.state, 'synced');
    assert.equal(after.body.bitrix?.syncedStatus, 'approved');
    assert.equal(after.body.bitrix?.attempts, 0);
    assert.equal((await auditOf('document', doc.id, 'bitrix.created')).length, 1);
  });

  test('сбой после фактического создания задачи — повтор не создаёт дубль', async () => {
    const initiator = await makeUser();
    const a = await makeUser();
    const doc = await makeGpm(initiator, [a], { launch: false });
    await setSetting(getPool(), SETTING_FAIL_AFTER_CREATE, true);
    expectStatus(await initiator.api.post(`/api/documents/${doc.id}/launch`), 200);
    const s1 = await syncBitrix();
    assert.equal(s1.failed, 1);
    let link = await one(getPool(), 'SELECT * FROM bitrix_links WHERE document_id = $1', [doc.id]);
    assert.equal(link.state, 'error');
    assert.equal(link.external_task_id, null, 'ответ потерян — идентификатор неизвестен');
    assert.equal((await mockTasksOf(doc.id)).length, 1, 'задача в Битрикс24 фактически создана');

    const r = await initiator.api.post(`/api/documents/${doc.id}/bitrix/retry`);
    expectStatus(r, 200);
    assert.equal(r.body.bitrix.state, 'synced');
    const tasks = await mockTasksOf(doc.id);
    assert.equal(tasks.length, 1, 'найдена по маркеру, дубль не создан');
    link = await one(getPool(), 'SELECT * FROM bitrix_links WHERE document_id = $1', [doc.id]);
    assert.equal(link.external_task_id, String(tasks[0].id));
    // Следующая смена статуса обновляет ту же запись.
    expectStatus(await a.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 200);
    await syncBitrix();
    const again = await mockTasksOf(doc.id);
    assert.equal(again.length, 1);
    assert.equal(again[0].id, tasks[0].id);
    assert.equal(again[0].status, 'completed');
  });

  test('задача удалена в Битрикс24 — создаётся заново; закрыта вручную — возобновляется', async () => {
    const initiator = await makeUser();
    const [a1, a2] = await makeUsers(2);
    const admin = await makeUser({ roles: ['employee', 'admin'] });
    const doc = await makeGpm(initiator, [a1, a2]);
    await syncBitrix();
    const [t1] = await mockTasksOf(doc.id);

    // Ручное удаление записи в Битрикс24 (эмулятор).
    expectStatus(await initiator.api.del(`/api/bitrix-mock/tasks/${t1.id}`), 403);
    expectStatus(await admin.api.del(`/api/bitrix-mock/tasks/${t1.id}`), 200);
    expectStatus(await a1.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 200);
    await syncBitrix();
    const recreated = await mockTasksOf(doc.id);
    assert.equal(recreated.length, 1);
    assert.notEqual(recreated[0].id, t1.id);
    assert.equal((await auditOf('document', doc.id, 'bitrix.recreated')).length, 1);
    const card = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    assert.equal(card.body.bitrix?.externalTaskId, String(recreated[0].id));

    // Закрытие записи в Битрикс24 не является решением согласующих.
    expectStatus(await admin.api.post(`/api/bitrix-mock/tasks/${recreated[0].id}/complete`), 200);
    const still = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    assert.equal(still.body.status, 'in_review');
    expectStatus(await initiator.api.post(`/api/documents/${doc.id}/bitrix/retry`), 200);
    const [reopened] = await mockTasksOf(doc.id);
    assert.equal(reopened.status, 'in_progress');
    assert.equal((await auditOf('document', doc.id, 'bitrix.reopened')).length, 1);
  });

  test('две карточки по одной сделке — две отдельные задачи', async () => {
    const initiator = await makeUser();
    const a = await makeUser();
    const deal = (await dealIds())[5];
    const d1 = await makeGpm(initiator, [a], { dealId: deal, title: 'Первая' });
    const d2 = await makeGpm(initiator, [a], { dealId: deal, title: 'Вторая' });
    await syncBitrix();
    expectStatus(await a.api.post(`/api/documents/${d2.id}/decision`, { decision: 'reject', comment: 'Нет' }), 200);
    await syncBitrix();
    const r = await initiator.api.get<MockDealDetail>(`/api/bitrix-mock/deals/${deal}`);
    const mine = r.body.tasks.filter((t) => t.documentId === d1.id || t.documentId === d2.id);
    assert.equal(mine.length, 2);
    assert.equal(mine.find((t) => t.documentId === d1.id)!.title, '[На согласовании] Первая');
    assert.equal(mine.find((t) => t.documentId === d2.id)!.title, '[Отклонено] Вторая');
  });

  test('черновик не передаётся; документ без сделки не ставится в очередь', async () => {
    const initiator = await makeUser();
    const a = await makeUser();
    const doc = await makeGpm(initiator, [a], { launch: false });
    await syncBitrix();
    assert.equal((await mockTasksOf(doc.id)).length, 0);
    assert.equal(await one(getPool(), 'SELECT 1 FROM bitrix_links WHERE document_id = $1', [doc.id]), null);
    const card = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    assert.equal(card.body.bitrix, null);
    assert.equal(card.body.dealLocked, false);
    // Сделку можно сменить до первого запуска, но не после.
    const deals = await dealIds();
    expectStatus(await initiator.api.patch(`/api/documents/${doc.id}`, { dealId: deals[7] }), 200);
    assert.equal((await auditOf('document', doc.id, 'document.deal_changed')).length, 1);
    expectStatus(await initiator.api.post(`/api/documents/${doc.id}/launch`), 200);
    expectStatus(await a.api.post(`/api/documents/${doc.id}/decision`, { decision: 'rework', comment: 'Доработать' }), 200);
    const locked = await initiator.api.patch(`/api/documents/${doc.id}`, { dealId: deals[8] });
    expectStatus(locked, 409);
    // Несуществующая сделка.
    const other = await makeGpm(initiator, [a], { launch: false });
    expectStatus(await initiator.api.patch(`/api/documents/${other.id}`, { dealId: '999999' }), 422);
  });

  test('немедленная передача после изменения статуса (без ожидания фонового задания)', async () => {
    const initiator = await makeUser();
    const a = await makeUser();
    const prev = config.jobsEnabled;
    config.jobsEnabled = true;
    try {
      const doc = await makeGpm(initiator, [a]);
      let synced = false;
      for (let i = 0; i < 50 && !synced; i++) {
        await new Promise((r) => setTimeout(r, 20));
        synced = (await mockTasksOf(doc.id)).length === 1;
      }
      assert.ok(synced, 'запись создана сразу после запуска');
      kickBitrixSync();
    } finally {
      config.jobsEnabled = prev;
      await new Promise((r) => setTimeout(r, 100));
    }
  });
});
