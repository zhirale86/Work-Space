/** Граничные сценарии: блокировка, ознакомление, поручения, сроки, поиск и счётчики, нумерация. */
import './env';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { DocumentDetail } from '../src/api-types';
import { checkDeadlines } from '../src/jobs/deadlines';
import {
  Client,
  PASSWORD,
  expectStatus,
  getPool,
  makeApproval,
  makeGpm,
  makeUser,
  makeUsers,
  notificationsOf,
  rows,
  samplePdf,
  setup,
  teardown,
  typeId,
} from './helpers';

before(setup);
after(teardown);

async function makeOrder(initiator: Awaited<ReturnType<typeof makeUser>>, signer: { id: number }, acquaintance: number[], approvers: number[] = []) {
  const r = await initiator.api.post<DocumentDetail>('/api/documents', {
    typeId: await typeId('ORDER'),
    title: 'Приказ о тестировании',
    approverIds: approvers,
    signerId: signer.id,
    acquaintanceIds: acquaintance,
  });
  expectStatus(r, 201);
  expectStatus(await initiator.api.upload(`/api/documents/${r.body.id}/files?role=main`, 'Приказ.pdf', samplePdf()), 201);
  return r.body;
}

describe('Блокировка сотрудника', () => {
  test('блокировка согласующего: сессия сброшена, вход запрещён, инициатор уведомлён', async () => {
    const admin = await makeUser({ roles: ['employee', 'admin'] });
    const initiator = await makeUser();
    const [a1, a2, a3] = await makeUsers(3);
    const doc = await makeApproval(initiator, [a1, a2]);
    const cookie = a1.api.cookie;
    expectStatus(await a1.api.get('/api/auth/me'), 200);

    expectStatus(await initiator.api.post(`/api/admin/users/${a1.id}/block`), 403, 'Блокирует только администратор.');
    const r = await admin.api.post(`/api/admin/users/${a1.id}/block`);
    expectStatus(r, 200);
    assert.equal(r.body.active, false);

    expectStatus(await new Client(cookie).get('/api/auth/me'), 401, 'Сессия сброшена.');
    const login = await new Client().post('/api/auth/login', { login: a1.login, password: PASSWORD });
    expectStatus(login, 401);
    const n = await notificationsOf(initiator.id, 'participant_blocked');
    assert.equal(n.length, 1);
    assert.equal(n[0].entity_id, doc.id);

    // Шаг остаётся и виден инициатору с пометкой; заблокированный не предлагается в выборе.
    const d = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    const step = d.body.rounds[0].steps.find((s) => s.user.id === a1.id)!;
    assert.equal(step.state, 'pending');
    assert.equal(step.user.active, false);
    const users = await initiator.api.get(`/api/users?q=${encodeURIComponent(a1.fullName)}`);
    assert.equal(users.body.items.some((u: { id: number }) => u.id === a1.id), false);
    // Заблокированного нельзя назначить; инициатор заменяет участника.
    expectStatus(await initiator.api.put(`/api/documents/${doc.id}/route`, { action: 'add', toUserId: a1.id, reason: 'x' }), 422);
    expectStatus(
      await initiator.api.put(`/api/documents/${doc.id}/route`, { action: 'replace', fromUserId: a1.id, toUserId: a3.id, reason: 'Сотрудник уволен' }),
      200,
    );
    // История действий заблокированного сохраняется.
    const hist = await initiator.api.get(`/api/documents/${doc.id}/history`);
    assert.ok(hist.body.items.length > 0);
    // Разблокировка возвращает вход.
    expectStatus(await admin.api.post(`/api/admin/users/${a1.id}/unblock`), 200);
    expectStatus(await new Client().post('/api/auth/login', { login: a1.login, password: PASSWORD }), 200);
    void a2;
  });

  test('блокировка исполнителя поручения уведомляет постановщика', async () => {
    const admin = await makeUser({ roles: ['employee', 'admin'] });
    const author = await makeUser();
    const assignee = await makeUser();
    const t = (await author.api.post('/api/tasks', { title: 'Поручение', assigneeId: assignee.id })).body;
    expectStatus(await admin.api.post(`/api/admin/users/${assignee.id}/block`), 200);
    const n = await notificationsOf(author.id, 'participant_blocked');
    assert.equal(n.length, 1);
    assert.equal(n[0].entity_id, t.id);
    // Администратор не может заблокировать сам себя.
    expectStatus(await admin.api.post(`/api/admin/users/${admin.id}/block`), 409);
  });
});

