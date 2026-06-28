import { FastifyInstance } from 'fastify';
import {
  listBankrolls, createBankroll, updateBankroll, deleteBankroll, ensureValuebetBankrollHandler,
  listAccounts, createAccount, updateAccount, deleteAccount,
  listBets, getBet, createBet, updateBet, settleBet, deleteBet, deleteLeg,
  listAnalytixTransactions, createAnalytixTransaction, deleteAnalytixTransaction,
  listPartners, createPartner, updatePartner, deletePartner,
  getSummary, getTimeseries, getBreakdown,
} from '@Controllers';
import { checkAuth } from '../middlewares/auth.middleware';

/**
 * ArbPrime Analytix — rastreador de apostas + banca + analytics.
 * Tudo é user-scoped: exige autenticação (cookie MToken). Grátis para qualquer
 * usuário logado; múltiplas bancas são gated por assinatura no controller.
 */
export default async function analytixRoutes(app: FastifyInstance) {
  const auth = { preHandler: [checkAuth] };

  // Bancas
  app.get('/bankrolls', auth, listBankrolls);
  app.post('/bankrolls', auth, createBankroll);
  app.post('/bankrolls/ensure-valuebet', auth, ensureValuebetBankrollHandler);
  app.put('/bankrolls/:id', auth, updateBankroll);
  app.delete('/bankrolls/:id', auth, deleteBankroll);

  // Casas do usuário
  app.get('/accounts', auth, listAccounts);
  app.post('/accounts', auth, createAccount);
  app.put('/accounts/:id', auth, updateAccount);
  app.delete('/accounts/:id', auth, deleteAccount);

  // Apostas
  app.get('/bets', auth, listBets);
  app.get('/bets/:id', auth, getBet);
  app.post('/bets', auth, createBet);
  app.put('/bets/:id', auth, updateBet);
  app.post('/bets/:id/settle', auth, settleBet);
  app.delete('/bets/:id/legs/:legId', auth, deleteLeg);
  app.delete('/bets/:id', auth, deleteBet);

  // Transações
  app.get('/transactions', auth, listAnalytixTransactions);
  app.post('/transactions', auth, createAnalytixTransaction);
  app.delete('/transactions/:id', auth, deleteAnalytixTransaction);

  // Parceiros (donos de conta)
  app.get('/partners', auth, listPartners);
  app.post('/partners', auth, createPartner);
  app.put('/partners/:id', auth, updatePartner);
  app.delete('/partners/:id', auth, deletePartner);

  // Analytics (agregados)
  app.get('/summary', auth, getSummary);
  app.get('/timeseries', auth, getTimeseries);
  app.get('/breakdown', auth, getBreakdown);
}
