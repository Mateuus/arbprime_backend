// Tipos do Efí Bank (ex-Gerencianet). Doc: https://dev.efipay.com.br/docs

export interface EfiPixChargeResponse {
  txid: string;
  calendario: { criacao: string; expiracao: number };
  loc: { id: number; location: string; tipoCob: string };
  location: string;
  status: 'ATIVA' | 'CONCLUIDA' | 'REMOVIDA_PELO_USUARIO_RECEBEDOR' | 'REMOVIDA_PELO_PSP';
  valor: { original: string };
  chave: string;
  pixCopiaECola?: string;
}

export interface EfiQrCodeResponse {
  qrcode: string;       // copia-e-cola
  imagemQrcode: string; // data URI (base64)
  linkVisualizacao?: string;
}

export interface EfiPixChargeStatus {
  txid: string;
  status: 'ATIVA' | 'CONCLUIDA' | 'REMOVIDA_PELO_USUARIO_RECEBEDOR' | 'REMOVIDA_PELO_PSP';
  valor: { original: string };
  pix?: Array<{ endToEndId: string; txid: string; valor: string; horario: string }>;
}

export interface EfiWebhookPayload {
  evento?: string;
  pix?: Array<{
    endToEndId: string;
    txid?: string;
    valor: string;
    chave?: string;
    horario: string;
    infoPagador?: string;
  }>;
}

export const EFI_STATUS_MAP = {
  ATIVA: 'pending',
  CONCLUIDA: 'completed',
  REMOVIDA_PELO_USUARIO_RECEBEDOR: 'cancelled',
  REMOVIDA_PELO_PSP: 'cancelled',
} as const;
