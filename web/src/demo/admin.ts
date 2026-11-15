/** Администрирование (server/src/admin): сотрудники, подразделения, типы документов, Битрикс24, журнал. */
import type {
  AdminAuditEntry,
  AdminBitrixState,
  AdminCreateDocTypeRequest,
  AdminCreateUserRequest,
  AdminDocumentDetail,
  AdminDocumentItem,
  AdminUpdateDocTypeRequest,
  AdminUpdateUserRequest,
  AdminUser,
  Department,
  DocType,
  Page,
  SystemRole,
} from '../api/types';
import { DOC_KIND_LABELS, ROLE_LABELS, ROUTE_MODE_LABELS, docStatusLabel } from '../../../server/src/labels';
import { badRequest, conflict, notFound, unprocessable } from '../../../server/src/errors';
import { getLink, toLinkInfo } from './bitrix';
import { type Actor, type Paging, audit, clean, deptRef, fail422, ilike, isAuditor, isoReq, iso, mapHistory, notify, pageOf, refOf } from './core';
import { type DocRow, type UserRow, db, nextId, now } from './db';
import { toDocType, toStep } from './documents';

function toAdminUser(u: UserRow): AdminUser {
  return {
    id: u.id,
    login: u.login,
    fullName: u.full_name,
    position: u.position,
    department: deptRef(u.department_id),
    active: u.active,
    roles: u.roles,
    roleLabels: u.roles.map((r) => ROLE_LABELS[r] ?? r),
    mustChangePassword: u.must_change_password,
    createdAt: isoReq(u.created_at),
  };
}

const sortUsers = (a: UserRow, b: UserRow): number => a.full_name.localeCompare(b.full_name, 'ru') || a.id - b.id;

export function searchUsers(f: { q?: string; departmentId?: number; active?: boolean; role?: string }): UserRow[] {
  return db.users
    .filter((u) => {
      if (f.q?.trim() && !ilike(u.full_name, f.q.trim()) && !ilike(u.login, f.q.trim()) && !ilike(u.position, f.q.trim())) return false;
      if (f.departmentId && u.department_id !== f.departmentId) return false;
      if (f.active !== undefined && u.active !== f.active) return false;
      if (f.role && !u.roles.includes(f.role as SystemRole)) return false;
      return true;
    })
    .sort(sortUsers);
}

export function listUsers(f: { q?: string; departmentId?: number; active?: boolean; role?: string }, pg: Paging): Page<AdminUser> {
  const page = pageOf(searchUsers(f), pg);
  return { ...page, items: page.items.map(toAdminUser) };
}

export function getUser(id: number): AdminUser {
  const u = db.users.find((x) => x.id === id);
  if (!u) throw notFound('Сотрудник не найден');
  return toAdminUser(u);
}

function normalizeRoles(roles: SystemRole[] | undefined): SystemRole[] {
  const set = new Set<SystemRole>(roles ?? []);
  set.add('employee');
  return (['employee', 'signer', 'admin', 'auditor'] as SystemRole[]).filter((r) => set.has(r));
}

function requireDepartment(id: number | null | undefined): void {
  if (id && !db.departments.some((d) => d.id === id)) throw fail422('Подразделение не найдено', 'departmentId');
}

export function checkPasswordStrength(password: string, field = 'newPassword'): void {
  if (password.length < 8 || password.length > 200) throw fail422('Пароль должен быть не короче 8 символов', field);
}

export function createUser(actorId: number | null, input: AdminCreateUserRequest): AdminUser {
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(input.login ?? '')) {
    throw badRequest('Некорректные данные запроса', [
      { field: 'login', message: 'Логин: 3–64 символа — латинские буквы, цифры, точка, дефис, подчёркивание' },
    ]);
  }
  checkPasswordStrength(input.password ?? '', 'password');
  const loginName = input.login.trim().toLowerCase();
  if (db.users.some((u) => u.login === loginName)) throw conflict(`Учётная запись с логином «${loginName}» уже существует`);
  requireDepartment(input.departmentId);
  const roles = normalizeRoles(input.roles);
  const u: UserRow = {
    id: nextId('users'),
    login: loginName,
    full_name: clean(input.fullName),
    position: clean(input.position),
    department_id: input.departmentId ?? null,
    roles,
    active: true,
    must_change_password: input.mustChangePassword ?? true,
    created_at: now(),
  };
  db.users.push(u);
  audit({
    actorId,
    entityType: 'user',
    entityId: u.id,
    action: 'user.created',
    summary: `Создана учётная запись «${loginName}» (${u.full_name}); роли: ${roles.map((x) => ROLE_LABELS[x]).join(', ')}`,
    details: { login: loginName, roles, departmentId: input.departmentId ?? null },
  });
  return toAdminUser(u);
}

