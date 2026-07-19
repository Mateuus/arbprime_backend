#!/usr/bin/env python3
"""
PrimeTV — UPSTREAM do SFU via aiortc (cliente WebRTC REAL, igual browser).

Consome UMA vez o stream mediasoup do fornecedor (o werift era rejeitado: o server
mandava só áudio+probe) e despeja o RTP DECRIPTADO em UDP localhost pro Node
(werift) re-transmitir aos N viewers. Sem decode/re-encode: o decoder do aiortc é
substituído por um dummy e o RTP é tapado cru em RTCRtpReceiver._handle_rtp_packet.

Uso:
  primetv_upstream.py --server wss://ms1.x.com --token MSTOKEN --udp-port 45001

Protocolo com o Node:
  stdout (JSON por linha): {"evt":"log"|"subscribed"|"resumed"|"reopen"|"fatal", ...}
  UDP 127.0.0.1:{udp-port}: datagrama = 1 byte kind (0=video, 1=audio) + RTP cru.
Reabertura (produtorPlay mudou / closeSubscribed / WS caiu) é responsabilidade do
Node: este processo emite {"evt":"reopen"} e sai; o Node respawna.
"""

import argparse
import asyncio
import json
import os
import socket
import struct
import sys

import websockets
from websockets.exceptions import ConnectionClosed

# ---- decoder dummy: sem decode = sem CPU e sem fila infinita de frames ----
import aiortc.rtcrtpreceiver as _rr


class _DummyDecoder:
    def decode(self, encoded_frame):  # noqa: ANN001
        return []

    def stop(self):
        pass


_rr.get_decoder = lambda codec: _DummyDecoder()  # type: ignore[assignment]

from aiortc.rtcrtpreceiver import RTCRtpReceiver  # noqa: E402
from pymediasoup import Device  # noqa: E402
from pymediasoup.handlers.aiortc_handler import AiortcHandler  # noqa: E402
from pymediasoup.models.transport import (  # noqa: E402
    DtlsParameters,
    IceCandidate,
    IceParameters,
)
from pymediasoup.rtp_parameters import RtpCapabilities, RtpParameters  # noqa: E402

KEEPALIVE_S = 5.0
HANDSHAKE_TIMEOUT_S = 30.0


def out(evt: str, **kw) -> None:
    print(json.dumps({"evt": evt, **kw}), flush=True)