describe('Ознакомление с приказом', () => {
  test('ознакомление до утверждения запрещено, повторное — идемпотентно', async () => {
    const initiator = await makeUser();
    const signer = await makeUser({ roles: ['employee', 'signer'] });
    const [e1, approverAndReader] = await makeUsers(2);
    const order = await makeOrder(initiator, signer, [e1.id, approverAndReader.id], [approverAndReader.id]);
    expectStatus(await initiator.api.post(`/api/documents/${order.id}/launch`), 200);
    // Сотрудник из списка, который видит приказ как согласующий, — 409; остальные карточку не видят.
    expectStatus(await approverAndReader.api.post(`/api/documents/${order.id}/acknowledge`), 409);
    expectStatus(await e1.api.post(`/api/documents/${order.id}/acknowledge`), 404);
    expectStatus(await approverAndReader.api.post(`/api/documents/${order.id}/decision`, { decision: 'approve' }), 200);
    expectStatus(await approverAndReader.api.post(`/api/documents/${order.id}/acknowledge`), 409, 'На утверждении.');
    // Утверждать может только указанный утверждающий.
    expectStatus(await initiator.api.post(`/api/documents/${order.id}/sign`, { decision: 'approve' }), 403);
    expectStatus(await signer.api.post(`/api/documents/${order.id}/sign`, { decision: 'rework' }), 422);
    expectStatus(await signer.api.post(`/api/documents/${order.id}/sign`, { decision: 'approve' }), 200);
    expectStatus(await signer.api.post(`/api/documents/${order.id}/sign`, { decision: 'approve' }), 200, 'Повтор утверждения ничего не меняет.');

    const first = await e1.api.post<DocumentDetail>(`/api/documents/${order.id}/acknowledge`);
    expectStatus(first, 200);
    const second = await e1.api.post<DocumentDetail>(`/api/documents/${order.id}/acknowledge`);
    expectStatus(second, 200);
    assert.equal(second.body.myAcknowledgement.acknowledgedAt, first.body.myAcknowledgement.acknowledgedAt);
    const acks = await rows(getPool(), 'SELECT * FROM acknowledgements WHERE document_id = $1', [order.id]);
    assert.equal(acks.length, 1);
    assert.equal((await rows(getPool(), `SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'order.acknowledged'`, [order.id])).length, 1);
    // Не входящий в список — 403 (карточку видит как инициатор, но ознакомление не требуется).
    expectStatus(await initiator.api.post(`/api/documents/${order.id}/acknowledge`), 403);
    // Архив: ознакомление больше не принимается, подтверждённое — сохраняется.
    expectStatus(await initiator.api.post(`/api/documents/${order.id}/archive`), 200);
    expectStatus(await approverAndReader.api.post(`/api/documents/${order.id}/acknowledge`), 409);
    const d = await initiator.api.get<DocumentDetail>(`/api/documents/${order.id}`);
    assert.equal(d.body.status, 'archived');
    assert.equal(d.body.acknowledgements!.acknowledged, 1);
  });

  test('приказ без согласующих сразу направляется на утверждение; заблокированный не ожидается', async () => {
    const initiator = await makeUser();
    const signer = await makeUser({ roles: ['employee', 'signer'] });
    const notSigner = await makeUser();
    const admin = await makeUser({ roles: ['employee', 'admin'] });
    const [e1, e2] = await makeUsers(2);
    const bad = await initiator.api.post('/api/documents', { typeId: await typeId('ORDER'), title: 'x', signerId: notSigner.id });
    expectStatus(bad, 422);
    const order = await makeOrder(initiator, signer, [e1.id, e2.id]);
    const r = await initiator.api.post<DocumentDetail>(`/api/documents/${order.id}/launch`);
    expectStatus(r, 200);
    assert.equal(r.body.status, 'on_signing');
    assert.equal((await notificationsOf(signer.id, 'sign_requested')).length, 1);
    expectStatus(await signer.api.post(`/api/documents/${order.id}/sign`, { decision: 'approve' }), 200);
    expectStatus(await admin.api.post(`/api/admin/users/${e2.id}/block`), 200);
    const d = await initiator.api.get<DocumentDetail>(`/api/documents/${order.id}`);
    assert.equal(d.body.acknowledgements!.total, 1, 'заблокированный исключён из ожидаемых');
    assert.equal(d.body.acknowledgements!.pending, 1);
  });
});

