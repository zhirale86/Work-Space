/**
 * Имитация HTTP API в браузере: разбор адреса, сессия, защита от CSRF, маршрутизация
 * и ответы строго по контракту api-types.ts (включая коды и тексты ошибок).
 */
import type {
  AdminCreateDocTypeRequest,
  AdminCreateUserRequest,
  ApiErrorBody,
  CreateDocumentRequest,
  CreateTaskRequest,
  CurrentUser,
  Decision,
  MetaResponse,
  NotificationItem,
  RouteChangeRequest,
  RouteMode,
  SystemRole,
  UpdateDocumentRequest,
  UpdateTaskRequest,
} from '../api/types';
import {
  BITRIX_STATE_LABELS,
  DECISION_LABELS,
  DOC_KIND_LABELS,
  DOC_STATUS_LABELS,
  FILE_ROLE_LABELS,
  NOTIFICATION_TYPE_LABELS,
  ORDER_STATUS_LABELS,
  REPORT_LABELS,
  ROLE_LABELS,
  ROUND_OUTCOME_LABELS,
  ROUTE_MODE_LABELS,
  STEP_STATE_LABELS,
  TASK_STATUS_LABELS,
  labeled,
} from '../../../server/src/labels';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../../../server/src/errors';
import * as admin from './admin';
import { BitrixError, getDeal, getLink, listMockDeals, getMockDeal, deleteMockTask, completeMockTask, processBitrixQueue, searchDeals, toLinkInfo } from './bitrix';
import { type Actor, actorOfUser, audit, entityHistory, isoReq, iso, pageOf, paging, requireDocument, requireDocumentForManage, requireInitiatorOrAdmin, requireTask, toUserRef } from './core';
import { db, now, saveSoon } from './db';
import * as docs from './documents';
import { LIMITS, deleteFile, openDownload, saveFile, sha256Hex, type UploadTarget } from './files';
import { checkDeadlines, dashboard, report, reportSummary } from './reports';
import { allApprovals, drill, myApprovals } from './reportsExt';
import { getOrderRequest, listOrderRequests, orderRequestFile, orderRequestState, sendOrderRequest } from './orderRequests';
import * as tasks from './tasks';

export interface DemoRequest {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}
export interface DemoResponse {
  status: number;
  json?: unknown;
  file?: { name: string; mime: string; bytes: Uint8Array };
}

type Body = Record<string, unknown>;
interface Ctx {
  params: Record<string, string>;
  query: Record<string, string>;
  body: Body;
  form: FormData | null;
  actor: Actor;
  setStatus: (s: number) => void;
}
type Handler = (c: Ctx) => unknown | Promise<unknown>;

