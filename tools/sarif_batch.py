# tools/sarif_batch.py
import argparse
import fnmatch
import sys
from pathlib import Path

# --- Ensure the repo root is importable when running from tools/ ---
ROOT = Path(__file__).resolve().parents[1]  # .../edgecheck
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from workers.py.runner import analyze_file  # noqa: E402
from core.sarif import to_sarif  # noqa: E402

DEFAULT_INCLUDES = ["**/src/**/*.py", "**/examples/**/*.py", "target_*.py"]
DEFAULT_EXCLUDES = [
    "**/.venv/**", "**/venv/**", "**/site-packages/**", "**/node_modules/**",
    "**/dist/**", "**/build/**", "**/__pycache__/**", "**/.git/**",
    "**/cli/**", "**/core/**", "**/workers/**", "**/tests/**", "**/tools/**"
]

def find_python_files(root: Path, includes, excludes):
    matched = set()
    for pat in includes:
        for p in root.rglob("*.py"):
            rel = str(p.relative_to(root))
            if fnmatch.fnmatch(rel, pat):
                matched.add(p)
    out = []
    for p in matched:
        rel = str(p.relative_to(root))
        if any(fnmatch.fnmatch(rel, ex) for ex in excludes):
            continue
        out.append(p)
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".", help="Repo root to scan")
    ap.add_argument("--out", default="edgecheck.sarif", help="SARIF output path")
    ap.add_argument("--budget-ms", type=int, default=200)
    ap.add_argument("--max-trials", type=int, default=24)
    ap.add_argument("--max-findings", type=int, default=50)
    ap.add_argument("--include", nargs="*", default=DEFAULT_INCLUDES)
    ap.add_argument("--exclude", nargs="*", default=DEFAULT_EXCLUDES)
    args = ap.parse_args()

    root = Path(args.root).resolve()

    all_findings = []
    for pyfile in find_python_files(root, args.include, args.exclude):
        try:
            head = (pyfile.read_text(encoding="utf-8").splitlines()[:5])
            if any(line.strip().lower() == "# edgecheck: ignore-file" for line in head):
                continue
        except Exception:
            pass
        try:
            fnds = analyze_file(
                str(pyfile),
                budget_ms=args.budget_ms,
                max_trials_per_fn=args.max_trials,
                max_findings_per_file=args.max_findings
            )
            if fnds:
                all_findings.extend(fnds)
        except Exception as e:
            print(f"[edgecheck] error analyzing {pyfile}: {e}")

    sarif = to_sarif(all_findings)
    out_path = Path(args.out).resolve()
    out_path.write_text(sarif, encoding="utf-8")
    print(f"[edgecheck] wrote SARIF: {out_path}")

if __name__ == "__main__":
    main()

