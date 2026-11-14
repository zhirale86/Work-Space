import type { Decision, DocumentDetail } from '../api-types';
import { docRef, manageResult, setStatus } from '../approvals/service';
import { audit } from '../audit/service';
import { type Actor, clean, requireActiveUsers, uniq } from '../common';
import { type Db, one, rows, tx } from '../db';
import {
  type DocRow,
  requireDocument,
  requireDocumentForManage,
  requireInitiator,
  requireInitiatorOrAdmin,
} from '../documents/access';
import { buildDetail } from '../documents/service';
import { conflict, forbidden, unprocessable } from '../errors';
import { notifyMany, notify } from '../notifications/service';

function requireOrder(doc: DocRow): void {
  if (doc.kind !== 'order') throw conflict('Действие применяется только к приказам');
}

async function notifyAcquaintance(db: Db, doc: DocRow, userIds: number[]): Promise<void> {
  await notifyMany(db, userIds, {
    type: 'acknowledge_requested',
    title: `Ознакомьтесь с приказом ${doc.number}`,
    body: `Приказ ${docRef(doc)} утверждён. Подтвердите ознакомление в карточке приказа.`,
    entityType: 'document',
    entityId: doc.id,
  });
}

const SIGN_RESULT: Record<Decision, DocRow['status']> = { approve: 'approved', rework: 'rework', reject: 'rejected' };

/** Утверждение приказа: утвердить, вернуть на доработку или отклонить. */
export async function signOrder(actor: Actor, id: number, decision: Decision, commentRaw?: string): Promise<DocumentDetail> {
  return tx(async (db) => {
    let doc = await requireDocument(db, actor, id, { lock: true });
    requireOrder(doc);
    if (doc.signer_id !== actor.id) throw forbidden('Утвердить приказ может только указанный в нём утверждающий');
    const comment = clean(commentRaw);
    if (decision !== 'approve' && !comment) {
      throw unprocessable('Укажите комментарий: он обязателен при возврате на доработку и отклонении', [
        { field: 'comment', message: 'Комментарий обязателен' },
      ]);
    }
    // Повтор того же решения ничего не меняет.
    if (doc.status === SIGN_RESULT[decision] && doc.signed_by === actor.id) return buildDetail(db, actor, doc);
    if (doc.status !== 'on_signing') throw conflict('Приказ не находится на утверждении');

    if (decision === 'approve') {
      doc = await setStatus(db, doc, 'approved', ', signed_at = now(), signed_by = ' + Number(actor.id) + ', order_date = COALESCE(order_date, CURRENT_DATE)');
      await audit(db, {
        actorId: actor.id,
        entityType: 'document',
        entityId: id,
        action: 'order.signed',
        summary: 'Приказ утверждён',
        details: { comment: comment || null, orderDate: doc.order_date },
      });
      await notify(db, {
        userId: doc.initiator_id,
        type: 'order_signed',
        title: `Приказ ${doc.number} утверждён`,
        body: `Приказ ${docRef(doc)} утверждён. Сотрудникам из списка ознакомления направлены уведомления.`,
        entityType: 'document',
        entityId: id,
      });
      const list = await rows<{ user_id: number }>(
        db,
        `SELECT user_id FROM document_participants WHERE document_id = $1 AND role = 'acquaintance'`,
        [id],
      );
      if (list.length) {
        await notifyAcquaintance(db, doc, list.map((l) => l.user_id));
        await audit(db, {
          actorId: null,
          entityType: 'document',
          entityId: id,
          action: 'order.acquaintance_started',
          summary: `Приказ направлен на ознакомление: сотрудников — ${list.length}`,
          details: { userIds: list.map((l) => l.user_id) },
        });
      }
    } else {
      doc = await setStatus(db, doc, SIGN_RESULT[decision], ', signed_by = ' + Number(actor.id));
      await audit(db, {
        actorId: actor.id,
        entityType: 'document',
        entityId: id,
        action: decision === 'rework' ? 'order.returned' : 'order.rejected',
        summary: decision === 'rework' ? 'Приказ возвращён утверждающим на доработку' : 'Приказ отклонён утверждающим',
        details: { comment },
      });
      await notify(db, {
        userId: doc.initiator_id,
        type: decision === 'rework' ? 'approval_rework' : 'approval_rejected',
        title: decision === 'rework' ? `Приказ ${doc.number} возвращён на доработку` : `Приказ ${doc.number} отклонён`,
        body: `${actor.fullName}: ${comment}`,
        entityType: 'document',
        entityId: id,
      });
    }
    return buildDetail(db, actor, doc);
  });
}

