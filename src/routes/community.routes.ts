import { FastifyInstance } from 'fastify';
import {
  listPublicProfiles, getPublicProfile, getPublicTrackRecord, getPublicCurve,
  getMyCommunityProfile, saveCommunityProfile, recordConsent,
  setBankrollVisibility, setBetVisibility,
  followUser, unfollowUser, getFeed, getNotifications, markNotificationsRead,
  getLeaderboard, getCommunityAnalytics,
} from '@Controllers';
import { checkAuth, optionalAuth } from '../middlewares/auth.middleware';

/**
 * Comunidade. Leitura é PÚBLICA (perfis, track record, curva) — sem auth, igual
 * às estatísticas da landing. optionalAuth personaliza (isFollowing) se logado.
 * Publicar/seguir/editar exige login.
 */
export default async function communityRoutes(app: FastifyInstance) {
  const auth = { preHandler: [checkAuth] };
  const opt = { preHandler: [optionalAuth] };

  // Público (sem auth; optionalAuth p/ personalizar isFollowing)
  app.get('/profiles', opt, listPublicProfiles);
  app.get('/leaderboard', opt, getLeaderboard);
  app.get('/analytics', getCommunityAnalytics);
  app.get('/u/:handle', opt, getPublicProfile);
  app.get('/u/:handle/track-record', getPublicTrackRecord);
  app.get('/u/:handle/curve', getPublicCurve);

  // Autenticado
  app.get('/profile/me', auth, getMyCommunityProfile);
  app.post('/profile', auth, saveCommunityProfile);
  app.post('/profile/consent', auth, recordConsent);
  app.put('/bankrolls/:id/visibility', auth, setBankrollVisibility);
  app.put('/bets/:id/visibility', auth, setBetVisibility);

  // Social
  app.post('/follow/:handle', auth, followUser);
  app.delete('/follow/:handle', auth, unfollowUser);
  app.get('/feed', auth, getFeed);
  app.get('/notifications', auth, getNotifications);
  app.put('/notifications/read', auth, markNotificationsRead);
}
