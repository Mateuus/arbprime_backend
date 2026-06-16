import 'fastify';

// Augmenta o FastifyRequest com os dados que os hooks/preHandlers anexam:
// - userData: preenchido pelo preHandler de autenticação (checkAuth)
// - translations/locale: preenchidos pelo hook de locale (localeHook)
declare module 'fastify' {
  interface FastifyRequest {
    userData?: { userId: string; email: string; role: string; token: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    translations: any;
    locale: string;
  }
}