export async function archiveOrder(actor: Actor, id: number): Promise<DocumentDetail | null> {
  return tx(async (db) => {
    const doc = await requireDocumentForManage(db, actor, id);
    requireOrder(doc);
    requireInitiatorOrAdmin(doc, actor);
    if (doc.status === 'archived') return manageResult(db, actor, id);
    if (doc.status !== 'approved') throw conflict('В архив можно перевести только утверждённый приказ');
    await db.query(`UPDATE documents SET status = 'archived', updated_at = now() WHERE id = $1`, [id]);
    await audit(db, {
      actorId: actor.id,
      entityType: 'document',
      entityId: id,
      action: 'order.archived',
      summary: 'Приказ переведён в архив',
    });
    return manageResult(db, actor, id);
  });
}

/** Подтверждение ознакомления с утверждённым приказом; повторное подтверждение ничего не меняет. */
export async function acknowledge(actor: Actor, id: number): Promise<DocumentDetail> {
  return tx(async (db) => {
    const doc = await requireDocument(db, actor, id, { lock: true });
    requireOrder(doc);
    const inList = await one(
      db,
      `SELECT 1 FROM document_participants WHERE document_id = $1 AND user_id = $2 AND role = 'acquaintance'`,
      [id, actor.id],
    );
    if (!inList) throw forbidden('Вы не входите в список ознакомления с этим приказом');
    const existing = await one(db, 'SELECT 1 FROM acknowledgements WHERE document_id = $1 AND user_id = $2', [id, actor.id]);
    if (existing) return buildDetail(db, actor, doc);
    if (doc.status !== 'approved') {
      throw conflict(doc.status === 'archived' ? 'Приказ находится в архиве' : 'Ознакомиться можно только с утверждённым приказом');
    }
    const version = await one<{ id: number; version_no: number }>(
      db,
      `SELECT v.id, v.version_no FROM files f JOIN file_versions v ON v.file_id = f.id
        WHERE f.owner_type = 'document' AND f.owner_id = $1 AND f.role = 'main' AND f.deleted_at IS NULL
        ORDER BY v.version_no DESC LIMIT 1`,
      [id],
    );
    await db.query(
      `INSERT INTO acknowledgements (document_id, user_id, file_version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [id, actor.id, version?.id ?? null],
    );
    await audit(db, {
      actorId: actor.id,
      entityType: 'document',
      entityId: id,
      action: 'order.acknowledged',
      summary: `Ознакомление с приказом подтверждено${version ? ` (версия файла ${version.version_no})` : ''}`,
      details: { fileVersionId: version?.id ?? null, fileVersionNo: version?.version_no ?? null },
    });
    return buildDetail(db, actor, doc);
  });
}

/** Список ознакомления: до утверждения — произвольно, после — только дополнение. */
export async function setAcquaintance(actor: Actor, id: number, userIdsRaw: number[]): Promise<DocumentDetail> {
  return tx(async (db) => {
    const doc = await requireDocument(db, actor, id, { lock: true });
    requireOrder(doc);
    requireInitiator(doc, actor, 'Изменять список ознакомления может только инициатор приказа');
    if (['rejected', 'cancelled', 'archived'].includes(doc.status)) {
      throw conflict('Список ознакомления завершённого приказа изменить нельзя');
    }
    const next = uniq(userIdsRaw);
    const old = (
      await rows<{ user_id: number }>(
        db,
        `SELECT user_id FROM document_participants WHERE document_id = $1 AND role = 'acquaintance' ORDER BY position`,
        [id],
      )
    ).map((r) => r.user_id);
    const added = next.filter((u) => !old.includes(u));
    const removed = old.filter((u) => !next.includes(u));
    if (doc.status === 'approved' && removed.length) {
      throw conflict('После утверждения приказа список ознакомления можно дополнять, но не сокращать');
    }
    await requireActiveUsers(db, added, 'userIds');
    if (!added.length && !removed.length) return buildDetail(db, actor, doc);
    if (removed.length) {
      await db.query(
        `DELETE FROM document_participants WHERE document_id = $1 AND role = 'acquaintance' AND user_id = ANY($2::int[])`,
        [id, removed],
      );
    }
    let pos = old.length;
    for (const u of added) {
      await db.query(
        `INSERT INTO document_participants (document_id, user_id, role, position) VALUES ($1, $2, 'acquaintance', $3)`,
        [id, u, ++pos],
      );
    }
    await db.query('UPDATE documents SET updated_at = now() WHERE id = $1', [id]);
    await audit(db, {
      actorId: actor.id,
      entityType: 'document',
      entityId: id,
      action: 'order.acquaintance_changed',
      summary: `Список ознакомления изменён: добавлено — ${added.length}, исключено — ${removed.length}`,
      details: { added, removed },
    });
    if (doc.status === 'approved') await notifyAcquaintance(db, doc, added);
    return buildDetail(db, actor, doc);
  });
}
