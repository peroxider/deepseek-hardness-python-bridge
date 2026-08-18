#!/usr/bin/env python3
"""Install a ``dsh_bridge``-decorated Python module as a DeepSeek Harness plugin.

This script automates every mechanical step of the conversion pipeline; the
only manual work left to the user is authoring the decorated Python module
itself (``bridge.py``). Steps are decoupled: each reads artifacts the previous
step left on disk, so any subset can run alone via ``--steps``.

Pipeline
--------

::

    bridge.py ──▶ [codegen] ──▶ [build] ──▶ [assemble] ──▶ [smoke] ──▶ [patch]
    decorated     TS package      built JS     plugin dir      import      cordis.patch.yml
    module        (.build/)       (lib/)       (self-contained) check      (loader entries)

  codegen    Parse the decorated module and emit a TypeScript bridge package
             into ``<plugin-dir>/.build/generated/``.
  build      Compile the generated package — plus the two packages a built dsh
             install does not ship (``dsh-python-bridge-runtime``,
             ``dsh-sdk-protocol``) — from TypeScript to JavaScript (``lib/``).
  assemble   Lay out the self-contained plugin directory: Python source
             packages at the root (the child process resolves modules from its
             cwd), built JS under ``node_modules/@deepseek-ai/``, and links to
             the runtime dependency closure inside the dsh install.
  smoke      Import the Python module inside the assembled plugin directory,
             proving the self-contained layout works before touching dsh.
  patch      Insert (or idempotently replace) the ``python-bridge`` and plugin
             entries in the target profile's ``cordis.patch.yml``.

Usage
-----

Full install (all steps):

    scripts/install-python-plugin.py \
      --source /path/to/bridge.py \
      --name '@my-org/sample-bridge' \
      --module sample_dsh.bridge \
      --python-path /path/to/python/src \
      --config-json '{"boardId": "my-board"}'

Only regenerate the TS package and rebuild JS (leave the profile alone):

    scripts/install-python-plugin.py --source ... --name ... --module ... \
      --python-path ... --steps codegen,build

Re-apply the patch after editing ``--config-json`` (no rebuild):

    scripts/install-python-plugin.py --source ... --name ... --module ... \
      --steps patch --config-json '{"boardId": "other"}'

Remove the plugin entries from the profile:

    scripts/install-python-plugin.py --source ... --name ... --module ... --uninstall

Environment
-------------

All discovery follows an explicit-candidate chain and fails with a message
listing what was tried. Overrides:

  ``DSH_TSC``       absolute path of a tsc 6.x binary
  ``DSH_NODE``      absolute path of node (needs --experimental-transform-types)
  ``DSH_MONOREPO``  deepseek-harness checkout (source of ``dsh-sdk-protocol``)
  ``DSH_INSTALL``   the dsh install's ``@deepseek-ai`` directory
                    (default: ``npm root -g``/@deepseek-ai/dsh/node_modules/@deepseek-ai)
  ``DSH_HOME``      dsh home (default: ``~/.dsh``)
  ``DSH_TYPE_ROOTS`` directory containing ``node/`` type definitions (optional;
                    only silences tsc diagnostics — emitted JS is unaffected)

YAML editing uses PyYAML when importable and falls back to the js-yaml copy
bundled inside the dsh install (via node). Symlink creation falls back to
copying on filesystems that deny links (e.g. Windows without developer mode).

Exit codes: 0 success (or clean skip), 2 usage/environment failure, 3 a step
failed.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Runtime dependency closure the built plugin needs at load time. Each is
# linked (or copied) from the dsh install; linked packages resolve their own
# dependencies inside that tree, so this list only needs the direct surface.
RUNTIME_LINKS = [
    "cordis",
    "cosmokit",
    "schemastery",
    "dsh-tools",
    "dsh-session",
    "dsh-subprocess",
    "dsh-invariants",
    "dsh-llm",
    "dsh-scope",
    "dsh-system-prompt",
    "dsh-timeout",
    "dsh-attachment",
    "dsh-brand",
    "dsh-typert-protocol",
    "dsh-agent",
    "dsh-code-runtime",
    "dsh-user-approval",
    "dsh-subagent",
]

# Packages built from source into the plugin's node_modules because a built
# dsh install does not ship them. Maps package name → source directory.
def bundled_packages(monorepo: Path) -> dict[str, Path]:
    return {
        "@peroxider/dsh-python-bridge-runtime": REPO_ROOT / "packages/bridge/python-bridge-runtime",
        "@deepseek-ai/dsh-sdk-protocol": monorepo / "packages/sdk/protocol",
    }

PATCH_HEADER = (
    "# Your patch layer for this dsh profile, applied after every bundle layer:\n"
    "# a top-level YAML array of loader patch entries (id-targeted config\n"
    "# overrides, disables, and insert lists; `!!js` expressions allowed).\n"
)


class InstallError(Exception):
    """One installation step failed; the CLI maps this to exit code 3."""


# ---------------------------------------------------------------------------
# Environment discovery
# ---------------------------------------------------------------------------


def _first_existing(candidates: list[Path | None]) -> Path | None:
    for candidate in candidates:
        if candidate is not None and Path(candidate).exists():
            return Path(candidate)
    return None


def find_node() -> Path:
    """Locate a node binary new enough for --experimental-transform-types (>= 22.6)."""
    env = os.environ.get("DSH_NODE")
    candidates = [Path(env) if env else None, Path(shutil.which("node") or "/nonexistent")]
    found = _first_existing(candidates)
    if found is None:
        raise InstallError("node not found on PATH; set DSH_NODE")
    return found


def find_tsc() -> Path:
    """Locate a tsc 6.x binary: env override → repo installs → monorepo → npm cache extraction."""
    candidates = [
        Path(os.environ["DSH_TSC"]) if os.environ.get("DSH_TSC") else None,
        REPO_ROOT / "node_modules/.bin/tsc",
        Path(os.environ.get("DSH_MONOREPO", "/home/chad/workspace/deepseek-harness"))
        / "node_modules/.bin/tsc",
        Path("/tmp/dsh-externals/manual/typescript-6.0.3/package/bin/tsc"),
    ]
    found = _first_existing(candidates)
    if found is None:
        raise InstallError(
            "tsc not found; tried $DSH_TSC, <bridge-repo>/node_modules/.bin/tsc, "
            "$DSH_MONOREPO/node_modules/.bin/tsc, /tmp/dsh-externals — set DSH_TSC "
            "to any tsc 6.x binary"
        )
    return found


def find_dsh_install() -> Path:
    """Locate the dsh install's @deepseek-ai directory (runtime dependency source)."""
    env = os.environ.get("DSH_INSTALL")
    if env:
        path = Path(env)
        if not path.is_dir():
            raise InstallError(f"DSH_INSTALL={path} is not a directory")
        return path
    tried: list[str] = []
    npm = shutil.which("npm")
    if npm:
        result = subprocess.run([npm, "root", "-g"], capture_output=True, text=True)
        npm_root = result.stdout.strip()
        tried.append(npm_root)
        candidate = Path(npm_root) / "@deepseek-ai/dsh/node_modules/@deepseek-ai"
        if candidate.is_dir():
            return candidate
    dsh_bin = shutil.which("dsh")
    if dsh_bin:
        # <prefix>/bin/dsh → <prefix>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
        candidate = Path(dsh_bin).resolve().parent.parent / "lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"
        tried.append(str(candidate))
        if candidate.is_dir():
            return candidate
    raise InstallError(
        "dsh install not found; tried `npm root -g` and the dsh binary layout "
        f"({'; '.join(tried) or 'none available'}) — set DSH_INSTALL"
    )


