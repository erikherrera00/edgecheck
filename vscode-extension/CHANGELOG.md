# Changelog

All notable changes to **EdgeCheck** will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- Workspace scan command
- Multi-language support (planned)

---

## [0.1.3] - 2025-09-23
### Added
- New setting: `edgecheck.showInfo` to toggle informational diagnostics (intentional guards).
- Default filtering hides info squiggles for clean editor experience.

### Changed
- Cleaned `activationEvents` (removed redundant `onCommand:edgecheck.runFile`).
- Version bump for VSIX packaging.

---

## [0.1.2] - 2025-09-22
### Added
- Diagnostic codes (EC001, EC002, EC101, EC102, EC090).
- Hover text includes repro + hints.
- Quick Fixes for ZeroDivisionError and IndexError.

---

## [0.1.1] - 2025-09-21
### Fixed
- Return bug in `analyze_file` that caused `"findings": null`.

---

## [0.1.0] - 2025-09-20
### Initial release
- CLI + VS Code extension MVP.
- Runs crash analysis on current file.
- Reports findings as squiggles.
