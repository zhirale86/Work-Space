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
  DocStatus,
  DocType,
  Page,
  SystemRole,
} from '../api-types';
import { type AuditRow, audit, mapHistory } from '../audit/service';
import { checkPasswordStrength } from '../auth/service';
import { generatePassword, hashPassword } from '../auth/passwords';
import { SETTING_UNAVAILABLE, getSetting, setSetting } from '../bitrix/mock';
import { type LinkRow, getLink, toLinkInfo } from '../bitrix/sync';
import { type Actor, type Paging, clean, deptRef, iso, isAuditor, like, loadUserRefs, pageOf, refOf } from '../common';
import { config } from '../config';
import { type Db, one, rows, tx } from '../db';
import type { DocRow } from '../documents/access';
import { type DocTypeRow, type StepRow, toDocType, toStep } from '../documents/service';
import { conflict, notFound, unprocessable } from '../errors';
import { DOC_KIND_LABELS, ROLE_LABELS, ROUTE_MODE_LABELS, docStatusLabel } from '../labels';
import { notify } from '../notifications/service';
import { Params } from '../sql';

// ───────────── Пользователи ─────────────

interface UserRow {
  id: number;
  login: string;
  full_name: string;
  position: string;
  department_id: number | null;
  department_name: string | null;
  roles: SystemRole[];
  active: boolean;
  must_change_password: boolean;
  created_at: Date;
}

const USER_SELECT = `SELECT u.id, u.login, u.full_name, u.position, u.department_id, d.name AS department_name,
                            u.roles, u.active, u.must_change_password, u.created_at
                       FROM users u LEFT JOIN departments d ON d.id = u.department_id`;

function toAdminUser(u: UserRow): AdminUser {
  return {
    id: u.id,
    login: u.login,
    fullName: u.full_name,
    position: u.position,
    department: deptRef(u.department_id, u.department_name),
    active: u.active,
    roles: u.roles,
    roleLabels: u.roles.map((r) => ROLE_LABELS[r] ?? r),
    mustChangePassword: u.must_change_password,
    createdAt: iso(u.created_at)!,
  };
}

export async function listUsers(
  db: Db,
  f: { q?: string; departmentId?: number; active?: boolean; role?: string },
  pg: Paging,
): Promise<Page<AdminUser>> {
  const p = new Params();
  const cond = ['TRUE'];
  if (f.q?.trim()) {
    const pat = p.add(like(f.q.trim()));
    cond.push(`(u.full_name ILIKE ${pat} OR u.login ILIKE ${pat} OR u.position ILIKE ${pat})`);
  }
  if (f.departmentId) cond.push(`u.department_id = ${p.add(f.departmentId)}`);
  if (f.active !== undefined) cond.push(`u.active = ${p.add(f.active)}`);
  if (f.role) cond.push(`${p.add(f.role)} = ANY(u.roles)`);
  const where = cond.join(' AND ');
  const total = (await one<{ c: number }>(db, `SELECT count(*)::int AS c FROM users u WHERE ${where}`, p.values))?.c ?? 0;
  const list = await rows<UserRow>(
    db,
    `${USER_SELECT} WHERE ${where} ORDER BY u.full_name, u.id LIMIT ${p.add(pg.limit)} OFFSET ${p.add(pg.offset)}`,
    p.values,
  );
  return pageOf(list.map(toAdminUser), total, pg);
}

export async function getUser(db: Db, id: number): Promise<AdminUser> {
  const u = await one<UserRow>(db, `${USER_SELECT} WHERE u.id = $1`, [id]);
  if (!u) throw notFound('Сотрудник не найден');
  return toAdminUser(u);
}

function normalizeRoles(roles: SystemRole[] | undefined): SystemRole[] {
  const set = new Set<SystemRole>(roles ?? []);
  set.add('employee');
  return (['employee', 'signer', 'admin', 'auditor'] as SystemRole[]).filter((r) => set.has(r));
}