describe('Поручения', () => {
  test('передача на проверку без результата — 422', async () => {
    const author = await makeUser();
    const assignee = await makeUser();
    const t = (await author.api.post('/api/tasks', { title: 'Без результата', assigneeId: assignee.id })).body;
    for (const body of [{}, { resultText: '' }, { resultText: '   \n ' }]) {
      const r = await assignee.api.post(`/api/tasks/${t.id}/submit`, body);
      expectStatus(r, 422, JSON.stringify(body));
      assert.equal(r.body.error.details[0].field, 'resultText');
    }
    const card = await assignee.api.get(`/api/tasks/${t.id}`);
    assert.equal(card.body.status, 'new');
    // Постановщик не передаёт результат за исполнителя.
    expectStatus(await author.api.post(`/api/tasks/${t.id}/submit`, { resultText: 'Готово' }), 403);
    // Отмена: причина обязательна; после отмены действия недоступны.
    expectStatus(await author.api.post(`/api/tasks/${t.id}/cancel`, { reason: ' ' }), 422);
    expectStatus(await author.api.post(`/api/tasks/${t.id}/cancel`, { reason: 'Неактуально' }), 200);
    expectStatus(await assignee.api.post(`/api/tasks/${t.id}/submit`, { resultText: 'Готово' }), 409);
  });

  test('поручение по документу: участник видит только номер и название основания', async () => {
    const initiator = await makeUser();
    const approver = await makeUser();
    const assignee = await makeUser();
    const doc = await makeGpm(initiator, [approver]);
    const t = await initiator.api.post('/api/tasks', { title: 'По документу', assigneeId: assignee.id, documentId: doc.id });
    expectStatus(t, 201);
    const card = await assignee.api.get(`/api/tasks/${t.body.id}`);
    assert.deepEqual(card.body.document, { id: doc.id, number: doc.number, title: doc.title, accessible: false });
    expectStatus(await assignee.api.get(`/api/documents/${doc.id}`), 404);
    // Основанием может быть только доступный постановщику документ.
    const outsider = await makeUser();
    expectStatus(await outsider.api.post('/api/tasks', { title: 'x', assigneeId: assignee.id, documentId: doc.id }), 404);
    const d = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    assert.deepEqual(d.body.tasks.map((x) => x.id), [t.body.id]);
  });
});

describe('Сроки', () => {
  test('уведомление о просрочке формируется один раз', async () => {
    const author = await makeUser();
    const assignee = await makeUser();
    const initiator = await makeUser();
    const approver = await makeUser();
    const t = (await author.api.post('/api/tasks', { title: 'Просроченное', assigneeId: assignee.id, dueAt: new Date(Date.now() - 3600_000).toISOString() })).body;
    assert.equal(t.overdue, true);
    const doc = await makeApproval(initiator, [approver]);
    const due = new Date(Date.now() + 10 * 3600_000);
    await getPool().query('UPDATE documents SET due_at = $2 WHERE id = $1', [doc.id, due]);

    // Срок документа приближается (менее 24 часов).
    await checkDeadlines(getPool(), new Date());
    await checkDeadlines(getPool(), new Date());
    assert.equal((await notificationsOf(approver.id, 'deadline_soon')).length, 1);
    // Наступление срока: проверка выполняется многократно.
    const later = new Date(due.getTime() + 60_000);
    for (let i = 0; i < 3; i++) await checkDeadlines(getPool(), later);
    assert.equal((await notificationsOf(approver.id, 'deadline_overdue')).length, 1);
    assert.equal((await notificationsOf(initiator.id, 'deadline_overdue')).length, 1);
    assert.equal((await notificationsOf(assignee.id, 'deadline_overdue')).length, 1);
    assert.equal((await notificationsOf(author.id, 'deadline_overdue')).length, 1);
    // Просрочка видна в списках и на главной у того, от кого ожидается действие.
    const dash = await assignee.api.get('/api/dashboard');
    assert.equal(dash.body.overdue.count, 1);
    assert.equal(dash.body.overdue.tasks[0].id, t.id);
    const overdueTasks = await author.api.get('/api/tasks?overdue=true');
    assert.deepEqual(overdueTasks.body.items.map((x: { id: number }) => x.id), [t.id]);
    // Завершённое поручение не просрочено.
    expectStatus(await assignee.api.post(`/api/tasks/${t.id}/submit`, { resultText: 'Сделано' }), 200);
    expectStatus(await author.api.post(`/api/tasks/${t.id}/accept`), 200);
    assert.equal((await author.api.get(`/api/tasks/${t.id}`)).body.overdue, false);
  });
});

