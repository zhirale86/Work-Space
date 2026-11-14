import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  AdminAuditEntry,
  AdminBitrixRetryResponse,
  AdminBitrixState,
  AdminDocumentDetail,
  AdminDocumentItem,
  AdminResetPasswordResponse,
  AdminUser,
  Department,
  DocType,
  Page,
} from '../api-types';
import { audit } from '../audit/service';
import { processBitrixQueue } from '../bitrix/sync';
import { idParams, paging, parse, zBoolQuery, zDate, zId, zPage } from '../common';
import { getPool, tx } from '../db';
import { conflict } from '../errors';
import { requireRole } from '../http';
import {
  adminDocument,
  adminDocuments,
  auditList,
  bitrixState,
  createDepartment,
  createDocType,
  createUser,
  getUser,
  listDepartments,
  listDocTypes,
  listUsers,
  resetPassword,
  setMockUnavailable,
  setUserActive,
  updateDepartment,
  updateDocType,
  updateUser,
} from './service';

const role = z.enum(['employee', 'signer', 'admin', 'auditor']);
const usersQuery = z.object({
  q: z.string().max(100).optional(),
  departmentId: zId.optional(),
  active: zBoolQuery,
  role: role.optional(),
  ...zPage,
});
const createUserSchema = z
  .object({
    login: z.string().regex(/^[A-Za-z0-9._-]{3,64}$/, 'Логин: 3–64 символа — латинские буквы, цифры, точка, дефис, подчёркивание'),
    fullName: z.string().min(1).max(200),
    position: z.string().max(200).optional(),
    departmentId: zId.nullable().optional(),
    roles: z.array(role).max(4).optional(),
    password: z.string().min(1).max(200),
    mustChangePassword: z.boolean().optional(),
  })
  .strict();
const updateUserSchema = z
  .object({
    fullName: z.string().max(200).optional(),
    position: z.string().max(200).optional(),
    departmentId: zId.nullable().optional(),
    roles: z.array(role).max(4).optional(),
  })
  .strict();
const resetSchema = z.object({ password: z.string().max(200).optional() });
const deptSchema = z.object({ name: z.string().max(200).optional(), active: z.boolean().optional() }).strict();
const requires = {
  requireDeal: z.boolean().optional(),
  requireFile: z.boolean().optional(),
  requireExcel: z.boolean().optional(),
  requireDeadline: z.boolean().optional(),
  requireDescription: z.boolean().optional(),
};
const createTypeSchema = z
  .object({
    code: z.string().regex(/^[A-Za-z0-9_]{2,30}$/, 'Код: 2–30 символов — латинские буквы, цифры, подчёркивание'),
    name: z.string().min(1).max(200),
    kind: z.enum(['approval', 'order']),
    numberPrefix: z.string().regex(/^[A-Za-zА-Яа-яЁё0-9]{1,10}$/, 'Префикс: 1–10 букв или цифр'),
    ...requires,
  })
  .strict();
const updateTypeSchema = z
  .object({
    name: z.string().max(200).optional(),
    numberPrefix: z
      .string()
      .regex(/^[A-Za-zА-Яа-яЁё0-9]{1,10}$/, 'Префикс: 1–10 букв или цифр')
      .optional(),
    active: z.boolean().optional(),
    ...requires,
  })
  .strict();