const routes: Array<{ method: string; re: RegExp; keys: string[]; handler: Handler; public?: boolean }> = [];
function route(method: string, pattern: string, handler: Handler, opts: { public?: boolean } = {}): void {
  const keys: string[] = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_m, k: string) => (keys.push(k), '([^/]+)'))}$`);
  routes.push({ method, re, keys, handler, public: opts.public });
}

// ───────────── Разбор параметров ─────────────

const DOC_STATUSES = ['draft', 'in_review', 'rework', 'on_signing', 'approved', 'rejected', 'cancelled', 'archived'];
const TASK_STATUSES = ['new', 'in_progress', 'review', 'done', 'cancelled'];
const invalid = (field: string, message = 'Недопустимое значение') => badRequest('Некорректные данные запроса', [{ field, message }]);

function idOf(v: string | undefined, field = 'id'): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw invalid(field);
  return n;
}
const optId = (v: string | undefined, field: string): number | undefined => (v === undefined || v === '' ? undefined : idOf(v, field));
function optBool(v: string | undefined, field: string): boolean | undefined {
  if (v === undefined || v === '') return undefined;
  if (!['true', 'false', '1', '0'].includes(v)) throw invalid(field, 'Недопустимое значение. Возможные: true, false, 1, 0');
  return v === 'true' || v === '1';
}
function statuses(v: string | undefined, allowed: string[]): string[] | undefined {
  if (!v) return undefined;
  const list = v.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.some((s) => !allowed.includes(s))) throw invalid('status', 'Недопустимый статус');
  return list;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string, required = false): T | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw invalid(field, 'Обязательное поле');
    return undefined;
  }
  if (!allowed.includes(v as T)) throw invalid(field, `Недопустимое значение. Возможные: ${allowed.join(', ')}`);
  return v as T;
}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
function idList(v: unknown, field: string): number[] {
  if (!Array.isArray(v) || v.some((x) => !Number.isInteger(x) || x <= 0)) throw invalid(field, 'Недопустимый тип значения');
  return v as number[];
}
function dateQ(v: string | undefined, field: string): string | undefined {
  if (!v) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw invalid(field, 'Дата в формате ГГГГ-ММ-ДД');
  return v;
}

const ok = { ok: true as const };
const detailOrOk = <T>(d: T | null): T | { ok: true } => d ?? ok;

function requireRole(actor: Actor, role: SystemRole): void {
  if (!actor.roles.includes(role)) throw forbidden(`Действие доступно только пользователям с ролью «${ROLE_LABELS[role]}»`);
}

function currentUser(actorId: number): CurrentUser {
  const u = db.users.find((x) => x.id === actorId)!;
  return { ...toUserRef(u), login: u.login, roles: u.roles, roleLabels: u.roles.map((r) => ROLE_LABELS[r] ?? r), mustChangePassword: u.must_change_password };
}

const wrapBitrix = (fn: () => unknown) => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof BitrixError) throw new AppError(502, 'bitrix_unavailable', err.message);
    throw err;
  }
};

// ───────────── Вход ─────────────

route(
  'POST',
  '/auth/login',
  (c) => {
    const login = str(c.body.login)?.trim().toLowerCase() ?? '';
    if (!login || !str(c.body.password)) throw badRequest('Некорректные данные запроса', [{ field: !login ? 'login' : 'password', message: 'Обязательное поле' }]);
    const u = db.users.find((x) => x.login === login);
    // Демо: пароль не проверяется — вход выполняется выбором сотрудника.
    if (!u || !u.active) throw new AppError(401, 'invalid_credentials', 'Неверный логин или пароль');
    db.session.userId = u.id;
    audit({ actorId: u.id, entityType: 'auth', entityId: u.id, action: 'auth.login', summary: 'Вход в систему' });
    return { user: currentUser(u.id) };
  },
  { public: true },
);
route('POST', '/auth/logout', (c) => {
  audit({ actorId: c.actor.id, entityType: 'auth', entityId: c.actor.id, action: 'auth.logout', summary: 'Выход из системы' });
  db.session.userId = null;
  return ok;
});
route('GET', '/auth/me', (c) => ({ user: currentUser(c.actor.id) }));
route('POST', '/auth/change-password', (c) => {
  admin.checkPasswordStrength(str(c.body.newPassword) ?? '');
  const u = db.users.find((x) => x.id === c.actor.id)!;
  u.must_change_password = false;
  audit({ actorId: u.id, entityType: 'user', entityId: u.id, action: 'user.password_changed', summary: 'Пароль изменён' });
  return ok;
});
route('GET', '/health', () => ok, { public: true });

// ───────────── Справочники ─────────────

route('GET', '/users', (c) => {
  const pg = paging(c.query);
  const list = admin.searchUsers({ q: c.query.q, departmentId: optId(c.query.departmentId, 'departmentId'), active: true, role: oneOf(c.query.role, ['employee', 'signer', 'admin', 'auditor'] as const, 'role') });
  const page = pageOf(list, pg);
  return { ...page, items: page.items.map(toUserRef) };
});
route('GET', '/departments', () => ({ items: admin.listDepartments(true) }));
route('GET', '/doc-types', () => ({ items: admin.listDocTypes(true) }));
route('GET', '/meta', (): MetaResponse => ({
  roles: labeled(ROLE_LABELS),
  docKinds: labeled(DOC_KIND_LABELS),
  docStatuses: labeled(DOC_STATUS_LABELS),
  orderStatuses: labeled(ORDER_STATUS_LABELS),
  routeModes: labeled(ROUTE_MODE_LABELS),
  roundOutcomes: labeled(ROUND_OUTCOME_LABELS),
  stepStates: labeled(STEP_STATE_LABELS),
  decisions: labeled(DECISION_LABELS),
  taskStatuses: labeled(TASK_STATUS_LABELS),
  fileRoles: labeled(FILE_ROLE_LABELS),
  bitrixLinkStates: labeled(BITRIX_STATE_LABELS),
  notificationTypes: labeled(NOTIFICATION_TYPE_LABELS),
  reports: labeled(REPORT_LABELS),
  limits: { ...LIMITS, allowedExtensions: [...LIMITS.allowedExtensions] },
  bitrixMode: 'mock',
}));

// ───────────── Документы ─────────────

route('GET', '/documents', (c) => {
  const qy = c.query;
  return docs.queryDocuments(
    c.actor,
    {
      q: qy.q,
      scope: oneOf(qy.scope, ['all', 'mine', 'to_approve', 'to_sign', 'to_acknowledge'] as const, 'scope'),
      kind: oneOf(qy.kind, ['approval', 'order'] as const, 'kind'),
      typeId: optId(qy.typeId, 'typeId'),
      statuses: statuses(qy.status, DOC_STATUSES),
      initiatorId: optId(qy.initiatorId, 'initiatorId'),
      departmentId: optId(qy.departmentId, 'departmentId'),
      createdFrom: dateQ(qy.createdFrom, 'createdFrom'),
      createdTo: dateQ(qy.createdTo, 'createdTo'),
      deal: qy.deal,
      overdue: optBool(qy.overdue, 'overdue'),
    },
    paging(qy),
  );
});
route('POST', '/documents', (c) => {
  c.setStatus(201);
  return docs.createDocument(c.actor, { ...(c.body as unknown as CreateDocumentRequest), typeId: idOf(String(c.body.typeId ?? ''), 'typeId') });
});
route('GET', '/documents/:id', (c) => docs.getDocumentDetail(c.actor, idOf(c.params.id)));
route('PATCH', '/documents/:id', (c) => docs.updateDocument(c.actor, idOf(c.params.id), c.body as UpdateDocumentRequest));
route('DELETE', '/documents/:id', (c) => (docs.deleteDocument(c.actor, idOf(c.params.id)), ok));
route('POST', '/documents/:id/copy', (c) => {
  c.setStatus(201);
  return docs.copyDocument(c.actor, idOf(c.params.id));
});
route('PUT', '/documents/:id/access', (c) => docs.setAccess(c.actor, idOf(c.params.id), idList(c.body.userIds, 'userIds'), idList(c.body.departmentIds, 'departmentIds')));
route('GET', '/documents/:id/history', (c) => {
  const id = idOf(c.params.id);
  requireDocument(c.actor, id);
  return entityHistory('document', id, paging(c.query, 50));
});
route('GET', '/documents/:id/comments', (c) => {
  const id = idOf(c.params.id);
  requireDocument(c.actor, id);
  return { items: docs.loadComments('document', id) };
});
route('POST', '/documents/:id/comments', (c) => {
  c.setStatus(201);
  return docs.addDocumentComment(c.actor, idOf(c.params.id), str(c.body.body) ?? '');
});

route('POST', '/documents/:id/launch', (c) => docs.launchDocument(c.actor, idOf(c.params.id), oneOf<RouteMode>(c.body.routeMode, ['sequential', 'parallel'], 'routeMode')));
route('POST', '/documents/:id/decision', (c) =>
  docs.decide(c.actor, idOf(c.params.id), oneOf<Decision>(c.body.decision, ['approve', 'rework', 'reject'], 'decision', true)!, str(c.body.comment)),
);
route('PUT', '/documents/:id/route', (c) => {
  const action = oneOf(c.body.action, ['replace', 'add'] as const, 'action', true)!;
  const input = { ...c.body, action, reason: str(c.body.reason) ?? '', toUserId: idOf(String(c.body.toUserId ?? ''), 'toUserId') } as RouteChangeRequest;
  if (input.action === 'replace') input.fromUserId = idOf(String(c.body.fromUserId ?? ''), 'fromUserId');
  return detailOrOk(docs.changeRoute(c.actor, idOf(c.params.id), input));
});
route('POST', '/documents/:id/cancel', (c) => detailOrOk(docs.cancelDocument(c.actor, idOf(c.params.id), str(c.body.reason) ?? '')));
route('POST', '/documents/:id/remind', (c) => docs.remind(c.actor, idOf(c.params.id)));
route('POST', '/documents/:id/sign', (c) =>
  docs.signOrder(c.actor, idOf(c.params.id), oneOf<Decision>(c.body.decision, ['approve', 'rework', 'reject'], 'decision', true)!, str(c.body.comment)),
);
route('POST', '/documents/:id/archive', (c) => detailOrOk(docs.archiveOrder(c.actor, idOf(c.params.id))));
route('POST', '/documents/:id/acknowledge', (c) => docs.acknowledge(c.actor, idOf(c.params.id)));
route('PUT', '/documents/:id/acquaintance', (c) => docs.setAcquaintance(c.actor, idOf(c.params.id), idList(c.body.userIds, 'userIds')));

// ───────────── Файлы ─────────────

async function receive(c: Ctx, target: UploadTarget) {
  const file = c.form?.get('file');
  if (!c.form) throw badRequest('Ожидается загрузка файла в формате multipart/form-data (поле «file»)');
  if (!(file instanceof Blob)) throw badRequest('Файл не передан: ожидается поле «file»');
  const name = (file as File).name || 'file';
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha = await sha256Hex(bytes);
  c.setStatus(201);
  return saveFile(c.actor, target, name, bytes, sha);
}
route('POST', '/documents/:id/files', (c) =>
  receive(c, { kind: 'new', ownerType: 'document', ownerId: idOf(c.params.id), role: oneOf(c.query.role, ['main', 'attachment'] as const, 'role') ?? 'attachment', title: c.query.title }),
);
route('POST', '/tasks/:id/files', (c) =>
  receive(c, { kind: 'new', ownerType: 'task', ownerId: idOf(c.params.id), role: oneOf(c.query.role, ['attachment', 'result'] as const, 'role') ?? 'attachment', title: c.query.title }),
);
route('POST', '/files/:fileId/versions', (c) => receive(c, { kind: 'version', fileId: idOf(c.params.fileId, 'fileId') }));
route('DELETE', '/files/:fileId', (c) => (deleteFile(c.actor, idOf(c.params.fileId, 'fileId')), ok));
route('GET', '/file-versions/:id/download', (c) => ({ __file: openDownload(c.actor, idOf(c.params.id)) }));

// ───────────── Поручения ─────────────

route('GET', '/tasks', (c) =>
  tasks.queryTasks(
    c.actor,
    {
      q: c.query.q,
      scope: oneOf(c.query.scope, ['all', 'assigned', 'authored'] as const, 'scope'),
      statuses: statuses(c.query.status, TASK_STATUSES),
      overdue: optBool(c.query.overdue, 'overdue'),
      documentId: optId(c.query.documentId, 'documentId'),
    },
    paging(c.query),
  ),
);
route('POST', '/tasks', (c) => {
  c.setStatus(201);
  if (typeof c.body.title !== 'string') throw invalid('title', 'Обязательное поле');
  return tasks.createTask(c.actor, { ...(c.body as unknown as CreateTaskRequest), assigneeId: idOf(String(c.body.assigneeId ?? ''), 'assigneeId') });
});
route('GET', '/tasks/:id', (c) => tasks.getTaskDetail(c.actor, idOf(c.params.id)));
route('PATCH', '/tasks/:id', (c) => tasks.updateTask(c.actor, idOf(c.params.id), c.body as UpdateTaskRequest));
route('POST', '/tasks/:id/start', (c) => tasks.transitionTask(c.actor, idOf(c.params.id), 'start'));
route('POST', '/tasks/:id/submit', (c) => tasks.transitionTask(c.actor, idOf(c.params.id), 'submit', str(c.body.resultText)));
route('POST', '/tasks/:id/accept', (c) => tasks.transitionTask(c.actor, idOf(c.params.id), 'accept'));
route('POST', '/tasks/:id/return', (c) => tasks.transitionTask(c.actor, idOf(c.params.id), 'return', str(c.body.comment)));
route('POST', '/tasks/:id/cancel', (c) => tasks.transitionTask(c.actor, idOf(c.params.id), 'cancel', str(c.body.reason)));
route('GET', '/tasks/:id/history', (c) => {
  const id = idOf(c.params.id);
  requireTask(c.actor, id);
  return entityHistory('task', id, paging(c.query, 50));
});
route('GET', '/tasks/:id/comments', (c) => {
  const id = idOf(c.params.id);
  requireTask(c.actor, id);
  return { items: docs.loadComments('task', id) };
});
route('POST', '/tasks/:id/comments', (c) => {
  c.setStatus(201);
  return tasks.addTaskComment(c.actor, idOf(c.params.id), str(c.body.body) ?? '');
});

// ───────────── Уведомления, главная, отчёты ─────────────

route('GET', '/notifications', (c) => {
  const unread = optBool(c.query.unread, 'unread');
  const list = db.notifications.filter((n) => n.user_id === c.actor.id && (!unread || n.read_at === null)).sort((a, b) => b.id - a.id);
  const page = pageOf(list, paging(c.query));
  return {
    ...page,
    items: page.items.map(
      (r): NotificationItem => ({
        id: r.id,
        type: r.type,
        typeLabel: NOTIFICATION_TYPE_LABELS[r.type] ?? r.type,
        title: r.title,
        body: r.body,
        entityType: r.entity_type,
        entityId: r.entity_id,
        createdAt: isoReq(r.created_at),
        readAt: iso(r.read_at),
      }),
    ),
  };
});
route('GET', '/notifications/unread-count', (c) => ({ count: db.notifications.filter((n) => n.user_id === c.actor.id && n.read_at === null).length }));
route('POST', '/notifications/:id/read', (c) => {
  const n = db.notifications.find((x) => x.id === idOf(c.params.id) && x.user_id === c.actor.id);
  if (!n) throw notFound('Уведомление не найдено');
  n.read_at ??= now();
  return ok;
});
route('POST', '/notifications/read-all', (c) => {
  for (const n of db.notifications) if (n.user_id === c.actor.id && n.read_at === null) n.read_at = now();
  return ok;
});
route('GET', '/dashboard', (c) => dashboard(c.actor));
route('GET', '/reports/summary', (c) => reportSummary(c.actor));
route('GET', '/report-ext/my', (c) => myApprovals(c.actor));
route('GET', '/report-ext/drill', (c) => drill(c.actor, c.query, paging(c.query, 25)));
route('GET', '/report-ext/all', (c) => allApprovals(c.actor, c.query, paging(c.query, 25)));
route('GET', '/reports/:code', (c) =>
  report(c.actor, decodeURIComponent(c.params.code), { userId: optId(c.query.userId, 'userId'), departmentId: optId(c.query.departmentId, 'departmentId') }, paging(c.query)),
);

// ───────────── Битрикс24 ─────────────

route('GET', '/bitrix/deals', (c) => wrapBitrix(() => ({ items: searchDeals(c.query.q ?? '') })));
route('GET', '/bitrix/deals/:id', (c) => {
  if (!/^\d{1,12}$/.test(c.params.id)) throw invalid('id', 'Некорректный идентификатор сделки');
  const deal = wrapBitrix(() => getDeal(c.params.id)) as ReturnType<typeof getDeal>;
  if (!deal) throw notFound('Сделка не найдена');
  return { id: deal.id, title: deal.title, url: deal.url };
});
route('POST', '/documents/:id/bitrix/retry', (c) => {
  const id = idOf(c.params.id);
  const doc = requireDocumentForManage(c.actor, id);
  requireInitiatorOrAdmin(doc, c.actor);
  const link = getLink(id);
  if (!link) throw conflict('По документу нет записи для передачи в Битрикс24');
  link.state = 'pending';
  link.next_attempt_at = now();
  audit({ actorId: c.actor.id, entityType: 'document', entityId: id, action: 'bitrix.retry_requested', summary: 'Запрошена повторная передача в Битрикс24' });
  processBitrixQueue({ documentId: id, force: true });
  return { bitrix: toLinkInfo(getLink(id)!) };
});
route('GET', '/bitrix-mock/deals', (c) => ({ items: listMockDeals(c.query.q ?? '') }));
route('GET', '/documents/:id/order-request', (c) => orderRequestState(c.actor, idOf(c.params.id)));
route('POST', '/documents/:id/order-request', (c) => sendOrderRequest(c.actor, idOf(c.params.id), (c.body ?? {}) as { comment?: unknown }));
route('GET', '/bitrix-mock/order-requests', (c) => listOrderRequests(c.query.dealId || undefined));
route('GET', '/bitrix-mock/order-requests/:id', (c) => getOrderRequest(idOf(c.params.id)));
route('GET', '/bitrix-mock/order-requests/:id/file', (c) => ({ __file: orderRequestFile(idOf(c.params.id)) }));
route('GET', '/bitrix-mock/deals/:id', (c) => getMockDeal(idOf(c.params.id)));
route('DELETE', '/bitrix-mock/tasks/:id', (c) => {
  requireRole(c.actor, 'admin');
  deleteMockTask(idOf(c.params.id));
  return ok;
});
route('POST', '/bitrix-mock/tasks/:id/complete', (c) => {
  requireRole(c.actor, 'admin');
  completeMockTask(idOf(c.params.id));
  return ok;
});

// ───────────── Администрирование ─────────────

const adm = (method: string, pattern: string, handler: Handler) =>
  route(method, pattern, (c) => {
    requireRole(c.actor, 'admin');
    return handler(c);
  });
const ROLES = ['employee', 'signer', 'admin', 'auditor'] as const;

adm('GET', '/admin/users', (c) =>
  admin.listUsers(
    { q: c.query.q, departmentId: optId(c.query.departmentId, 'departmentId'), active: optBool(c.query.active, 'active'), role: oneOf(c.query.role, ROLES, 'role') },
    paging(c.query),
  ),
);
adm('POST', '/admin/users', (c) => {
  c.setStatus(201);
  return admin.createUser(c.actor.id, c.body as unknown as AdminCreateUserRequest);
});
adm('GET', '/admin/users/:id', (c) => admin.getUser(idOf(c.params.id)));
adm('PATCH', '/admin/users/:id', (c) => admin.updateUser(c.actor, idOf(c.params.id), c.body));
adm('POST', '/admin/users/:id/block', (c) => admin.setUserActive(c.actor, idOf(c.params.id), false));
adm('POST', '/admin/users/:id/unblock', (c) => admin.setUserActive(c.actor, idOf(c.params.id), true));
adm('POST', '/admin/users/:id/reset-password', (c) => ({ temporaryPassword: admin.resetPassword(c.actor, idOf(c.params.id), str(c.body.password)) }));
adm('GET', '/admin/departments', () => ({ items: admin.listDepartments(false) }));
adm('POST', '/admin/departments', (c) => {
  c.setStatus(201);
  return admin.createDepartment(c.actor.id, str(c.body.name) ?? '');
});
adm('PATCH', '/admin/departments/:id', (c) => admin.updateDepartment(c.actor, idOf(c.params.id), c.body as { name?: string; active?: boolean }));
adm('GET', '/admin/doc-types', () => ({ items: admin.listDocTypes(false) }));
adm('POST', '/admin/doc-types', (c) => {
  const b = c.body as unknown as AdminCreateDocTypeRequest;
  if (!/^[A-Za-z0-9_]{2,30}$/.test(b.code ?? '')) throw invalid('code', 'Код: 2–30 символов — латинские буквы, цифры, подчёркивание');
  if (!/^[A-Za-zА-Яа-яЁё0-9]{1,10}$/.test(b.numberPrefix ?? '')) throw invalid('numberPrefix', 'Префикс: 1–10 букв или цифр');
  oneOf(b.kind, ['approval', 'order'] as const, 'kind', true);
  c.setStatus(201);
  return admin.createDocType(c.actor.id, b);
});
adm('PATCH', '/admin/doc-types/:id', (c) => {
  if (c.body.numberPrefix !== undefined && !/^[A-Za-zА-Яа-яЁё0-9]{1,10}$/.test(String(c.body.numberPrefix))) throw invalid('numberPrefix', 'Префикс: 1–10 букв или цифр');
  return admin.updateDocType(c.actor, idOf(c.params.id), c.body);
});
adm('GET', '/admin/bitrix', () => admin.bitrixState());
adm('PUT', '/admin/bitrix/mock', (c) => {
  if (typeof c.body.unavailable !== 'boolean') throw invalid('unavailable', 'Обязательное поле');
  admin.setMockUnavailable(c.actor, c.body.unavailable);
  return admin.bitrixState();
});
adm('POST', '/admin/bitrix/retry', (c) => {
  const documentId = c.body.documentId === undefined ? undefined : idOf(String(c.body.documentId), 'documentId');
  const list = db.bitrixLinks.filter((l) => (l.state === 'pending' || l.state === 'error') && (documentId === undefined || l.document_id === documentId));
  if (documentId && !list.length) throw conflict('По документу нет записей, ожидающих передачи');
  for (const l of list) {
    l.state = 'pending';
    l.next_attempt_at = now();
  }
  audit({
    actorId: c.actor.id,
    entityType: documentId ? 'document' : 'bitrix',
    entityId: documentId ?? null,
    action: 'bitrix.retry_requested',
    summary: documentId ? 'Запрошена повторная передача в Битрикс24' : 'Запрошена повторная передача в Битрикс24 всех ожидающих записей',
  });
  return processBitrixQueue({ documentId, force: true });
});
adm('GET', '/admin/audit', (c) =>
  admin.auditList(
    c.actor,
    {
      entityType: c.query.entityType,
      entityId: optId(c.query.entityId, 'entityId'),
      actorId: optId(c.query.actorId, 'actorId'),
      action: c.query.action,
      from: dateQ(c.query.from, 'from'),
      to: dateQ(c.query.to, 'to'),
      q: c.query.q,
    },
    paging(c.query, 50),
  ),
);
adm('GET', '/admin/documents', (c) =>
  admin.adminDocuments({ q: c.query.q, statuses: c.query.status?.split(',').map((s) => s.trim()).filter(Boolean), initiatorId: optId(c.query.initiatorId, 'initiatorId') }, paging(c.query)),
);
adm('GET', '/admin/documents/:id', (c) => admin.adminDocument(idOf(c.params.id)));

// ───────────── Обработка запроса ─────────────

const errorBody = (code: ApiErrorBody['error']['code'], message: string, details?: ApiErrorBody['error']['details']): ApiErrorBody => ({
  error: { code, message, ...(details?.length ? { details } : {}) },
});

/** Фоновые задания сервера (передача в Битрикс24, проверка сроков) — при каждом обращении. */
export function runJobs(): void {
  processBitrixQueue();
  checkDeadlines();
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function handle(req: DemoRequest): Promise<DemoResponse> {
  const u = new URL(req.url, 'http://demo.local');
  const path = u.pathname.replace(/^\/api/, '') || '/';
  const query: Record<string, string> = {};
  u.searchParams.forEach((v, k) => (query[k] = v));
  try {
    if (MUTATING.has(req.method) && req.headers.get('X-Requested-With') !== 'docflow') {
      throw new AppError(403, 'csrf', 'Запрос отклонён: отсутствует заголовок X-Requested-With: docflow');
    }
    const r = routes.find((x) => x.method === req.method && x.re.test(path));
    const anyMethod = routes.some((x) => x.re.test(path));
    const sessionUser = db.session.userId ? db.users.find((x) => x.id === db.session.userId && x.active) : undefined;
    if (!r?.public && !sessionUser) throw unauthorized('Требуется вход в систему');
    if (!r) throw notFound(anyMethod ? 'Маршрут не найден' : 'Маршрут не найден');
    if (sessionUser?.must_change_password && !/^\/(auth\/|meta$)/.test(path)) {
      throw new AppError(403, 'password_change_required', 'Необходимо сменить временный пароль');
    }
    const m = r.re.exec(path)!;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = m[i + 1]));
    let status = 200;
    let body: Body = {};
    let form: FormData | null = null;
    if (req.body instanceof FormData) form = req.body;
    else if (typeof req.body === 'string' && req.body) {
      try {
        body = JSON.parse(req.body) as Body;
      } catch {
        throw badRequest('Некорректный запрос');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) body = {};
    }
    runJobs();
    const actor = sessionUser ? actorOfUser(sessionUser) : ({ id: 0, login: '', fullName: '', roles: [], departmentId: null } as Actor);
    const result = await r.handler({ params, query, body, form, actor, setStatus: (s) => (status = s) });
    if (MUTATING.has(req.method)) runJobs();
    saveSoon();
    if (result && typeof result === 'object' && '__file' in result) return { status: 200, file: (result as { __file: DemoResponse['file'] }).__file };
    return { status, json: result };
  } catch (err) {
    saveSoon();
    if (err instanceof AppError) return { status: err.status, json: errorBody(err.code, err.message, err.details) };
    console.error('Демо-сервер: необработанная ошибка', err);
    return { status: 500, json: errorBody('internal', 'Внутренняя ошибка сервера. Повторите попытку позже') };
  }
}

/** Может ли сотрудник открыть страницу (для переключателя «Войти как…»). */
export function canOpenPath(userId: number, path: string): boolean {
  const u = db.users.find((x) => x.id === userId);
  if (!u) return false;
  const actor = actorOfUser(u);
  const doc = /^\/(?:approvals|orders|documents)\/(\d+)(\/edit)?/.exec(path);
  if (doc) {
    try {
      const d = requireDocument(actor, Number(doc[1]));
      return !doc[2] || (d.initiator_id === actor.id && (d.status === 'draft' || d.status === 'rework'));
    } catch {
      return false;
    }
  }
  const task = /^\/tasks\/(\d+)/.exec(path);
  if (task) {
    try {
      requireTask(actor, Number(task[1]));
      return true;
    } catch {
      return false;
    }
  }
  if (path.startsWith('/admin')) return actor.roles.includes('admin');
  return true;
}