describe('Поиск и счётчики', () => {
  test('поиск по номеру чужой карточки ничего не возвращает и не влияет на счётчики', async () => {
    const owner = await makeUser();
    const ownerApprover = await makeUser();
    const outsider = await makeUser();
    const outsiderApprover = await makeUser();
    const mine = await makeApproval(outsider, [outsiderApprover]);
    const before = {
      dash: (await outsider.api.get('/api/dashboard')).body,
      summary: (await outsider.api.get('/api/reports/summary')).body,
      list: (await outsider.api.get('/api/documents')).body.total,
    };
    const foreign = await makeGpm(owner, [ownerApprover], { title: 'Секретная сделка' });
    await owner.api.post(`/api/documents/${foreign.id}/remind`);
    const r = await outsider.api.get(`/api/documents?q=${encodeURIComponent(foreign.number)}`);
    expectStatus(r, 200);
    assert.equal(r.body.total, 0);
    assert.deepEqual(r.body.items, []);
    for (const q of [`deal=${foreign.deal!.id}`, 'status=in_review', `initiatorId=${owner.id}`, 'overdue=false']) {
      const list = await outsider.api.get(`/api/documents?${q}`);
      expectStatus(list, 200, q);
      assert.equal(list.body.items.some((i: { id: number }) => i.id === foreign.id), false, q);
    }
    const afterDash = (await outsider.api.get('/api/dashboard')).body;
    const afterSummary = (await outsider.api.get('/api/reports/summary')).body;
    assert.deepEqual(afterDash, before.dash);
    assert.deepEqual(afterSummary, before.summary);
    assert.equal((await outsider.api.get('/api/documents')).body.total, before.list);
    const rep = await outsider.api.get('/api/reports/approvals_in_progress');
    assert.deepEqual(rep.body.items.map((i: { id: number }) => i.id), [mine.id]);
    const byEmployee = await outsider.api.get('/api/reports/approvals_by_employee');
    assert.equal(byEmployee.body.items.some((i: { user: { id: number } }) => i.user.id === ownerApprover.id), false);
    // Роль «Контроль документов» видит всё.
    const auditor = await makeUser({ roles: ['employee', 'auditor'] });
    const all = await auditor.api.get(`/api/documents?q=${encodeURIComponent(foreign.number)}`);
    assert.deepEqual(all.body.items.map((i: { id: number }) => i.id), [foreign.id]);
  });

  test('фильтры списка документов и разбивка на страницы', async () => {
    const initiator = await makeUser({ department: 'Finance' });
    const a = await makeUser();
    const d1 = await makeApproval(initiator, [a], { launch: false });
    const d2 = await makeApproval(initiator, [a]);
    const d3 = await makeGpm(initiator, [a]);
    const page1 = await initiator.api.get('/api/documents?scope=mine&pageSize=2&page=1');
    const page2 = await initiator.api.get('/api/documents?scope=mine&pageSize=2&page=2');
    assert.equal(page1.body.total, 3);
    assert.equal(page1.body.items.length, 2);
    assert.equal(page2.body.items.length, 1);
    const drafts = await initiator.api.get('/api/documents?status=draft');
    assert.deepEqual(drafts.body.items.map((i: { id: number }) => i.id), [d1.id]);
    const multi = await initiator.api.get('/api/documents?status=draft,in_review&kind=approval');
    assert.equal(multi.body.total, 3);
    const byType = await initiator.api.get(`/api/documents?typeId=${await typeId('GPM')}`);
    assert.deepEqual(byType.body.items.map((i: { id: number }) => i.id), [d3.id]);
    const today = new Date().toISOString().slice(0, 10);
    const period = await initiator.api.get(`/api/documents?createdFrom=${today}&createdTo=${today}&departmentId=${initiator.departmentId}`);
    assert.equal(period.body.total, 3);
    expectStatus(await initiator.api.get('/api/documents?status=unknown'), 400);
    expectStatus(await initiator.api.get('/api/documents?pageSize=1000'), 400);
    const toApprove = await a.api.get('/api/documents?scope=to_approve');
    assert.deepEqual(toApprove.body.items.map((i: { id: number }) => i.id).sort(), [d2.id, d3.id].sort());
  });
});

describe('Нумерация', () => {
  test('параллельное создание 50 карточек — уникальные номера', async () => {
    const users = await makeUsers(5);
    const tid = await typeId('APPROVAL');
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => users[i % users.length].api.post('/api/documents', { typeId: tid, title: `Параллельная ${i}` })),
    );
    for (const r of results) expectStatus(r, 201);
    const numbers = results.map((r) => r.body.number as string);
    assert.equal(new Set(numbers).size, 50);
    const year = new Date().getFullYear();
    for (const n of numbers) assert.match(n, new RegExp(`^СГЛ-${year}-\\d{6}$`));
    const seqs = numbers.map((n) => Number(n.slice(-6))).sort((x, y) => x - y);
    assert.equal(seqs[seqs.length - 1] - seqs[0], 49, 'номера идут подряд, без пропусков');
    // Поручения нумеруются отдельным счётчиком.
    const tasks = await Promise.all(
      Array.from({ length: 10 }, (_, i) => users[0].api.post('/api/tasks', { title: `Поручение ${i}`, assigneeId: users[1].id })),
    );
    assert.equal(new Set(tasks.map((t) => t.body.number)).size, 10);
  });
});
