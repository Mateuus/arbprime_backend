/**
 * Chave de dedupe ("não apostar 2x na mesma seleção/evento") por escopo. Função
 * PURA; o estado (SET no Redis + lock in-flight + backstop no índice único do banco)
 * fica no bus/runner. `vb.id` já embute (evento+mercado+seleção+casa) e é UNIQUE.
 */
import { DedupeScope } from '../enums/bet-instance.enum';
import { FlatValuebet } from './valuebet-source';

export function dedupeKey(scope: DedupeScope, vb: FlatValuebet): string {
  switch (scope) {
    case DedupeScope.PER_EVENT:
      return `ev:${vb.eventId}`;
    case DedupeScope.PER_EVENT_SELECTION:
      return `es:${vb.eventId}:${vb.market}:${vb.selKey ?? vb.selection}`;
    case DedupeScope.PER_EMISSION:
    default:
      return `em:${vb.id}`;
  }
}
