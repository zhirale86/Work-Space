import type { EntityType, NotificationItem, NotificationType, Page } from '../api-types';
import { type Paging, iso, pageOf } from '../common';
import { type Db, one, rows } from '../db';
import { notFound } from '../errors';
import { NOTIFICATION_TYPE_LABELS } from '../labels';

export interface NotifyInput {
  userId: number;
  type: NotificationType;
  title: string;
  body?: string;
  entityType?: EntityType;
  entityId?: number;
  /** Ключ, по которому уведомление формируется не более одного раза. */
  dedupeKey?: string;
}

/** Создаёт уведомление внутри системы. Заблокированным сотрудникам уведомления не создаются. */
export async function notify(db: Db, n: NotifyInput): Promise<void> {
  await db.query(
    `INSERT INTO notifications (user_id, type, title, body, entity_type, entity_id, dedupe_key)
     SELECT u.id, $2, $3, $4, $5, $6, $7 FROM users u WHERE u.id = $1 AND u.active
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [n.userId, n.type, n.title, n.body ?? '', n.entityType ?? null, n.entityId ?? null, n.dedupeKey ?? null],
  );
}

export async function notifyMany(db: Db, userIds: number[], n: Omit<NotifyInput, 'userId'>): Promise<void> {
  for (const userId of new Set(userIds)) await notify(db, { ...n, userId });
}

interface Row {
  id: number;
  type: NotificationType;
  title: string;
  body: string;
  entity_type: EntityType | null;
  entity_id: number | null;
  created_at: Date;
  read_at: Date | null;
}

export async function listNotifications(
  db: Db,
  userId: number,
  unreadOnly: boolean,
  p: Paging,
): Promise<Page<NotificationItem>> {
  const cond = unreadOnly ? 'AND read_at IS NULL' : '';
  const total = await one<{ c: number }>(
    db,
    `SELECT count(*)::int AS c FROM notifications WHERE user_id = $1 ${cond}`,
    [userId],
  );
  const list = await rows<Row>(
    db,
    `SELECT * FROM notifications WHERE user_id = $1 ${cond} ORDER BY id DESC LIMIT $2 OFFSET $3`,
    [userId, p.limit, p.offset],
  );
  return pageOf(
    list.map((r) => ({
      id: r.id,
      type: r.type,
      typeLabel: NOTIFICATION_TYPE_LABELS[r.type] ?? r.type,
      title: r.title,
      body: r.body,
      entityType: r.entity_type,
      entityId: r.entity_id,
      createdAt: iso(r.created_at)!,
      readAt: iso(r.read_at),
    })),
    total?.c ?? 0,
    p,
  );
}

export async function unreadCount(db: Db, userId: number): Promise<number> {
  const r = await one<{ c: number }>(
    db,
    'SELECT count(*)::int AS c FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return r?.c ?? 0;
}

export async function markRead(db: Db, userId: number, id: number): Promise<void> {
  const r = await db.query(
    'UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  if (!r.rowCount) throw notFound('Уведомление не найдено');
}

export async function markAllRead(db: Db, userId: number): Promise<void> {
  await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
}
