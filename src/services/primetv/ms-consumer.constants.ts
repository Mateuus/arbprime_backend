/**
 * Payloads FIXOS do handshake mediasoup do lado consumer (backend).
 *
 * No player de referência (browser) esses valores vêm do mediasoup-client Device
 * (device.rtpCapabilities e o dtlsParameters do recvTransport). O backend NÃO roda
 * um stack WebRTC real — ele só faz a SINALIZAÇÃO pra manter a sessão viva e obter
 * o `produtorPlay` (via keepAlive), que é retransmitido pro nosso WSS. Por isso
 * enviamos os payloads capturados do fluxo de referência.
 *
 * ⚠️ dtlsParameters tem um fingerprint fixo (de uma sessão de referência). Como não
 * há mídia real no backend, serve só pra fechar a sinalização (subConnected). Se o
 * fornecedor passar a exigir fingerprint único por sessão, é aqui que muda.
 */

// Capacidades RTP do consumer (mensagem `consume`).
export const CONSUMER_RTP_CAPABILITIES = {
  codecs: [
    {
      mimeType: "audio/opus",
      kind: "audio",
      preferredPayloadType: 100,
      clockRate: 48000,
      channels: 2,
      parameters: { minptime: 10, useinbandfec: 1 },
      rtcpFeedback: [{ type: "transport-cc", parameter: "" }],
    },
    {
      mimeType: "video/VP8",
      kind: "video",
      preferredPayloadType: 101,
      clockRate: 90000,
      parameters: {},
      rtcpFeedback: [
        { type: "goog-remb", parameter: "" },
        { type: "transport-cc", parameter: "" },
        { type: "ccm", parameter: "fir" },
        { type: "nack", parameter: "" },
        { type: "nack", parameter: "pli" },
      ],
    },
    {
      mimeType: "video/rtx",
      kind: "video",
      preferredPayloadType: 102,
      clockRate: 90000,
      parameters: { apt: 101 },
      rtcpFeedback: [],
    },
    {
      mimeType: "video/H264",
      kind: "video",
      preferredPayloadType: 103,
      clockRate: 90000,
      parameters: { "level-asymmetry-allowed": 1, "packetization-mode": 1, "profile-level-id": "4d001f" },
      rtcpFeedback: [
        { type: "goog-remb", parameter: "" },
        { type: "transport-cc", parameter: "" },
        { type: "ccm", parameter: "fir" },
        { type: "nack", parameter: "" },
        { type: "nack", parameter: "pli" },
      ],
    },
    {
      mimeType: "video/rtx",
      kind: "video",
      preferredPayloadType: 104,
      clockRate: 90000,
      parameters: { apt: 103 },
      rtcpFeedback: [],
    },
    {
      mimeType: "video/H264",
      kind: "video",
      preferredPayloadType: 105,
      clockRate: 90000,
      parameters: { "level-asymmetry-allowed": 1, "packetization-mode": 1, "profile-level-id": "42e01f" },
      rtcpFeedback: [
        { type: "goog-remb", parameter: "" },
        { type: "transport-cc", parameter: "" },
        { type: "ccm", parameter: "fir" },
        { type: "nack", parameter: "" },
        { type: "nack", parameter: "pli" },
      ],
    },
    {
      mimeType: "video/rtx",
      kind: "video",
      preferredPayloadType: 106,
      clockRate: 90000,
      parameters: { apt: 105 },
      rtcpFeedback: [],
    },
  ],
  headerExtensions: [
    { kind: "audio", uri: "urn:ietf:params:rtp-hdrext:sdes:mid", preferredId: 1, preferredEncrypt: false, direction: "sendrecv" },
    { kind: "video", uri: "urn:ietf:params:rtp-hdrext:sdes:mid", preferredId: 1, preferredEncrypt: false, direction: "sendrecv" },
    { kind: "audio", uri: "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time", preferredId: 4, preferredEncrypt: false, direction: "sendrecv" },
    { kind: "video", uri: "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time", preferredId: 4, preferredEncrypt: false, direction: "sendrecv" },
    { kind: "video", uri: "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01", preferredId: 5, preferredEncrypt: false, direction: "sendrecv" },
    { kind: "audio", uri: "urn:ietf:params:rtp-hdrext:ssrc-audio-level", preferredId: 10, preferredEncrypt: false, direction: "sendrecv" },
    { kind: "video", uri: "urn:3gpp:video-orientation", preferredId: 11, preferredEncrypt: false, direction: "sendrecv" },
    { kind: "video", uri: "urn:ietf:params:rtp-hdrext:toffset", preferredId: 12, preferredEncrypt: false, direction: "sendrecv" },
  ],
} as const;

// DTLS do consumer (mensagem `connectConsumerTransport`).
export const CONSUMER_DTLS_PARAMETERS = {
  role: "client",
  fingerprints: [
    { algorithm: "sha-256", value: "2C:16:27:41:B3:67:3A:89:BF:C5:A7:AB:4E:EF:59:EB:CA:E7:04:19:76:24:25:5D:F8:EB:77:C7:9E:83:27:12" },
  ],
} as const;
