"""Read-side isolation for the Python bridge child process.

The `@deepseek-ai/dsh-sandbox` seam restricts WRITES via bwrap / Landlock /
Seatbelt / Windows-ACL, but explicitly does NOT restrict reads — the contract
is recorded in `sandbox/src/index.ts:23-28` ("network and process visibility are
outside this vocabulary") and `sandbox-windows-acl/README.md:77` ("Writes are
restricted; reads, network, and process visibility are not. `WRITE_RESTRICTED`
intersects write accesses only, so a confined child can read any caller-readable
file and open sockets."). Under `workspace-write` the child can therefore read
operator secrets such as `~/.aws/credentials` or `/etc/shadow`.

This module closes that gap with a deny-list enforced inside the Python child
via `sys.addaudithook`. The hook intercepts `open`, `os.open`, `os.scandir`,
`os.listdir`, and `subprocess.Popen` and rejects calls whose path matches a
deny rule.

Config arrives as the `DSH_READ_DENY_PATHS_JSON` environment variable, a JSON
object of the shape `{"rules": ["<glob>", "<glob>", ...]}`. The TypeScript
runtime encodes this from `PythonBridgeSpawnSpec.readDenyPaths` in `buildEnv()`
(`packages/bridge/python-bridge-runtime/src/index.ts`).

Deny-rule semantics:
- Each rule is a glob matched via `fnmatch.fnmatch` (POSIX) or
  `fnmatch.fnmatchcase(os.path.normcase(...))` (Windows).
- `os.path.realpath()` resolves symlinks BEFORE matching; a rule of
  `/etc/passwd` matches the resolved path.
- A rule matches the named path AND its whole subtree, so `/etc` denies
  `/etc`, `/etc/passwd`, and `/etc/ssl/private/key.pem` alike. Operators do
  not need to add a second `/etc/*` rule.
- `fnmatch` `*` matches zero or more characters *including* path separators,
  so there is no distinction between `*` and a `**` globstar here:
  `/home/*/.aws` also matches `/home/a/b/c/.aws`. Rules are broader than
  shell globbing would suggest — prefer specific prefixes.
- A hard-coded deny rule always blocks `/proc/self/mem` (and any
  `/proc/<pid>/mem`) — the canonical process-memory-read primitive.

Failure modes:
- Missing env var or empty rules list → no hook installed, zero overhead.
- Malformed JSON → caller logs `WARN`; no hook installed (fail-open).
- Oversized env value → TS side fails closed before spawn (raises a
  `PythonBridgeError` of `kind: 'config-too-large'`); Python never sees
  oversized input. The 64 KB cap is enforced at TS encode time; this
  module exports `MAX_CONFIG_BYTES` for the symmetric Python-side check.

Best-effort caveats (documented out of scope):
- A non-`str` path argument (bytes, or an integer fd passed to `os.scandir`)
  is not checked: a deny rule is a path glob and cannot be evaluated against
  an already-open descriptor. Reaching a denied file this way still requires
  first opening it, which the hook does check.
- `ctypes.CDLL` / `ctypes.dlopen` bypass this layer (require `import ctypes`,
  which the operator may add to a deny list).
- `shell=True` passes the command as a single string; it is matched verbatim
  rather than tokenized, so a denied path appearing mid-command may not be
  recognized.
- A determined user with native code can call `open(2)` directly; this
  layer is defense-in-depth, not a security boundary.

@module dsh_bridge._read_isolation
"""

from __future__ import annotations

import fnmatch
import json
import os
import sys
from dataclasses import dataclass


# Hard cap on the encoded JSON value. The TS runtime enforces this too
# (fail-closed at the spawn site, raising `PythonBridgeError` of
# `kind: 'config-too-large'`); this constant is the Python-side belt for
# tests and any future in-process callers.
MAX_CONFIG_BYTES = 65536


# CPython audit events covered by the hook. Listed verbatim per
# https://docs.python.org/3/library/audit_events.html ; the `open` and
# `io.open` events fire for `builtins.open()`.
_AUDITED_EVENTS = frozenset(
    {"open", "io.open", "os.open", "os.scandir", "os.listdir", "subprocess.Popen"}
)


# Events whose first positional argument is the path to check. Grouped so the
# hook body stays one lookup instead of a per-event `if` chain.
_PATH_ARG_EVENTS = frozenset({"open", "io.open", "os.open", "os.scandir", "os.listdir"})


