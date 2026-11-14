import fs from 'node:fs';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance, LogController } from 'fastify';
import { adminRoutes } from './admin/routes';
import type { ApiErrorBody } from './api-types';
import { approvalRoutes } from './approvals/routes';
import { authRoutes } from './auth/routes';
import { readSessionToken, resolveSession } from './auth/service';
import { bitrixRoutes } from './bitrix/routes';
import { config } from './config';
import { getPool } from './db';
import { documentRoutes } from './documents/routes';
import { AppError } from './errors';
import { fileRoutes } from './files/routes';
import { ensureFilesDir } from './files/storage';
import { notificationRoutes } from './notifications/routes';
import { orderRoutes } from './orders/routes';
import { reportRoutes } from './reports/routes';
import { taskRoutes } from './tasks/routes';
import { directoryRoutes } from './users/routes';

const errorBody = (code: ApiErrorBody['error']['code'], message: string, details?: ApiErrorBody['error']['details']): ApiErrorBody => ({
  error: { code, message, ...(details?.length ? { details } : {}) },
});

/** Маршруты, доступные без сессии. */
const PUBLIC = new Set(['POST /api/auth/login', 'GET /api/health']);
/** Маршруты, доступные до смены временного пароля. */
const BEFORE_PASSWORD_CHANGE = /^\/api\/(auth\/|meta$)/;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel, redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    logController: new LogController({ disableRequestLogging: config.logLevel !== 'debug' }),
  });
  ensureFilesDir();

  await app.register(multipart, {
    limits: { fileSize: config.maxFileMb * 1024 * 1024, files: 1, fields: 10, fieldSize: 10_000, parts: 12 },
  });

  // Заголовки безопасности для всех ответов.
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
    if (config.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (req.url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // Сессия и защита от межсайтовых запросов — для всех маршрутов API.
  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    if (MUTATING.has(req.method) && req.headers['x-requested-with'] !== 'docflow') {
      throw new AppError(403, 'csrf', 'Запрос отклонён: отсутствует заголовок X-Requested-With: docflow');
    }
    if (PUBLIC.has(`${req.method} ${path}`)) return;
    const token = readSessionToken(req.headers.cookie);
    const session = token ? await resolveSession(token) : null;
    if (!session) throw new AppError(401, 'unauthorized', 'Требуется вход в систему');
    req.session = session;
    if (session.mustChangePassword && !BEFORE_PASSWORD_CHANGE.test(path)) {
      throw new AppError(403, 'password_change_required', 'Необходимо сменить временный пароль');
    }
  });

  app.setErrorHandler((err: FastifyError | AppError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send(errorBody(err.code, err.message, err.details));
    }
    const fe = err as FastifyError;
    const code = fe.code ?? '';
    if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_ERR_CTP_BODY_TOO_LARGE' || fe.statusCode === 413) {
      return reply.code(413).send(errorBody('payload_too_large', `Размер файла или запроса превышает допустимый (файл — до ${config.maxFileMb} МБ)`));
    }
    if (code.startsWith('FST_') && fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      const message =
        code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT'
          ? 'За один запрос можно загрузить только один файл'
          : code === 'FST_INVALID_MULTIPART_CONTENT_TYPE'
            ? 'Ожидается загрузка файла в формате multipart/form-data'
            : 'Некорректный запрос';
      return reply.code(400).send(errorBody('validation', message));
    }
    req.log.error({ err }, 'Необработанная ошибка');
    return reply.code(500).send(errorBody('internal', 'Внутренняя ошибка сервера. Повторите попытку позже'));
  });

  app.get('/api/health', async () => {
    await getPool().query('SELECT 1');
    return { ok: true };
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(directoryRoutes);
      await api.register(documentRoutes);
      await api.register(approvalRoutes);
      await api.register(orderRoutes);
      await api.register(fileRoutes);
      await api.register(taskRoutes);
      await api.register(notificationRoutes);
      await api.register(reportRoutes);
      await api.register(bitrixRoutes);
      await api.register(adminRoutes);
    },
    { prefix: '/api' },
  );

  // Собранный интерфейс: статика и возврат index.html для неизвестных не-API путей.
  const hasWeb = fs.existsSync(config.webDist) && fs.existsSync(`${config.webDist}/index.html`);
  if (hasWeb) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false, index: ['index.html'] });
  }
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0];
    if (path === '/api' || path.startsWith('/api/')) {
      // Неизвестный маршрут API: без сессии — 401 (onRequest), с сессией — 404.
      return reply.code(404).send(errorBody('not_found', 'Маршрут не найден'));
    }
    if (hasWeb && (req.method === 'GET' || req.method === 'HEAD')) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send(errorBody('not_found', 'Страница не найдена'));
  });

  return app;
}