def find_monorepo() -> Path:
    """Locate the deepseek-harness checkout (source of dsh-sdk-protocol)."""
    candidate = Path(os.environ.get("DSH_MONOREPO", "/home/chad/workspace/deepseek-harness"))
    if not (candidate / "packages/sdk/protocol/src/index.ts").exists():
        raise InstallError(
            f"dsh-sdk-protocol source not found under {candidate}; set DSH_MONOREPO"
        )
    return candidate


def find_type_roots() -> Path | None:
    """Optional @types/node location; only silences tsc diagnostics, never required."""
    env = os.environ.get("DSH_TYPE_ROOTS")
    candidates = [
        Path(env) if env else None,
        Path("/tmp/dsh-externals/manual/types-node"),
    ]
    return _first_existing(candidates)


def find_python(requested: str) -> str:
    """Resolve the child-process interpreter and require Python >= 3.10."""
    candidate = requested or os.environ.get("DSH_PYTHON") or "python3"
    probe = subprocess.run(
        [candidate, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
        capture_output=True,
        text=True,
    )
    if probe.returncode != 0:
        raise InstallError(f"python interpreter not runnable: {candidate}")
    major, minor = (int(part) for part in probe.stdout.strip().split("."))
    if (major, minor) < (3, 10):
        raise InstallError(f"dsh-bridge requires Python >= 3.10 (got {major}.{minor} at {candidate})")
    return candidate


# ---------------------------------------------------------------------------
# YAML helpers — PyYAML when importable, js-yaml (bundled with dsh) otherwise.
# ---------------------------------------------------------------------------


def _js_yaml_esm() -> Path:
    """The js-yaml ESM entry bundled inside the dsh install."""
    dsh_pkg = find_dsh_install().parent  # .../@deepseek-ai/dsh/node_modules
    candidate = dsh_pkg / "js-yaml/dist/js-yaml.mjs"
    if not candidate.exists():
        raise InstallError(f"js-yaml not found at {candidate}; install PyYAML instead")
    return candidate


def yaml_load(text: str):
    """Parse YAML via PyYAML, falling back to the dsh-bundled js-yaml."""
    try:
        import yaml  # type: ignore

        return yaml.safe_load(text)
    except ImportError:
        script = (
            f"import * as yaml from '{_js_yaml_esm().as_posix()}';"
            "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{"
            "process.stdout.write(JSON.stringify(yaml.load(s)))})"
        )
        result = subprocess.run(
            [str(find_node()), "--input-type=module", "-e", script],
            input=text,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise InstallError(f"js-yaml fallback failed: {result.stderr.strip()}")
        return json.loads(result.stdout)


def yaml_dump(value) -> str:
    """Serialize YAML via PyYAML, falling back to the dsh-bundled js-yaml."""
    try:
        import yaml  # type: ignore

        return yaml.dump(value, allow_unicode=True, sort_keys=False)
    except ImportError:
        script = (
            f"import * as yaml from '{_js_yaml_esm().as_posix()}';"
            "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{"
            "process.stdout.write(yaml.dump(JSON.parse(s)))})"
        )
        result = subprocess.run(
            [str(find_node()), "--input-type=module", "-e", script],
            input=json.dumps(value),
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise InstallError(f"js-yaml fallback failed: {result.stderr.strip()}")
        return result.stdout


# ---------------------------------------------------------------------------
# Shared context passed between steps.
# ---------------------------------------------------------------------------


@dataclass
class InstallContext:
    """Resolved inputs shared by all steps. Paths are absolute."""

    args: argparse.Namespace
    node: Path
    tsc: Path
    python: str
    dsh_install: Path
    monorepo: Path
    type_roots: Path | None
    plugin_dir: Path
    generated_dir: Path  # <plugin-dir>/.build/generated (codegen output)
    plugin_pkg: Path  # <plugin-dir>/<package-short-name> (built plugin package)
    entry_id: str
    dsh_home: Path
    dry_run: bool = field(default=False)

    @property
    def package_short_name(self) -> str:
        return self.args.name.split("/")[-1]


# ---------------------------------------------------------------------------
# Step implementations. Each reads prior artifacts from disk and leaves its
# own, so subsets compose freely via --steps.
# ---------------------------------------------------------------------------


def step_codegen(ctx: InstallContext) -> None:
    """Python source → TS bridge package in ``<plugin-dir>/.build/generated/``.

    Fails when the decorated module does not parse cleanly (the codegen
    reports diagnostics on stderr).
    """
    if ctx.generated_dir.exists():
        shutil.rmtree(ctx.generated_dir)
    ctx.generated_dir.mkdir(parents=True)
    command = [
        ctx.node,
        "--experimental-transform-types",
        "--no-warnings",
        REPO_ROOT / "scripts/run-codegen.mjs",
        ctx.args.source,
        "--out",
        ctx.generated_dir,
        "--name",
        ctx.args.name,
        "--module",
        ctx.args.module,
    ]
    print(f"+ {' '.join(str(c) for c in command)}")
    result = subprocess.run([str(c) for c in command], capture_output=True, text=True)
    if result.stdout.strip():
        print(result.stdout.strip())
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise InstallError("codegen reported decoration diagnostics")


def _build_package(ctx: InstallContext, source_entry: Path, out_dir: Path, label: str) -> None:
    """Transpile one TS package to JS with tsc.

    Type-resolution diagnostics (missing @types) are non-fatal here: tsc emits
    JS regardless, and strict type checking is the verification suite's job.
    A missing output file IS fatal.
    """
    command = [
        ctx.tsc,
        "--ignoreConfig",
        source_entry,
        "--outDir",
        out_dir,
        "--module",
        "esnext",
        "--target",
        "es2024",
        "--moduleResolution",
        "bundler",
        "--skipLibCheck",
        "--rewriteRelativeImportExtensions",
        "--declaration",
        "false",
        "--sourceMap",
        "false",
    ]
    if ctx.type_roots is not None:
        command += ["--types", "node", "--typeRoots", ctx.type_roots]
    print(f"+ tsc {label}")
    result = subprocess.run([str(c) for c in command], capture_output=True, text=True)
    if not (out_dir / "index.js").exists():
        print(result.stdout)
        print(result.stderr, file=sys.stderr)
        raise InstallError(f"tsc produced no output for {label}")


def step_build(ctx: InstallContext) -> None:
    """TS → JS for the generated package and the two bridge-side packages.

    Reads ``<plugin-dir>/.build/generated/`` (from ``codegen``) and the bridge
    repo sources; writes ``lib/`` next to each package.json in the plugin dir.
    """
    if not (ctx.generated_dir / "package.json").exists():
        raise InstallError(f"no codegen output at {ctx.generated_dir}; run the codegen step first")
    if not ctx.dry_run:
        for package_name, source_pkg in bundled_packages(ctx.monorepo).items():
            short = package_name.split("/")[-1]
            target = ctx.plugin_dir / "node_modules/@deepseek-ai" / short
            target.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_pkg / "package.json", target / "package.json")
            _build_package(ctx, source_pkg / "src/index.ts", target / "lib", package_name)
            print(f"  built {package_name}")

        ctx.plugin_pkg.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ctx.generated_dir / "package.json", ctx.plugin_pkg / "package.json")
        _build_package(ctx, ctx.generated_dir / "src/index.ts", ctx.plugin_pkg / "lib", ctx.args.name)
        print(f"  built {ctx.args.name}")


def _link_or_copy(source: Path, link: Path) -> str:
    """Link (preferred) or copy a dependency directory into the plugin tree."""
    if link.is_symlink() or link.exists():
        if link.is_symlink() or link.is_file():
            link.unlink()
        else:
            shutil.rmtree(link)
    try:
        link.symlink_to(source, target_is_directory=True)
        return "linked"
    except OSError:
        # Filesystems that deny symlinks (Windows without developer mode).
        shutil.copytree(source, link, symlinks=True)
        return "copied"


def step_assemble(ctx: InstallContext) -> None:
    """Lay out the self-contained plugin directory.

    Copies the bridge SDK to the plugin root and links the runtime dependency
    closure from the dsh install into ``node_modules/@deepseek-ai/``. Business
    packages stay at their configured ``--python-path`` roots unless the
    compatibility flag ``--copy-python-src`` is present.
    """
    modules_dir = ctx.plugin_dir / "node_modules/@deepseek-ai"
    modules_dir.mkdir(parents=True, exist_ok=True)
    linked = copied = 0
    if not ctx.dry_run:
        for name in RUNTIME_LINKS:
            source = ctx.dsh_install / name
            if not source.is_dir():
                continue
            if _link_or_copy(source, modules_dir / name) == "linked":
                linked += 1
            else:
                copied += 1
    note = f"  {linked} deps linked, {copied} copied from {ctx.dsh_install}"
    print(note)

    python_roots = [REPO_ROOT / "python/sdk-dsl/src"]
    if ctx.args.copy_python_src:
        python_roots.extend(Path(d) for d in ctx.args.python_path)
    for src_root in python_roots:
        if not src_root.is_dir():
            raise InstallError(f"python src dir not found: {src_root}")
        for child in sorted(src_root.iterdir()):
            if not child.is_dir() or child.name.startswith(".") or child.name == "__pycache__":
                continue
            if not (child / "__init__.py").exists():
                continue
            target = ctx.plugin_dir / child.name
            if not ctx.dry_run:
                if target.exists():
                    shutil.rmtree(target)
                shutil.copytree(child, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            print(f"  python package {child.name} -> {target}")


def step_smoke(ctx: InstallContext) -> None:
    """Import the Python module with the configured import roots."""
    env = os.environ.copy()
    configured = [str(Path(path).resolve()) for path in ctx.args.python_path]
    if configured:
        env["PYTHONPATH"] = os.pathsep.join(
            [*configured, *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])]
        )
    result = subprocess.run(
        [ctx.python, "-c", f"import {ctx.args.module}"],
        cwd=ctx.plugin_dir,
        env=env,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise InstallError(
            f"python module {ctx.args.module} does not import inside {ctx.plugin_dir} "
            "(missing --python-path?)"
        )
    print(f"  import {ctx.args.module} ok")


def _file_uri(path: Path) -> str:
    """file:// URL for a plugin entry. as_uri() percent-encodes '@' as %40;
    Node's ESM loader decodes it back, so the URL stays correct on every
    platform (including Windows drive letters)."""
    return path.resolve().as_uri()


def _patch_file(ctx: InstallContext) -> Path:
    return ctx.dsh_home / "profiles" / ctx.args.profile / "cordis.patch.yml"


def _target_entry_ids(ctx: InstallContext) -> set[str]:
    return {"python-bridge", ctx.entry_id}


def step_patch(ctx: InstallContext) -> None:
    """Insert or replace the plugin entries in the profile's cordis.patch.yml.

    Idempotent: insert-lists carrying our entry ids are replaced; every other
    patch entry is preserved verbatim.
    """
    patch_file = _patch_file(ctx)
    if not patch_file.exists():
        raise InstallError(f"profile patch file not found: {patch_file} (is the profile initialized?)")

    config = {
        "pythonBin": ctx.python,
        "module": ctx.args.module,
        "cwd": str(ctx.plugin_dir),
        "pythonPath": [str(Path(path).resolve()) for path in ctx.args.python_path],
        **json.loads(ctx.args.config_json),
    }
    new_entries = [
        {
            "id": "python-bridge",
            "name": _file_uri(ctx.plugin_dir / "node_modules/@peroxider/dsh-python-bridge-runtime/lib/index.js"),
        },
        {"id": ctx.entry_id, "name": _file_uri(ctx.plugin_pkg / "lib/index.js"), "config": config},
    ]

    patches = yaml_load(patch_file.read_text()) or []
    if not isinstance(patches, list):
        raise InstallError(f"{patch_file} is not a YAML array")

    ours = _target_entry_ids(ctx)
    kept = []
    for patch in patches:
        if not isinstance(patch, dict) or "insert" not in patch:
            kept.append(patch)
            continue
        remaining = [
            entry
            for entry in patch.get("insert") or []
            if not (isinstance(entry, dict) and entry.get("id") in ours)
        ]
        if remaining:
            kept.append({**patch, "insert": remaining})
    kept.append({"insert": new_entries})

    if ctx.dry_run:
        print(PATCH_HEADER + yaml_dump(kept))
        return
    patch_file.write_text(PATCH_HEADER + yaml_dump(kept))
    print(f"  patched {patch_file} (entries: python-bridge, {ctx.entry_id})")


def step_uninstall(ctx: InstallContext) -> None:
    """Remove the plugin entries from the profile's cordis.patch.yml.

    With ``--delete-dir`` the plugin directory is removed as well.
    """
    patch_file = _patch_file(ctx)
    if patch_file.exists():
        patches = yaml_load(patch_file.read_text()) or []
        ours = _target_entry_ids(ctx)
        kept = []
        removed = 0
        for patch in patches:
            if not isinstance(patch, dict) or "insert" not in patch:
                kept.append(patch)
                continue
            remaining = [
                entry
                for entry in patch.get("insert") or []
                if not (isinstance(entry, dict) and entry.get("id") in ours)
            ]
            removed += len(patch.get("insert") or []) - len(remaining)
            if remaining:
                kept.append({**patch, "insert": remaining})
        if not ctx.dry_run:
            patch_file.write_text(PATCH_HEADER + yaml_dump(kept))
        print(f"  removed {removed} entr{'ies' if removed != 1 else 'y'} from {patch_file}")
    else:
        print(f"  no patch file at {patch_file}; nothing to remove")
    if ctx.args.delete_dir:
        if not ctx.dry_run and ctx.plugin_dir.exists():
            shutil.rmtree(ctx.plugin_dir)
        print(f"  {'would delete' if ctx.dry_run else 'deleted'} {ctx.plugin_dir}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

STEPS = {
    "codegen": step_codegen,
    "build": step_build,
    "assemble": step_assemble,
    "smoke": step_smoke,
    "patch": step_patch,
}
DEFAULT_STEPS = ["codegen", "build", "assemble", "smoke", "patch"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="install-python-plugin.py",
        description="Install a dsh_bridge-decorated Python module as a dsh plugin.",
        epilog="Steps: " + ", ".join(STEPS) + " (default: all). See the module docstring for examples.",
    )
    parser.add_argument("--source", required=True, help="Path to the decorated Python module (bridge.py).")
    parser.add_argument("--name", required=True, help="Generated package name, e.g. @my-org/sample-bridge.")
    parser.add_argument("--module", required=True, help="Python module path, e.g. sample_dsh.bridge.")
    parser.add_argument(
        "--python-path",
        action="append",
        default=[],
        help="Import root prepended to the child PYTHONPATH (repeatable).",
    )
    parser.add_argument(
        "--copy-python-src",
        action="store_true",
        help="Compatibility mode: copy top-level packages from --python-path roots into the plugin directory.",
    )
    parser.add_argument("--plugin-dir", default=None, help="Plugin directory (default: $DSH_HOME/plugins/<short-name>).")
    parser.add_argument("--id", default=None, help="Loader entry id (default: package short name minus '-bridge').")
    parser.add_argument("--profile", default="web", help="dsh profile to patch (default: web).")
    parser.add_argument("--python-bin", default="python3", help="Python interpreter for the child process.")
    parser.add_argument("--config-json", default="{}", help="Extra cordis.yml config keys as a JSON object.")
    parser.add_argument(
        "--steps",
        default=",".join(DEFAULT_STEPS),
        help="Comma-separated subset of steps to run (default: all).",
    )
    parser.add_argument("--uninstall", action="store_true", help="Remove the plugin entries from the profile instead.")
    parser.add_argument("--delete-dir", action="store_true", help="With --uninstall: also delete the plugin directory.")
    parser.add_argument("--dry-run", action="store_true", help="Print what would happen without writing anything.")
    return parser.parse_args()


def build_context(args: argparse.Namespace) -> InstallContext:
    dsh_home = Path(os.environ.get("DSH_HOME", Path.home() / ".dsh"))
    short_name = args.name.split("/")[-1]
    plugin_dir = Path(args.plugin_dir) if args.plugin_dir else dsh_home / "plugins" / short_name
    return InstallContext(
        args=args,
        node=find_node(),
        tsc=find_tsc(),
        python=find_python(args.python_bin),
        dsh_install=find_dsh_install(),
        monorepo=find_monorepo(),
        type_roots=find_type_roots(),
        plugin_dir=plugin_dir.resolve(),
        generated_dir=(plugin_dir / ".build/generated").resolve(),
        plugin_pkg=(plugin_dir / short_name).resolve(),
        entry_id=args.id or short_name.removesuffix("-bridge"),
        dsh_home=dsh_home,
        dry_run=args.dry_run,
    )


def main() -> int:
    args = parse_args()
    if not Path(args.source).exists():
        print(f"install-python-plugin: error: source not found: {args.source}", file=sys.stderr)
        return 2
    try:
        ctx = build_context(args)
    except InstallError as error:
        print(f"install-python-plugin: error: {error}", file=sys.stderr)
        return 2

    if args.uninstall:
        try:
            step_uninstall(ctx)
        except InstallError as error:
            print(f"install-python-plugin: uninstall failed: {error}", file=sys.stderr)
            return 3
        return 0

    requested = [name.strip() for name in args.steps.split(",") if name.strip()]
    unknown = [name for name in requested if name not in STEPS]
    if unknown:
        print(f"install-python-plugin: error: unknown step(s): {', '.join(unknown)}", file=sys.stderr)
        return 2

    for name in requested:
        print(f"[{name}]")
        try:
            STEPS[name](ctx)
        except InstallError as error:
            print(f"install-python-plugin: step '{name}' failed: {error}", file=sys.stderr)
            return 3

    print()
    print(f"installed: {args.name} (entry id '{ctx.entry_id}')")
    print(f"  plugin dir: {ctx.plugin_dir}")
    if "patch" in requested:
        print(f"  profile:    {_patch_file(ctx)}")
        print("  the patch-layer watcher hot-applies new entries; when replacing an")
        print("  already-loaded plugin, restart `dsh web` to pick up rebuilt artifacts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
