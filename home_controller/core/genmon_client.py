from __future__ import annotations

import json
import socket
from typing import Any, Optional

TERMINATOR = "EndOfMessage"


class GenMonClient:
    """
    Lightweight client for talking to a GenMon instance over its TCP socket
    interface (defaults: host GenMon_PI, port 9082).

    The protocol is simple: send a command string like
    "generator:gui_status_json" and read until the terminating string
    "EndOfMessage". On connect the server may send a short health banner; we
    drain it best-effort before issuing our command.
    """

    def __init__(self, host: str = "GenMon_PI", port: int = 9082, timeout: float = 3.0) -> None:
        self.host = host
        self.port = int(port)
        self.timeout = float(timeout)

    def _drain_startup(self, sock: socket.socket) -> None:
        """Drop the optional startup banner (e.g., OK/CRITICAL)."""
        try:
            sock.settimeout(0.4)
            data = sock.recv(4096)
            if not data:
                return
            text = data.decode("utf-8", errors="ignore")
            # If the banner already contains the terminator, put it back into
            # the buffer by raising so the caller will retry read loop.
            if TERMINATOR in text:
                # Stuff the data back is not trivial; easiest is to keep it by
                # setting an attribute and letting the caller handle it. For
                # now, we just store it for the next read.
                self._prefetched = text
            else:
                self._prefetched = ""
        except Exception:
            self._prefetched = ""
        finally:
            try:
                sock.settimeout(self.timeout)
            except Exception:
                pass

    def _recv_until_eom(self, sock: socket.socket) -> str:
        buf = getattr(self, "_prefetched", "") or ""
        while True:
            if TERMINATOR in buf:
                buf = buf.split(TERMINATOR, 1)[0]
                break
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                break
            if not chunk:
                break
            buf += chunk.decode("utf-8", errors="ignore")
        return buf.strip()

    def _prefix(self, cmd: str) -> str:
        cmd = (cmd or "").strip()
        if not cmd.lower().startswith("generator:"):
            return f"generator:{cmd}"
        return cmd

    def command(self, cmd: str, expect_json: bool = False) -> Any:
        self._prefetched = ""
        command = self._prefix(cmd)
        with socket.create_connection((self.host, self.port), timeout=self.timeout) as sock:
            self._drain_startup(sock)
            sock.sendall(command.encode("utf-8"))
            raw = self._recv_until_eom(sock)
        if expect_json:
            try:
                return json.loads(raw or "{}")
            except Exception as e:
                raise RuntimeError(f"GenMon JSON parse failed: {e}; raw={raw!r}") from e
        return raw

    # Convenience wrappers
    def status(self) -> dict:
        return self.command("gui_status_json", expect_json=True)

    def monitor(self) -> dict:
        return self.command("monitor_json", expect_json=True)

    def base(self) -> dict:
        return self.command("getbase", expect_json=True)

    def send_contact(self, contact: int, state: str, template: Optional[str] = None) -> str:
        st = (state or "").strip().lower()
        if st not in ("on", "off"):
            raise ValueError("state must be 'on' or 'off'")
        if contact < 1:
            raise ValueError("contact must be >=1")
        if template:
            cmd = template.format(contact=contact, state=st)
        else:
            cmd = f"set_button_command=contact{contact}:{st}"
        return self.command(cmd, expect_json=False)
