#!/usr/bin/env python3
"""Safely paste into a herdr-core terminal without submitting.

Protocol and paste-mode detection adapted from herdr-gitview's src/hcpaste.rs
(Copyright 2026 Adam Chmara, MIT; see LICENSE-GITVIEW-MIT).
"""
import json
import os
import select
import struct
import subprocess
import sys
import time
import unicodedata

DATA, CREDIT, CLOSE = 0, 1, 2
PASTE_ON, PASTE_OFF = b"\x1b[?2004h", b"\x1b[?2004l"


def paste_mode(replay):
    if replay is None:
        return None
    on, off = replay.rfind(PASTE_ON), replay.rfind(PASTE_OFF)
    return on >= 0 and on > off


def paste_bytes(text, mode):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(c for c in text if c in "\n\t" or unicodedata.category(c) != "Cc").rstrip("\n")
    if mode:
        return b"\x1b[200~" + text.encode("utf-8") + b"\x1b[201~"
    if "\n" in text:
        raise ValueError("No se puede confirmar un pegado multilínea seguro; no se ha insertado nada.")
    return text.encode("utf-8")


def frame(channel, kind, payload=b""):
    return struct.pack("<IBI", channel, kind, len(payload)) + payload


def write_all(stream, data):
    remaining = memoryview(data)
    while remaining:
        count = stream.write(remaining)
        if not count:
            raise BrokenPipeError("herdr-core cerró la conexión")
        remaining = remaining[count:]


class Reader:
    def __init__(self, stream):
        self.fd = stream.fileno()
        self.buffer = bytearray()

    def read(self, count, deadline):
        while len(self.buffer) < count:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.fd], [], [], remaining)[0]:
                raise TimeoutError("Tiempo agotado esperando a herdr-core")
            data = os.read(self.fd, 65536)
            if not data:
                raise EOFError("herdr-core cerró la conexión")
            self.buffer.extend(data)
        data = bytes(self.buffer[:count])
        del self.buffer[:count]
        return data

    def line(self, deadline):
        result = bytearray()
        while len(result) < 65536:
            c = self.read(1, deadline)
            if c == b"\n":
                return bytes(result)
            result.extend(c)
        raise ValueError("Respuesta hello demasiado larga")

    def frame(self, deadline):
        header = self.read(9, deadline)
        channel, kind, length = struct.unpack("<IBI", header)
        if length > 8 * 1024 * 1024:
            raise ValueError("Respuesta de herdr-core demasiado grande")
        try:
            return channel, kind, self.read(length, deadline)
        except TimeoutError as error:
            raise ValueError("Respuesta incompleta; no se ha insertado nada") from error


def terminal_info(address):
    result = subprocess.run(["hc", "get", address, "--json"], capture_output=True, text=True, timeout=8, check=True)
    info = json.loads(result.stdout)
    if info.get("state") != "live" or (info.get("status") or {}).get("state") not in ("idle", "working"):
        raise ValueError("El agente ya no está disponible para recibir texto")
    return info


def paste(address, text):
    info = terminal_info(address)
    process = subprocess.Popen(["hc", "connect"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
    try:
        reader = Reader(process.stdout)
        write_all(process.stdin, b'{"jsonrpc":"2.0","id":0,"method":"hello","params":{"framed":true}}\n')
        hello = json.loads(reader.line(time.monotonic() + 5))
        if "error" in hello:
            raise ValueError("herdr-core rechazó la conexión")
        request = {"jsonrpc": "2.0", "id": 1, "method": "terminal.attach", "params": {
            "terminal": address, "cols": info.get("cols") or 80, "rows": info.get("rows") or 24, "history": 0}}
        write_all(process.stdin, frame(0, DATA, json.dumps(request).encode()))
        deadline = time.monotonic() + 5
        while True:
            channel, kind, payload = reader.frame(deadline)
            if channel == 0 and kind == DATA:
                response = json.loads(payload)
                if response.get("id") == 1:
                    if "error" in response:
                        raise ValueError("herdr-core no pudo adjuntar la terminal")
                    channel = response["result"]["channel"]
                    break
        write_all(process.stdin, frame(channel, CREDIT, struct.pack("<I", 1 << 20)))
        replay = None
        deadline = time.monotonic() + 0.8
        while True:
            try:
                ch, kind, payload = reader.frame(min(deadline, time.monotonic() + 0.15) if replay is not None else deadline)
            except TimeoutError:
                # A partial frame must never be treated as a complete replay.
                if reader.buffer:
                    raise ValueError("Respuesta incompleta; no se ha insertado nada")
                break
            if ch == channel and kind == DATA:
                replay = (replay or b"") + payload
        data = paste_bytes(text, paste_mode(replay))
        # Recheck immediately before writing; never force a blocked agent.
        terminal_info(address)
        write_all(process.stdin, frame(channel, DATA, data))
        write_all(process.stdin, frame(channel, CLOSE))
        time.sleep(0.2)  # allow the core to process the queued input before disconnecting
    finally:
        process.kill()
        process.wait()


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("Uso: paste_to_agent.py TERMINAL TEXTO")
        paste(sys.argv[1], sys.argv[2])
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