export function updateUser(actor: Actor, id: number, input: AdminUpdateUserRequest): AdminUser {
  const u = db.users.find((x) => x.id === id);
  if (!u) throw notFound('Сотрудник не найден');
  const patch: Partial<UserRow> = {};
  const notes: string[] = [];
  if (input.fullName !== undefined && clean(input.fullName) !== u.full_name) {
    if (!clean(input.fullName)) throw unprocessable('Укажите имя сотрудника', [{ field: 'fullName', message: 'Обязательное поле' }]);
    patch.full_name = clean(input.fullName);
    notes.push('имя');
  }
  if (input.position !== undefined && clean(input.position) !== u.position) {
    patch.position = clean(input.position);
    notes.push('должность');
  }
  if (input.departmentId !== undefined && (input.departmentId ?? null) !== u.department_id) {
    requireDepartment(input.departmentId);
    patch.department_id = input.departmentId ?? null;
    notes.push('подразделение');
  }
  let rolesNote = '';
  if (input.roles !== undefined) {
    const roles = normalizeRoles(input.roles);
    if (roles.join() !== normalizeRoles(u.roles).join()) {
      if (id === actor.id && !roles.includes('admin')) throw conflict('Нельзя отозвать роль администратора у самого себя');
      patch.roles = roles;
      const added = roles.filter((r) => !u.roles.includes(r)).map((r) => ROLE_LABELS[r]);
      const removed = u.roles.filter((r) => !roles.includes(r)).map((r) => ROLE_LABELS[r] ?? r);
      rolesNote = [added.length ? `назначены роли: ${added.join(', ')}` : '', removed.length ? `отозваны роли: ${removed.join(', ')}` : ''].filter(Boolean).join('; ');
    }
  }
  if (!Object.keys(patch).length) return toAdminUser(u);
  Object.assign(u, patch);
  audit({
    actorId: actor.id,
    entityType: 'user',
    entityId: id,
    action: 'user.updated',
    summary: `Учётная запись «${u.login}» изменена: ${[notes.join(', '), rolesNote].filter(Boolean).join('; ')}`,
    details: { input },
  });
  return toAdminUser(u);
}

export function setUserActive(actor: Actor, id: number, active: boolean): AdminUser {
  const u = db.users.find((x) => x.id === id);
  if (!u) throw notFound('Сотрудник не найден');
  if (u.active === active) return toAdminUser(u);
  if (!active && id === actor.id) throw conflict('Нельзя заблокировать собственную учётную запись');
  u.active = active;
  if (!active) {
    const docs = new Map<number, { doc: DocRow; role: string }>();
    for (const s of db.steps.filter((x) => x.user_id === id && (x.state === 'pending' || x.state === 'waiting'))) {
      const r = db.rounds.find((x) => x.id === s.round_id && x.finished_at === null);
      const d = r && db.documents.find((x) => x.id === r.document_id);
      if (d) docs.set(d.id, { doc: d, role: 'согласующего' });
    }
    for (const d of db.documents.filter((x) => x.signer_id === id && ['in_review', 'on_signing', 'rework'].includes(x.status))) {
      if (!docs.has(d.id)) docs.set(d.id, { doc: d, role: 'утверждающего' });
    }
    for (const { doc, role } of docs.values()) {
      notify({
        userId: doc.initiator_id,
        type: 'participant_blocked',
        title: `Требуется замена участника: ${doc.number}`,
        body: `Учётная запись ${role} ${u.full_name} заблокирована. Замените участника в документе ${doc.number}.`,
        entityType: 'document',
        entityId: doc.id,
      });
    }
    for (const t of db.tasks.filter((x) => x.assignee_id === id && !['done', 'cancelled'].includes(x.status))) {
      notify({
        userId: t.author_id,
        type: 'participant_blocked',
        title: `Требуется замена исполнителя: ${t.number}`,
        body: `Учётная запись исполнителя ${u.full_name} заблокирована. Назначьте другого исполнителя поручения ${t.number}.`,
        entityType: 'task',
        entityId: t.id,
      });
    }
  }
  audit({
    actorId: actor.id,
    entityType: 'user',
    entityId: id,
    action: active ? 'user.unblocked' : 'user.blocked',
    summary: active ? `Учётная запись «${u.login}» разблокирована` : `Учётная запись «${u.login}» заблокирована, сессии завершены`,
  });
  return toAdminUser(u);
}

export function resetPassword(actor: Actor, id: number, password?: string): string {
  const temp = password ?? `Demo-${Math.random().toString(36).slice(2, 8)}${Math.floor(Math.random() * 90 + 10)}`;
  checkPasswordStrength(temp, 'password');
  const u = db.users.find((x) => x.id === id);
  if (!u) throw notFound('Сотрудник не найден');
  u.must_change_password = true;
  audit({ actorId: actor.id, entityType: 'user', entityId: id, action: 'user.password_reset', summary: `Пароль учётной записи «${u.login}» сброшен администратором` });
  return temp;
}

