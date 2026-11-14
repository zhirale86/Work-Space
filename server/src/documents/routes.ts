import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  AccessRequest,
  AddCommentRequest,
  Comment,
  CreateDocumentRequest,
  DocumentDetail,
  DocumentListItem,
  HistoryEntry,
  OkResponse,
  Page,
  UpdateDocumentRequest,
} from '../api-types';
import { entityHistory } from '../audit/service';
import { idParams, paging, parse, zBoolQuery, zDate, zId, zIdList, zPage } from '../common';
import { getPool } from '../db';
import { actorOf } from '../http';
import { requireDocument } from './access';
import {
  addDocumentComment,
  copyDocument,
  createDocument,
  deleteDocument,
  getDocumentDetail,
  loadComments,
  parseStatuses,
  queryDocuments,
  setAccess,
  updateDocument,
} from './service';

const DOC_STATUSES = ['draft', 'in_review', 'rework', 'on_signing', 'approved', 'rejected', 'cancelled', 'archived'];

const listQuery = z.object({
  q: z.string().max(200).optional(),
  scope: z.enum(['all', 'mine', 'to_approve', 'to_sign', 'to_acknowledge']).optional(),
  kind: z.enum(['approval', 'order']).optional(),
  typeId: zId.optional(),
  status: z
    .string()
    .max(200)
    .refine((v) => v.split(',').every((s) => DOC_STATUSES.includes(s.trim())), 'Недопустимый статус')
    .optional(),
  initiatorId: zId.optional(),
  departmentId: zId.optional(),
  createdFrom: zDate.optional(),
  createdTo: zDate.optional(),
  deal: z.string().max(200).optional(),
  overdue: zBoolQuery,
  ...zPage,
});

const dueAt = z.string().max(40).nullable().optional();
const baseFields = {
  title: z.string().max(300).optional(),
  description: z.string().max(10000).optional(),
  dueAt,
  routeMode: z.enum(['sequential', 'parallel']).optional(),
  dealId: z
    .union([z.string().max(40), z.number().int().positive()])
    .transform((v) => String(v))
    .nullable()
    .optional(),
  approverIds: zIdList.optional(),
  observerIds: zIdList.optional(),
  signerId: zId.nullable().optional(),
  acquaintanceIds: z.array(z.number().int().positive()).max(1000).optional(),
  orderDate: zDate.nullable().optional(),
};
const createSchema = z.object({ typeId: zId, ...baseFields }).strict();
const updateSchema = z.object(baseFields).strict();
const commentSchema = z.object({ body: z.string().max(5000) });
const accessSchema = z.object({ userIds: zIdList, departmentIds: zIdList });
const pageQuery = z.object(zPage);

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/documents', async (req): Promise<Page<DocumentListItem>> => {
    const actor = actorOf(req);
    const query = parse(listQuery, req.query);
    return queryDocuments(
      getPool(),
      actor,
      {
        q: query.q,
        scope: query.scope,
        kind: query.kind,
        typeId: query.typeId,
        statuses: parseStatuses(query.status),
        initiatorId: query.initiatorId,
        departmentId: query.departmentId,
        createdFrom: query.createdFrom,
        createdTo: query.createdTo,
        deal: query.deal,
        overdue: query.overdue,
      },
      paging(query),
    );
  });

  app.post('/documents', async (req, reply): Promise<DocumentDetail> => {
    const actor = actorOf(req);
    const body: CreateDocumentRequest = parse(createSchema, req.body);
    reply.code(201);
    return createDocument(actor, body);
  });

  app.get('/documents/:id', async (req): Promise<DocumentDetail> => {
    const { id } = parse(idParams, req.params);
    return getDocumentDetail(getPool(), actorOf(req), id);
  });

  app.patch('/documents/:id', async (req): Promise<DocumentDetail> => {
    const { id } = parse(idParams, req.params);
    const body: UpdateDocumentRequest = parse(updateSchema, req.body);
    return updateDocument(actorOf(req), id, body);
  });

  app.delete('/documents/:id', async (req): Promise<OkResponse> => {
    const { id } = parse(idParams, req.params);
    await deleteDocument(actorOf(req), id);
    return { ok: true };
  });

  app.post('/documents/:id/copy', async (req, reply): Promise<DocumentDetail> => {
    const { id } = parse(idParams, req.params);
    reply.code(201);
    return copyDocument(actorOf(req), id);
  });

  app.put('/documents/:id/access', async (req): Promise<DocumentDetail> => {
    const { id } = parse(idParams, req.params);
    const body: AccessRequest = parse(accessSchema, req.body);
    return setAccess(actorOf(req), id, body.userIds, body.departmentIds);
  });

  app.get('/documents/:id/history', async (req): Promise<Page<HistoryEntry>> => {
    const { id } = parse(idParams, req.params);
    const db = getPool();
    await requireDocument(db, actorOf(req), id);
    return entityHistory(db, 'document', id, paging({ pageSize: 50, ...parse(pageQuery, req.query) }));
  });

  app.get('/documents/:id/comments', async (req): Promise<{ items: Comment[] }> => {
    const { id } = parse(idParams, req.params);
    const db = getPool();
    await requireDocument(db, actorOf(req), id);
    return { items: await loadComments(db, 'document', id) };
  });

  app.post('/documents/:id/comments', async (req, reply): Promise<Comment> => {
    const { id } = parse(idParams, req.params);
    const body: AddCommentRequest = parse(commentSchema, req.body);
    reply.code(201);
    return addDocumentComment(actorOf(req), id, body.body);
  });
}
