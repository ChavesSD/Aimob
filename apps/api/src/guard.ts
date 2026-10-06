import type { FastifyReply, FastifyRequest } from 'fastify';
import { can, type Action, type Module } from './permissions.js';

declare module 'fastify' {
  interface FastifyRequest { session?: import('./auth.js').Session }
}

/** preHandler que exige permissão `action` no módulo `mod` para o papel atual da sessão. */
export const guard = (mod: Module, action: Action) => async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.session || !can(req.session.role, mod, action)) {
    return reply.code(403).send({ error: 'Você não tem permissão para esta ação.' });
  }
};
