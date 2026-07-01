/**
 * betbot — camada de automação autenticada de casas de aposta (Bet Worker).
 * Núcleo portável (http/cycle-session/betano) + adaptador arbprime (proxy-list).
 */
export * from './http';
export * from './cycle-session';
export * from './betano/errors';
export * from './betano/betano-status';
export * from './betano/betano-client';
export * from './betano/proxy-check';
export * from './proxy-list';
