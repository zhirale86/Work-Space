import type { FastifyRequest } from 'fastify';
import type { SystemRole } from './api-types';
import type { SessionInfo } from './auth/service';
import type { Actor } from './common';
import { forbidden, unauthorized } from './errors';
import { ROLE_LABELS } from './labels';

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionInfo;
  }
}

export function actorOf(req: FastifyRequest): Actor {
  if (!req.session) throw unauthorized();
  return req.session.actor;
}

export function requireRole(req: FastifyRequest, role: SystemRole): Actor {
  const actor = actorOf(req);
  if (!actor.roles.includes(role)) throw forbidden(`Действие доступно только пользователям с ролью «${ROLE_LABELS[role]}»`);
  return actor;
}

/** Ответ управляющего действия: карточка либо `{ ok: true }`, если у администратора нет права просмотра содержимого. */
export const detailOrOk = <T>(detail: T | null): T | { ok: true } => detail ?? { ok: true };
