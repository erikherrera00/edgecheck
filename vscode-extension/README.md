# EdgeCheck

EdgeCheck finds **edge cases and crash risks** in your Python code — *before* they reach production.

## Try it in 30 seconds
1. Command Palette → **EdgeCheck: Insert Sample Snippet**
2. Command Palette → **EdgeCheck: Scan Current File**
3. Hover squiggles → **Quick Fix**, or run **EdgeCheck: Fix All in Current File**

## Features
- Auto-generated inputs to trigger **ZeroDivisionError**, **IndexError**, and more
- **Inline Quick Fixes** that insert safe guards
- **Fix All** to apply guards across a file at once
- **Workspace Scan** that writes SARIF and populates Problems
- EDU preset for calm defaults in classrooms

## Settings
- `edgecheck.autoScanOnSave` (default: false)
- `edgecheck.hideTimeouts` (default: true)
- `edgecheck.coalesceOverlapping` (default: true)
- `edgecheck.quickFix.nearbyLines` (default: 2)
- `edgecheck.zeroGuardMessage` (default: "denominator cannot be zero")

## EDU
Free for students & classrooms. Contact for enterprise licensing.
