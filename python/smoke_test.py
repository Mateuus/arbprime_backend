#!/usr/bin/env python3
"""Smoke test: login → acha evento ao vivo → view → roda o upstream e conta RTP."""
import asyncio
import json
import os
import socket
import subprocess
import sys
import urllib.request

URL = os.environ.get("PRIMETV_PROVIDER_URL", "https://bllsport.com")
EMAIL = os.environ["PRIMETV_PROVIDER_EMAIL"]
SENHA = os.environ["PRIMETV_PROVIDER_PASSWORD"]


UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
BROWSER = {"User-Agent": UA, "Origin": URL, "Referer": URL + "/"}


def post(path, body, headers=None):
    data = json.dumps(body).encode()
    req = urllib.request.Request(URL + path, data=data, method="POST",
                                 headers={"Content-Type": "application/json", **BROWSER, **(headers or {})})
    return json.loads(urllib.request.urlopen(req, timeout=20).read())


def get(path, headers=None):
    req = urllib.request.Request(URL + path, headers={**BROWSER, **(headers or {})})
    return json.loads(urllib.request.urlopen(req, timeout=20).read())


def main():
    print("login…")
    sess = post("/api/sessao", {"email": EMAIL, "senha": SENHA})["sessao"]
    key = sess["key"]
    print("  key ok, _id", sess["_id"])

    cache = get("/api/evento/cache?_limit=300")
    itens = cache.get("itens") or cache.get("data") or cache
    if isinstance(itens, dict):
        itens = itens.get("itens", [])
    live = [e for e in itens if e.get("situacao") == 3]
    print(f"  {len(live)} ao vivo")
    if not live:
        print("SEM eventos ao vivo agora — não dá pra testar vídeo")
        sys.exit(2)

    server = token = None
    for ev in live:
        sid = ev.get("_id")
        try:
            view = get(f"/api/evento/view/{sid}", {"authorization": key})
        except Exception as e:  # noqa: BLE001
            print("  view falhou", sid, e)
            continue
        vit = (view.get("itens") or [None])[0]
        if vit and vit.get("msToken") and vit.get("servidor"):
            server, token = vit["servidor"], vit["msToken"]
            print(f"  evento '{ev.get('nome','?')[:40]}' → server={server}")
            break
    if not server:
        print("nenhuma view com msToken+servidor")
        sys.exit(2)

    # UDP listener
    port = 45123
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", port))
    sock.settimeout(1.0)
    counts = {0: 0, 1: 0}

    here = os.path.dirname(os.path.abspath(__file__))
    proc = subprocess.Popen(
        [os.path.join(here, ".venv/bin/python"), os.path.join(here, "primetv_upstream.py"),
         "--server", server, "--token", token, "--udp-port", str(port)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )

    import threading
    def drain():
        for line in proc.stdout:
            print("  [py]", line.rstrip())
    threading.Thread(target=drain, daemon=True).start()

    import time
    t0 = time.time()
    while time.time() - t0 < 25:
        try:
            data, _ = sock.recvfrom(4096)
            counts[data[0]] = counts.get(data[0], 0) + 1
        except socket.timeout:
            pass
    proc.terminate()
    print(f"\n=== RESULTADO em 25s: VÍDEO={counts[0]} pacotes, ÁUDIO={counts[1]} pacotes ===")
    if counts[0] > 0:
        print(">>> VÍDEO FLUINDO via aiortc ✅")
    else:
        print(">>> vídeo NÃO fluiu (só áudio?) ❌")


if __name__ == "__main__":
    main()
