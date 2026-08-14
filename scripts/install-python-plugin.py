#!/usr/bin/env python3
"""One-shot installer: convert a dsh_bridge-decorated Python module into a
loaded DeepSeek Harness plugin.

Covers the mechanical steps of the conversion pipeline (everything after
authoring the decorated module):

  1. codegen   — generate the TypeScript bridge package from the Python source
  2. build     — compile the generated package (+ runtime + sdk-protocol) to JS
  3. assemble  — lay out a self-contained plugin directory (Python sources,
                 built JS, node_modules links into the dsh install)
  4. patch     — insert/replace entries in the dsh profile's cordis.patch.yml

Usage:

  scripts/install-python-plugin.py \
    --source /path/to/bridge.py \
    --name '@my-org/lkb-bridge' \
    --module lkb_dsh.bridge \
    --python-src /path/to/lkb/src \
    --config-json '{"boardId": "dsh-live"}'

Environment overrides:

  DSH_TSC        absolute path of a tsc 6.x binary
  DSH_MONOREPO   absolute path of the deepseek-harness checkout (provides the
                 dsh-sdk-protocol source, which the dsh install does not ship)
  DSH_INSTALL    absolute path of the dsh install's @deepseek-ai dir
                 (default: `npm root -g`/@deepseek-ai/dsh/node_modules/@deepseek-ai)
  DSH_HOME       dsh home (default: ~/.dsh)
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
MONOREPO = Path(os.environ.get("DSH_MONOREPO", "/home/chad/workspace/deepseek-harness"))

# Runtime dependencies the built plugin needs at load time. Symlinked from the
# dsh install; each linked package resolves its own deps inside that tree.
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

# Packages built from source into the plugin's node_modules because the dsh
# install does not ship them.
BUNDLED_PACKAGES = {
    "@deepseek-ai/dsh-python-bridge-runtime": REPO_ROOT / "packages/bridge/python-bridge-runtime",
    "@deepseek-ai/dsh-sdk-protocol": MONOREPO / "packages/sdk/protocol",
}

PATCH_HEADER = (
    "# Your patch layer for this dsh profile, applied after every bundle layer:\n"
    "# a top-level YAML array of loader patch entries (id-targeted config\n"
    "# overrides, disables, and insert lists; `!!js` expressions allowed).\n"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="install-python-plugin.py",
        description="Install a dsh_bridge-decorated Python module as a dsh plugin.",
    )
    parser.add_argument("--source", required=True, help="Path to the decorated Python module (bridge.py).")
    parser.add_argument("--name", required=True, help="Generated package name, e.g. @my-org/lkb-bridge.")
    parser.add_argument("--module", required=True, help="Python module path, e.g. lkb_dsh.bridge.")
    parser.add_argument(
        "--python-src",
        action="append",
        default=[],
        help="Directory holding the Python packages the module imports (repeatable). "
        "Each top-level package inside is copied into the plugin root.",
    )
    parser.add_argument(
        "--plugin-dir",
        default=None,
        help="Plugin directory (default: $DSH_HOME/plugins/<package-short-name>).",
    )
    parser.add_argument("--id", default=None, help="Loader entry id (default: package short name minus '-bridge').")
    parser.add_argument("--profile", default="web", help="dsh profile to patch (default: web).")
    parser.add_argument("--python-bin", default="python3", help="Python interpreter for the child process.")
    parser.add_argument("--config-json", default="{}", help="Extra cordis.yml config keys as a JSON object.")
    parser.add_argument("--no-patch", action="store_true", help="Build and assemble only; do not touch the profile.")
    return parser.parse_args()


def fail(message: str) -> "SystemExit":
    print(f"install-python-plugin: error: {message}", file=sys.stderr)
    return SystemExit(2)


def resolve_tsc() -> Path:
    candidates = [
        os.environ.get("DSH_TSC"),
        REPO_ROOT / "node_modules/.bin/tsc",
        Path("/tmp/dsh-externals/manual/typescript-6.0.3/package/bin/tsc"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return Path(candidate)
    raise fail(
        "tsc 6.x not found; set DSH_TSC (e.g. extract typescript from the npm cache "
        "or pnpm install in a workspace)"
    )


def resolve_dsh_install() -> Path:
    if os.environ.get("DSH_INSTALL"):
        path = Path(os.environ["DSH_INSTALL"])
        if path.is_dir():
            return path
        raise fail(f"DSH_INSTALL={path} is not a directory")
    npm_root = subprocess.run(
        ["npm", "root", "-g"], capture_output=True, text=True, check=True
    ).stdout.strip()
    path = Path(npm_root) / "@deepseek-ai/dsh/node_modules/@deepseek-ai"
    if not path.is_dir():
        raise fail(f"dsh install not found at {path}; set DSH_INSTALL")
    return path


def resolve_type_roots() -> Path | None:
    candidate = Path("/tmp/dsh-externals/manual/types-node")
    return candidate if candidate.is_dir() else None


def run(command: list[str], **kwargs) -> None:
    print(f"+ {' '.join(str(c) for c in command)}")
    subprocess.run([str(c) for c in command], check=True, **kwargs)


def build_package(tsc: Path, source_entry: Path, out_dir: Path, type_roots: Path | None) -> None:
    args = [
        tsc,
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
    if type_roots is not None:
        args += ["--types", "node", "--typeRoots", type_roots]
    # tsc emits despite type-resolution noise (missing @types); the emitted JS
    # is what matters here, so a nonzero exit is only fatal when lib/ is empty.
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True)
    if not (out_dir / "index.js").exists():
        print(result.stdout)
        print(result.stderr, file=sys.stderr)
        raise fail(f"failed to build {source_entry}")


def copy_python_packages(plugin_dir: Path, src_dirs: list[str]) -> None:
    roots = [REPO_ROOT / "python/sdk-dsl/src", *[Path(d) for d in src_dirs]]
    for src_root in roots:
        if not src_root.is_dir():
            raise fail(f"python src dir not found: {src_root}")
        for child in sorted(src_root.iterdir()):
            if not child.is_dir() or child.name.startswith(".") or child.name == "__pycache__":
                continue
            if not (child / "__init__.py").exists():
                continue
            target = plugin_dir / child.name
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(child, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            print(f"  python package {child.name} -> {target}")


def assemble_plugin(
    args: argparse.Namespace,
    plugin_dir: Path,
    generated_dir: Path,
    dsh_install: Path,
    tsc: Path,
    type_roots: Path | None,
) -> Path:
    plugin_dir.mkdir(parents=True, exist_ok=True)
    modules_dir = plugin_dir / "node_modules/@deepseek-ai"
    modules_dir.mkdir(parents=True, exist_ok=True)

    # 1. Built packages the dsh install does not ship.
    for package_name, source_pkg in BUNDLED_PACKAGES.items():
        short = package_name.split("/")[-1]
        target = modules_dir / short
        target.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_pkg / "package.json", target / "package.json")
        build_package(tsc, source_pkg / "src/index.ts", target / "lib", type_roots)
        print(f"  built {package_name}")

    # 2. The generated plugin package itself.
    short_name = args.name.split("/")[-1]
    plugin_pkg = plugin_dir / short_name
    plugin_pkg.mkdir(parents=True, exist_ok=True)
    shutil.copy2(generated_dir / "package.json", plugin_pkg / "package.json")
    build_package(tsc, generated_dir / "src/index.ts", plugin_pkg / "lib", type_roots)
    print(f"  built {args.name}")

    # 3. Runtime dependency links into the dsh install.
    for name in RUNTIME_LINKS:
        source = dsh_install / name
        link = modules_dir / name
        if not source.is_dir():
            continue
        if link.is_symlink() or link.exists():
            link.unlink() if link.is_symlink() else shutil.rmtree(link)
        link.symlink_to(source)
    print(f"  linked {len(RUNTIME_LINKS)} runtime deps from {dsh_install}")

    # 4. Python sources, self-contained at the plugin root.
    copy_python_packages(plugin_dir, args.python_src)
    return plugin_pkg


def patch_profile(args: argparse.Namespace, plugin_dir: Path, plugin_pkg: Path, entry_id: str) -> None:
    dsh_home = Path(os.environ.get("DSH_HOME", Path.home() / ".dsh"))
    patch_file = dsh_home / "profiles" / args.profile / "cordis.patch.yml"
    if not patch_file.exists():
        raise fail(f"profile patch file not found: {patch_file} (is the profile initialized?)")

    runtime_entry = REPO_ROOT and plugin_dir / "node_modules/@deepseek-ai/dsh-python-bridge-runtime/lib/index.js"
    plugin_entry = plugin_pkg / "lib/index.js"
    extra_config = json.loads(args.config_json)
    config = {
        "pythonBin": args.python_bin,
        "module": args.module,
        "cwd": str(plugin_dir),
        **extra_config,
    }
    # Plain file:// concatenation keeps '@' readable (as_uri percent-encodes it).
    new_entries = [
        {"id": "python-bridge", "name": f"file://{runtime_entry}"},
        {"id": entry_id, "name": f"file://{plugin_entry}", "config": config},
    ]

    patches = yaml.safe_load(patch_file.read_text()) or []
    if not isinstance(patches, list):
        raise fail(f"{patch_file} is not a YAML array")

    # Idempotent install: drop prior insert-lists containing our ids, then append.
    ours = {entry["id"] for entry in new_entries}
    kept = []
    for patch in patches:
        if not isinstance(patch, dict) or "insert" not in patch:
            kept.append(patch)
            continue
        remaining = [e for e in patch.get("insert") or [] if not (isinstance(e, dict) and e.get("id") in ours)]
        if remaining or "insert" not in patch:
            kept.append(patch)
    kept.append({"insert": new_entries})

    patch_file.write_text(PATCH_HEADER + yaml.dump(kept, allow_unicode=True, sort_keys=False))
    print(f"  patched {patch_file} (entries: python-bridge, {entry_id})")


def main() -> int:
    args = parse_args()
    source = Path(args.source)
    if not source.exists():
        raise fail(f"source not found: {source}")

    tsc = resolve_tsc()
    dsh_home = Path(os.environ.get("DSH_HOME", Path.home() / ".dsh"))
    short_name = args.name.split("/")[-1]
    plugin_dir = Path(args.plugin_dir) if args.plugin_dir else dsh_home / "plugins" / short_name
    entry_id = args.id or short_name.removesuffix("-bridge")

    print(f"[1/4] codegen {source} -> {args.name}")
    generated_dir = plugin_dir / ".build/generated"
    if generated_dir.exists():
        shutil.rmtree(generated_dir)
    generated_dir.mkdir(parents=True)
    run([
        "node",
        "--experimental-transform-types",
        "--no-warnings",
        REPO_ROOT / "scripts/run-codegen.mjs",
        source,
        "--out",
        generated_dir,
        "--name",
        args.name,
        "--module",
        args.module,
    ])

    print(f"[2/4] assemble plugin dir {plugin_dir}")
    plugin_pkg = assemble_plugin(args, plugin_dir, generated_dir, resolve_dsh_install(), tsc, resolve_type_roots())

    print("[3/4] python smoke check (module imports inside the plugin dir)")
    smoke = subprocess.run(
        [args.python_bin, "-c", f"import {args.module}"],
        cwd=plugin_dir,
        capture_output=True,
        text=True,
    )
    if smoke.returncode != 0:
        print(smoke.stderr, file=sys.stderr)
        raise fail(f"python module {args.module} does not import inside {plugin_dir}")
    print("  module imports cleanly")

    if args.no_patch:
        print("[4/4] patch skipped (--no-patch)")
    else:
        print(f"[4/4] patch profile '{args.profile}'")
        patch_profile(args, plugin_dir, plugin_pkg, entry_id)

    print()
    print(f"installed: {args.name} (entry id '{entry_id}')")
    print(f"  plugin dir: {plugin_dir}")
    if not args.no_patch:
        print(f"  profile:    {dsh_home}/profiles/{args.profile}/cordis.patch.yml")
        print("  the patch-layer watcher hot-applies new entries; when replacing an")
        print("  already-loaded plugin, restart `dsh web` to pick up rebuilt artifacts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