async function requireDepartment(db: Db, id: number | null | undefined): Promise<void> {
  if (!id) return;
  const d = await one(db, 'SELECT 1 FROM departments WHERE id = $1', [id]);
  if (!d) throw unprocessable('Подразделение не найдено', [{ field: 'departmentId', message: 'Подразделение не найдено' }]);
}

/** Создание учётной записи. `actorId = null` — системный процесс (начальные данные). */
export async function createUser(actorId: number | null, input: AdminCreateUserRequest): Promise<AdminUser> {
  checkPasswordStrength(input.password, 'password');
  const hash = await hashPassword(input.password);
  return tx(async (db) => {
    const loginName = input.login.trim().toLowerCase();
    if (await one(db, 'SELECT 1 FROM users WHERE login = $1', [loginName])) {
      throw conflict(`Учётная запись с логином «${loginName}» уже существует`);
    }
    await requireDepartment(db, input.departmentId);
    const roles = normalizeRoles(input.roles);
    const r = (await one<{ id: number }>(
      db,
      `INSERT INTO users (login, full_name, position, department_id, password_hash, roles, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [loginName, clean(input.fullName), clean(input.position), input.departmentId ?? null, hash, roles, input.mustChangePassword ?? true],
    ))!;
    await audit(db, {
      actorId,
      entityType: 'user',
      entityId: r.id,
      action: 'user.created',
      summary: `Создана учётная запись «${loginName}» (${clean(input.fullName)}); роли: ${roles.map((x) => ROLE_LABELS[x]).join(', ')}`,
      details: { login: loginName, roles, departmentId: input.departmentId ?? null },
    });
    return getUser(db, r.id);
  });
}

export async function updateUser(actor: Actor, id: number, input: AdminUpdateUserRequest): Promise<AdminUser> {
  return tx(async (db) => {
    const u = await one<UserRow>(db, `${USER_SELECT} WHERE u.id = $1 FOR UPDATE OF u`, [id]);
    if (!u) throw notFound('Сотрудник не найден');
    const p = new Params();
    const sets: string[] = [];
    const notes: string[] = [];
    if (input.fullName !== undefined && clean(input.fullName) !== u.full_name) {
      if (!clean(input.fullName)) throw unprocessable('Укажите имя сотрудника', [{ field: 'fullName', message: 'Обязательное поле' }]);
      sets.push(`full_name = ${p.add(clean(input.fullName))}`);
      notes.push('имя');
    }
    if (input.position !== undefined && clean(input.position) !== u.position) {
      sets.push(`position = ${p.add(clean(input.position))}`);
      notes.push('должность');
    }
    if (input.departmentId !== undefined && (input.departmentId ?? null) !== u.department_id) {
      await requireDepartment(db, input.departmentId);
      sets.push(`department_id = ${p.add(input.departmentId ?? null)}`);
      notes.push('подразделение');
    }
    let rolesNote = '';
    if (input.roles !== undefined) {
      const roles = normalizeRoles(input.roles);
      if (roles.join() !== normalizeRoles(u.roles).join()) {
        if (id === actor.id && !roles.includes('admin')) throw conflict('Нельзя отозвать роль администратора у самого себя');
        sets.push(`roles = ${p.add(roles)}`);
        const added = roles.filter((r) => !u.roles.includes(r)).map((r) => ROLE_LABELS[r]);
        const removed = u.roles.filter((r) => !roles.includes(r)).map((r) => ROLE_LABELS[r] ?? r);
        rolesNote = [added.length ? `назначены роли: ${added.join(', ')}` : '', removed.length ? `отозваны роли: ${removed.join(', ')}` : '']
          .filter(Boolean)
          .join('; ');
      }
    }
    if (!sets.length) return toAdminUser(u);
    await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ${p.add(id)}`, p.values);
    await audit(db, {
      actorId: actor.id,
      entityType: 'user',
      entityId: id,
      action: 'user.updated',
      summary: `Учётная запись «${u.login}» изменена: ${[notes.join(', '), rolesNote].filter(Boolean).join('; ')}`,
      details: { input },
    });
    return getUser(db, id);
  });
}

/**
 * Блокировка: вход запрещён, сессии сбрасываются, история сохраняется. Инициаторы документов и
 * постановщики поручений, где сотрудник должен действовать, получают уведомление о необходимости замены.
 */
export async function setUserActive(actor: Actor, id: number, active: boolean): Promise<AdminUser> {
  return tx(async (db) => {
    const u = await one<UserRow>(db, `${USER_SELECT} WHERE u.id = $1 FOR UPDATE OF u`, [id]);
    if (!u) throw notFound('Сотрудник не найден');
    if (u.active === active) return toAdminUser(u);
    if (!active && id === actor.id) throw conflict('Нельзя заблокировать собственную учётную запись');
    await db.query('UPDATE users SET active = $2 WHERE id = $1', [id, active]);
    if (!active) {
      await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      const docs = await rows<{ id: number; number: string; initiator_id: number; role: string }>(
        db,
        `SELECT DISTINCT d.id, d.number, d.initiator_id, 'согласующего' AS role
           FROM approval_steps s JOIN approval_rounds r ON r.id = s.round_id JOIN documents d ON d.id = r.document_id
          WHERE s.user_id = $1 AND s.state IN ('pending','waiting') AND r.finished_at IS NULL
         UNION
         SELECT d.id, d.number, d.initiator_id, 'утверждающего' AS role
           FROM documents d WHERE d.signer_id = $1 AND d.status IN ('in_review','on_signing','rework')`,
        [id],
      );
      for (const d of docs) {
        await notify(db, {
          userId: d.initiator_id,
          type: 'participant_blocked',
          title: `Требуется замена участника: ${d.number}`,
          body: `Учётная запись ${d.role} ${u.full_name} заблокирована. Замените участника в документе ${d.number}.`,
          entityType: 'document',
          entityId: d.id,
        });
      }
      const tasks = await rows<{ id: number; number: string; author_id: number }>(
        db,
        `SELECT id, number, author_id FROM tasks WHERE assignee_id = $1 AND status NOT IN ('done','cancelled')`,
        [id],
      );
      for (const t of tasks) {
        await notify(db, {
          userId: t.author_id,
          type: 'participant_blocked',
          title: `Требуется замена исполнителя: ${t.number}`,
          body: `Учётная запись исполнителя ${u.full_name} заблокирована. Назначьте другого исполнителя поручения ${t.number}.`,
          entityType: 'task',
          entityId: t.id,
        });
      }
    }
    await audit(db, {
      actorId: actor.id,
      entityType: 'user',
      entityId: id,
      action: active ? 'user.unblocked' : 'user.blocked',
      summary: active ? `Учётная запись «${u.login}» разблокирована` : `Учётная запись «${u.login}» заблокирована, сессии завершены`,
    });
    return getUser(db, id);
  });
}

export async function resetPassword(actor: Actor, id: number, password?: string): Promise<string> {
  const temp = password ?? generatePassword();
  checkPasswordStrength(temp, 'password');
  const hash = await hashPassword(temp);
  await tx(async (db) => {
    const u = await one<{ login: string }>(db, 'SELECT login FROM users WHERE id = $1 FOR UPDATE', [id]);
    if (!u) throw notFound('Сотрудник не найден');
    await db.query('UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1', [id, hash]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await audit(db, {
      actorId: actor.id,
      entityType: 'user',
      entityId: id,
      action: 'user.password_reset',
      summary: `Пароль учётной записи «${u.login}» сброшен администратором`,
    });
  });
  return temp;
}

// ───────────── Подразделения ─────────────

export async function listDepartments(db: Db, onlyActive: boolean): Promise<Department[]> {
  return rows<Department>(db, `SELECT id, name, active FROM departments ${onlyActive ? 'WHERE active' : ''} ORDER BY name`);
}

export async function createDepartment(actorId: number | null, nameRaw: string): Promise<Department> {
  return tx(async (db) => {
    const name = clean(nameRaw);
    if (!name) throw unprocessable('Укажите название подразделения', [{ field: 'name', message: 'Обязательное поле' }]);
    if (await one(db, 'SELECT 1 FROM departments WHERE lower(name) = lower($1)', [name])) {
      throw conflict(`Подразделение «${name}» уже существует`);
    }
    const d = (await one<Department>(db, 'INSERT INTO departments (name) VALUES ($1) RETURNING id, name, active', [name]))!;
    await audit(db, { actorId, entityType: 'department', entityId: d.id, action: 'department.created', summary: `Создано подразделение «${name}»` });
    return d;
  });
}

export async function updateDepartment(actor: Actor, id: number, input: { name?: string; active?: boolean }): Promise<Department> {
  return tx(async (db) => {
    const d = await one<Department>(db, 'SELECT id, name, active FROM departments WHERE id = $1 FOR UPDATE', [id]);
    if (!d) throw notFound('Подразделение не найдено');
    const name = input.name !== undefined ? clean(input.name) : d.name;
    if (!name) throw unprocessable('Укажите название подразделения', [{ field: 'name', message: 'Обязательное поле' }]);
    if (name !== d.name && (await one(db, 'SELECT 1 FROM departments WHERE lower(name) = lower($1) AND id <> $2', [name, id]))) {
      throw conflict(`Подразделение «${name}» уже существует`);
    }
    const active = input.active ?? d.active;
    const u = (await one<Department>(db, 'UPDATE departments SET name = $2, active = $3 WHERE id = $1 RETURNING id, name, active', [id, name, active]))!;
    const notes = [name !== d.name ? `переименовано в «${name}»` : '', active !== d.active ? (active ? 'включено' : 'отключено') : ''].filter(Boolean);
    if (notes.length) {
      await audit(db, {
        actorId: actor.id,
        entityType: 'department',
        entityId: id,
        action: 'department.updated',
        summary: `Подразделение «${d.name}»: ${notes.join(', ')}`,
      });
    }
    return u;
  });
}

// ───────────── Типы документов ─────────────

export async function listDocTypes(db: Db, onlyActive: boolean): Promise<DocType[]> {
  return (await rows<DocTypeRow>(db, `SELECT * FROM doc_types ${onlyActive ? 'WHERE active' : ''} ORDER BY id`)).map(toDocType);
}

export async function createDocType(actorId: number | null, input: AdminCreateDocTypeRequest): Promise<DocType> {
  return tx(async (db) => {
    if (await one(db, 'SELECT 1 FROM doc_types WHERE code = $1', [input.code])) throw conflict(`Тип с кодом «${input.code}» уже существует`);
    const isOrder = input.kind === 'order';
    if (isOrder && input.requireDeal) throw unprocessable('Связь со сделкой для приказов не используется');
    const t = (await one<DocTypeRow>(
      db,
      `INSERT INTO doc_types (code, name, kind, number_prefix, require_deal, require_file, require_excel, require_deadline, require_description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        input.code,
        clean(input.name),
        input.kind,
        clean(input.numberPrefix),
        !!input.requireDeal,
        !!input.requireFile || !!input.requireExcel,
        !!input.requireExcel,
        !!input.requireDeadline,
        !!input.requireDescription,
      ],
    ))!;
    await audit(db, { actorId, entityType: 'doc_type', entityId: t.id, action: 'doc_type.created', summary: `Создан тип документа «${t.name}»`, details: { ...input } });
    return toDocType(t);
  });
}

export async function updateDocType(actor: Actor, id: number, input: AdminUpdateDocTypeRequest): Promise<DocType> {
  return tx(async (db) => {
    const t = await one<DocTypeRow>(db, 'SELECT * FROM doc_types WHERE id = $1 FOR UPDATE', [id]);
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
    const u = (await one<DocTypeRow>(
      db,
      `UPDATE doc_types SET name = $2, number_prefix = $3, active = $4, require_deal = $5, require_file = $6,
              require_excel = $7, require_deadline = $8, require_description = $9 WHERE id = $1 RETURNING *`,
      [id, next.name, next.number_prefix, next.active, next.require_deal, next.require_file, next.require_excel, next.require_deadline, next.require_description],
    ))!;
    await audit(db, {
      actorId: actor.id,
      entityType: 'doc_type',
      entityId: id,
      action: 'doc_type.updated',
      summary: `Изменены настройки типа документа «${t.name}»`,
      details: { input },
    });
    return toDocType(u);
  });
}

// ───────────── Битрикс24 ─────────────

export async function bitrixState(db: Db): Promise<AdminBitrixState> {
  const counts = await rows<{ state: 'pending' | 'synced' | 'error'; c: number }>(
    db,
    'SELECT state, count(*)::int AS c FROM bitrix_links GROUP BY state',
  );
  const queue = await rows<LinkRow & { number: string; status: DocStatus; kind: string; deal_id: string | null }>(
    db,
    `SELECT l.*, d.number, d.status, d.kind, d.deal_id FROM bitrix_links l JOIN documents d ON d.id = l.document_id
      WHERE l.state IN ('pending','error') ORDER BY l.last_attempt_at DESC NULLS LAST, l.document_id LIMIT 200`,
  );
  const get = (s: string) => counts.find((c) => c.state === s)?.c ?? 0;
  return {
    mode: config.bitrixMode,
    webhookConfigured: !!config.bitrixWebhookUrl,
    mockUnavailable: await getSetting<boolean>(db, SETTING_UNAVAILABLE, false),
    counts: { pending: get('pending'), synced: get('synced'), error: get('error') },
    queue: queue.map((l) => ({
      documentId: l.document_id,
      documentNumber: l.number,
      documentStatus: l.status,
      documentStatusLabel: docStatusLabel(l.status, l.kind),
      dealId: l.deal_id,
      link: toLinkInfo(l, l.kind),
    })),
  };
}

export async function setMockUnavailable(actor: Actor, unavailable: boolean): Promise<void> {
  await tx(async (db) => {
    await setSetting(db, SETTING_UNAVAILABLE, unavailable);
    await audit(db, {
      actorId: actor.id,
      entityType: 'bitrix',
      entityId: null,
      action: 'bitrix.mock_toggled',
      summary: unavailable ? 'Эмулятор Битрикс24 переведён в режим «недоступен»' : 'Эмулятор Битрикс24 снова доступен',
    });
  });
}

// ───────────── Журнал действий ─────────────

export async function auditList(
  db: Db,
  actor: Actor,
  f: { entityType?: string; entityId?: number; actorId?: number; action?: string; from?: string; to?: string; q?: string },
  pg: Paging,
): Promise<Page<AdminAuditEntry>> {
  const p = new Params();
  const cond = ['TRUE'];
  if (f.entityType) cond.push(`entity_type = ${p.add(f.entityType)}`);
  if (f.entityId) cond.push(`entity_id = ${p.add(f.entityId)}`);
  if (f.actorId) cond.push(`actor_id = ${p.add(f.actorId)}`);
  if (f.action) cond.push(`action LIKE ${p.add(f.action.replace(/[\\%_]/g, (c) => '\\' + c) + '%')}`);
  if (f.from) cond.push(`at >= ${p.add(f.from)}::date`);
  if (f.to) cond.push(`at < ${p.add(f.to)}::date + 1`);
  if (f.q?.trim()) cond.push(`summary ILIKE ${p.add(like(f.q.trim()))}`);
  const where = cond.join(' AND ');
  const total = (await one<{ c: number }>(db, `SELECT count(*)::int AS c FROM audit_log WHERE ${where}`, p.values))?.c ?? 0;
  const list = await rows<AuditRow>(
    db,
    `SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT ${p.add(pg.limit)} OFFSET ${p.add(pg.offset)}`,
    p.values,
  );
  const mapped = await mapHistory(db, list);
  // Подробности могут содержать содержимое документов — их видит только роль «Контроль документов».
  const withDetails = isAuditor(actor);
  return pageOf(
    mapped.map((m, i) => ({ ...m, entityType: list[i].entity_type, entityId: list[i].entity_id, details: withDetails ? m.details : null })),
    total,
    pg,
  );
}

// ───────────── Служебные сведения о документах ─────────────

interface AdminDocRow extends DocRow {
  type_name: string;
  department_name: string | null;
}

function toAdminDoc(d: AdminDocRow, users: Map<number, ReturnType<typeof refOf>>): AdminDocumentItem {
  return {
    id: d.id,
    number: d.number,
    kind: d.kind,
    kindLabel: DOC_KIND_LABELS[d.kind],
    typeName: d.type_name,
    status: d.status,
    statusLabel: docStatusLabel(d.status, d.kind),
    initiator: refOf(users, d.initiator_id),
    department: deptRef(d.department_id, d.department_name),
    createdAt: iso(d.created_at)!,
    dueAt: iso(d.due_at),
  };
}

const ADMIN_DOC_SELECT = `SELECT d.*, t.name AS type_name, dep.name AS department_name
                            FROM documents d JOIN doc_types t ON t.id = d.doc_type_id
                            LEFT JOIN departments dep ON dep.id = d.department_id`;

/** Список документов для администратора: только служебные сведения, без названий и содержимого. Черновики не показываются. */
export async function adminDocuments(
  db: Db,
  f: { q?: string; statuses?: string[]; initiatorId?: number },
  pg: Paging,
): Promise<Page<AdminDocumentItem>> {
  const p = new Params();
  const cond = [`d.launch_count > 0`];
  if (f.q?.trim()) cond.push(`d.number ILIKE ${p.add(like(f.q.trim()))}`);
  if (f.statuses?.length) cond.push(`d.status = ANY(${p.add(f.statuses)}::text[])`);
  if (f.initiatorId) cond.push(`d.initiator_id = ${p.add(f.initiatorId)}`);
  const where = cond.join(' AND ');
  const total = (await one<{ c: number }>(db, `SELECT count(*)::int AS c FROM documents d WHERE ${where}`, p.values))?.c ?? 0;
  const list = await rows<AdminDocRow>(
    db,
    `${ADMIN_DOC_SELECT} WHERE ${where} ORDER BY d.created_at DESC, d.id DESC LIMIT ${p.add(pg.limit)} OFFSET ${p.add(pg.offset)}`,
    p.values,
  );
  const users = await loadUserRefs(db, list.map((d) => d.initiator_id));
  return pageOf(list.map((d) => toAdminDoc(d, users)), total, pg);
}

export async function adminDocument(db: Db, id: number): Promise<AdminDocumentDetail> {
  const d = await one<AdminDocRow>(db, `${ADMIN_DOC_SELECT} WHERE d.id = $1 AND d.launch_count > 0`, [id]);
  if (!d) throw notFound('Документ не найден');
  const steps = await rows<StepRow>(
    db,
    `SELECT s.* FROM approval_steps s
      WHERE s.round_id = (SELECT id FROM approval_rounds WHERE document_id = $1 ORDER BY round_no DESC LIMIT 1)
      ORDER BY s.position, s.id`,
    [id],
  );
  const users = await loadUserRefs(db, [d.initiator_id, d.signer_id, ...steps.map((s) => s.user_id)]);
  const link = await getLink(db, id);
  return {
    ...toAdminDoc(d, users),
    routeMode: d.route_mode,
    routeModeLabel: ROUTE_MODE_LABELS[d.route_mode],
    signer: d.signer_id ? refOf(users, d.signer_id) : null,
    // Комментарии к решениям — содержимое документа, администратору не передаются.
    steps: steps.map((s) => ({ ...toStep(s, users), comment: null })),
    bitrix: link ? toLinkInfo(link, d.kind) : null,
    canCancel: ['in_review', 'rework', 'on_signing'].includes(d.status),
    canChangeRoute: d.status === 'in_review',
    canArchive: d.kind === 'order' && d.status === 'approved',
  };
}
