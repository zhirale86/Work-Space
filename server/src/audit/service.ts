import type { HistoryEntry, Page } from '../api-types';
import { type Paging, iso, loadUserRefs, pageOf } from '../common';
import { type Db, one, rows } from '../db';

export interface AuditInput {
  /** null — системный процесс. */
  actorId: number | null;
  entityType: 'document' | 'task' | 'user' | 'department' | 'doc_type' | 'bitrix' | 'auth' | 'file';
  entityId: number | null;
  action: string;
  /** Готовая русская фраза без содержимого документов (названий, текстов комментариев). */
  summary: string;
  details?: Record<string, unknown>;
}

export async function audit(db: Db, e: AuditInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_id, entity_type, entity_id, action, summary, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.actorId, e.entityType, e.entityId, e.action, e.summary, JSON.stringify(e.details ?? {})],
  );
}

export interface AuditRow {
  id: number;
  at: Date;
  actor_id: number | null;
  entity_type: string;
  entity_id: number | null;
  action: string;
  summary: string;
  details: Record<string, unknown>;
}

export const SYSTEM_ACTOR_NAME = 'Системный процесс';

export async function mapHistory(db: Db, list: AuditRow[]): Promise<HistoryEntry[]> {
  const users = await loadUserRefs(db, list.map((r) => r.actor_id));
  return list.map((r) => {
    const actor = r.actor_id ? users.get(r.actor_id) ?? null : null;
    return {
      id: r.id,
      at: iso(r.at)!,
      actor,
      actorName: actor ? actor.fullName : SYSTEM_ACTOR_NAME,
      action: r.action,
      summary: r.summary,
      details: r.details ?? {},
    };
  });
}

/** История карточки. Доступ к карточке проверяет вызывающий обработчик. */
export async function entityHistory(
  db: Db,
  entityType: 'document' | 'task',
  entityId: number,
  p: Paging,
): Promise<Page<HistoryEntry>> {
  const total = await one<{ c: number }>(
    db,
    'SELECT count(*)::int AS c FROM audit_log WHERE entity_type = $1 AND entity_id = $2',
    [entityType, entityId],
  );
  const list = await rows<AuditRow>(
    db,
    `SELECT * FROM audit_log WHERE entity_type = $1 AND entity_id = $2
      ORDER BY id DESC LIMIT $3 OFFSET $4`,
    [entityType, entityId, p.limit, p.offset],
  );
  return pageOf(await mapHistory(db, list), total?.c ?? 0, p);
}
