import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AddCommentRequest, Comment, CreateTaskRequest, HistoryEntry, Page, TaskDetail, TaskListItem, UpdateTaskRequest } from '../api-types';
import { entityHistory } from '../audit/service';
import { idParams, paging, parse, zBoolQuery, zId, zIdList, zPage } from '../common';
import { getPool } from '../db';
import { loadComments } from '../documents/service';
import { actorOf } from '../http';
import { requireTask } from './access';
import { addTaskComment, createTask, getTaskDetail, queryTasks, transitionTask, updateTask } from './service';

const STATUSES = ['new', 'in_progress', 'review', 'done', 'cancelled'];
const listQuery = z.object({
  q: z.string().max(200).optional(),
  scope: z.enum(['all', 'assigned', 'authored']).optional(),
  status: z
    .string()
    .max(100)
    .refine((v) => v.split(',').every((s) => STATUSES.includes(s.trim())), 'Недопустимый статус')
    .optional(),
  overdue: zBoolQuery,
  documentId: zId.optional(),
  ...zPage,
});
const dueAt = z.string().max(40).nullable().optional();
const createSchema = z
  .object({
    title: z.string().max(300),
    body: z.string().max(10000).optional(),
    assigneeId: zId,
    dueAt,
    documentId: zId.nullable().optional(),
    observerIds: zIdList.optional(),
  })
  .strict();
const updateSchema = z
  .object({
    title: z.string().max(300).optional(),
    body: z.string().max(10000).optional(),
    assigneeId: zId.optional(),
    dueAt,
    observerIds: zIdList.optional(),
  })
  .strict();
const submitSchema = z.object({ resultText: z.string().max(10000).optional() });
const returnSchema = z.object({ comment: z.string().max(5000).optional() });
const cancelSchema = z.object({ reason: z.string().max(2000).optional() });
const commentSchema = z.object({ body: z.string().max(5000) });
const pageQuery = z.object(zPage);

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tasks', async (req): Promise<Page<TaskListItem>> => {
    const query = parse(listQuery, req.query);
    return queryTasks(
      getPool(),
      actorOf(req),
      {
        q: query.q,
        scope: query.scope,
        statuses: query.status?.split(',').map((s) => s.trim()),
        overdue: query.overdue,
        documentId: query.documentId,
      },
      paging(query),
    );
  });

  app.post('/tasks', async (req, reply): Promise<TaskDetail> => {
    const body: CreateTaskRequest = parse(createSchema, req.body);
    reply.code(201);
    return createTask(actorOf(req), body);
  });

  app.get('/tasks/:id', async (req): Promise<TaskDetail> => {
    const { id } = parse(idParams, req.params);
    return getTaskDetail(getPool(), actorOf(req), id);
  });

  app.patch('/tasks/:id', async (req): Promise<TaskDetail> => {
    const { id } = parse(idParams, req.params);
    const body: UpdateTaskRequest = parse(updateSchema, req.body);
    return updateTask(actorOf(req), id, body);
  });

  app.post('/tasks/:id/start', async (req): Promise<TaskDetail> => {
    const { id } = parse(idParams, req.params);
    return transitionTask(actorOf(req), id, 'start');
  });

  app.post('/tasks/:id/submit', async (req): Promise<TaskDetail> => {
    const { id } = parse(idParams, req.params);
    return transitionTask(actorOf(req), id, 'submit', parse(submitSchema, req.body).resultText);
  });

  app.post('/tasks/:id/accept', async (req): Promise<TaskDetail> => {
    const { id } = parse(idParams, req.params);
    return transitionTask(actorOf(req), id, 'accept');
  });

  app.post('/tasks/:id/return', async (req): Promise<TaskDetail> => {
    const { id } = parse(idParams, req.params);
    return transitionTask(actorOf(req), id, 'return', parse(returnSchema, req.body).comment);
  });

  app.post('/tasks/:id/cancel', async (req): Promise<TaskDetail> => {
    const { id } = parse(idParams, req.params);
    return transitionTask(actorOf(req), id, 'cancel', parse(cancelSchema, req.body).reason);
  });

  app.get('/tasks/:id/history', async (req): Promise<Page<HistoryEntry>> => {
    const { id } = parse(idParams, req.params);
    const db = getPool();
    await requireTask(db, actorOf(req), id);
    return entityHistory(db, 'task', id, paging({ pageSize: 50, ...parse(pageQuery, req.query) }));
  });

  app.get('/tasks/:id/comments', async (req): Promise<{ items: Comment[] }> => {
    const { id } = parse(idParams, req.params);
    const db = getPool();
    await requireTask(db, actorOf(req), id);
    return { items: await loadComments(db, 'task', id) };
  });

  app.post('/tasks/:id/comments', async (req, reply): Promise<Comment> => {
    const { id } = parse(idParams, req.params);
    const body: AddCommentRequest = parse(commentSchema, req.body);
    reply.code(201);
    return addTaskComment(actorOf(req), id, body.body);
  });
}