class Upstream:
    def __init__(self, server: str, token: str, udp_port: int, origin: str):
        self.server = server if server.rstrip("/").endswith("/ws") else server.rstrip("/") + "/ws"
        self.token = token
        self.origin = origin
        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp_addr = ("127.0.0.1", udp_port)
        self.ws = None
        self.device = None
        self.transport = None
        self.produtor_play = ""
        self.resumed = asyncio.Event()
        self.reopen_reason = None
        # ssrc → kind byte; rtx ssrc → (main ssrc, main pt) p/ unwrap RFC4588
        self.ssrc_kind: dict[int, int] = {}
        self.rtx_map: dict[int, tuple[int, int]] = {}
        self.waiters: dict[str, asyncio.Future] = {}
        self.rtp_count = {0: 0, 1: 0}

    # ---------- tap de RTP (pré-decoder, pós-SRTP) ----------
    def install_tap(self) -> None:
        orig = RTCRtpReceiver._handle_rtp_packet
        me = self

        async def patched(self_recv, packet, arrival_time_ms):  # noqa: ANN001
            me.tap(packet)
            return await orig(self_recv, packet, arrival_time_ms)

        RTCRtpReceiver._handle_rtp_packet = patched  # type: ignore[method-assign]

    def tap(self, packet) -> None:  # noqa: ANN001
        try:
            ssrc = packet.ssrc
            kind = self.ssrc_kind.get(ssrc)
            if kind is not None:
                data = packet.serialize()
                self.udp.sendto(bytes([kind]) + data, self.udp_addr)
            elif ssrc in self.rtx_map and len(packet.payload) >= 2:
                # rtx (RFC 4588): 2 primeiros bytes do payload = seq original
                main_ssrc, main_pt = self.rtx_map[ssrc]
                kind = self.ssrc_kind.get(main_ssrc)
                if kind is None:
                    return
                orig_seq = struct.unpack("!H", packet.payload[:2])[0]
                packet.ssrc = main_ssrc
                packet.payload_type = main_pt
                packet.sequence_number = orig_seq
                packet.payload = packet.payload[2:]
                self.udp.sendto(bytes([kind]) + packet.serialize(), self.udp_addr)
            else:
                return
            self.rtp_count[kind] += 1
            n = self.rtp_count[kind]
            if n == 1 or n % 1000 == 0:
                out("log", msg=f"rtp {'video' if kind == 0 else 'audio'} #{n}")
        except Exception as e:  # noqa: BLE001
            out("log", msg=f"tap erro: {e}")

    # ---------- signaling ----------
    async def send(self, obj: dict) -> None:
        obj["token"] = self.token
        await self.ws.send(json.dumps(obj))

    def wait_for(self, mtype: str) -> asyncio.Future:
        fut = asyncio.get_event_loop().create_future()
        self.waiters[mtype] = fut
        return fut

    async def run(self) -> None:
        self.install_tap()
        out("log", msg=f"conectando {self.server}")
        headers = {
            "Origin": self.origin,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        }
        async with websockets.connect(self.server, additional_headers=headers, max_size=8 * 1024 * 1024) as ws:
            self.ws = ws
            reader = asyncio.create_task(self.read_loop())
            try:
                await asyncio.wait_for(self.handshake(), HANDSHAKE_TIMEOUT_S)
                out("resumed")
                await self.keepalive_loop()
            except ConnectionClosed:
                # Fechamento NORMAL do fornecedor (closeSubscribed / ciclo do ms) —
                # não é erro: o Node respawna e o vídeo volta.
                self.reopen_reason = self.reopen_reason or "ws-closed"
            finally:
                reader.cancel()
        if self.reopen_reason:
            out("reopen", reason=self.reopen_reason)
        else:
            out("reopen", reason="ws-close")

    async def read_loop(self) -> None:
        try:
            async for raw in self.ws:
                try:
                    msg = json.loads(raw)
                except Exception:  # noqa: BLE001
                    continue
                mtype = msg.get("type")
                data = msg.get("data")
                if mtype == "keepAlive":
                    self.on_keepalive(data or {})
                elif mtype == "closeSubscribed":
                    out("log", msg="ms → closeSubscribed")
                    self.reopen_reason = "closeSubscribed"
                    await self.ws.close()
                elif mtype in self.waiters:
                    self.waiters.pop(mtype).set_result(data)
                else:
                    out("log", msg=f"ms → {mtype}")
        except asyncio.CancelledError:
            pass
        except Exception as e:  # noqa: BLE001
            out("log", msg=f"read_loop: {e}")

    def on_keepalive(self, d: dict) -> None:
        pp = d.get("produtorPlay") or ""
        if d.get("status") and pp:
            if not self.produtor_play:
                self.produtor_play = pp
            elif pp != self.produtor_play:
                out("log", msg="produtorPlay mudou")
                self.reopen_reason = "produtorPlay"
                asyncio.ensure_future(self.ws.close())

    async def handshake(self) -> None:
        fut = self.wait_for("routerCap")
        await self.send({"type": "getRouterRtpCapabilities"})
        router_cap = await fut

        self.device = Device(handlerFactory=AiortcHandler.createFactory(tracks=[]))
        await self.device.load(RtpCapabilities.model_validate(router_cap))

        fut = self.wait_for("subTransportCreated")
        await self.send({"type": "createConsumerTransport", "forceTcp": False})
        t = await fut

        self.transport = self.device.createRecvTransport(
            id=t["id"],
            iceParameters=IceParameters.model_validate(t["iceParameters"]),
            iceCandidates=[IceCandidate.model_validate(c) for c in t["iceCandidates"]],
            dtlsParameters=DtlsParameters.model_validate(t["dtlsParameters"]),
        )

        @self.transport.on("connect")
        async def on_connect(dtls: DtlsParameters) -> None:
            await self.send(
                {
                    "type": "connectConsumerTransport",
                    "transportId": self.transport.id,
                    "dtlsParameters": dtls.model_dump(exclude_none=True),
                }
            )

        @self.transport.on("connectionstatechange")
        async def on_state(state: str) -> None:
            out("log", msg=f"transport {state}")
            if state == "connected":
                await self.send({"type": "resume"})
            elif state in ("failed", "closed"):
                self.reopen_reason = self.reopen_reason or f"transport-{state}"
                if self.ws:
                    await self.ws.close()

        fut = self.wait_for("subscribed")
        caps = self.device.rtpCapabilities.model_dump(exclude_none=True)
        await self.send({"type": "consume", "rtpCapabilities": caps})
        sub = await fut
        if not sub or (not sub.get("video") and not sub.get("audio")):
            self.reopen_reason = "sem-produtor"
            raise RuntimeError("subscribed sem video/audio")

        info = {}
        for kind_byte, key in ((0, "video"), (1, "audio")):
            item = sub.get(key)
            if not item:
                continue
            enc = (item["rtpParameters"].get("encodings") or [{}])[0]
            ssrc = enc.get("ssrc")
            main_pt = item["rtpParameters"]["codecs"][0]["payloadType"]
            if ssrc:
                self.ssrc_kind[ssrc] = kind_byte
                if enc.get("rtx", {}).get("ssrc"):
                    self.rtx_map[enc["rtx"]["ssrc"]] = (ssrc, main_pt)
            await self.transport.consume(
                id=item["id"],
                producerId=item["producerId"],
                kind=key,
                rtpParameters=RtpParameters.model_validate(item["rtpParameters"]),
            )
            info[key] = {"ssrc": ssrc, "pt": main_pt}
            out("log", msg=f"consumindo {key} ssrc={ssrc}")
        out("subscribed", **info)
        # `resumed` chega via read_loop; aguarda pra confirmar (com tolerância)
        try:
            await asyncio.wait_for(self.wait_for("resumed"), 15)
        except asyncio.TimeoutError:
            out("log", msg="resumed não veio (seguindo mesmo assim)")

    async def keepalive_loop(self) -> None:
        while True:
            await asyncio.sleep(KEEPALIVE_S)
            await self.send({"type": "keepAlive"})


async def watch_parent() -> None:
    """Se o Node (pai) morrer, o processo é re-parentado (ppid muda) → sai NA HORA.
    Impede órfão segurando a view do fornecedor (o limite é 1 view/conta; órfão =
    tempestade de reconexão)."""
    orig = os.getppid()
    while True:
        await asyncio.sleep(2)
        if os.getppid() != orig:
            os._exit(0)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--udp-port", type=int, required=True)
    ap.add_argument("--origin", default="https://bllsport.com")
    args = ap.parse_args()
    up = Upstream(args.server, args.token, args.udp_port, args.origin)
    asyncio.create_task(watch_parent())
    try:
        await up.run()
    except Exception as e:  # noqa: BLE001
        out("fatal", msg=str(e))
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
