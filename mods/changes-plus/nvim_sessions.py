#!/usr/bin/env python3
"""Find local Neovim servers by terminal ancestry, without terminal input."""
import json
import os
import re
import subprocess
import sys
from pathlib import Path


def sessions(addresses):
    roots = {}
    for address in addresses:
        try:
            result = subprocess.run(["hc", "get", address, "--json"], capture_output=True, text=True, check=True, timeout=3)
            terminal = json.loads(result.stdout)
            if terminal.get("pid") and terminal.get("state") == "live":
                roots[int(terminal["pid"])] = address
        except (subprocess.SubprocessError, ValueError, KeyError):
            continue
    processes = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text()
            fields = stat[stat.rfind(")") + 2:].split()
            processes[int(entry.name)] = int(fields[1])
        except (OSError, ValueError, IndexError):
            continue
    sockets = {}
    for line in Path("/proc/net/unix").read_text().splitlines()[1:]:
        fields = line.split(maxsplit=7)
        if len(fields) == 8 and fields[5] == "01" and fields[7].startswith("/"):
            sockets[fields[6]] = fields[7]
    found = []
    for pid, parent in processes.items():
        try:
            name = Path(f"/proc/{pid}/comm").read_text().strip()
            if name not in ("nvim", "vim"):
                continue
            ancestor = pid
            visited = set()
            while ancestor not in roots and ancestor in processes and ancestor not in visited:
                visited.add(ancestor)
                ancestor = processes[ancestor]
            if ancestor not in roots:
                continue
            for fd in Path(f"/proc/{pid}/fd").iterdir():
                try:
                    match = re.fullmatch(r"socket:\[(\d+)\]", os.readlink(fd))
                except OSError:
                    continue
                if match and match.group(1) in sockets:
                    socket = sockets[match.group(1)]
                    try:
                        probe = subprocess.run(["nvim", "--server", socket, "--remote-expr", "getpid()"],
                                               capture_output=True, text=True, timeout=2)
                        if probe.returncode == 0 and probe.stdout.strip() == str(pid):
                            found.append({"address": roots[ancestor], "pid": pid, "socket": socket})
                    except (OSError, subprocess.SubprocessError):
                        continue
        except OSError:
            continue
    return found


def main():
    if len(sys.argv) < 3:
        raise ValueError("Faltan argumentos")
    action, addresses = sys.argv[1], json.loads(sys.argv[2])
    found = sessions(set(addresses))
    if action == "list":
        print(json.dumps(found))
        return
    if action != "open" or len(sys.argv) != 6:
        raise ValueError("Acción no válida")
    target, path, line = json.loads(sys.argv[3]), sys.argv[4], int(sys.argv[5])
    if target not in found:
        raise ValueError("La sesión ya no está disponible; no se ha abierto el archivo.")
    # A fresh tab preserves modified buffers and avoids sending terminal keystrokes.
    lua = "local a = ...; vim.cmd.tabedit(vim.fn.fnameescape(a[1])); if a[2] > 0 then pcall(vim.api.nvim_win_set_cursor, 0, {a[2], 0}) end; return 1"
    expression = "luaeval(" + json.dumps("(function(...) " + lua + " end)(_A)") + ", " + json.dumps([path, line]) + ")"
    result = subprocess.run(["nvim", "--server", target["socket"], "--remote-expr", expression], capture_output=True, text=True, timeout=8)
    if result.returncode or result.stdout.strip() != "1":
        raise ValueError(result.stderr.strip() or "No se confirmó la apertura; comprueba Neovim antes de reintentar.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
