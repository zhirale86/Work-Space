import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ChangePasswordRequest, LoginRequest, LoginResponse, MeResponse, OkResponse } from '../api-types';
import { parse } from '../common';
import { getPool } from '../db';
import { actorOf } from '../http';
import { changePassword, currentUser, login, logout, sessionCookie } from './service';

const loginSchema = z.object({ login: z.string().min(1).max(100), password: z.string().min(1).max(200) });
const changeSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) });

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (req, reply): Promise<LoginResponse> => {
    const body: LoginRequest = parse(loginSchema, req.body);
    const { token, user } = await login(body.login, body.password);
    reply.header('Set-Cookie', sessionCookie(token));
    return { user };
  });

  app.post('/auth/logout', async (req, reply): Promise<OkResponse> => {
    const actor = actorOf(req);
    await logout(req.session!.sessionId, actor.id);
    reply.header('Set-Cookie', sessionCookie(null));
    return { ok: true };
  });

  app.get('/auth/me', async (req): Promise<MeResponse> => {
    const actor = actorOf(req);
    return { user: await currentUser(getPool(), actor, req.session!.mustChangePassword) };
  });

  app.post('/auth/change-password', async (req): Promise<OkResponse> => {
    const actor = actorOf(req);
    const body: ChangePasswordRequest = parse(changeSchema, req.body);
    await changePassword(actor, req.session!.sessionId, body.currentPassword, body.newPassword);
    return { ok: true };
  });
}
