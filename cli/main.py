# edgecheck: ignore-file
# cli/main.py
import argparse, sys
from core.diagnostics import pretty, as_json
from core.sarif import to_sarif
from workers.py.runner import analyze_file

def write_tests(findings, out_path="tests/test_edgecheck_generated.py"):
    if not findings:
        return None
    lines = [
        "import pytest",
        "",
    ]
    for f in findings:
        fn = f["function"]
        args = f["repro"]["args"]
        # turn bytes reprs into literal-safe forms
        args_src = []
        for a in args:
            if isinstance(a, bytes):
                args_src.append(repr(a))
            else:
                args_src.append(repr(a))
        lines += [
            f"def test_{fn}_repro():",
            f"    # Repro for: {f['kind']} - {f['message']}",
            f"    from {__name__} import __file__  # noqa: F401",
            f"    import importlib.util, os",
            f"    spec = importlib.util.spec_from_file_location('edgecheck_target', r\"{f['file']}\")",
            f"    mod = importlib.util.module_from_spec(spec)",
            f"    spec.loader.exec_module(mod)  # type: ignore",
            f"    with pytest.raises(Exception):",
            f"        getattr(mod, '{fn}')({', '.join(args_src)})",
            "",
        ]
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    return out_path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--format", choices=["pretty","json","sarif"], default="pretty")
    ap.add_argument("--budget-ms", type=int, default=200)
    ap.add_argument("--max-trials", type=int, default=24)
    ap.add_argument("--max-findings", type=int, default=50)
    ap.add_argument("--out", type=str, default="")
    args = ap.parse_args()

    findings = analyze_file(args.path, args.budget_ms, args.max_trials, args.max_findings)

    if args.format == "pretty":
        pretty(findings)
        return

    if args.format == "json":
        as_json(findings)
        return

    if args.format == "sarif":
        sarif = to_sarif(findings)
        if args.out:
            with open(args.out, "w", encoding="utf-8") as f:
                f.write(sarif)
        else:
            print(sarif)
        return

if __name__ == "__main__":
    main()
