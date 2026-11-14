import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Department, DocType, MetaResponse, Page, UserRef } from '../api-types';
import { listDepartments, listDocTypes } from '../admin/service';
import { like, pageOf, paging, parse, toUserRef, zId, zPage } from '../common';
import { config } from '../config';
import { getPool, one, rows } from '../db';
import { actorOf } from '../http';
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
} from '../labels';
import { Params } from '../sql';

const usersQuery = z.object({
  q: z.string().max(100).optional(),
  departmentId: zId.optional(),
  role: z.enum(['employee', 'signer', 'admin', 'auditor']).optional(),
  ...zPage,
});

export async function directoryRoutes(app: FastifyInstance): Promise<void> {
  /** Поиск активных сотрудников для выбора участников. */
  app.get('/users', async (req): Promise<Page<UserRef>> => {
    actorOf(req);
    const query = parse(usersQuery, req.query);
    const pg = paging(query);
    const p = new Params();
    const cond = ['u.active'];
    if (query.q?.trim()) {
      const pat = p.add(like(query.q.trim()));
      cond.push(`(u.full_name ILIKE ${pat} OR u.login ILIKE ${pat} OR u.position ILIKE ${pat})`);
    }
    if (query.departmentId) cond.push(`u.department_id = ${p.add(query.departmentId)}`);
    if (query.role) cond.push(`${p.add(query.role)} = ANY(u.roles)`);
    const where = cond.join(' AND ');
    const db = getPool();
    const total = (await one<{ c: number }>(db, `SELECT count(*)::int AS c FROM users u WHERE ${where}`, p.values))?.c ?? 0;
    const list = await rows(
      db,
      `SELECT u.id, u.full_name, u.position, u.active, u.department_id, d.name AS department_name
         FROM users u LEFT JOIN departments d ON d.id = u.department_id
        WHERE ${where} ORDER BY u.full_name, u.id LIMIT ${p.add(pg.limit)} OFFSET ${p.add(pg.offset)}`,
      p.values,
    );
    return pageOf(list.map(toUserRef), total, pg);
  });

  app.get('/departments', async (req): Promise<{ items: Department[] }> => {
    actorOf(req);
    return { items: await listDepartments(getPool(), true) };
  });

  app.get('/doc-types', async (req): Promise<{ items: DocType[] }> => {
    actorOf(req);
    return { items: await listDocTypes(getPool(), true) };
  });

  /** Перечисления с русскими подписями и действующие ограничения. */
  app.get('/meta', async (req): Promise<MetaResponse> => {
    actorOf(req);
    return {
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
      limits: {
        maxFileMb: config.maxFileMb,
        maxFilesPerCard: config.maxFilesPerCard,
        maxCardTotalMb: config.maxCardTotalMb,
        allowedExtensions: config.allowedExtensions,
      },
      bitrixMode: config.bitrixMode,
    };
  });
}