// ───────────── Подразделения и типы документов ─────────────

export const listDepartments = (onlyActive: boolean): Department[] =>
  db.departments
    .filter((d) => !onlyActive || d.active)
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    .map((d) => ({ ...d }));

export function createDepartment(actorId: number | null, nameRaw: string): Department {
  const name = clean(nameRaw);
  if (!name) throw unprocessable('Укажите название подразделения', [{ field: 'name', message: 'Обязательное поле' }]);
  if (db.departments.some((d) => d.name.toLowerCase() === name.toLowerCase())) throw conflict(`Подразделение «${name}» уже существует`);
  const d = { id: nextId('departments'), name, active: true };
  db.departments.push(d);
  audit({ actorId, entityType: 'department', entityId: d.id, action: 'department.created', summary: `Создано подразделение «${name}»` });
  return { ...d };
}

export function updateDepartment(actor: Actor, id: number, input: { name?: string; active?: boolean }): Department {
  const d = db.departments.find((x) => x.id === id);
  if (!d) throw notFound('Подразделение не найдено');
  const name = input.name !== undefined ? clean(input.name) : d.name;
  if (!name) throw unprocessable('Укажите название подразделения', [{ field: 'name', message: 'Обязательное поле' }]);
  if (name !== d.name && db.departments.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw conflict(`Подразделение «${name}» уже существует`);
  const active = input.active ?? d.active;
  const notes = [name !== d.name ? `переименовано в «${name}»` : '', active !== d.active ? (active ? 'включено' : 'отключено') : ''].filter(Boolean);
  const oldName = d.name;
  d.name = name;
  d.active = active;
  if (notes.length) audit({ actorId: actor.id, entityType: 'department', entityId: id, action: 'department.updated', summary: `Подразделение «${oldName}»: ${notes.join(', ')}` });
  return { ...d };
}

export const listDocTypes = (onlyActive: boolean): DocType[] =>
  db.docTypes
    .filter((t) => !onlyActive || t.active)
    .sort((a, b) => a.id - b.id)
    .map(toDocType);

export function createDocType(actorId: number | null, input: AdminCreateDocTypeRequest): DocType {
  if (db.docTypes.some((t) => t.code === input.code)) throw conflict(`Тип с кодом «${input.code}» уже существует`);
  if (input.kind === 'order' && input.requireDeal) throw unprocessable('Связь со сделкой для приказов не используется');
  const t = {
    id: nextId('docTypes'),
    code: input.code,
    name: clean(input.name),
    kind: input.kind,
    number_prefix: clean(input.numberPrefix),
    active: true,
    require_deal: !!input.requireDeal,
    require_file: !!input.requireFile || !!input.requireExcel,
    require_excel: !!input.requireExcel,
    require_deadline: !!input.requireDeadline,
    require_description: !!input.requireDescription,
  };
  db.docTypes.push(t);
  audit({ actorId, entityType: 'doc_type', entityId: t.id, action: 'doc_type.created', summary: `Создан тип документа «${t.name}»`, details: { ...input } });
  return toDocType(t);
}

export function updateDocType(actor: Actor, id: number, input: AdminUpdateDocTypeRequest): DocType {
  const t = db.docTypes.find((x) => x.id === id);
  if (!t) throw notFound('Тип документа не найден');
  const next = {
    name: input.name !== undefined ? clean(input.name) : t.name,
    number_prefix: input.numberPrefix !== undefined ? clean(input.numberPrefix) : t.number_prefix,
    active: input.active ?? t.active,
    require_deal: input.requireDeal ?? t.require_deal,
    require_excel: input.requireExcel ?? t.require_excel,
    require_file: input.requireFile ?? t.require_file,
    require_deadline: input.requireDeadline ?? t.require_deadline,
    require_description: input.requireDescription ?? t.require_description,
  };
  if (!next.name || !next.number_prefix) throw unprocessable('Название и префикс номера обязательны');
  if (t.kind === 'order' && next.require_deal) throw unprocessable('Связь со сделкой для приказов не используется');
  if (next.require_excel) next.require_file = true;
  const oldName = t.name;
  Object.assign(t, next);
  audit({ actorId: actor.id, entityType: 'doc_type', entityId: id, action: 'doc_type.updated', summary: `Изменены настройки типа документа «${oldName}»`, details: { input } });
  return toDocType(t);
}

// ───────────── Битрикс24 ─────────────

export function bitrixState(): AdminBitrixState {
  const count = (s: string) => db.bitrixLinks.filter((l) => l.state === s).length;
  const queue = db.bitrixLinks
    .filter((l) => l.state === 'pending' || l.state === 'error')
    .sort((a, b) => (b.last_attempt_at ?? -Infinity) - (a.last_attempt_at ?? -Infinity) || a.document_id - b.document_id)
    .map((l) => {
      const d = db.documents.find((x) => x.id === l.document_id)!;
      return {
        documentId: l.document_id,
        documentNumber: d.number,
        documentStatus: d.status,
        documentStatusLabel: docStatusLabel(d.status, d.kind),
        dealId: d.deal_id,
        link: toLinkInfo(l, d.kind),
      };
    });
  return {
    mode: 'mock',
    webhookConfigured: false,
    mockUnavailable: db.settings.mockUnavailable,
    counts: { pending: count('pending'), synced: count('synced'), error: count('error') },
    queue,
  };
}

export function setMockUnavailable(actor: Actor, unavailable: boolean): void {
  db.settings.mockUnavailable = unavailable;
  audit({
    actorId: actor.id,
    entityType: 'bitrix',
    entityId: null,
    action: 'bitrix.mock_toggled',
    summary: unavailable ? 'Эмулятор Битрикс24 переведён в режим «недоступен»' : 'Эмулятор Битрикс24 снова доступен',
  });
}

// ───────────── Журнал и служебные сведения ─────────────

const dayStart = (s: string): number => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};