# Hard-coded deny rules applied AFTER the operator's rules. Matching is
# `fnmatch` against the realpath-normalized path. `*` in `fnmatch` matches
# zero or more characters (including separators), so `*/proc/self/mem`
# matches the literal `/proc/self/mem` (`*` matches empty) and any
# `<prefix>/proc/self/mem`.
_HARDCODED_RULES: tuple[str, ...] = (
    "*/proc/self/mem",
    "*/proc/*/mem",
)


@dataclass(frozen=True)
class ReadDenyConfig:
    """Resolved read-deny configuration."""

    rules: tuple[str, ...]

    def is_empty(self) -> bool:
        return not self.rules


class ReadIsolationError(PermissionError):
    """Raised when a file I/O or subprocess attempt matches a deny rule.

    Subclasses `PermissionError` so the bridge's existing exception
    classifier maps it to wire kind "permission" (`_errors.py:79` →
    `(-32003, "permission")`). The message identifies the matched rule
    AND the path the call requested so operators can audit attempted
    reads without re-running.
    """


def parse_config(value: str | None) -> ReadDenyConfig | None:
    """Parse the `DSH_READ_DENY_PATHS_JSON` env value into a config.

    Returns `None` when:
    - the value is `None` or empty (env var unset),
    - the JSON is malformed (caller logs WARN; fail-open),
    - the value is valid JSON but not an object with a `rules` array.
    """
    if not value:
        return None
    try:
        data = json.loads(value)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    rules_raw = data.get("rules", [])
    if not isinstance(rules_raw, list):
        return None
    rules = tuple(r for r in rules_raw if isinstance(r, str) and r)
    if not rules:
        return None
    return ReadDenyConfig(rules=rules)


def _normalize(path: str) -> str:
    """Resolve symlinks and normalize separators for matching.

    On Windows also applies `os.path.normcase` so a deny rule
    `C:\\Users\\*\\.ssh` matches a realpath that arrives with different
    drive-letter or path-component case. On POSIX case is preserved
    (matches what `open()` would actually attempt).
    """
    try:
        resolved = os.path.realpath(path)
    except (OSError, ValueError):
        resolved = path
    return _strip_and_case(resolved)


def _as_spelled(path: str) -> str:
    """Normalize separators and case WITHOUT resolving symlinks.

    Complements `_normalize`: `os.path.abspath` collapses `..` and makes the
    path absolute so matching is deterministic, but leaves symlinks and
    `/proc/self` intact.
    """
    try:
        absolute = os.path.abspath(path)
    except (OSError, ValueError):
        absolute = path
    return _strip_and_case(absolute)


def _strip_and_case(path: str) -> str:
    """Drop any trailing separator and case-fold on Windows."""
    stripped = path.rstrip(os.sep) or os.sep
    if os.name == "nt":
        stripped = os.path.normcase(stripped)
    return stripped


def _descendant_pattern(rule: str) -> str:
    """Build the glob that matches everything *under* `rule`.

    `fnmatch`'s `*` spans separators, so a single trailing `/*` covers the
    whole subtree at any depth.
    """
    if rule.endswith(os.sep):
        return rule + "*"
    return rule + os.sep + "*"


def _matches(rule: str, normalized_path: str) -> bool:
    """Test one rule against one already-normalized path.

    A rule matches the path itself AND anything beneath it, so a rule of
    `/etc` denies `/etc/passwd` without the operator having to spell out a
    second `/etc/*` rule. See the module docstring for the full semantics.
    """
    if os.name == "nt":
        rule = os.path.normcase(rule)
        match = fnmatch.fnmatchcase
    else:
        match = fnmatch.fnmatch
    stripped = rule.rstrip(os.sep) or rule
    if match(normalized_path, stripped):
        return True
    return match(normalized_path, _descendant_pattern(stripped))


def _match_rule(rules: tuple[str, ...], path: str) -> str | None:
    """Return the first rule (operator list, then hard-coded) that matches.

    Operator rules are tried first so operator-supplied denials surface in
    error messages. Hard-coded rules are a backstop for known primitives
    the operator may have forgotten (currently `/proc/self/mem`).

    Each rule is tested against both the realpath-resolved path and the path
    as the caller spelled it. Resolving catches a symlink that points into a
    denied subtree; testing as-spelled catches a rule that names a symlink or
    a synthetic path whose resolution differs, most notably `/proc/self/*`
    where `realpath` rewrites `self` to the live pid.
    """
    candidates = [_normalize(path)]
    as_spelled = _as_spelled(path)
    if as_spelled not in candidates:
        candidates.append(as_spelled)
    for rule in (*rules, *_HARDCODED_RULES):
        for candidate in candidates:
            if _matches(rule, candidate):
                return rule
    return None