const mockSchema = z.object({ unavailable: z.boolean() });
const retrySchema = z.object({ documentId: zId.optional() });
const auditQuery = z.object({
  entityType: z.string().max(40).optional(),
  entityId: zId.optional(),
  actorId: zId.optional(),
  action: z.string().max(60).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  q: z.string().max(200).optional(),
  ...zPage,
});
const docsQuery = z.object({ q: z.string().max(100).optional(), status: z.string().max(200).optional(), initiatorId: zId.optional(), ...zPage });

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Все маршруты раздела доступны только роли «Администратор».
  app.addHook('preHandler', async (req) => {
    requireRole(req, 'admin');
  });

  app.get('/admin/users', async (req): Promise<Page<AdminUser>> => {
    const query = parse(usersQuery, req.query);
    return listUsers(getPool(), query, paging(query));
  });
  app.post('/admin/users', async (req, reply): Promise<AdminUser> => {
    const actor = requireRole(req, 'admin');
    reply.code(201);
    return createUser(actor.id, parse(createUserSchema, req.body));
  });
  app.get('/admin/users/:id', async (req): Promise<AdminUser> => getUser(getPool(), parse(idParams, req.params).id));
  app.patch('/admin/users/:id', async (req): Promise<AdminUser> => {
    return updateUser(requireRole(req, 'admin'), parse(idParams, req.params).id, parse(updateUserSchema, req.body));
  });
  app.post('/admin/users/:id/block', async (req): Promise<AdminUser> => {
    return setUserActive(requireRole(req, 'admin'), parse(idParams, req.params).id, false);
  });
  app.post('/admin/users/:id/unblock', async (req): Promise<AdminUser> => {
    return setUserActive(requireRole(req, 'admin'), parse(idParams, req.params).id, true);
  });
  app.post('/admin/users/:id/reset-password', async (req): Promise<AdminResetPasswordResponse> => {
    const body = parse(resetSchema, req.body);
    return { temporaryPassword: await resetPassword(requireRole(req, 'admin'), parse(idParams, req.params).id, body.password) };
  });

  app.get('/admin/departments', async (): Promise<{ items: Department[] }> => ({ items: await listDepartments(getPool(), false) }));
  app.post('/admin/departments', async (req, reply): Promise<Department> => {
    const body = parse(deptSchema, req.body);
    reply.code(201);
    return createDepartment(requireRole(req, 'admin').id, body.name ?? '');
  });
  app.patch('/admin/departments/:id', async (req): Promise<Department> => {
    return updateDepartment(requireRole(req, 'admin'), parse(idParams, req.params).id, parse(deptSchema, req.body));
  });

  app.get('/admin/doc-types', async (): Promise<{ items: DocType[] }> => ({ items: await listDocTypes(getPool(), false) }));
  app.post('/admin/doc-types', async (req, reply): Promise<DocType> => {
    reply.code(201);
    return createDocType(requireRole(req, 'admin').id, parse(createTypeSchema, req.body));
  });
  app.patch('/admin/doc-types/:id', async (req): Promise<DocType> => {
    return updateDocType(requireRole(req, 'admin'), parse(idParams, req.params).id, parse(updateTypeSchema, req.body));
  });

  app.get('/admin/bitrix', async (): Promise<AdminBitrixState> => bitrixState(getPool()));
  app.put('/admin/bitrix/mock', async (req): Promise<AdminBitrixState> => {
    const body = parse(mockSchema, req.body);
    await setMockUnavailable(requireRole(req, 'admin'), body.unavailable);
    return bitrixState(getPool());
  });
  app.post('/admin/bitrix/retry', async (req): Promise<AdminBitrixRetryResponse> => {
    const actor = requireRole(req, 'admin');
    const body = parse(retrySchema, req.body);
    await tx(async (db) => {
      const r = await db.query(
        `UPDATE bitrix_links SET state = 'pending', next_attempt_at = now()
          WHERE state IN ('pending','error') AND ($1::int IS NULL OR document_id = $1)`,
        [body.documentId ?? null],
      );
      if (body.documentId && !r.rowCount) throw conflict('По документу нет записей, ожидающих передачи');
      await audit(db, {
        actorId: actor.id,
        entityType: body.documentId ? 'document' : 'bitrix',
        entityId: body.documentId ?? null,
        action: 'bitrix.retry_requested',
        summary: body.documentId ? 'Запрошена повторная передача в Битрикс24' : 'Запрошена повторная передача в Битрикс24 всех ожидающих записей',
      });
    });
    return processBitrixQueue({ documentId: body.documentId, force: true });
  });

  app.get('/admin/audit', async (req): Promise<Page<AdminAuditEntry>> => {
    const query = parse(auditQuery, req.query);
    return auditList(getPool(), requireRole(req, 'admin'), query, paging({ pageSize: 50, ...query }));
  });

  app.get('/admin/documents', async (req): Promise<Page<AdminDocumentItem>> => {
    const query = parse(docsQuery, req.query);
    return adminDocuments(
      getPool(),
      { q: query.q, statuses: query.status?.split(',').map((s) => s.trim()).filter(Boolean), initiatorId: query.initiatorId },
      paging(query),
    );
  });
  app.get('/admin/documents/:id', async (req): Promise<AdminDocumentDetail> => adminDocument(getPool(), parse(idParams, req.params).id));
}
