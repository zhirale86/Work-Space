import type { Decision, DocumentDetail, ErrorDetail, RouteChangeRequest, RouteMode, StepState } from '../api-types';
import { audit } from '../audit/service';
import { enqueueBitrixSync } from '../bitrix/sync';
import { type Actor, clean, isAdmin } from '../common';
import { type Db, one, rows, tx } from '../db';
import {
  type DocRow,
  findDocument,
  requireDocument,
  requireDocumentForManage,
  requireInitiator,
  requireInitiatorOrAdmin,
} from '../documents/access';
import { type DocTypeRow, type StepRow, buildDetail } from '../documents/service';
import { conflict, forbidden, unprocessable } from '../errors';
import { ROUTE_MODE_LABELS, docStatusLabel, q } from '../labels';
import { notify, notifyMany } from '../notifications/service';

const docRef = (doc: DocRow): string => `${doc.number}${doc.title ? ` ${q(doc.title)}` : ''}`;

async function setStatus(db: Db, doc: DocRow, status: DocRow['status'], extra = ''): Promise<DocRow> {
  const completed = ['approved', 'rejected', 'cancelled'].includes(status);
  const updated = (await one<DocRow>(
    db,
    `UPDATE documents SET status = $2, updated_at = now(),
            completed_at = ${completed ? 'now()' : 'NULL'} ${extra}
      WHERE id = $1 RETURNING *`,
    [doc.id, status],
  ))!;
  await enqueueBitrixSync(db, updated);
  return updated;
}

async function result(db: Db, actor: Actor, doc: DocRow): Promise<DocumentDetail> {
  // После действия администратора без права просмотра содержимого карточка не возвращается целиком.
  return buildDetail(db, actor, doc);
}

// ───────────── Запуск ─────────────

async function launchProblems(db: Db, doc: DocRow, type: DocTypeRow, approvers: number[]): Promise<ErrorDetail[]> {
  const problems: ErrorDetail[] = [];
  if (!doc.title.trim()) problems.push({ field: 'title', message: 'Не указано название' });
  if (type.require_description && !doc.description.trim()) problems.push({ field: 'description', message: 'Не заполнено описание' });
  if (doc.kind === 'order') {
    if (!doc.signer_id) problems.push({ field: 'signer', message: 'Не выбран утверждающий' });
    else {
      const s = await one<{ full_name: string; active: boolean; roles: string[] }>(
        db,
        'SELECT full_name, active, roles FROM users WHERE id = $1',
        [doc.signer_id],
      );
      if (!s?.active) problems.push({ field: 'signer', message: `Учётная запись утверждающего (${s?.full_name}) заблокирована — выберите другого` });
      else if (!s.roles.includes('signer')) problems.push({ field: 'signer', message: `Сотрудник ${s.full_name} не имеет полномочия «Утверждающий»` });
    }
  } else if (!approvers.length) {
    problems.push({ field: 'approvers', message: 'Не выбран ни один согласующий' });
  }
  if (approvers.length) {
    const blocked = await rows<{ full_name: string }>(
      db,
      'SELECT full_name FROM users WHERE id = ANY($1::int[]) AND NOT active ORDER BY full_name',
      [approvers],
    );
    for (const b of blocked) {
      problems.push({ field: 'approvers', message: `Учётная запись согласующего (${b.full_name}) заблокирована — замените участника` });
    }
    if (approvers.includes(doc.initiator_id)) {
      problems.push({ field: 'approvers', message: 'Инициатор не может быть согласующим собственного документа' });
    }
  }
  if (type.require_deal && !doc.deal_id) problems.push({ field: 'deal', message: 'Не выбрана сделка Битрикс24' });
  if (type.require_deadline && !doc.due_at) problems.push({ field: 'dueAt', message: 'Не указан срок' });
  if (doc.due_at && doc.due_at.getTime() <= Date.now()) problems.push({ field: 'dueAt', message: 'Срок уже прошёл — укажите новый срок' });

  const files = await rows<{ role: string; ext: string }>(
    db,
    `SELECT f.role, v.ext FROM files f
       JOIN LATERAL (SELECT ext FROM file_versions WHERE file_id = f.id ORDER BY version_no DESC LIMIT 1) v ON true
      WHERE f.owner_type = 'document' AND f.owner_id = $1 AND f.deleted_at IS NULL`,
    [doc.id],
  );
  const main = files.find((f) => f.role === 'main');
  if (type.require_excel) {
    if (!main) problems.push({ field: 'mainFile', message: 'Не прикреплён Excel-файл (основной документ)' });
    else if (!['xlsx', 'xls'].includes(main.ext)) {
      problems.push({ field: 'mainFile', message: 'Основной документ должен быть Excel-файлом (XLSX или XLS)' });
    }
  } else if (type.require_file && !main) {
    problems.push({ field: 'mainFile', message: 'Не прикреплён основной документ' });
  }
  return problems;
}

