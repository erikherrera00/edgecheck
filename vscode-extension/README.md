# EdgeCheck

[![EdgeCheck CI](https://github.com/erikherrera00/edgecheck/actions/workflows/ci.yml/badge.svg)](https://github.com/erikherrera00/edgecheck/actions/workflows/ci.yml)

Auto-generated edge case simulator and bug finder for Python. Detects crashes, edge cases, and unsafe inputs before production.


EdgeCheck runs your functions under randomized and structured inputs to uncover hidden crashes, unsafe edge cases, and missed guards. It integrates directly into VS Code so you see squiggles, quick fixes, and hover details without leaving the editor.

---

## ✨ Features

- 🔍 **Detect runtime edge cases** (division by zero, out-of-range indexing, bad inputs).
- 🟢 **Inline diagnostics** in the editor (red/yellow squiggles).
- 💡 **Quick fixes** (auto-insert guards for zero denominators, buffer checks, etc.).
- 🖱️ **Status bar menu** for one-click scan of file/workspace.
- 📊 **Workspace scanning** with include/exclude globs.
- 📝 **SARIF output** for CI/CD integration and GitHub code scanning.
- ⚙️ **Configurable** analysis budget, trials, and max findings.
- 📖 **Hover docs** show error type, hint, params, repro inputs.

---

## 🚀 Usage

1. **Install** the extension (`edgecheck-*.vsix`) in VS Code.
2. Open a Python project.
3. Watch squiggles appear as you type or save.
4. Click the **EdgeCheck ▶︎ Menu** in the status bar for options:
   - Scan current file
   - Scan workspace
   - Toggle info diagnostics
   - Open last SARIF

---

## ⚙️ Settings

| Setting                        | Default | Description                                           |
|--------------------------------|---------|-------------------------------------------------------|
| `edgecheck.pythonPath`          | `""`    | Path to Python interpreter (falls back to `python3`). |
| `edgecheck.budgetMs`            | `200`   | Analysis budget per function (ms).                    |
| `edgecheck.showInfo`            | `false` | Show informational findings (guards).                 |
| `edgecheck.maxTrialsPerFunction`| `24`    | Max input trials per function.                        |
| `edgecheck.maxFindingsPerFile`  | `50`    | Max findings reported per file.                       |
| `edgecheck.scanInclude`         | `["**/src/**/*.py", "**/examples/**/*.py", "target_*.py"]` | Glob patterns to include. |
| `edgecheck.scanExclude`         | *(venv/tests/etc)* | Glob patterns to exclude. |

---

## 🧪 Example

```python
def divide(a: int, b: int):
    return a / b  # 🚨 EdgeCheck: Possible division by zero

def bad_bytes(b: bytes):
    return b[100]  # 🚨 EdgeCheck: Index may be out of range