def _audit_hook(event: str, args: tuple) -> None:
    """Single audit hook covering file I/O and subprocess attempts.

    Other audit events are ignored — we deliberately do NOT block `import`
    (the runtime itself needs imports), `exec`, or `compile` (too coarse —
    would break legitimate use). CPython's `addaudithook` provides no
    remove hook, so this callback stays installed for the interpreter
    lifetime; with an empty config it short-circuits in O(1).
    """
    cfg = _installed_config
    # Only a missing config short-circuits. An installed-but-empty rule list
    # still enforces `_HARDCODED_RULES` — the backstop is unconditional once
    # the hook is live.
    if cfg is None:
        return
    if event not in _AUDITED_EVENTS:
        return
    if event in _PATH_ARG_EVENTS:
        # Every event in this set passes the path first: `open(path, mode,
        # flags)`, `os.open(path, flags, mode)`, `os.scandir(path)`,
        # `os.listdir(path)`. A non-str path (an int fd for `os.scandir`, or
        # bytes) is not something a deny rule can be written against, so it
        # falls through unchecked — documented in the module docstring.
        path = args[0] if args else ""
        if not isinstance(path, str):
            return
        rule = _match_rule(cfg.rules, path)
        if rule is not None:
            raise ReadIsolationError(
                f"read isolation denied: {event}({path!r}) matched deny rule {rule!r}"
            )
        return
    # event == "subprocess.Popen"
    # CPython fires this as `(executable, args, cwd, env)` — see
    # https://docs.python.org/3/library/audit_events.html. `executable` is
    # the resolved program; `args` is the full argv (list, or a string when
    # `shell=True`); `cwd` may be None.
    executable = args[0] if args else None
    cmd_args = args[1] if len(args) > 1 else ()
    cwd = args[2] if len(args) > 2 else None
    candidates: list[str] = []
    for direct in (executable, cwd):
        if isinstance(direct, str) and direct:
            candidates.append(direct)
    if isinstance(cmd_args, str) and cmd_args:
        # `shell=True` passes the command as one string. Tokenizing a shell
        # command correctly is out of scope (documented in the module
        # docstring), so the whole string is matched as-is — it catches a
        # denied path that appears as the leading program name.
        candidates.append(cmd_args)
    elif isinstance(cmd_args, (list, tuple)):
        for item in cmd_args:
            if isinstance(item, str) and item:
                candidates.append(item)
    for candidate in candidates:
        rule = _match_rule(cfg.rules, candidate)
        if rule is not None:
            raise ReadIsolationError(
                f"read isolation denied: subprocess({candidate!r}) matched deny rule {rule!r}"
            )


# Module-level slot for the installed config — supports test-time
# replacement and idempotent re-install. The hook reference itself is
# kept so the function is not garbage-collected while CPython holds it.
_installed_config: ReadDenyConfig | None = None
_installed_hook = None  # type: ignore[var-annotated]


def install(config: ReadDenyConfig) -> None:
    """Install the deny-list audit hook. Idempotent.

    The first call registers `_audit_hook` with `sys.addaudithook`; later
    calls keep the same hook and just swap the config. Calling with an
    empty rule list is not an error: the hook stays registered (CPython
    provides no remove API) and still enforces `_HARDCODED_RULES`. The
    zero-overhead path is never calling `install` at all — which is what
    happens when the env var is unset, since `parse_config` returns None.
    """
    global _installed_config, _installed_hook
    if _installed_hook is None:
        sys.addaudithook(_audit_hook)
        _installed_hook = _audit_hook
    _installed_config = config


def current_config() -> ReadDenyConfig | None:
    """Return the currently installed config (for tests and diagnostics)."""
    return _installed_config


def reset() -> None:
    """Clear the config slot (test helper).

    CPython has no `removeaudithook` API — once installed, the hook stays
    in the interpreter for its lifetime. `reset` clears the config so the
    hook short-circuits in O(1); tests that need a fully clean interpreter
    must run in a subprocess.
    """
    global _installed_config, _installed_hook
    _installed_config = None