/** Запуск и повторный запуск согласования. Новый раунд создаётся для всех согласующих. */
export async function launchDocument(actor: Actor, id: number, routeMode?: RouteMode): Promise<DocumentDetail> {
  return tx(async (db) => {
    let doc = await requireDocument(db, actor, id, { lock: true });
    requireInitiator(doc, actor, 'Запустить согласование может только инициатор');
    if (doc.status !== 'draft' && doc.status !== 'rework') {
      throw conflict(`Запуск невозможен: документ в статусе ${q(docStatusLabel(doc.status, doc.kind))}`);
    }
    const type = (await one<DocTypeRow>(db, 'SELECT * FROM doc_types WHERE id = $1', [doc.doc_type_id]))!;
    const approvers = (
      await rows<{ user_id: number }>(
        db,
        `SELECT user_id FROM document_participants WHERE document_id = $1 AND role = 'approver' ORDER BY position, user_id`,
        [id],
      )
    ).map((r) => r.user_id);
    const problems = await launchProblems(db, doc, type, approvers);
    if (problems.length) throw unprocessable('Запуск невозможен: заполните обязательные сведения', problems);

    const mode = routeMode ?? doc.route_mode;
    const relaunch = doc.launch_count > 0;
    const isOrder = doc.kind === 'order';
    const nextStatus = approvers.length ? 'in_review' : 'on_signing';
    doc = (await one<DocRow>(
      db,
      `UPDATE documents SET status = $2, route_mode = $3, launch_count = launch_count + 1, launched_at = now(),
              completed_at = NULL, updated_at = now(), signed_at = NULL, signed_by = NULL
        WHERE id = $1 RETURNING *`,
      [id, nextStatus, mode],
    ))!;

    let roundNo: number | null = null;
    if (approvers.length) {
      const last = await one<{ n: number }>(db, 'SELECT COALESCE(max(round_no), 0)::int AS n FROM approval_rounds WHERE document_id = $1', [id]);
      roundNo = (last?.n ?? 0) + 1;
      const round = (await one<{ id: number }>(
        db,
        `INSERT INTO approval_rounds (document_id, round_no, mode, started_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [id, roundNo, mode, actor.id],
      ))!;
      // Снимок версий файлов, рассматриваемых в этом раунде.
      await db.query(
        `INSERT INTO round_files (round_id, file_version_id)
         SELECT $1, v.id FROM files f
           JOIN LATERAL (SELECT id FROM file_versions WHERE file_id = f.id ORDER BY version_no DESC LIMIT 1) v ON true
          WHERE f.owner_type = 'document' AND f.owner_id = $2 AND f.deleted_at IS NULL`,
        [round.id, id],
      );
      const first: number[] = [];
      for (let i = 0; i < approvers.length; i++) {
        const pending = mode === 'parallel' || i === 0;
        await db.query(
          `INSERT INTO approval_steps (round_id, user_id, position, state, activated_at) VALUES ($1, $2, $3, $4, $5)`,
          [round.id, approvers[i], i + 1, pending ? 'pending' : 'waiting', pending ? new Date() : null],
        );
        if (pending) first.push(approvers[i]);
      }
      await notifyMany(db, first, {
        type: 'approval_requested',
        title: `Документ на согласование: ${doc.number}`,
        body: `Вам на согласование поступил документ ${docRef(doc)}. Инициатор — ${actor.fullName}.`,
        entityType: 'document',
        entityId: id,
      });
    } else {
      await notifySigner(db, doc);
    }
    await audit(db, {
      actorId: actor.id,
      entityType: 'document',
      entityId: id,
      action: relaunch ? 'approval.relaunched' : 'approval.launched',
      summary: approvers.length
        ? `${relaunch ? 'Согласование запущено повторно' : 'Согласование запущено'}: раунд ${roundNo}, ${ROUTE_MODE_LABELS[mode].toLowerCase()}, согласующих — ${approvers.length}`
        : `${isOrder ? 'Приказ' : 'Документ'} направлен на утверждение${relaunch ? ' повторно' : ''}`,
      details: { roundNo, mode, approvers },
    });
    await enqueueBitrixSync(db, doc);
    return result(db, actor, doc);
  });
}

export async function notifySigner(db: Db, doc: DocRow): Promise<void> {
  if (!doc.signer_id) return;
  await notify(db, {
    userId: doc.signer_id,
    type: 'sign_requested',
    title: `Приказ на утверждение: ${doc.number}`,
    body: `Приказ ${docRef(doc)} ожидает вашего утверждения.`,
    entityType: 'document',
    entityId: doc.id,
  });
}

// ───────────── Решение согласующего ─────────────

const DECISION_STATE: Record<Decision, StepState> = { approve: 'approved', rework: 'rework', reject: 'rejected' };

export async function decide(actor: Actor, id: number, decision: Decision, commentRaw?: string): Promise<DocumentDetail> {
  return tx(async (db) => {
    let doc = await requireDocument(db, actor, id, { lock: true });
    const comment = clean(commentRaw);
    if (decision !== 'approve' && !comment) {
      throw unprocessable('Укажите комментарий: он обязателен при возврате на доработку и отклонении', [
        { field: 'comment', message: 'Комментарий обязателен' },
      ]);
    }
    // Решения сериализуются блокировкой строки раунда.
    const round = await one<{ id: number; round_no: number; mode: RouteMode; finished_at: Date | null }>(
      db,
      'SELECT id, round_no, mode, finished_at FROM approval_rounds WHERE document_id = $1 ORDER BY round_no DESC LIMIT 1 FOR UPDATE',
      [id],
    );
    if (!round) throw conflict('Согласование по документу не запущено');
    const step = await one<StepRow>(
      db,
      `SELECT * FROM approval_steps WHERE round_id = $1 AND user_id = $2 AND state <> 'replaced'`,
      [round.id, actor.id],
    );
    if (!step) throw forbidden('Вы не являетесь согласующим в текущем раунде');
    const target = DECISION_STATE[decision];
    // Повтор того же решения (двойное нажатие) не создаёт второй записи.
    if (step.state === target) return result(db, actor, doc);
    if (round.finished_at) throw conflict('Раунд согласования уже завершён — решение не принято');
    if (step.state !== 'pending') {
      throw conflict(
        step.state === 'waiting'
          ? 'Очередь согласования до вас ещё не дошла'
          : 'Решение по этому шагу уже принято и не может быть изменено',
      );
    }
    await db.query(`UPDATE approval_steps SET state = $2, comment = $3, decided_at = now() WHERE id = $1`, [
      step.id,
      target,
      comment || null,
    ]);
    const snapshot = await rows<{ file_version_id: number }>(db, 'SELECT file_version_id FROM round_files WHERE round_id = $1', [round.id]);
    const base = { roundNo: round.round_no, stepId: step.id, fileVersionIds: snapshot.map((s) => s.file_version_id) };

    if (decision === 'approve') {
      await audit(db, {
        actorId: actor.id,
        entityType: 'document',
        entityId: id,
        action: 'approval.approved',
        summary: `Согласовано (раунд ${round.round_no})`,
        details: { ...base, comment: comment || null },
      });
      const next = await one<StepRow>(
        db,
        `SELECT * FROM approval_steps WHERE round_id = $1 AND state = 'waiting' ORDER BY position, id LIMIT 1`,
        [round.id],
      );
      const stillPending = await one(db, `SELECT 1 FROM approval_steps WHERE round_id = $1 AND state = 'pending' LIMIT 1`, [round.id]);
      if (next && !stillPending) {
        await db.query(`UPDATE approval_steps SET state = 'pending', activated_at = now() WHERE id = $1`, [next.id]);
        await notify(db, {
          userId: next.user_id,
          type: 'approval_requested',
          title: `Документ на согласование: ${doc.number}`,
          body: `Документ ${docRef(doc)} ожидает вашего решения.`,
          entityType: 'document',
          entityId: id,
        });
        await db.query('UPDATE documents SET updated_at = now() WHERE id = $1', [id]);
        // Состав текущих согласующих изменился — обновить запись в Битрикс24.
        await enqueueBitrixSync(db, doc);
      } else if (!next && !stillPending) {
        await db.query(`UPDATE approval_rounds SET finished_at = now(), outcome = 'approved' WHERE id = $1`, [round.id]);
        if (doc.kind === 'order') {
          doc = await setStatus(db, doc, 'on_signing');
          await audit(db, {
            actorId: null,
            entityType: 'document',
            entityId: id,
            action: 'approval.completed',
            summary: 'Согласование завершено — приказ направлен на утверждение',
            details: { roundNo: round.round_no },
          });
          await notifySigner(db, doc);
          await notify(db, {
            userId: doc.initiator_id,
            type: 'approval_completed',
            title: `Приказ ${doc.number} согласован`,
            body: `Приказ ${docRef(doc)} согласован всеми участниками и направлен на утверждение.`,
            entityType: 'document',
            entityId: id,
          });
        } else {
          doc = await setStatus(db, doc, 'approved');
          await audit(db, {
            actorId: null,
            entityType: 'document',
            entityId: id,
            action: 'approval.completed',
            summary: 'Согласование завершено: получены все согласования, статус «Согласовано»',
            details: { roundNo: round.round_no },
          });
          await notify(db, {
            userId: doc.initiator_id,
            type: 'approval_completed',
            title: `Документ ${doc.number} согласован`,
            body: `Документ ${docRef(doc)} согласован всеми участниками.`,
            entityType: 'document',
            entityId: id,
          });
        }
      }
    } else {
      // Отрицательное решение завершает раунд сразу; остальные шаги — «Не потребовалось».
      await db.query(`UPDATE approval_steps SET state = 'skipped' WHERE round_id = $1 AND state IN ('pending','waiting')`, [round.id]);
      await db.query(`UPDATE approval_rounds SET finished_at = now(), outcome = $2 WHERE id = $1`, [round.id, target]);
      doc = await setStatus(db, doc, decision === 'rework' ? 'rework' : 'rejected');
      await audit(db, {
        actorId: actor.id,
        entityType: 'document',
        entityId: id,
        action: decision === 'rework' ? 'approval.returned' : 'approval.rejected',
        summary: decision === 'rework' ? `Возвращено на доработку (раунд ${round.round_no})` : `Отклонено (раунд ${round.round_no})`,
        details: { ...base, comment },
      });
      await notify(db, {
        userId: doc.initiator_id,
        type: decision === 'rework' ? 'approval_rework' : 'approval_rejected',
        title: decision === 'rework' ? `Документ ${doc.number} возвращён на доработку` : `Документ ${doc.number} отклонён`,
        body: `${actor.fullName}: ${comment}`,
        entityType: 'document',
        entityId: id,
      });
    }
    return result(db, actor, doc);
  });
}

// ───────────── Изменение маршрута ─────────────

export async function changeRoute(actor: Actor, id: number, input: RouteChangeRequest): Promise<DocumentDetail | null> {
  return tx(async (db) => {
    const doc = await requireDocumentForManage(db, actor, id);
    requireInitiatorOrAdmin(doc, actor);
    const reason = clean(input.reason);
    if (!reason) throw unprocessable('Укажите причину изменения маршрута', [{ field: 'reason', message: 'Причина обязательна' }]);
    if (['approved', 'rejected', 'cancelled', 'archived'].includes(doc.status)) {
      throw conflict('Маршрут завершённого документа изменить нельзя');
    }
    if (doc.status !== 'in_review') {
      throw conflict('Маршрут изменяется во время согласования; в черновике и на доработке измените состав согласующих в карточке');
    }
    const round = (await one<{ id: number; round_no: number; mode: RouteMode }>(
      db,
      'SELECT id, round_no, mode FROM approval_rounds WHERE document_id = $1 AND finished_at IS NULL FOR UPDATE',
      [id],
    ))!;
    const to = await one<{ id: number; full_name: string; active: boolean }>(db, 'SELECT id, full_name, active FROM users WHERE id = $1', [
      input.toUserId,
    ]);
    const failTo = (m: string) => unprocessable(m, [{ field: 'toUserId', message: m }]);
    if (!to) throw failTo('Сотрудник не найден');
    if (!to.active) throw failTo(`Учётная запись сотрудника ${to.full_name} заблокирована`);
    if (to.id === doc.initiator_id) throw failTo('Инициатор не может быть согласующим собственного документа');
    const dup = await one(db, `SELECT 1 FROM approval_steps WHERE round_id = $1 AND user_id = $2 AND state <> 'replaced'`, [round.id, to.id]);
    if (dup) throw failTo(`${to.full_name} уже участвует в этом раунде согласования`);

    if (input.action === 'replace') {
      const step = await one<StepRow>(
        db,
        `SELECT * FROM approval_steps WHERE round_id = $1 AND user_id = $2 AND state <> 'replaced'`,
        [round.id, input.fromUserId],
      );
      if (!step) throw unprocessable('Заменяемый сотрудник не участвует в текущем раунде', [{ field: 'fromUserId', message: 'Сотрудник не участвует в текущем раунде' }]);
      if (step.state !== 'pending' && step.state !== 'waiting') throw conflict('Нельзя заменить участника, уже принявшего решение');
      const from = (await one<{ full_name: string }>(db, 'SELECT full_name FROM users WHERE id = $1', [step.user_id]))!;
      await db.query(`UPDATE approval_steps SET state = 'replaced', decided_at = now(), comment = $2 WHERE id = $1`, [step.id, `Заменён: ${reason}`]);
      await db.query(
        `INSERT INTO approval_steps (round_id, user_id, position, state, activated_at) VALUES ($1, $2, $3, $4, $5)`,
        [round.id, to.id, step.position, step.state, step.state === 'pending' ? new Date() : null],
      );
      // Плановый состав (для повторного запуска) тоже обновляется.
      await db.query(`DELETE FROM document_participants WHERE document_id = $1 AND role = 'approver' AND user_id = $2`, [id, to.id]);
      await db.query(`UPDATE document_participants SET user_id = $3 WHERE document_id = $1 AND role = 'approver' AND user_id = $2`, [
        id,
        step.user_id,
        to.id,
      ]);
      await audit(db, {
        actorId: actor.id,
        entityType: 'document',
        entityId: id,
        action: 'route.replaced',
        summary: `Маршрут изменён: замена согласующего — ${from.full_name} → ${to.full_name}. Причина: ${reason}`,
        details: { roundNo: round.round_no, fromUserId: step.user_id, toUserId: to.id, reason, position: step.position },
      });
      await notify(db, {
        userId: step.user_id,
        type: 'route_changed',
        title: `Вы исключены из маршрута согласования ${doc.number}`,
        body: `Ваше участие в согласовании документа ${doc.number} больше не требуется.`,
      });
      if (step.state === 'pending') {
        await notify(db, {
          userId: to.id,
          type: 'approval_requested',
          title: `Документ на согласование: ${doc.number}`,
          body: `Документ ${docRef(doc)} ожидает вашего решения.`,
          entityType: 'document',
          entityId: id,
        });
      }
    } else {
      const last = await one<{ n: number }>(db, `SELECT COALESCE(max(position), 0)::int AS n FROM approval_steps WHERE round_id = $1`, [round.id]);
      const position = (last?.n ?? 0) + 1;
      const pending = round.mode === 'parallel';
      await db.query(
        `INSERT INTO approval_steps (round_id, user_id, position, state, activated_at) VALUES ($1, $2, $3, $4, $5)`,
        [round.id, to.id, position, pending ? 'pending' : 'waiting', pending ? new Date() : null],
      );
      await db.query(
        `INSERT INTO document_participants (document_id, user_id, role, position)
         VALUES ($1, $2, 'approver', (SELECT COALESCE(max(position), 0) + 1 FROM document_participants WHERE document_id = $1 AND role = 'approver'))
         ON CONFLICT DO NOTHING`,
        [id, to.id],
      );
      await audit(db, {
        actorId: actor.id,
        entityType: 'document',
        entityId: id,
        action: 'route.added',
        summary: `Маршрут изменён: добавлен согласующий ${to.full_name}. Причина: ${reason}`,
        details: { roundNo: round.round_no, toUserId: to.id, reason, position },
      });
      if (pending) {
        await notify(db, {
          userId: to.id,
          type: 'approval_requested',
          title: `Документ на согласование: ${doc.number}`,
          body: `Документ ${docRef(doc)} ожидает вашего решения.`,
          entityType: 'document',
          entityId: id,
        });
      }
    }
    await db.query('UPDATE documents SET updated_at = now() WHERE id = $1', [id]);
    await enqueueBitrixSync(db, doc);
    return manageResult(db, actor, doc.id);
  });
}

/** Карточка после управляющего действия; администратору без права просмотра содержимого — null. */
export async function manageResult(db: Db, actor: Actor, id: number): Promise<DocumentDetail | null> {
  const doc = await findDocument(db, actor, id);
  return doc ? buildDetail(db, actor, doc) : null;
}

// ───────────── Отмена и напоминание ─────────────

export async function cancelDocument(actor: Actor, id: number, reasonRaw: string): Promise<DocumentDetail | null> {
  return tx(async (db) => {
    let doc = await requireDocumentForManage(db, actor, id);
    requireInitiatorOrAdmin(doc, actor);
    const reason = clean(reasonRaw);
    if (!reason) throw unprocessable('Укажите причину отмены', [{ field: 'reason', message: 'Причина обязательна' }]);
    if (doc.status === 'cancelled') return manageResult(db, actor, id);
    if (!['draft', 'in_review', 'rework', 'on_signing'].includes(doc.status)) {
      throw conflict(`Отмена невозможна: документ в статусе ${q(docStatusLabel(doc.status, doc.kind))}`);
    }
    const prev = doc.status;
    const round = await one<{ id: number }>(db, 'SELECT id FROM approval_rounds WHERE document_id = $1 AND finished_at IS NULL FOR UPDATE', [id]);
    let waiting: number[] = [];
    if (round) {
      waiting = (
        await rows<{ user_id: number }>(db, `SELECT user_id FROM approval_steps WHERE round_id = $1 AND state = 'pending'`, [round.id])
      ).map((r) => r.user_id);
      await db.query(`UPDATE approval_steps SET state = 'skipped' WHERE round_id = $1 AND state IN ('pending','waiting')`, [round.id]);
      await db.query(`UPDATE approval_rounds SET finished_at = now(), outcome = 'cancelled' WHERE id = $1`, [round.id]);
    }
    if (prev === 'on_signing' && doc.signer_id) waiting.push(doc.signer_id);
    doc = await setStatus(db, doc, 'cancelled');
    await audit(db, {
      actorId: actor.id,
      entityType: 'document',
      entityId: id,
      action: 'document.cancelled',
      summary: `Процесс отменён${isAdmin(actor) && doc.initiator_id !== actor.id ? ' администратором' : ''}. Причина: ${reason}`,
      details: { reason, previousStatus: prev },
    });
    const recipients = [...waiting, doc.initiator_id].filter((u) => u !== actor.id);
    await notifyMany(db, recipients, {
      type: 'approval_cancelled',
      title: `Процесс по документу ${doc.number} отменён`,
      body: `Причина: ${reason}`,
      entityType: 'document',
      entityId: id,
    });
    return manageResult(db, actor, id);
  });
}

/** Напоминание участникам, от которых ожидается решение, — не чаще раза в сутки. */
export async function remind(actor: Actor, id: number): Promise<DocumentDetail> {
  return tx(async (db) => {
    const doc = await requireDocument(db, actor, id, { lock: true });
    requireInitiator(doc, actor, 'Отправить напоминание может только инициатор');
    let recipients: number[] = [];
    if (doc.status === 'in_review') {
      recipients = (
        await rows<{ user_id: number }>(
          db,
          `SELECT s.user_id FROM approval_steps s JOIN approval_rounds r ON r.id = s.round_id
            WHERE r.document_id = $1 AND r.finished_at IS NULL AND s.state = 'pending'`,
          [id],
        )
      ).map((r) => r.user_id);
    } else if (doc.status === 'on_signing' && doc.signer_id) {
      recipients = [doc.signer_id];
    } else {
      throw conflict('Напоминание отправляется, только когда от участников ожидается решение');
    }
    if (doc.last_reminded_at && Date.now() - doc.last_reminded_at.getTime() < 24 * 3600 * 1000) {
      throw conflict('Напоминание уже отправлялось — повторить можно не чаще одного раза в сутки');
    }
    const updated = (await one<DocRow>(db, 'UPDATE documents SET last_reminded_at = now() WHERE id = $1 RETURNING *', [id]))!;
    await notifyMany(db, recipients, {
      type: 'reminder',
      title: `Напоминание: ожидается ваше решение по документу ${doc.number}`,
      body: `Инициатор ${actor.fullName} напоминает о документе ${docRef(doc)}.`,
      entityType: 'document',
      entityId: id,
    });
    await audit(db, {
      actorId: actor.id,
      entityType: 'document',
      entityId: id,
      action: 'document.reminded',
      summary: `Отправлено напоминание участникам (${recipients.length})`,
      details: { recipients },
    });
    return buildDetail(db, actor, updated);
  });
}

export { setStatus, docRef };
