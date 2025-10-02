# cli/main.py
from __future__ import annotations
import argparse
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Any, Iterable

# --- Ensure repo root is importable (so workers/core imports resolve) ---
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Project imports
from workers.py.runner import analyze_file
try:
    from core.sarif import to_sarif  # optional: for --sarif-out
    HAS_SARIF = True
except Exception:
    HAS_SARIF = False

# Directories to skip when scanning folders
SKIP_DIRS = {
    ".git", ".venv", "venv", "__pycache__", "node_modules",
    "dist", "build", "site-packages", "vscode-extension",
    # exclude EdgeCheck engine code
    "cli", "core", "workers", "tests", "tools"
}

def iter_python_files(root: Path) -> Iterable[Path]:
    """Yield all .py files under root, skipping SKIP_DIRS."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for f in filenames:
            if f.endswith(".py"):
                yield Path(dirpath) / f

def analyze_many(
    files: Iterable[Path],
    budget_ms: int,
    max_trials: int,
    max_findings: int
) -> List[Dict[str, Any]]:
    """Run analyzer over many files and concatenate findings."""
    all_findings: List[Dict[str, Any]] = []
    for p in files:
        try:
            fnds = analyze_file(str(p), budget_ms, max_trials, max_findings) or []
            all_findings.extend(fnds)
        except Exception as e:
            sys.stderr.write(f"[edgecheck] error analyzing {p}: {e}\n")
    return all_findings

def print_human(findings: List[Dict[str, Any]]) -> None:
    """Pretty, human-readable summary."""
    if not findings:
        print("✅ No findings.")
        return

    # per-file grouping
    by_file: Dict[str, List[Dict[str, Any]]] = {}
    for f in findings:
        by_file.setdefault(f.get("file", "<unknown>"), []).append(f)

    total = len(findings)
    print(f"⚠️  Findings: {total}")
    for file, items in sorted(by_file.items()):
        print(f"{file}")
        for it in items:
            line = it.get("line", 1)
            code = it.get("code", "EC")
            title = it.get("title", "EdgeCheck")
            severity = (it.get("severity") or "").upper()
            msg = it.get("message", "")
            print(f"  - [{code}] {title} ({severity}) @ {line}: {msg}")
    print()

def build_argparser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="edgecheck",
        description="EdgeCheck — auto-generated edge case simulator / bug finder for Python."
    )
    ap.add_argument(
        "path",
        help="Path to a Python file OR a directory to scan."
    )
    ap.add_argument("--budget-ms", type=int, default=200,
                    help="Analysis budget per function (milliseconds).")
    ap.add_argument("--max-trials", type=int, default=24,
                    help="Max input trials per function.")
    ap.add_argument("--max-findings", type=int, default=50,
                    help="Max findings reported per file.")
    ap.add_argument("--format", choices=["human", "json"], default="human",
                    help="Output format.")
    ap.add_argument("--sarif-out", default=None,
                    help="Optional: write SARIF to this file (requires core.sarif).")
    return ap

# -------- JSON sanitization so bytes/sets/tuples/etc. don't crash dumps --------
def _jsonable(x: Any) -> Any:
    """Convert non-JSON-serializable objects into safe representations."""
    if x is None or isinstance(x, (bool, int, float, str)):
        return x
    if isinstance(x, bytes):
        # show a short safe string like "b''" or b'\x00...'
        try:
            s = x.decode('utf-8', errors='replace')
            return f"b'{s}'"
        except Exception:
            return f"b<{len(x)} bytes>"
    if isinstance(x, (list, tuple, set)):
        return [_jsonable(i) for i in x]
    if isinstance(x, dict):
        return {str(k): _jsonable(v) for k, v in x.items()}
    # Exceptions, Path, etc.
    if isinstance(x, Exception):
        return f"{x.__class__.__name__}: {x}"
    if isinstance(x, Path):
        return str(x)
    # Fallback: stringified
    return str(x)

def _json_dump(obj: Any) -> str:
    return json.dumps(_jsonable(obj), indent=2)

# -----------------------------------------------------------------------------

def main() -> None:
    ap = build_argparser()
    args = ap.parse_args()

    target = Path(args.path)
    if not target.exists():
        ap.error(f"Path not found: {target}")

    # Determine the set of files to analyze
    if target.is_dir():
        files = list(iter_python_files(target))
        if not files:
            print("✅ No Python files found to analyze.")
            if args.format == "json":
                print(_json_dump({"version": "0.1.0", "findings": []}))
            return
        print(f"[edgecheck] scanning {len(files)} Python files under {target}")
        findings = analyze_many(files, args.budget_ms, args.max_trials, args.max_findings)
    else:
        if target.suffix != ".py":
            ap.error(f"Expected a .py file or a directory, got: {target}")
        findings = analyze_many([target], args.budget_ms, args.max_trials, args.max_findings)

    # SARIF (optional)
    if args.sarif_out:
        if not HAS_SARIF:
            sys.stderr.write("[edgecheck] SARIF not available (core.sarif missing).\n")
        else:
            sarif = to_sarif(findings)
            Path(args.sarif_out).write_text(_json_dump(sarif))
            print(f"[edgecheck] wrote SARIF: {Path(args.sarif_out).resolve()}")

    # Output
    if args.format == "json":
        print(_json_dump({"version": "0.1.0", "findings": findings}))
    else:
        print_human(findings)

if __name__ == "__main__":
    main()
