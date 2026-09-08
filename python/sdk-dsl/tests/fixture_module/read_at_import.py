"""Fixture module that performs a file read AT IMPORT TIME.

Used by `test_runtime.py` to prove the read-isolation audit hook is installed
before `main()` calls `importlib.import_module`. The path to read comes from
`DSH_TEST_READ_TARGET` so the test can point it at a deny-listed location.

If the hook is active and the target matches a deny rule, importing this
module raises `ReadIsolationError` and `main()` never reaches the transport
setup. If the hook were installed too late, the read would succeed and the
module would import cleanly — which is exactly the regression the test guards.
"""

from __future__ import annotations

import os

from dsh_bridge import provide_method, service

IMPORT_TIME_READ: str | None = None

_target = os.environ.get("DSH_TEST_READ_TARGET")
if _target:
    with open(_target, "r", encoding="utf-8") as handle:
        IMPORT_TIME_READ = handle.read()


@service(name="reader")
class Reader:
    @provide_method()
    def peek(self) -> str | None:
        return IMPORT_TIME_READ
