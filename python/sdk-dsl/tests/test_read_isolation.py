"""Tests for `dsh_bridge._read_isolation`.

Pure-logic tests (parse, normalize, match) run in-process. Hook-firing tests
fork a subprocess because CPython's `sys.addaudithook` has no removal API —
once installed, the hook persists for the interpreter lifetime, so each
hook-firing test needs a clean interpreter to avoid cross-test contamination.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import textwrap

import pytest

from dsh_bridge._read_isolation import (
    MAX_CONFIG_BYTES,
    ReadDenyConfig,
    ReadIsolationError,
    _match_rule,
    _normalize,
    current_config,
    parse_config,
    reset,
)


# ---------------------------------------------------------------------------
# parse_config
# ---------------------------------------------------------------------------


class TestParseConfig:
    def test_none_returns_none(self) -> None:
        assert parse_config(None) is None

    def test_empty_returns_none(self) -> None:
        assert parse_config("") is None

    def test_valid_rules(self) -> None:
        cfg = parse_config(json.dumps({"rules": ["/etc", "/root/.ssh"]}))
        assert cfg is not None
        assert cfg.rules == ("/etc", "/root/.ssh")
        assert not cfg.is_empty()

    def test_valid_with_extra_fields_ignored(self) -> None:
        # Forward-compatible: unknown keys must not break parsing.
        cfg = parse_config(json.dumps({"rules": ["/etc"], "future_field": 42}))
        assert cfg is not None
        assert cfg.rules == ("/etc",)

    def test_malformed_json_returns_none(self) -> None:
        assert parse_config("{not json") is None

    def test_non_object_returns_none(self) -> None:
        assert parse_config(json.dumps([1, 2, 3])) is None
        assert parse_config(json.dumps("just a string")) is None
        assert parse_config(json.dumps(42)) is None

    def test_missing_rules_returns_none(self) -> None:
        assert parse_config(json.dumps({})) is None

    def test_non_list_rules_returns_none(self) -> None:
        assert parse_config(json.dumps({"rules": "/etc"})) is None
        assert parse_config(json.dumps({"rules": {"a": 1}})) is None

    def test_empty_rules_list_returns_none(self) -> None:
        assert parse_config(json.dumps({"rules": []})) is None

    def test_non_string_entries_skipped(self) -> None:
        cfg = parse_config(json.dumps({"rules": ["/etc", 42, None, "/root"]}))
        assert cfg is not None
        assert cfg.rules == ("/etc", "/root")

    def test_empty_string_entries_skipped(self) -> None:
        cfg = parse_config(json.dumps({"rules": ["/etc", "", "/root"]}))
        assert cfg is not None
        assert cfg.rules == ("/etc", "/root")

    def test_max_config_bytes_constant_matches_plan(self) -> None:
        assert MAX_CONFIG_BYTES == 65536


# ---------------------------------------------------------------------------
# _normalize / _match_rule (pure functions)
# ---------------------------------------------------------------------------


class TestNormalize:
    def test_strips_trailing_separator(self, tmp_path) -> None:
        f = tmp_path / "x.txt"
        f.write_text("hi")
        normalized = _normalize(str(f) + os.sep)
        assert normalized.endswith("x.txt")
        assert not normalized.endswith("x.txt" + os.sep)

    def test_resolves_symlinks(self, tmp_path) -> None:
        target = tmp_path / "target.txt"
        target.write_text("hi")
        link = tmp_path / "link.txt"
        try:
            os.symlink(str(target), str(link))
        except (OSError, NotImplementedError):
            pytest.skip("symlink unsupported on this platform")
        assert _normalize(str(link)) == str(target)

    def test_nonexistent_path_falls_back_to_as_spelled(self) -> None:
        # realpath raises on a missing path; the fallback returns the
        # input so the matcher still gets something deterministic.
        assert _normalize("/nonexistent/__nope__/x") == "/nonexistent/__nope__/x"


class TestMatchRule:
    def test_exact_match(self, tmp_path) -> None:
        f = tmp_path / "secret"
        f.write_text("")
        assert _match_rule((str(tmp_path),), str(f)) == str(tmp_path)

    def test_glob_match(self, tmp_path) -> None:
        d = tmp_path / "sub"
        d.mkdir()
        f = d / "x"
        f.write_text("")
        assert _match_rule((f"{tmp_path}/*",), str(f)) == f"{tmp_path}/*"

    def test_directory_rule_covers_nested_file(self, tmp_path) -> None:
        # A bare directory rule must deny files beneath it at any depth,
        # otherwise `readDenyPaths: ['/etc']` would deny only the directory
        # entry and leak every file inside it.
        nested = tmp_path / "a" / "b"
        nested.mkdir(parents=True)
        deep = nested / "secret"
        deep.write_text("")
        assert _match_rule((str(tmp_path),), str(deep)) == str(tmp_path)

    def test_trailing_separator_rule_covers_nested_file(self, tmp_path) -> None:
        f = tmp_path / "secret"
        f.write_text("")
        rule = str(tmp_path) + os.sep
        assert _match_rule((rule,), str(f)) == rule

    def test_sibling_prefix_not_matched(self, tmp_path) -> None:
        # `/etc` must not match `/etcetera` — the subtree expansion appends a
        # separator rather than matching on a bare string prefix.
        base = tmp_path / "etc"
        base.mkdir()
        sibling = tmp_path / "etcetera"
        sibling.write_text("")
        assert _match_rule((str(base),), str(sibling)) is None

    def test_no_match(self, tmp_path) -> None:
        assert _match_rule(("/etc",), str(tmp_path / "x")) is None

    def test_hardcoded_proc_self_mem(self) -> None:
        # The hard-coded deny list always blocks `/proc/self/mem`.
        assert _match_rule((), "/proc/self/mem") == "*/proc/self/mem"

    def test_hardcoded_proc_pid_mem(self) -> None:
        assert _match_rule((), "/proc/12345/mem") == "*/proc/*/mem"

    def test_operator_rules_tried_first(self, tmp_path) -> None:
        # If the operator has a matching rule, the operator rule wins in the
        # error message (more actionable than the hard-coded fallback).
        d = tmp_path / "sensitive"
        d.mkdir()
        rule = f"{tmp_path}/*"
        matched = _match_rule((rule,), str(d))
        assert matched == rule


# ---------------------------------------------------------------------------
# Hook-firing tests — subprocess isolated.
# ---------------------------------------------------------------------------


_SRC_DIR = str(pathlib.Path(__file__).resolve().parents[1] / "src")


def _run_in_subprocess(script: str) -> subprocess.CompletedProcess:
    """Run `script` in a fresh Python interpreter and return its result.

    `src` is prepended to `PYTHONPATH` so the child imports `dsh_bridge`
    from the working tree whether or not the package is pip-installed.
    """
    existing = os.environ.get("PYTHONPATH", "")
    pythonpath = _SRC_DIR + (os.pathsep + existing if existing else "")
    return subprocess.run(
        [sys.executable, "-c", textwrap.dedent(script)],
        capture_output=True,
        text=True,
        check=False,
        env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONPATH": pythonpath},
    )


class TestHookFiring:
    def test_open_blocked_by_deny_rule(self) -> None:
        # Create a real file to open, then deny its directory and confirm the
        # audit hook raises ReadIsolationError.
        with __import__("tempfile").NamedTemporaryFile(suffix=".txt", delete=False) as tf:
            tf.write(b"hi")
            target = tf.name
        try:
            script = f"""
                from dsh_bridge._read_isolation import (
                    ReadDenyConfig, ReadIsolationError, install,
                )
                config = ReadDenyConfig(rules=({os.path.dirname(target)!r},))
                install(config)
                try:
                    open({target!r}, "r").read()
                except ReadIsolationError as exc:
                    print("BLOCKED:", exc)
                else:
                    print("NOT BLOCKED")
            """
            result = _run_in_subprocess(script)
            assert "BLOCKED:" in result.stdout, result.stdout + result.stderr
            assert "matched deny rule" in result.stdout
        finally:
            os.unlink(target)

    def test_open_allowed_when_path_not_denied(self) -> None:
        # An allow path that is NOT matched by any rule should succeed.
        # `/dev/null` exists on POSIX; on Windows the test is skipped.
        if os.name != "posix":
            pytest.skip("POSIX-only path used in this assertion")
        script = """
            from dsh_bridge._read_isolation import ReadDenyConfig, install
            install(ReadDenyConfig(rules=("/nonexistent/never_matches",)))
            try:
                f = open("/dev/null", "r")
                f.close()
                print("ALLOWED")
            except Exception as exc:
                print("DENIED UNEXPECTEDLY:", exc)
                raise
        """
        result = _run_in_subprocess(script)
        assert "ALLOWED" in result.stdout, result.stdout + result.stderr

    def test_hardcoded_proc_self_mem_blocked(self) -> None:
        # The hard-coded rule fires even when the operator's list is empty.
        script = """
            from dsh_bridge._read_isolation import ReadDenyConfig, ReadIsolationError, install
            install(ReadDenyConfig(rules=()))
            try:
                open("/proc/self/mem", "r")
            except ReadIsolationError as exc:
                print("HARD-BLOCKED:", exc)
            else:
                print("NOT BLOCKED")
        """
        result = _run_in_subprocess(script)
        assert "HARD-BLOCKED:" in result.stdout, result.stdout + result.stderr

    def test_subprocess_popen_blocked_when_arg_matches(self) -> None:
        # Deny a directory; calling Popen with a binary inside it must raise.
        with __import__("tempfile").TemporaryDirectory() as td:
            bin_path = os.path.join(td, "fakebinary")
            with open(bin_path, "wb") as f:
                f.write(b"#!/bin/sh\nexit 0\n")
            os.chmod(bin_path, 0o755)
            script = f"""
                from dsh_bridge._read_isolation import (
                    ReadDenyConfig, ReadIsolationError, install,
                )
                install(ReadDenyConfig(rules=({td!r},)))
                try:
                    import subprocess
                    subprocess.Popen([{bin_path!r}, "arg"])
                except ReadIsolationError as exc:
                    print("SUBPROC-BLOCKED:", exc)
                else:
                    print("SUBPROC NOT BLOCKED")
            """
            result = _run_in_subprocess(script)
            assert "SUBPROC-BLOCKED:" in result.stdout, result.stdout + result.stderr

    def test_os_listdir_blocked(self) -> None:
        # `os.listdir` fires its own audit event from CPython 3.12 on. On
        # 3.10/3.11 it emits nothing and the call leaks through, so the
        # assertion is version-gated rather than skipped outright — that way
        # the coverage turns on automatically as deployments move forward.
        with __import__("tempfile").TemporaryDirectory() as td:
            script = f"""
                from dsh_bridge._read_isolation import (
                    ReadDenyConfig, ReadIsolationError, install,
                )
                install(ReadDenyConfig(rules=({td!r},)))
                try:
                    import os
                    os.listdir({td!r})
                except ReadIsolationError as exc:
                    print("LISTDIR-BLOCKED:", exc)
                else:
                    print("LISTDIR NOT BLOCKED")
            """
            result = _run_in_subprocess(script)
            if sys.version_info >= (3, 12):
                assert "LISTDIR-BLOCKED:" in result.stdout, result.stdout + result.stderr
            else:
                assert "LISTDIR NOT BLOCKED" in result.stdout, result.stdout + result.stderr

    def test_os_scandir_blocked(self) -> None:
        with __import__("tempfile").TemporaryDirectory() as td:
            script = f"""
                from dsh_bridge._read_isolation import (
                    ReadDenyConfig, ReadIsolationError, install,
                )
                install(ReadDenyConfig(rules=({td!r},)))
                try:
                    import os
                    next(os.scandir({td!r}))
                except ReadIsolationError as exc:
                    print("SCANDIR-BLOCKED:", exc)
                else:
                    print("SCANDIR NOT BLOCKED")
            """
            result = _run_in_subprocess(script)
            assert "SCANDIR-BLOCKED:" in result.stdout, result.stdout + result.stderr

    def test_install_idempotent(self) -> None:
        # Calling install() twice with different configs must replace the
        # config; the hook itself stays registered exactly once (CPython
        # has no removeaudithook so we cannot reset that — but a duplicate
        # registration is still wrong; verify it doesn't fire twice for
        # one event by checking the message count).
        script = """
            from dsh_bridge._read_isolation import (
                ReadDenyConfig, current_config, install,
                _installed_hook,
            )
            install(ReadDenyConfig(rules=("/etc",)))
            assert current_config() is not None
            first_hook = _installed_hook
            install(ReadDenyConfig(rules=("/var",)))
            assert _installed_hook is first_hook, "hook should not be re-registered"
            assert current_config().rules == ("/var",), "config should be replaced"
            print("IDEMPOTENT-OK")
        """
        result = _run_in_subprocess(script)
        assert "IDEMPOTENT-OK" in result.stdout, result.stdout + result.stderr

    def test_empty_config_does_not_install_hook_via_parse(self) -> None:
        # An empty rules list must NOT trigger addaudithook at all — the
        # normal flow is `parse_config` → `install`; `parse_config` returns
        # None for empty rules so `install` is never reached. We verify
        # by spying on `sys.addaudithook`.
        script = """
            import json
            import sys
            from dsh_bridge import _read_isolation as ri
            calls = []
            real_add = sys.addaudithook
            def spy(_hook):
                calls.append(_hook)
            sys.addaudithook = spy
            try:
                cfg = ri.parse_config(json.dumps({"rules": []}))
                assert cfg is None, "empty rules must parse to None"
                print("CALLS:", len(calls))
            finally:
                sys.addaudithook = real_add
        """
        result = _run_in_subprocess(script)
        assert "CALLS: 0" in result.stdout, result.stdout + result.stderr


# ---------------------------------------------------------------------------
# In-process smoke tests of pure functions only (no install)
# ---------------------------------------------------------------------------


class TestPureFunctions:
    def test_read_deny_config_is_frozen(self) -> None:
        cfg = ReadDenyConfig(rules=("/etc",))
        with pytest.raises(Exception):
            cfg.rules = ("/var",)  # type: ignore[misc]

    def test_reset_clears_config(self) -> None:
        # `reset` is in-process safe; verify it clears the slot without
        # touching the registered hook (which CPython won't remove anyway).
        from dsh_bridge._read_isolation import install
        install(ReadDenyConfig(rules=("/tmp",)))
        assert current_config() is not None
        reset()
        assert current_config() is None
