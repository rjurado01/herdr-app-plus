import importlib.util
import json
import socket
import struct
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("paste_to_agent", Path(__file__).parents[1] / "mods/changes-plus/paste_to_agent.py")
paste = importlib.util.module_from_spec(spec)
spec.loader.exec_module(paste)


def read_exact(stream, length):
    chunks = bytearray()
    while len(chunks) < length:
        part = stream.read(length - len(chunks))
        if not part:
            raise EOFError()
        chunks.extend(part)
    return bytes(chunks)


def read_frame(stream):
    channel, kind, length = struct.unpack("<IBI", read_exact(stream, 9))
    return channel, kind, read_exact(stream, length)


class FakeCore:
    def __init__(self, replay):
        client, server = socket.socketpair()
        self.client = client
        self.server = server
        self.stdin = client.makefile("wb", buffering=0)
        self.stdout = client.makefile("rb", buffering=0)
        self.received = []
        self.thread = threading.Thread(target=self.serve, args=(replay,), daemon=True)
        self.thread.start()

    def serve(self, replay):
        stream = self.server.makefile("rwb", buffering=0)
        try:
            stream.readline()
            stream.write(b'{"jsonrpc":"2.0","id":0,"result":{}}\n')
            read_frame(stream)
            response = json.dumps({"id": 1, "result": {"channel": 7}}).encode()
            stream.write(paste.frame(0, paste.DATA, response))
            read_frame(stream)  # replay credit
            stream.write(paste.frame(7, paste.DATA, replay))
            while True:
                channel, kind, data = read_frame(stream)
                self.received.append((channel, kind, data))
                if kind == paste.CLOSE:
                    break
        except (EOFError, OSError):
            pass
        finally:
            stream.close()

    def kill(self):
        self.stdin.close()
        self.stdout.close()
        self.client.close()

    def wait(self):
        self.thread.join(timeout=2)
        self.server.close()


class PasteTests(unittest.TestCase):
    def test_modes_and_control_characters(self):
        self.assertIsNone(paste.paste_mode(None))
        self.assertFalse(paste.paste_mode(b"\x1b[?2004h\x1b[?2004l"))
        self.assertTrue(paste.paste_mode(b"\x1b[?2004l\x1b[?2004h"))
        self.assertEqual(paste.paste_bytes("a\x1b[201~\x9b\r\nb\n", True), b"\x1b[200~a[201~\nb\x1b[201~")
        for mode in (False, None):
            with self.assertRaises(ValueError):
                paste.paste_bytes("one\ntwo", mode)

    def test_framed_paste_without_enter(self):
        core = FakeCore(b"\x1b[?2004hprompt")
        info = {"state": "live", "status": {"state": "idle"}, "cols": 80, "rows": 24}
        with patch.object(paste, "terminal_info", return_value=info), patch.object(paste.subprocess, "Popen", return_value=core):
            paste.paste("test-terminal", "first\nsecond")
        self.assertEqual(core.received, [(7, paste.DATA, b"\x1b[200~first\nsecond\x1b[201~"), (7, paste.CLOSE, b"")])

    def test_plain_terminal_receives_no_multiline(self):
        core = FakeCore(b"plain shell")
        info = {"state": "live", "status": {"state": "idle"}}
        with patch.object(paste, "terminal_info", return_value=info), patch.object(paste.subprocess, "Popen", return_value=core):
            with self.assertRaises(ValueError):
                paste.paste("test-terminal", "first\nsecond")
        self.assertEqual(core.received, [])


if __name__ == "__main__":
    unittest.main()
