import argparse
from core.config import Config
from core.diagnostics import pretty, as_json
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
    ap = argparse.ArgumentParser(prog="edgecheck")
    ap.add_argument("path", help="Python file to analyze")
    ap.add_argument("--budget-ms", type=int, default=200)
    ap.add_argument("--format", choices=["pretty","json"], default="pretty")
    ap.add_argument("--write-tests", action="store_true", help="Write pytest file from current findings")
    args = ap.parse_args()

    cfg = Config(budget_ms=args.budget_ms, fmt=args.format)
    findings = analyze_file(args.path, cfg.budget_ms)

    if cfg.fmt == "json":
        as_json(findings)
    else:
        pretty(findings)

    if args.write_tests:
        out = write_tests(findings)
        if out:
            print(f"\n🧪 Wrote tests to {out}")
        else:
            print("\n🧪 No findings → no tests written.")

if __name__ == "__main__":
    main()

