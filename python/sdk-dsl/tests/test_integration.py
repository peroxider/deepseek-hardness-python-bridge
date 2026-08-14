"""End-to-end integration: spawn `python -u -m dsh_bridge.runtime` as a real
child process and drive it with newline-delimited JSON-RPC over stdio.

The fixture module lives under `tests/fixture_module/` and carries one
`@service` class, one `@tool`, and one `@on` listener whose body writes to
stdout (which the runtime proxies into `bridge/log` notifications).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURES = REPO_ROOT / "tests" / "fixture_module"
SDK_SRC = REPO_ROOT / "src"


def _runtime_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = f"{FIXTURES}:{SDK_SRC}"
    env["PYTHONUNBUFFERED"] = "1"
    return env


class _BridgeProcess:
    def __init__(self, argv: list[str]) -> None:
        self.proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=_runtime_env(),
        )
        self.notifications: list[dict] = []

    def send(self, message: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        self.proc.stdin.flush()

    def recv_response(self, timeout: float = 10.0) -> dict:
        """Read frames until a response (has `id` and no `method`) arrives."""
        assert self.proc.stdout is not None
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise AssertionError(f"bridge stdout closed; stderr: {self.read_stderr()}")
            frame = json.loads(line)
            if "method" in frame and "id" not in frame:
                self.notifications.append(frame)
                continue
            return frame

    def read_stderr(self) -> str:
        assert self.proc.stderr is not None
        try:
            return self.proc.stderr.read()
        except Exception:  # noqa: BLE001
            return ""

    def close(self) -> None:
        if self.proc.stdin is not None:
            try:
                self.proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()


@pytest.fixture
def bridge() -> _BridgeProcess:
    proc = _BridgeProcess(
        [
            sys.executable,
            "-u",
            "-m",
            "dsh_bridge.runtime",
            "fixture_provider",
            "--class",
            "EchoProvider",
            "--init-args",
            '{"greeting": "hi"}',
        ]
    )
    yield proc
    proc.close()


def test_initialize_handshake(bridge: _BridgeProcess) -> None:
    bridge.send({"jsonrpc": "2.0", "id": "init", "method": "initialize", "params": {}})
    resp = bridge.recv_response()
    assert resp["id"] == "init"
    result = resp["result"]
    assert result["serverInfo"]["name"] == "dsh-python-bridge-runtime"
    manifest = result["manifest"]
    assert "echo" in manifest["methods"]
    assert "shout" in manifest["methods"]
    assert any(s["event"] == "session/event" for s in manifest["listeners"])


def test_call_provide_method(bridge: _BridgeProcess) -> None:
    bridge.send({"jsonrpc": "2.0", "id": "init", "method": "initialize", "params": {}})
    bridge.recv_response()
    bridge.send({"jsonrpc": "2.0", "id": "c1", "method": "echo", "params": {"text": "hello"}})
    resp = bridge.recv_response()
    assert resp["id"] == "c1"
    assert resp["result"] == "hi: hello"


def test_call_tool(bridge: _BridgeProcess) -> None:
    bridge.send({"jsonrpc": "2.0", "id": "init", "method": "initialize", "params": {}})
    bridge.recv_response()
    bridge.send({"jsonrpc": "2.0", "id": "c1", "method": "shout", "params": {"text": "hey"}})
    resp = bridge.recv_response()
    assert resp["result"] == {"text": "HEY"}


def test_error_mapping_invalid_args(bridge: _BridgeProcess) -> None:
    bridge.send({"jsonrpc": "2.0", "id": "init", "method": "initialize", "params": {}})
    bridge.recv_response()
    bridge.send({"jsonrpc": "2.0", "id": "c1", "method": "boom", "params": {}})
    resp = bridge.recv_response()
    assert resp["error"]["code"] == -32004
    assert resp["error"]["data"]["kind"] == "invalid-args"


def test_unknown_method_returns_minus_32601(bridge: _BridgeProcess) -> None:
    bridge.send({"jsonrpc": "2.0", "id": "init", "method": "initialize", "params": {}})
    bridge.recv_response()
    bridge.send({"jsonrpc": "2.0", "id": "c1", "method": "no_such_method", "params": {}})
    resp = bridge.recv_response()
    assert resp["error"]["code"] == -32601


def test_event_deliver_and_stdout_proxying(bridge: _BridgeProcess) -> None:
    bridge.send({"jsonrpc": "2.0", "id": "init", "method": "initialize", "params": {}})
    bridge.recv_response()
    bridge.send(
        {
            "jsonrpc": "2.0",
            "method": "event/deliver",
            "params": {"event": "session/event", "payload": {"type": "tool/call", "data": {"name": "shout"}}},
        }
    )
    # The listener print()s; the runtime proxies that into bridge/log. Issue a
    # follow-up request so we can observe the interleaved notification.
    bridge.send({"jsonrpc": "2.0", "id": "c1", "method": "shout", "params": {"text": "x"}})
    bridge.recv_response()
    log_msgs = [
        n["params"].get("message", "")
        for n in bridge.notifications
        if n.get("method") == "bridge/log"
    ]
    assert any("audit" in m for m in log_msgs), f"notifications: {bridge.notifications}"


def test_shutdown_exits_cleanly(bridge: _BridgeProcess) -> None:
    bridge.send({"jsonrpc": "2.0", "id": "init", "method": "initialize", "params": {}})
    bridge.recv_response()
    bridge.send({"jsonrpc": "2.0", "id": "c1", "method": "shutdown", "params": {}})
    resp = bridge.recv_response()
    assert resp["result"] == {}
    assert bridge.proc.stdin is not None
    bridge.proc.stdin.close()
    exit_code = bridge.proc.wait(timeout=10)
    assert exit_code == 0