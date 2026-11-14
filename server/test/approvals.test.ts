/** Граничные сценарии маршрута согласования. */
import './env';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { DocumentDetail } from '../src/api-types';
import {
  auditOf,
  expectStatus,
  getPool,
  makeApproval,
  makeGpm,
  makeUser,
  makeUsers,
  notificationsOf,
  one,
  setup,
  teardown,
  typeId,
  xlsx,
} from './helpers';

before(setup);
after(teardown);

describe('Маршрут согласования', () => {
  test('одновременные противоположные решения в параллельном маршруте дают одно итоговое состояние', async () => {
    const initiator = await makeUser();
    for (let i = 0; i < 6; i++) {
      const [a, b] = await makeUsers(2);
      const doc = await makeApproval(initiator, [a, b], { mode: 'parallel' });
      const [ra, rb] = await Promise.all([
        a.api.post(`/api/documents/${doc.id}/decision`, { decision: 'rework', comment: 'Вернуть' }),
        b.api.post(`/api/documents/${doc.id}/decision`, { decision: 'reject', comment: 'Отклонить' }),
      ]);
      const codes = [ra.status, rb.status].sort();
      assert.deepEqual(codes, [200, 409], `итерация ${i}: одно решение принято, второе отклонено`);
      const winner = ra.status === 200 ? 'rework' : 'rejected';
      const d = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
      assert.equal(d.body.status, winner);
      assert.equal(d.body.rounds.length, 1);
      assert.equal(d.body.rounds[0].outcome, winner);
      const states = d.body.rounds[0].steps.map((s) => s.state).sort();
      assert.deepEqual(states, [winner, 'skipped'].sort());
      const finals = (await auditOf('document', doc.id)).filter((e) => ['approval.returned', 'approval.rejected'].includes(e.action));
      assert.equal(finals.length, 1, 'в истории одно итоговое решение');
      assert.equal((await notificationsOf(initiator.id)).filter((n) => n.entity_id === doc.id && ['approval_rework', 'approval_rejected'].includes(n.type)).length, 1);
    }
  });

  test('одновременные «согласовать» и «отклонить» в параллельном маршруте — итог «Отклонено»', async () => {
    const initiator = await makeUser();
    for (let i = 0; i < 4; i++) {
      const [a, b] = await makeUsers(2);
      const doc = await makeApproval(initiator, [a, b], { mode: 'parallel' });
      await Promise.all([
        a.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }),
        b.api.post(`/api/documents/${doc.id}/decision`, { decision: 'reject', comment: 'Нет' }),
      ]);
      const d = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
      assert.equal(d.body.status, 'rejected');
      assert.equal(d.body.rounds[0].outcome, 'rejected');
      assert.equal((await auditOf('document', doc.id, 'approval.completed')).length, 0);
    }
  });

  test('отклонение вторым в последовательном маршруте — третий согласующий документ не получал', async () => {
    const initiator = await makeUser();
    const [a1, a2, a3] = await makeUsers(3);
    const doc = await makeGpm(initiator, [a1, a2, a3]);
    // Третий не видит документ, пока очередь не дошла.
    expectStatus(await a3.api.get(`/api/documents/${doc.id}`), 404);
    expectStatus(await a2.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 404, 'Второй до своей очереди документ не видит.');
    expectStatus(await a1.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 200);
    expectStatus(await a2.api.post(`/api/documents/${doc.id}/decision`, { decision: 'reject', comment: 'Противоречит политике' }), 200);
    const d = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    assert.equal(d.body.status, 'rejected');
    const step3 = d.body.rounds[0].steps.find((s) => s.user.id === a3.id)!;
    assert.equal(step3.state, 'skipped');
    assert.equal(step3.activatedAt, null);
    assert.equal((await notificationsOf(a3.id, 'approval_requested')).length, 0);
    expectStatus(await a3.api.get(`/api/documents/${doc.id}`), 404);
    expectStatus(await a3.api.get(doc.files[0].currentVersion.downloadUrl), 404);
    assert.equal((await a3.api.get('/api/dashboard')).body.toApprove.count, 0);
    // Отклонённый документ — финальное состояние.
    expectStatus(await initiator.api.post(`/api/documents/${doc.id}/launch`), 409);
  });

  test('повторное решение идемпотентно, противоположное после принятого — 409', async () => {
    const initiator = await makeUser();
    const [a1, a2] = await makeUsers(2);
    const doc = await makeApproval(initiator, [a1, a2]);
    const r1 = await a1.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve', comment: 'Ок' });
    const r2 = await a1.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve', comment: 'Ок' });
    expectStatus(r1, 200);
    expectStatus(r2, 200);
    assert.equal((await auditOf('document', doc.id, 'approval.approved')).length, 1, 'двойное нажатие не создаёт второй записи');
    assert.equal((await notificationsOf(a2.id, 'approval_requested')).length, 1);
    const r3 = await a1.api.post(`/api/documents/${doc.id}/decision`, { decision: 'reject', comment: 'Передумал' });
    expectStatus(r3, 409);
    assert.equal(r3.body.error.code, 'conflict');
    // Последний согласующий; после завершения раунда — решение по закрытому раунду невозможно.
    expectStatus(await a2.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 200);
    expectStatus(await a2.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 200);
    expectStatus(await a2.api.post(`/api/documents/${doc.id}/decision`, { decision: 'rework', comment: 'Поздно' }), 409);
    const d = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    assert.equal(d.body.status, 'approved');
    assert.equal((await auditOf('document', doc.id, 'approval.completed')).length, 1);
    // Инициатор не является согласующим.
    expectStatus(await initiator.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 403);
  });

  test('возврат или отклонение без комментария либо с комментарием из пробелов — 422', async () => {
    const initiator = await makeUser();
    const a = await makeUser();
    const doc = await makeApproval(initiator, [a]);
    for (const body of [
      { decision: 'rework' },
      { decision: 'rework', comment: '' },
      { decision: 'rework', comment: '   \n\t ' },
      { decision: 'reject', comment: '  ' },
    ]) {
      const r = await a.api.post(`/api/documents/${doc.id}/decision`, body);
      expectStatus(r, 422, JSON.stringify(body));
      assert.equal(r.body.error.details[0].field, 'comment');
    }
    expectStatus(await a.api.post(`/api/documents/${doc.id}/decision`, { decision: 'maybe' }), 400);
    const d = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    assert.equal(d.body.status, 'in_review');
    assert.equal(d.body.rounds[0].steps[0].state, 'pending');
  });

  test('загрузка файла во время согласования — 409', async () => {
    const initiator = await makeUser();
    const a = await makeUser();
    const doc = await makeGpm(initiator, [a]);
    const fileId = doc.files[0].id;
    expectStatus(await initiator.api.upload(`/api/documents/${doc.id}/files`, 'Приложение.xlsx', xlsx()), 409);
    expectStatus(await initiator.api.upload(`/api/files/${fileId}/versions`, 'GPM2.xlsx', xlsx(0.5)), 409);
    expectStatus(await initiator.api.del(`/api/files/${fileId}`), 409);
    const d = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    assert.equal(d.body.files.length, 1);
    assert.equal(d.body.files[0].versions.length, 1);
    // Изменение полей карточки также запрещено.
    expectStatus(await initiator.api.patch(`/api/documents/${doc.id}`, { title: 'Другое' }), 409);
  });

  test('повторный запуск: решения первого раунда видны вместе со старой версией файла', async () => {
    const initiator = await makeUser();
    const [a1, a2] = await makeUsers(2);
    const doc = await makeGpm(initiator, [a1, a2]);
    const v1 = doc.files[0].currentVersion;
    expectStatus(await a1.api.post(`/api/documents/${doc.id}/decision`, { decision: 'rework', comment: 'Обновите расчёт' }), 200);
    const up = await initiator.api.upload(`/api/files/${doc.files[0].id}/versions`, 'GPM v2.xlsx', xlsx(0.4));
    expectStatus(up, 201);
    const re = await initiator.api.post<DocumentDetail>(`/api/documents/${doc.id}/launch`);
    expectStatus(re, 200);
    const round1 = re.body.rounds.find((r) => r.roundNo === 1)!;
    const round2 = re.body.rounds.find((r) => r.roundNo === 2)!;
    assert.equal(round1.files[0].version.id, v1.id);
    assert.equal(round1.files[0].version.versionNo, 1);
    assert.equal(round1.steps[0].state, 'rework');
    assert.equal(round1.steps[0].comment, 'Обновите расчёт');
    assert.equal(round1.steps[1].state, 'skipped');
    assert.equal(round2.files[0].version.versionNo, 2);
    assert.equal(round2.steps[0].state, 'pending');
    assert.equal(round2.steps[1].state, 'waiting');
    // Детали решения в истории ссылаются на рассмотренную версию.
    const ev = (await auditOf('document', doc.id, 'approval.returned'))[0];
    assert.deepEqual(ev.details.fileVersionIds, [v1.id]);
    // Повторно запущенный раунд снова начинается с первого согласующего.
    assert.equal((await notificationsOf(a1.id, 'approval_requested')).length, 2);
  });

  test('повторный запуск с прошедшим сроком требует нового срока', async () => {
    const initiator = await makeUser();
    const a = await makeUser();
    const doc = await makeApproval(initiator, [a]);
    expectStatus(await a.api.post(`/api/documents/${doc.id}/decision`, { decision: 'rework', comment: 'Доработать' }), 200);
    await getPool().query(`UPDATE documents SET due_at = now() - interval '1 hour' WHERE id = $1`, [doc.id]);
    const r = await initiator.api.post(`/api/documents/${doc.id}/launch`);
    expectStatus(r, 422);
    assert.ok(r.body.error.details.some((x: { field: string }) => x.field === 'dueAt'));
    expectStatus(await initiator.api.patch(`/api/documents/${doc.id}`, { dueAt: '2099-01-31' }), 200);
    expectStatus(await initiator.api.post(`/api/documents/${doc.id}/launch`), 200);
  });

  test('замена согласовавшего запрещена, ожидающего — разрешена; заменённый теряет доступ к файлу', async () => {
    const initiator = await makeUser();
    const [a1, a2, a3] = await makeUsers(3);
    const doc = await makeGpm(initiator, [a1, a2], { mode: 'parallel' });
    const fileUrl = doc.files[0].currentVersion.downloadUrl;
    expectStatus(await a1.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 200);
    expectStatus(await a2.api.get(fileUrl), 200);

    const noReason = await initiator.api.put(`/api/documents/${doc.id}/route`, { action: 'replace', fromUserId: a2.id, toUserId: a3.id, reason: '  ' });
    expectStatus(noReason, 422);
    const decided = await initiator.api.put(`/api/documents/${doc.id}/route`, { action: 'replace', fromUserId: a1.id, toUserId: a3.id, reason: 'Отпуск' });
    expectStatus(decided, 409);
    // Посторонний сотрудник маршрут не меняет.
    expectStatus(await a2.api.put(`/api/documents/${doc.id}/route`, { action: 'replace', fromUserId: a2.id, toUserId: a3.id, reason: 'x' }), 403);

    const ok = await initiator.api.put<DocumentDetail>(`/api/documents/${doc.id}/route`, {
      action: 'replace',
      fromUserId: a2.id,
      toUserId: a3.id,
      reason: 'Сотрудник в командировке',
    });
    expectStatus(ok, 200);
    const steps = ok.body.rounds[0].steps;
    assert.equal(steps.find((s) => s.user.id === a1.id)!.state, 'approved', 'история решений сохранена');
    assert.equal(steps.find((s) => s.user.id === a2.id)!.state, 'replaced');
    assert.equal(steps.find((s) => s.user.id === a3.id)!.state, 'pending');
    assert.deepEqual(ok.body.approvers.map((u) => u.id), [a1.id, a3.id]);
    const ev = (await auditOf('document', doc.id, 'route.replaced'))[0];
    assert.equal(ev.actor_id, initiator.id);
    assert.equal(ev.details.fromUserId, a2.id);
    assert.equal(ev.details.toUserId, a3.id);
    assert.equal(ev.details.reason, 'Сотрудник в командировке');

    // Заменённый теряет доступ к карточке и файлу.
    expectStatus(await a2.api.get(`/api/documents/${doc.id}`), 404);
    expectStatus(await a2.api.get(fileUrl), 404);
    expectStatus(await a2.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 404);
    // Новый участник получил документ и завершает согласование.
    assert.equal((await notificationsOf(a3.id, 'approval_requested')).length, 1);
    expectStatus(await a3.api.get(fileUrl), 200);
    expectStatus(await a3.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 200);
    const d = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    assert.equal(d.body.status, 'approved');
    // В завершённом документе маршрут не меняется.
    expectStatus(await initiator.api.put(`/api/documents/${doc.id}/route`, { action: 'add', toUserId: a2.id, reason: 'x' }), 409);
  });

  test('добавление согласующего в последовательный маршрут — в конец очереди', async () => {
    const initiator = await makeUser();
    const [a1, a2] = await makeUsers(2);
    const admin = await makeUser({ roles: ['employee', 'admin'] });
    const doc = await makeApproval(initiator, [a1]);
    // Администратор без роли «Контроль документов» меняет маршрут, не получая содержимого.
    const r = await admin.api.put(`/api/documents/${doc.id}/route`, { action: 'add', toUserId: a2.id, reason: 'Требуется юрист' });
    expectStatus(r, 200);
    assert.deepEqual(r.body, { ok: true });
    expectStatus(await a2.api.get(`/api/documents/${doc.id}`), 404, 'Очередь до добавленного не дошла.');
    expectStatus(await a1.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 200);
    const d = await a2.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    expectStatus(d, 200);
    assert.equal(d.body.myAction, 'approve');
    expectStatus(await a2.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 200);
    assert.equal((await one<{ status: string }>(getPool(), 'SELECT status FROM documents WHERE id = $1', [doc.id]))!.status, 'approved');
  });

  test('отмена процесса: причина обязательна, ожидающие участники уведомлены', async () => {
    const initiator = await makeUser();
    const a = await makeUser();
    const doc = await makeApproval(initiator, [a]);
    expectStatus(await initiator.api.post(`/api/documents/${doc.id}/cancel`, {}), 422);
    const r = await initiator.api.post<DocumentDetail>(`/api/documents/${doc.id}/cancel`, { reason: 'Сделка закрыта' });
    expectStatus(r, 200);
    assert.equal(r.body.status, 'cancelled');
    assert.equal(r.body.rounds[0].outcome, 'cancelled');
    assert.equal((await notificationsOf(a.id, 'approval_cancelled')).length, 1);
    expectStatus(await a.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 409);
    // Копия отменённой карточки — новый черновик без файлов и решений.
    const copy = await initiator.api.post<DocumentDetail>(`/api/documents/${doc.id}/copy`);
    expectStatus(copy, 201);
    assert.equal(copy.body.status, 'draft');
    assert.equal(copy.body.rounds.length, 0);
    assert.notEqual(copy.body.number, doc.number);
    assert.deepEqual(copy.body.approvers.map((u) => u.id), [a.id]);
  });

  test('инициатор не может быть согласующим, сотрудник — дважды в маршруте', async () => {
    const initiator = await makeUser();
    const a = await makeUser();
    const tid = await typeId('APPROVAL');
    const r1 = await initiator.api.post('/api/documents', { typeId: tid, title: 'x', approverIds: [initiator.id] });
    expectStatus(r1, 422);
    const r2 = await initiator.api.post('/api/documents', { typeId: tid, title: 'x', approverIds: [a.id, a.id] });
    expectStatus(r2, 422);
  });

  test('напоминание участникам — не чаще раза в сутки', async () => {
    const initiator = await makeUser();
    const a = await makeUser();
    const doc = await makeApproval(initiator, [a]);
    expectStatus(await initiator.api.post(`/api/documents/${doc.id}/remind`), 200);
    expectStatus(await initiator.api.post(`/api/documents/${doc.id}/remind`), 409);
    assert.equal((await notificationsOf(a.id, 'reminder')).length, 1);
  });
});
