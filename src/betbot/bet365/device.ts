/**
 * Provedor do device bet365 (perfil capturado 1× por MÁQUINA — device-estável).
 * O device é pesado (fingerprint + canvas + syscolors + device-trust + cf3/cf4) e NÃO é por-conta:
 * é da máquina/worker que roda o backend. Capture 1× (scripts em arbbetting_master/Test/bet365nd/mint/)
 * e aponte BET365_DEVICE_PATH pro JSON: { fingerprint, canvasDumps, syscolors, deviceTrust:{aaat,usdi}, cf3, cf4 }.
 */
import * as fs from 'fs';
import type { Bet365Device } from './account';

let cached: Bet365Device | null = null;

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
