import type { DocKind, DocStatus, RouteMode } from '../api-types';
import { type Actor, isAdmin, isAuditor } from '../common';
import { type Db, one } from '../db';
import { forbidden, notFound } from '../errors';
import { Params } from '../sql';

export interface DocRow {
  id: number;
  number: string;
  doc_type_id: number;
  kind: DocKind;
  title: string;
  description: string;
  initiator_id: number;
  department_id: number | null;
  status: DocStatus;
  route_mode: RouteMode;
  due_at: Date | null;
  deal_id: string | null;
  deal_title: string | null;
  deal_url: string | null;
  signer_id: number | null;
  order_date: string | null;
  signed_at: Date | null;
  signed_by: number | null;
  launch_count: number;
  last_reminded_at: Date | null;
  created_at: Date;
  updated_at: Date;
  launched_at: Date | null;
  completed_at: Date | null;
}

export const DOC_NOT_FOUND = 'Документ не найден или нет доступа';

/**
 * Единое правило видимости документа (архитектура, п. 2.7) в виде условия SQL.
 * Используется и для списков, и для проверки доступа к одной карточке, её файлам и истории.
 *
 * Документ видят: инициатор; согласующие любого раунда, получившие документ (шаг был активирован
 * и не заменён); утверждающий и наблюдатели — после первого запуска; сотрудники из списка
 * ознакомления — после утверждения приказа; те, кому доступ открыт индивидуально или по
 * подразделению; роль «Контроль документов».
 */
export function docVisibleSql(actor: Actor, alias: string, p: Params): string {
  if (isAuditor(actor)) return 'TRUE';
  const u = p.add(actor.id);
  const dept = p.add(actor.departmentId);
  const d = alias;
  return `(
    ${d}.initiator_id = ${u}
    OR EXISTS (SELECT 1 FROM approval_steps vs JOIN approval_rounds vr ON vr.id = vs.round_id
                WHERE vr.document_id = ${d}.id AND vs.user_id = ${u}
                  AND vs.activated_at IS NOT NULL AND vs.state <> 'replaced')
    OR (${d}.signer_id = ${u} AND ${d}.launch_count > 0)
    OR (${d}.launch_count > 0 AND EXISTS (SELECT 1 FROM document_participants vp
                WHERE vp.document_id = ${d}.id AND vp.user_id = ${u} AND vp.role = 'observer'))
    OR (${d}.kind = 'order' AND ${d}.status IN ('approved','archived') AND EXISTS (SELECT 1 FROM document_participants vp
                WHERE vp.document_id = ${d}.id AND vp.user_id = ${u} AND vp.role = 'acquaintance'))
    OR EXISTS (SELECT 1 FROM document_access va
                WHERE va.document_id = ${d}.id AND (va.user_id = ${u} OR va.department_id = ${dept}::int))
  )`;
}

/** Возвращает документ, если он доступен пользователю; иначе null. */
export async function findDocument(db: Db, actor: Actor, id: number, opts: { lock?: boolean } = {}): Promise<DocRow | null> {
  const p = new Params();
  const idRef = p.add(id);
  return one<DocRow>(
    db,
    `SELECT d.* FROM documents d WHERE d.id = ${idRef} AND ${docVisibleSql(actor, 'd', p)}
     ${opts.lock ? 'FOR UPDATE OF d' : ''}`,
    p.values,
  );
}

/**
 * Общая проверка доступа к документу. Нет доступа или документа — одинаковый ответ 404,
 * чтобы не раскрывать существование карточки.
 */
export async function requireDocument(db: Db, actor: Actor, id: number, opts: { lock?: boolean } = {}): Promise<DocRow> {
  const doc = await findDocument(db, actor, id, opts);
  if (!doc) throw notFound(DOC_NOT_FOUND);
  return doc;
}

/**
 * Доступ для управляющих действий (отмена, изменение маршрута, архив, повтор передачи в Битрикс24):
 * участник с доступом к карточке либо администратор. Администратор без роли «Контроль документов»
 * управляет процессом по служебным сведениям, не получая содержимого документа.
 */
export async function requireDocumentForManage(db: Db, actor: Actor, id: number): Promise<DocRow> {
  if (isAdmin(actor)) {
    const doc = await one<DocRow>(db, 'SELECT * FROM documents WHERE id = $1 FOR UPDATE', [id]);
    if (!doc) throw notFound(DOC_NOT_FOUND);
    return doc;
  }
  return requireDocument(db, actor, id, { lock: true });
}

export function requireInitiator(doc: DocRow, actor: Actor, message = 'Действие доступно только инициатору документа'): void {
  if (doc.initiator_id !== actor.id) throw forbidden(message);
}

export function requireInitiatorOrAdmin(doc: DocRow, actor: Actor): void {
  if (doc.initiator_id !== actor.id && !isAdmin(actor)) {
    throw forbidden('Действие доступно только инициатору документа и администратору');
  }
}

export const isDocOverdue = (doc: Pick<DocRow, 'due_at' | 'status'>, now = new Date()): boolean =>
  !!doc.due_at && doc.due_at.getTime() < now.getTime() && ['in_review', 'on_signing', 'rework'].includes(doc.status);

export const DOC_OVERDUE_SQL = (alias: string): string =>
  `(${alias}.due_at IS NOT NULL AND ${alias}.due_at < now() AND ${alias}.status IN ('in_review','on_signing','rework'))`;
