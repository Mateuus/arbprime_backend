/**
 * Provedor do device bet365 (perfil capturado 1× por MÁQUINA — device-estável).
 * O device é pesado (fingerprint + canvas + syscolors + device-trust + cf3/cf4) e NÃO é por-conta:
 * é da máquina/worker que roda o backend. Capture 1× (scripts em arbbetting_master/Test/bet365nd/mint/)
 * e aponte BET365_DEVICE_PATH pro JSON: { fingerprint, canvasDumps, syscolors, deviceTrust:{aaat,usdi}, cf3, cf4 }.
 */
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import type { Bet365Device } from './account';

let cached: Bet365Device | null = null;

/**
 * Gera um device NOVO por conta (≠ device compartilhado da máquina). Cada conta precisa do SEU device
 * porque o device-trust `aaat` é amarrado à conta (ue=email) — contas com o mesmo device se invalidam.
 * O que varia por conta: `usdi` (uqid GUID novo, client-side). O que compartilha (perfil da máquina, alimenta
 * o bot-score do nst, não a identidade): fingerprint/canvasDumps/syscolors/cf3/cf4 — copiados do device base.
 * O `aaat` NÃO vem aqui: é emitido pelo bet365 no 1º login (enroll) e gravado na entidade do device.
 * Espelha o newSuperbetDevice(). Retorna null se não há device base na máquina.
 */
export function newBet365Device(): Bet365Device | null {
  const base = loadBet365Device();
  if (!base) return null;
  const uqid = randomUUID().toUpperCase(); // formato do bet365: GUID maiúsculo
  return {
    fingerprint: base.fingerprint,
    canvasDumps: base.canvasDumps,
    syscolors: base.syscolors,
    cf3: base.cf3,
    cf4: base.cf4,
    // device NOVO: só usdi (uqid próprio). SEM aaat → o login não injeta trust de outra conta; o bet365
    // emite o aaat da conta no 1º login e a entidade é atualizada. Ver [[bet365-multiaccount-device]].
    deviceTrust: { usdi: `uqid=${uqid}` },
  } as Bet365Device;
}

export function loadBet365Device(): Bet365Device | null {
  if (cached) return cached;
  const p = process.env.BET365_DEVICE_PATH;
  if (!p) return null;
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (d && d.fingerprint && Array.isArray(d.canvasDumps) && d.syscolors && d.deviceTrust && d.cf3 != null && d.cf4 != null) {
      d.cf3 = String(d.cf3); d.cf4 = String(d.cf4);
      cached = d as Bet365Device;
      return cached;
    }
  } catch { /* arquivo ausente/ilegível */ }
  return null;
}

/** O device bet365 está provisionado nesta máquina? (gate do `ready` no NoDelay) */
export function bet365DeviceReady(): boolean {
  return loadBet365Device() != null;
}
