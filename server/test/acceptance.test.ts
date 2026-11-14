/**
 * Критерии приёмки тестовой модели (ТЗ, раздел 22): №1–16.
 * Критерий 17 (восстановление из резервной копии) — в backup.test.ts.
 */
import './env';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { DocumentDetail, MockDealDetail } from '../src/api-types';
import {
  Client,
  PASSWORD,
  auditOf,
  dealIds,
  expectStatus,
  makeGpm,
  makeUser,
  makeUsers,
  mockTasksOf,
  notificationsOf,
  samplePdf,
  setMockUnavailable,
  setup,
  syncBitrix,
  teardown,
  typeId,
  xlsx,
} from './helpers';

before(setup);
after(teardown);

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('Критерии приёмки', () => {
  test('Критерий 1: вход под тестовой учётной записью — доступ в соответствии с ролью', async () => {
    const employee = await makeUser({ login: false });
    const admin = await makeUser({ roles: ['employee', 'admin'], login: false });
    const anon = new Client();

    // Без сессии API недоступен.
    expectStatus(await anon.get('/api/dashboard'), 401);
    // Неверный пароль — единый ответ без раскрытия причины.
    const bad = await anon.post('/api/auth/login', { login: employee.login, password: 'неверный' });
    expectStatus(bad, 401);
    assert.equal(bad.body.error.code, 'invalid_credentials');

    const e = new Client();
    const login = await e.post('/api/auth/login', { login: employee.login, password: PASSWORD });
    expectStatus(login, 200);
    assert.deepEqual(login.body.user.roles, ['employee']);
    assert.equal(login.body.user.roleLabels[0], 'Сотрудник');
    assert.ok(e.cookie, 'выдана cookie сессии');
    const setCookie = String(login.headers['set-cookie']);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);

    expectStatus(await e.get('/api/auth/me'), 200);
    const dash = await e.get('/api/dashboard');
    expectStatus(dash, 200);
    assert.equal(dash.body.toApprove.count, 0);
    // Сотрудник не имеет доступа к администрированию.
    const denied = await e.get('/api/admin/users');
    expectStatus(denied, 403);
    assert.equal(denied.body.error.code, 'forbidden');

    const a = new Client();
    expectStatus(await a.post('/api/auth/login', { login: admin.login, password: PASSWORD }), 200);
    const users = await a.get('/api/admin/users');
    expectStatus(users, 200);
    assert.ok(users.body.total >= 2);

    // Изменяющий запрос без заголовка X-Requested-With отклоняется.
    const csrf = await a.request('POST', '/api/auth/logout', {}, { 'x-requested-with': '' });
    expectStatus(csrf, 403);
    assert.equal(csrf.body.error.code, 'csrf');

    // Выход завершает сессию.
    const oldCookie = e.cookie;
    expectStatus(await e.post('/api/auth/logout'), 200);
    expectStatus(await new Client(oldCookie).get('/api/auth/me'), 401);
  });

  test('Критерий 2: GPM-согласование без Excel-файла не запускается', async () => {
    const initiator = await makeUser();
    const approver = await makeUser();
    const doc = await makeGpm(initiator, [approver], { file: false, launch: false });
    const r = await initiator.api.post(`/api/documents/${doc.id}/launch`);
    expectStatus(r, 422);
    assert.ok(r.body.error.details.some((d: { field: string }) => d.field === 'mainFile'));

    // PDF в качестве основного документа GPM тоже не подходит.
    expectStatus(await initiator.api.upload(`/api/documents/${doc.id}/files?role=main`, 'расчёт.pdf', samplePdf()), 201);
    const r2 = await initiator.api.post(`/api/documents/${doc.id}/launch`);
    expectStatus(r2, 422);
    assert.match(r2.body.error.details.find((d: { field: string }) => d.field === 'mainFile').message, /Excel/);

    // Без сделки и согласующих — перечень всех замечаний.
    const empty = await initiator.api.post<DocumentDetail>('/api/documents', { typeId: await typeId('GPM') });
    expectStatus(empty, 201);
    const r3 = await initiator.api.post(`/api/documents/${empty.body.id}/launch`);
    expectStatus(r3, 422);
    const fields = r3.body.error.details.map((d: { field: string }) => d.field).sort();
    assert.deepEqual(fields, ['approvers', 'deal', 'mainFile', 'title']);

    const after = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    assert.equal(after.body.status, 'draft');
    assert.equal(after.body.rounds.length, 0);
  });

  test('Критерий 3: Excel-файл, сделка и согласующие — согласование запускается', async () => {
    const initiator = await makeUser();
    const [a1, a2] = await makeUsers(2);
    const deal = (await dealIds())[1];
    const doc = await makeGpm(initiator, [a1, a2], { dealId: deal, launch: false });
    assert.equal(doc.deal?.id, deal);
    assert.ok(doc.deal?.title, 'название сделки сохранено отдельно');
    assert.equal(doc.files[0].currentVersion.ext, 'xlsx');

    const r = await initiator.api.post<DocumentDetail>(`/api/documents/${doc.id}/launch`, { routeMode: 'sequential' });
    expectStatus(r, 200);
    assert.equal(r.body.status, 'in_review');
    assert.equal(r.body.statusLabel, 'На согласовании');
    assert.equal(r.body.rounds.length, 1);
    assert.deepEqual(
      r.body.rounds[0].steps.map((s) => [s.user.id, s.state]),
      [
        [a1.id, 'pending'],
        [a2.id, 'waiting'],
      ],
    );
    assert.equal(r.body.rounds[0].files.length, 1);
    assert.equal((await notificationsOf(a1.id, 'approval_requested')).length, 1);
    assert.equal((await notificationsOf(a2.id, 'approval_requested')).length, 0);
    assert.equal((await auditOf('document', doc.id, 'approval.launched')).length, 1);
    const dash = await a1.api.get('/api/dashboard');
    assert.equal(dash.body.toApprove.count, 1);
    assert.equal(dash.body.toApprove.items[0].id, doc.id);
  });

  test('Критерий 4: согласующий открывает карточку — доступны сведения и файлы', async () => {
    const initiator = await makeUser();
    const approver = await makeUser();
    const doc = await makeGpm(initiator, [approver]);
    const r = await approver.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    expectStatus(r, 200);
    assert.equal(r.body.title, doc.title);
    assert.equal(r.body.deal?.id, doc.deal?.id);
    assert.equal(r.body.myAction, 'approve');
    assert.equal(r.body.permissions.canDecide, true);
    assert.equal(r.body.permissions.canManageFiles, false);
    assert.equal(r.body.files.length, 1);
    const file = await approver.api.get(r.body.files[0].currentVersion.downloadUrl);
    expectStatus(file, 200);
    assert.equal(sha(file.raw), r.body.files[0].currentVersion.sha256);
    assert.equal(sha(file.raw), sha(xlsx()));
    assert.match(String(file.headers['content-disposition']), /^attachment;/);
    assert.equal(file.headers['x-content-type-options'], 'nosniff');
    // История карточки доступна участнику.
    const h = await approver.api.get(`/api/documents/${doc.id}/history`);
    expectStatus(h, 200);
    assert.ok(h.body.items.some((e: { action: string }) => e.action === 'approval.launched'));
  });

  test('Критерий 5: возврат на доработку — инициатор видит комментарий и статус', async () => {
    const initiator = await makeUser();
    const approver = await makeUser();
    const doc = await makeGpm(initiator, [approver]);
    const comment = 'Пересчитайте логистику, GPM ниже порога';
    const r = await approver.api.post(`/api/documents/${doc.id}/decision`, { decision: 'rework', comment });
    expectStatus(r, 200);

    const d = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    assert.equal(d.body.status, 'rework');
    assert.equal(d.body.statusLabel, 'На доработке');
    assert.equal(d.body.myAction, 'rework');
    assert.equal(d.body.rounds[0].outcome, 'rework');
    assert.equal(d.body.rounds[0].steps[0].comment, comment);
    assert.equal(d.body.permissions.canLaunch, true);
    assert.equal(d.body.permissions.canManageFiles, true);
    const n = await notificationsOf(initiator.id, 'approval_rework');
    assert.equal(n.length, 1);
    assert.ok(n[0].body.includes(comment));
    const dash = await initiator.api.get('/api/dashboard');
    assert.equal(dash.body.rework.count, 1);
  });

  test('Критерий 6: новая версия и повторный запуск — предыдущая версия и история сохранены', async () => {
    const initiator = await makeUser();
    const [a1, a2] = await makeUsers(2);
    const doc = await makeGpm(initiator, [a1, a2], { mode: 'parallel' });
    const v1 = doc.files[0].currentVersion;
    expectStatus(await a1.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 200);
    expectStatus(await a2.api.post(`/api/documents/${doc.id}/decision`, { decision: 'rework', comment: 'Исправьте' }), 200);

    const up = await initiator.api.upload(`/api/files/${doc.files[0].id}/versions`, 'GPM_v2.xlsx', xlsx(0.25));
    expectStatus(up, 201);
    assert.equal(up.body.versions.length, 2);
    assert.equal(up.body.currentVersion.versionNo, 2);

    const re = await initiator.api.post<DocumentDetail>(`/api/documents/${doc.id}/launch`);
    expectStatus(re, 200);
    assert.equal(re.body.status, 'in_review');
    assert.equal(re.body.launchCount, 2);
    assert.equal(re.body.rounds.length, 2);
    const [round2, round1] = re.body.rounds;
    assert.equal(round2.roundNo, 2);
    assert.equal(round2.files[0].version.versionNo, 2);
    assert.ok(round2.steps.every((s) => s.state === 'pending'), 'новый раунд — для всех согласующих');
    // Решения первого раунда видны вместе со старой версией файла.
    assert.equal(round1.files[0].version.id, v1.id);
    assert.deepEqual(
      round1.steps.map((s) => s.state),
      ['approved', 'rework'],
    );
    // Старая версия по-прежнему скачивается.
    const old = await a1.api.get(v1.downloadUrl);
    expectStatus(old, 200);
    assert.equal(sha(old.raw), v1.sha256);

    const h = await initiator.api.get(`/api/documents/${doc.id}/history`);
    const actions = h.body.items.map((e: { action: string }) => e.action);
    for (const a of ['document.created', 'file.uploaded', 'approval.launched', 'approval.approved', 'approval.returned', 'file.version_uploaded', 'approval.relaunched']) {
      assert.ok(actions.includes(a), `в истории есть ${a}`);
    }
  });

  test('Критерий 7: все обязательные согласующие согласовали — статус «Согласовано»', async () => {
    const initiator = await makeUser();
    const approvers = await makeUsers(3);
    for (const mode of ['sequential', 'parallel'] as const) {
      const doc = await makeGpm(initiator, approvers, { mode });
      for (let i = 0; i < approvers.length; i++) {
        const before = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
        assert.equal(before.body.status, 'in_review', `${mode}: до последнего решения документ на согласовании`);
        expectStatus(await approvers[i].api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 200);
      }
      const d = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
      assert.equal(d.body.status, 'approved', mode);
      assert.equal(d.body.statusLabel, 'Согласовано');
      assert.equal(d.body.rounds[0].outcome, 'approved');
      assert.ok(d.body.completedAt);
      assert.equal((await notificationsOf(initiator.id, 'approval_completed')).filter((n) => n.entity_id === doc.id).length, 1);
    }
  });

  test('Критерий 8: в связанной сделке согласование видно среди задач', async () => {
    const initiator = await makeUser();
    const approver = await makeUser();
    const deal = (await dealIds())[2];
    const doc = await makeGpm(initiator, [approver], { dealId: deal, title: 'GPM для проверки отображения в сделке' });
    await syncBitrix();
    const r = await approver.api.get<MockDealDetail>(`/api/bitrix-mock/deals/${deal}`);
    expectStatus(r, 200);
    const task = r.body.tasks.find((t) => t.documentId === doc.id);
    assert.ok(task, 'задача согласования есть в сделке');
    assert.equal(task.title, '[На согласовании] GPM для проверки отображения в сделке');
    assert.equal(task.cardUrl, `http://docflow.test/documents/${doc.id}`);
    assert.match(task.description, new RegExp(doc.number));
    assert.match(task.description, /Инициатор: /);
    assert.match(task.description, /Текущие согласующие: /);
    assert.match(task.description, /Дата создания: /);
    const card = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    assert.equal(card.body.bitrix?.state, 'synced');
    assert.equal(card.body.bitrix?.externalTaskId, String(task.id));
    // Ссылка из карточки ведёт в сделку.
    assert.equal(card.body.deal?.url, `http://docflow.test/bitrix-mock/deals/${deal}`);
  });

  test('Критерий 9: переход по ссылке из сделки открывает карточку после проверки доступа', async () => {
    const initiator = await makeUser();
    const approver = await makeUser();
    const outsider = await makeUser();
    const deal = (await dealIds())[3];
    const doc = await makeGpm(initiator, [approver], { dealId: deal });
    await syncBitrix();
    const dealCard = await outsider.api.get<MockDealDetail>(`/api/bitrix-mock/deals/${deal}`);
    const task = dealCard.body.tasks.find((t) => t.documentId === doc.id)!;
    const id = Number(/\/documents\/(\d+)$/.exec(task.cardUrl!)![1]);
    assert.equal(id, doc.id);
    // Участник открывает нужную карточку.
    const ok = await approver.api.get<DocumentDetail>(`/api/documents/${id}`);
    expectStatus(ok, 200);
    assert.equal(ok.body.number, doc.number);
    // Сотрудник без прав — отказ, существование карточки не раскрывается.
    const denied = await outsider.api.get(`/api/documents/${id}`);
    expectStatus(denied, 404);
    assert.equal(denied.body.error.message, 'Документ не найден или нет доступа');
    // Без сессии — требование входа (интерфейс вернёт на карточку после входа).
    expectStatus(await new Client().get(`/api/documents/${id}`), 401);
  });

  test('Критерий 10: изменение статуса передаётся в Битрикс24', async () => {
    const initiator = await makeUser();
    const [a1, a2] = await makeUsers(2);
    const doc = await makeGpm(initiator, [a1, a2], { title: 'Передача статуса' });
    await syncBitrix();
    let [t] = await mockTasksOf(doc.id);
    assert.equal(t.title, '[На согласовании] Передача статуса');
    assert.match(t.description, new RegExp(a1.fullName));

    expectStatus(await a1.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 200);
    await syncBitrix();
    [t] = await mockTasksOf(doc.id);
    assert.match(t.description, new RegExp(`Текущие согласующие: ${a2.fullName}`), 'текущий согласующий обновлён');

    expectStatus(await a2.api.post(`/api/documents/${doc.id}/decision`, { decision: 'rework', comment: 'Нет' }), 200);
    await syncBitrix();
    [t] = await mockTasksOf(doc.id);
    assert.equal(t.title, '[На доработке] Передача статуса');
    assert.equal(t.status, 'in_progress');

    expectStatus(await initiator.api.post(`/api/documents/${doc.id}/cancel`, { reason: 'Сделка отменена клиентом' }), 200);
    await syncBitrix();
    const tasks = await mockTasksOf(doc.id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, '[Отменено] Передача статуса');
    assert.equal(tasks[0].status, 'completed', 'запись закрыта при завершении процесса');
    const card = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    assert.equal(card.body.bitrix?.syncedStatus, 'cancelled');
  });

  test('Критерий 11: Битрикс24 недоступен — ошибка фиксируется, повтор без дублирования', async () => {
    const initiator = await makeUser();
    const approver = await makeUser();
    const admin = await makeUser({ roles: ['employee', 'admin'] });
    // Сделка выбрана, пока Битрикс24 доступен; связь пропадает к моменту запуска.
    const draft = await makeGpm(initiator, [approver], { launch: false });
    await setMockUnavailable(true);
    try {
      // При недоступном Битрикс24 новую сделку выбрать нельзя — понятная ошибка 502.
      const search = await initiator.api.get('/api/bitrix/deals?q=ЦОД');
      expectStatus(search, 502);
      assert.equal(search.body.error.code, 'bitrix_unavailable');
      const launched = await initiator.api.post<DocumentDetail>(`/api/documents/${draft.id}/launch`);
      expectStatus(launched, 200);
      const doc = launched.body;
      assert.equal(doc.status, 'in_review', 'согласование сохранено независимо от Битрикс24');
      await syncBitrix();
      const card = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
      assert.equal(card.body.bitrix?.state, 'error');
      assert.match(card.body.bitrix!.lastError!, /недоступен/);
      assert.equal(card.body.permissions.canRetryBitrix, true);
      assert.ok((await auditOf('document', doc.id, 'bitrix.error')).length >= 1, 'ошибка записана в журнал');
      const state = await admin.api.get('/api/admin/bitrix');
      expectStatus(state, 200);
      assert.ok(state.body.queue.some((q: { documentId: number; link: { state: string } }) => q.documentId === doc.id && q.link.state === 'error'));
      assert.equal((await mockTasksOf(doc.id)).length, 0);

      // Ручной повтор при недоступном Битрикс24 — снова ошибка, запись не создаётся.
      const r1 = await initiator.api.post(`/api/documents/${doc.id}/bitrix/retry`);
      expectStatus(r1, 200);
      assert.equal(r1.body.bitrix.state, 'error');
      assert.equal((await mockTasksOf(doc.id)).length, 0);

      await setMockUnavailable(false);
      const r2 = await initiator.api.post(`/api/documents/${doc.id}/bitrix/retry`);
      expectStatus(r2, 200);
      assert.equal(r2.body.bitrix.state, 'synced');
      const r3 = await admin.api.post('/api/admin/bitrix/retry', { documentId: doc.id });
      expectStatus(r3, 409, 'Нет записей, ожидающих передачи.');
      expectStatus(await initiator.api.post(`/api/documents/${doc.id}/bitrix/retry`), 200);
      const tasks = await mockTasksOf(doc.id);
      assert.equal(tasks.length, 1, 'повторная передача не создаёт дубль');
      assert.equal(tasks[0].title.startsWith('[На согласовании]'), true);
    } finally {
      await setMockUnavailable(false);
    }
  });

  test('Критерий 12: прямая ссылка без прав — доступ к документу и файлам запрещён', async () => {
    const initiator = await makeUser();
    const approver = await makeUser();
    const outsider = await makeUser({ department: 'IT' });
    const admin = await makeUser({ roles: ['employee', 'admin'] });
    const doc = await makeGpm(initiator, [approver]);
    const versionUrl = doc.files[0].currentVersion.downloadUrl;
    for (const u of [outsider, admin]) {
      expectStatus(await u.api.get(`/api/documents/${doc.id}`), 404);
      expectStatus(await u.api.get(versionUrl), 404);
      expectStatus(await u.api.get(`/api/documents/${doc.id}/history`), 404);
      expectStatus(await u.api.get(`/api/documents/${doc.id}/comments`), 404);
      expectStatus(await u.api.post(`/api/documents/${doc.id}/comments`, { body: 'Пытаюсь' }), 404);
      expectStatus(await u.api.upload(`/api/documents/${doc.id}/files`, 'x.pdf', samplePdf()), 404);
      expectStatus(await u.api.post(`/api/documents/${doc.id}/decision`, { decision: 'approve' }), 404);
    }
    // Без сессии файл не отдаётся.
    expectStatus(await new Client().get(versionUrl), 401);
    // Администратор видит только служебные сведения — без названия и файлов.
    const meta = await admin.api.get(`/api/admin/documents/${doc.id}`);
    expectStatus(meta, 200);
    assert.equal(meta.body.number, doc.number);
    assert.equal('title' in meta.body, false);
    assert.equal('files' in meta.body, false);
    // Индивидуальный доступ открывает карточку и файлы.
    expectStatus(await initiator.api.put(`/api/documents/${doc.id}/access`, { userIds: [outsider.id], departmentIds: [] }), 200);
    expectStatus(await outsider.api.get(`/api/documents/${doc.id}`), 200);
    expectStatus(await outsider.api.get(versionUrl), 200);
    // Доступ по подразделению.
    const itColleague = await makeUser({ department: 'IT' });
    expectStatus(await itColleague.api.get(`/api/documents/${doc.id}`), 404);
    expectStatus(
      await initiator.api.put(`/api/documents/${doc.id}/access`, { userIds: [], departmentIds: [outsider.departmentId] }),
      200,
    );
    expectStatus(await itColleague.api.get(`/api/documents/${doc.id}`), 200);
  });

  test('Критерий 13: приказ с ознакомлением — видно, кто ознакомился и когда', async () => {
    const initiator = await makeUser({ department: 'Logistics' });
    const signer = await makeUser({ roles: ['employee', 'signer'] });
    const approver = await makeUser();
    const [e1, e2, e3] = await makeUsers(3);
    const created = await initiator.api.post<DocumentDetail>('/api/documents', {
      typeId: await typeId('ORDER'),
      title: 'О графике дежурств',
      description: 'Порядок дежурств',
      approverIds: [approver.id],
      signerId: signer.id,
      acquaintanceIds: [e1.id, e2.id],
    });
    expectStatus(created, 201);
    const id = created.body.id;
    assert.match(created.body.number, /^ПР-\d{4}-\d{6}$/);
    expectStatus(await initiator.api.upload(`/api/documents/${id}/files?role=main`, 'Приказ.pdf', samplePdf('Order')), 201);
    expectStatus(await initiator.api.post(`/api/documents/${id}/launch`), 200);
    expectStatus(await approver.api.post(`/api/documents/${id}/decision`, { decision: 'approve' }), 200);
    let d = await signer.api.get<DocumentDetail>(`/api/documents/${id}`);
    assert.equal(d.body.status, 'on_signing');
    assert.equal(d.body.myAction, 'sign');
    // До утверждения сотрудник из списка ознакомления карточку не видит.
    expectStatus(await e1.api.get(`/api/documents/${id}`), 404);
    const signed = await signer.api.post<DocumentDetail>(`/api/documents/${id}/sign`, { decision: 'approve' });
    expectStatus(signed, 200);
    assert.equal(signed.body.status, 'approved');
    assert.equal(signed.body.statusLabel, 'Утверждён');
    assert.ok(signed.body.orderDate, 'дата приказа проставлена при утверждении');
    assert.equal((await notificationsOf(e1.id, 'acknowledge_requested')).length, 1);

    const ack = await e1.api.post<DocumentDetail>(`/api/documents/${id}/acknowledge`);
    expectStatus(ack, 200);
    assert.ok(ack.body.myAcknowledgement.acknowledgedAt);
    assert.equal(ack.body.acknowledgements, null, 'сводку видит только ответственный');
    // Список можно дополнять после утверждения, но не сокращать.
    expectStatus(await initiator.api.put(`/api/documents/${id}/acquaintance`, { userIds: [e1.id, e2.id, e3.id] }), 200);
    expectStatus(await initiator.api.put(`/api/documents/${id}/acquaintance`, { userIds: [e1.id, e3.id] }), 409);
    assert.equal((await notificationsOf(e3.id, 'acknowledge_requested')).length, 1);

    d = await initiator.api.get<DocumentDetail>(`/api/documents/${id}`);
    const s = d.body.acknowledgements!;
    assert.equal(s.total, 3);
    assert.equal(s.acknowledged, 1);
    assert.equal(s.pending, 2);
    const item1 = s.items.find((i) => i.user.id === e1.id)!;
    assert.ok(item1.acknowledgedAt);
    assert.equal(item1.fileVersionNo, 1, 'зафиксирована версия приказа');
    assert.equal(s.items.find((i) => i.user.id === e2.id)!.acknowledgedAt, null);
    const bySigner = await signer.api.get<DocumentDetail>(`/api/documents/${id}`);
    assert.equal(bySigner.body.acknowledgements!.acknowledged, 1);
    assert.equal((await auditOf('document', id, 'order.acknowledged')).length, 1);
    // Отчёт «Приказы, ожидающие ознакомления».
    const rep = await initiator.api.get(`/api/reports/orders_pending_acknowledgement`);
    expectStatus(rep, 200);
    const row = rep.body.items.find((i: { id: number }) => i.id === id);
    assert.deepEqual([row.ackTotal, row.ackDone, row.ackPending], [3, 1, 2]);
    // Файлы утверждённого приказа не изменяются.
    expectStatus(await initiator.api.upload(`/api/files/${d.body.files[0].id}/versions`, 'Приказ2.pdf', samplePdf()), 409);
  });

  test('Критерий 14: самостоятельное поручение доступно исполнителю без документа-основания', async () => {
    const author = await makeUser();
    const assignee = await makeUser({ department: 'Engineering' });
    const outsider = await makeUser();
    const r = await author.api.post('/api/tasks', { title: 'Обновить регламент', body: 'Подготовить редакцию', assigneeId: assignee.id, dueAt: '2099-12-31' });
    expectStatus(r, 201);
    assert.match(r.body.number, /^ПОР-\d{4}-\d{6}$/);
    assert.equal(r.body.document, null);
    assert.equal(r.body.status, 'new');
    const list = await assignee.api.get('/api/tasks?scope=assigned');
    expectStatus(list, 200);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.items[0].id, r.body.id);
    const card = await assignee.api.get(`/api/tasks/${r.body.id}`);
    expectStatus(card, 200);
    assert.equal(card.body.document, null);
    assert.equal(card.body.permissions.canSubmit, true);
    assert.equal((await notificationsOf(assignee.id, 'task_assigned')).length, 1);
    const dash = await assignee.api.get('/api/dashboard');
    assert.equal(dash.body.myTasks.count, 1);
    expectStatus(await outsider.api.get(`/api/tasks/${r.body.id}`), 404);
  });

  test('Критерий 15: результат поручения — постановщик принимает или возвращает в работу', async () => {
    const author = await makeUser();
    const assignee = await makeUser();
    const t1 = (await author.api.post('/api/tasks', { title: 'Поручение 1', assigneeId: assignee.id })).body;
    expectStatus(await assignee.api.post(`/api/tasks/${t1.id}/start`), 200);
    const sub = await assignee.api.post(`/api/tasks/${t1.id}/submit`, { resultText: 'Сделано, отчёт приложен' });
    expectStatus(sub, 200);
    assert.equal(sub.body.status, 'review');
    assert.equal((await notificationsOf(author.id, 'task_submitted')).length, 1);
    const authorView = await author.api.get(`/api/tasks/${t1.id}`);
    assert.equal(authorView.body.permissions.canAccept, true);
    assert.equal(authorView.body.permissions.canReturn, true);
    assert.equal((await author.api.get('/api/dashboard')).body.tasksToReview.count, 1);
    // Исполнитель не может принять собственный результат.
    expectStatus(await assignee.api.post(`/api/tasks/${t1.id}/accept`), 403);
    const acc = await author.api.post(`/api/tasks/${t1.id}/accept`);
    expectStatus(acc, 200);
    assert.equal(acc.body.status, 'done');
    assert.equal(acc.body.resultText, 'Сделано, отчёт приложен');

    const t2 = (await author.api.post('/api/tasks', { title: 'Поручение 2', assigneeId: assignee.id })).body;
    expectStatus(await assignee.api.post(`/api/tasks/${t2.id}/submit`, { resultText: 'Черновой результат' }), 200);
    expectStatus(await author.api.post(`/api/tasks/${t2.id}/return`, { comment: '   ' }), 422);
    const ret = await author.api.post(`/api/tasks/${t2.id}/return`, { comment: 'Добавьте расчёт' });
    expectStatus(ret, 200);
    assert.equal(ret.body.status, 'in_progress');
    assert.ok(ret.body.comments.some((c: { body: string }) => c.body === 'Добавьте расчёт'));
    assert.equal((await notificationsOf(assignee.id, 'task_returned')).length, 1);
    expectStatus(await assignee.api.post(`/api/tasks/${t2.id}/submit`, { resultText: 'Расчёт добавлен' }), 200);
    expectStatus(await author.api.post(`/api/tasks/${t2.id}/accept`), 200);
    const h = await author.api.get(`/api/tasks/${t2.id}/history`);
    assert.deepEqual(
      h.body.items.map((e: { action: string }) => e.action).reverse(),
      ['task.created', 'task.submitted', 'task.returned', 'task.submitted', 'task.accepted'],
    );
  });

  test('Критерий 16: поиск по номеру или названию — только доступные результаты', async () => {
    const initiator = await makeUser();
    const approver = await makeUser();
    const outsider = await makeUser();
    const doc = await makeGpm(initiator, [approver], { title: 'Уникальное согласование Альбатрос' });
    const own = await makeGpm(outsider, [approver], { title: 'Альбатрос — своё' });

    const byNumber = await approver.api.get(`/api/documents?q=${encodeURIComponent(doc.number)}`);
    expectStatus(byNumber, 200);
    assert.deepEqual(byNumber.body.items.map((i: { id: number }) => i.id), [doc.id]);
    const byTitle = await initiator.api.get(`/api/documents?q=${encodeURIComponent('альбатрос')}`);
    assert.deepEqual(byTitle.body.items.map((i: { id: number }) => i.id), [doc.id]);
    const both = await approver.api.get(`/api/documents?q=${encodeURIComponent('Альбатрос')}`);
    assert.deepEqual(both.body.items.map((i: { id: number }) => i.id).sort(), [doc.id, own.id].sort());
    // Чужая карточка не находится ни по номеру, ни по названию.
    const foreign = await outsider.api.get(`/api/documents?q=${encodeURIComponent(doc.number)}`);
    assert.equal(foreign.body.total, 0);
    const foreignTitle = await outsider.api.get(`/api/documents?q=${encodeURIComponent('Уникальное')}`);
    assert.equal(foreignTitle.body.total, 0);
    // Поиск по названию сделки.
    const byDeal = await initiator.api.get(`/api/documents?deal=${encodeURIComponent(doc.deal!.title!.slice(0, 10))}`);
    assert.ok(byDeal.body.items.some((i: { id: number }) => i.id === doc.id));
    // Поиск поручения по номеру.
    const t = (await initiator.api.post('/api/tasks', { title: 'Поручение Альбатрос', assigneeId: approver.id })).body;
    const tq = await approver.api.get(`/api/tasks?q=${encodeURIComponent(t.number)}`);
    assert.deepEqual(tq.body.items.map((i: { id: number }) => i.id), [t.id]);
    assert.equal((await outsider.api.get(`/api/tasks?q=${encodeURIComponent(t.number)}`)).body.total, 0);
  });
});