export function auditList(
  actor: Actor,
  f: { entityType?: string; entityId?: number; actorId?: number; action?: string; from?: string; to?: string; q?: string },
  pg: Paging,
): Page<AdminAuditEntry> {
  const list = db.audit
    .filter((a) => {
      if (f.entityType && a.entity_type !== f.entityType) return false;
      if (f.entityId && a.entity_id !== f.entityId) return false;
      if (f.actorId && a.actor_id !== f.actorId) return false;
      if (f.action && !a.action.startsWith(f.action)) return false;
      if (f.from && a.at < dayStart(f.from)) return false;
      if (f.to && a.at >= dayStart(f.to) + 86400_000) return false;
      if (f.q?.trim() && !ilike(a.summary, f.q.trim())) return false;
      return true;
    })
    .sort((a, b) => b.id - a.id);
  const page = pageOf(list, pg);
  const withDetails = isAuditor(actor);
  const mapped = mapHistory(page.items);
  return {
    ...page,
    items: mapped.map((m, i) => ({ ...m, entityType: page.items[i].entity_type, entityId: page.items[i].entity_id, details: withDetails ? m.details : null })),
  };
}

function toAdminDoc(d: DocRow): AdminDocumentItem {
  return {
    id: d.id,
    number: d.number,
    kind: d.kind,
    kindLabel: DOC_KIND_LABELS[d.kind],
    typeName: db.docTypes.find((t) => t.id === d.doc_type_id)?.name ?? '',
    status: d.status,
    statusLabel: docStatusLabel(d.status, d.kind),
    initiator: refOf(d.initiator_id),
    department: deptRef(d.department_id),
    createdAt: isoReq(d.created_at),
    dueAt: iso(d.due_at),
  };
}

export function adminDocuments(f: { q?: string; statuses?: string[]; initiatorId?: number }, pg: Paging): Page<AdminDocumentItem> {
  const list = db.documents
    .filter((d) => d.launch_count > 0)
    .filter((d) => !f.q?.trim() || ilike(d.number, f.q.trim()))
    .filter((d) => !f.statuses?.length || f.statuses.includes(d.status))
    .filter((d) => !f.initiatorId || d.initiator_id === f.initiatorId)
    .sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  const page = pageOf(list, pg);
  return { ...page, items: page.items.map(toAdminDoc) };
}

export function adminDocument(id: number): AdminDocumentDetail {
  const d = db.documents.find((x) => x.id === id && x.launch_count > 0);
  if (!d) throw notFound('Документ не найден');
  const last = db.rounds.filter((r) => r.document_id === id).sort((a, b) => b.round_no - a.round_no)[0];
  const steps = last ? db.steps.filter((s) => s.round_id === last.id).sort((a, b) => a.position - b.position || a.id - b.id) : [];
  const link = getLink(id);
  return {
    ...toAdminDoc(d),
    routeMode: d.route_mode,
    routeModeLabel: ROUTE_MODE_LABELS[d.route_mode],
    signer: d.signer_id ? refOf(d.signer_id) : null,
    steps: steps.map((s) => ({ ...toStep(s), comment: null })),
    bitrix: link ? toLinkInfo(link, d.kind) : null,
    canCancel: ['in_review', 'rework', 'on_signing'].includes(d.status),
    canChangeRoute: d.status === 'in_review',
    canArchive: d.kind === 'order' && d.status === 'approved',
  };
}
