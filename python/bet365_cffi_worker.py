#!/usr/bin/env python3
"""
Worker HTTP persistente para a bet365 via curl_cffi (impersonate="chrome" = chrome146, BoringSSL).

POR QUÊ: o login da bet365 SÓ passa quando a coleta (GETs) e o POST usam a MESMA Session curl_cffi,
com o cookie jar NATIVO gerindo os cookies nos GETs e um header Cookie EXPLÍCITO (device-trust merge)
no POST. Provado exaustivamente: binário curl-impersonate, cookies explícitos nos GETs, ou coleta/POST
em Sessions separadas → resultCode=fail. Só o padrão "uma Session persistente + jar nativo" funciona.

O Node (CurlCffiSession) dirige este worker request-a-request via JSON line-delimited em stdin/stdout,
mintando o nst entre a coleta e o POST. Uma Session por worker (reuso de conexão = rápido no placeBet).

Protocolo (uma linha JSON por comando → uma linha JSON de resposta):
  {"id":N,"op":"set_cookie","name":..,"value":..,"domain":".bet365.bet.br"}     -> {"id":N,"ok":true}
  {"id":N,"op":"request","method":..,"url":..,"headers":{..},"body":str|null,
        "cookie_override":str|null,"timeout":30,"proxy":str|null}
        -> {"id":N,"status":int,"body":str,"headers":[[k,v]..],"set_cookie":[..],"jar":[[name,value]..]}
  {"id":N,"op":"reset"}                                                          -> {"id":N,"ok":true}
  {"id":N,"op":"close"}                                                          -> (encerra)
"""
import os
import sys
import json
import base64
from curl_cffi import requests as R
try:
    from curl_cffi.requests import CurlWsFlag, WebSocketTimeout
except Exception:  # versões antigas
    CurlWsFlag = None
    WebSocketTimeout = Exception

# Alvo de impersonation TLS/JA3/HTTP2. Default "chrome" (=chrome146). Sobrescreve via env p/ varrer
# fingerprints (BET365_IMPERSONATE=chrome145|safari180|firefox144|…) — buscar o que o edge da bet365
# aceita p/ a AÇÃO autenticada (addbet), sem browser. Ver [[bet365-nodelay-betting]].
IMPERSONATE = os.environ.get("BET365_IMPERSONATE", "chrome")


def new_session():
    return R.Session(impersonate=IMPERSONATE, timeout=30)


def jar_pairs(sess):
    """Cookies do jar como [[name, value]..] (mantém duplicatas de domínio; o Node deduplica)."""
    out = []
    try:
        for c in sess.cookies.jar:
            out.append([c.name, c.value])
    except Exception:
        pass
    return out


def multi_set_cookie(resp):
    out = []
    try:
        items = resp.headers.multi_items() if hasattr(resp.headers, "multi_items") else resp.headers.items()
        for k, v in items:
            if k.lower() == "set-cookie":
                out.append(v)
    except Exception:
        pass
    return out


def resp_headers(resp):
    out = []
    try:
        items = resp.headers.multi_items() if hasattr(resp.headers, "multi_items") else resp.headers.items()
        for k, v in items:
            out.append([k, v])
    except Exception:
        pass
    return out


def main():
    sess = new_session()
    ws = {"sock": None, "sess": None}  # WebSocket zap (browser-TLS via impersonate) — separado do HTTP
    out = sys.stdout
    # readline() explícito (NÃO `for line in sys.stdin`, que tem readahead-buffering e pode travar).
    while True:
        raw = sys.stdin.readline()
        if raw == "":  # EOF → stdin do Node fechou
            break
        line = raw.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except Exception as e:
            out.write(json.dumps({"error": "bad json: " + str(e)}) + "\n"); out.flush(); continue

        cid = cmd.get("id")
        op = cmd.get("op")
        try:
            if op == "close":
                out.write(json.dumps({"id": cid, "ok": True}) + "\n"); out.flush(); break
            elif op == "reset":
                try: sess.close()
                except Exception: pass
                sess = new_session()
                out.write(json.dumps({"id": cid, "ok": True}) + "\n")
            elif op == "set_cookie":
                sess.cookies.set(cmd["name"], cmd["value"], domain=cmd.get("domain", ".bet365.bet.br"))
                out.write(json.dumps({"id": cid, "ok": True}) + "\n")
            elif op == "request":
                headers = dict(cmd.get("headers") or {})
                ov = cmd.get("cookie_override")
                if ov is not None:
                    headers["cookie"] = ov  # POST: header explícito (merge device-trust)
                body = cmd.get("body")
                data = body.encode() if isinstance(body, str) else None
                kwargs = dict(headers=headers, data=data, timeout=cmd.get("timeout", 30), allow_redirects=False)
                proxy = cmd.get("proxy")
                if proxy:
                    kwargs["proxies"] = {"http": proxy, "https": proxy}
                r = sess.request(cmd.get("method", "GET").upper(), cmd["url"], **kwargs)
                try:
                    text = r.content.decode("utf-8", "replace")
                except Exception:
                    text = r.text
                out.write(json.dumps({
                    "id": cid, "status": r.status_code, "body": text,
                    "headers": resp_headers(r), "set_cookie": multi_set_cookie(r), "jar": jar_pairs(sess),
                }) + "\n")
            elif op == "ws_connect":
                # WS zap com a MESMA TLS impersonada (passa o Cloudflare que barra o `ws` do Node com 403).
                if ws["sess"] is None:
                    ws["sess"] = R.Session(impersonate=IMPERSONATE, timeout=cmd.get("timeout", 20))
                headers = dict(cmd.get("headers") or {})
                ws["sock"] = ws["sess"].ws_connect(cmd["url"], headers=headers)
                out.write(json.dumps({"id": cid, "ok": True}) + "\n")
            elif op == "ws_send":
                data = base64.b64decode(cmd["data_b64"])
                flag = (CurlWsFlag.TEXT if cmd.get("text", True) else CurlWsFlag.BINARY) if CurlWsFlag else 1
                n = ws["sock"].send(data, flag)
                out.write(json.dumps({"id": cid, "ok": True, "sent": n}) + "\n")
            elif op == "ws_recv":
                try:
                    data, flags = ws["sock"].recv()
                    out.write(json.dumps({"id": cid, "data_b64": base64.b64encode(bytes(data)).decode(), "flags": int(flags)}) + "\n")
                except WebSocketTimeout:
                    out.write(json.dumps({"id": cid, "timeout": True}) + "\n")
            elif op == "ws_close":
                try: ws["sock"].close()
                except Exception: pass
                ws["sock"] = None
                out.write(json.dumps({"id": cid, "ok": True}) + "\n")
            else:
                out.write(json.dumps({"id": cid, "error": "unknown op: " + str(op)}) + "\n")
        except Exception as e:
            out.write(json.dumps({"id": cid, "error": str(e)}) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
