# tools/sarif_batch.py
import argparse, json, os, sys
from pathlib import Path

# --- Ensure repo root is on sys.path so 'workers', 'core', 'cli' import ---
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from workers.py.runner import analyze_file  # now resolvable after sys.path tweak
from core.sarif import to_sarif

SKIP_DIRS = {
    '.git', '.venv', 'venv', '__pycache__', 'node_modules',
    'dist', 'build', 'site-packages', 'vscode-extension',
    # exclude EdgeCheck engine code from scans
    'cli', 'core', 'workers', 'tests', 'tools'
}

def iter_python_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for f in filenames:
            if f.endswith('.py'):
                yield Path(dirpath) / f

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--budget-ms', type=int, default=200)
    ap.add_argument('--max-trials', type=int, default=24)
    ap.add_argument('--max-findings', type=int, default=50)
    args = ap.parse_args()

    root = ROOT
    targets = list(iter_python_files(root))
    print(f"[edgecheck] scanning {len(targets)} Python files from {root}")

    all_findings = []
    for p in targets:
        try:
            findings = analyze_file(str(p), args.budget_ms, args.max_trials, args.max_findings)
            if findings:
                all_findings.extend(findings)
        except Exception as e:
            sys.stderr.write(f"[edgecheck] error on {p}: {e}\n")

    sarif = to_sarif(all_findings)
    out_path = Path(args.out)
    out_path.write_text(json.dumps(sarif, indent=2))
    print(f"[edgecheck] wrote SARIF: {out_path.resolve()}")

if __name__ == '__main__':
    main()
