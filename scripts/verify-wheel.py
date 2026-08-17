#!/usr/bin/env python3
"""Install and import the built dsh-python-bridge wheel in an isolated environment."""

from __future__ import annotations

import pathlib
import subprocess
import sys
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "python" / "sdk-dsl"


def run(*args: str, cwd: pathlib.Path | None = None) -> None:
    """Run one wheel acceptance command and fail with its exit status."""
    subprocess.run(args, cwd=cwd, check=True)


with tempfile.TemporaryDirectory(prefix="dsh-bridge-wheel-") as temporary:
    root = pathlib.Path(temporary)
    venv = root / "venv"
    run(sys.executable, "-m", "venv", str(venv))
    python = venv / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    pip = venv / ("Scripts/pip.exe" if sys.platform == "win32" else "bin/pip")
    wheels = sorted((PACKAGE / "dist").glob("*.whl"))
    if len(wheels) != 1:
        raise RuntimeError(f"expected one wheel, found {len(wheels)} in {PACKAGE / 'dist'}")
    run(str(pip), "install", "--no-index", str(wheels[0]))
    run(str(python), "-c", "import dsh_bridge; print(dsh_bridge.__version__)")
