# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-08-14

### Added

- Font name references now resolve when the font name is stored in a LaTeX variable (e.g. `\def \fontType {Arial}` followed by `\setmainfont{\fontType}`). Macro definitions are collected from the root document and every included file, so the definition may live in a different file than the `\setmainfont`/`\newfontfamily` call.

### Changed

- Engine asset downloads now use the [TeXWASM BusyTeX Mirror](https://github.com/texwasm/texlyre-busytex-mirror) release feed instead of the upstream TeXlyre build releases.

### Fixed

- Docstrip generation for CTAN packages whose embedded install driver maps guards to multiple files (e.g. `pdflscape`, which ships both `pdflscape.sty` and `pdflscape-nometadata.sty`). Previously all guards were merged into a single `.sty`, so `\RequirePackage{pdflscape-nometadata}` failed and compilation aborted.
- CTAN packages that ship no prebuilt main `.sty` (only `.dtx`/`.ins` sources) no longer skip docstrip when the bundle contains an unrelated `.sty` (e.g. `eso-pic`, which ships `showframe.sty`). Previously the main `.sty` was never generated and the unrelated file was aliased as the package's, so `\usepackage{eso-pic}` resolved to a file providing `showframe`, leaving `\AddToShipoutPictureFG` undefined and breaking the first page of documents compiled with `texwasm.includeExtraBundle: false`. The `{packageName}.sty` alias now only points at a `.sty` whose name is related to the package (e.g. `tabulary-v010.sty` → `tabulary.sty`).

## [0.2.0] - 2026-08-12

### Added

- Prompt to enable `texwasm.includeExtraBundle` when a CTAN package download fails.
- Link to GitHub releases shown if the download of engine assets fails.
- `with-assets.vsix` GitHub release asset as a fallback in case the asset download fails.

## [0.1.0] - 2026-08-09

### Added

- Compile LaTeX to PDF via WebAssembly (TeXlyre-BusyTeX), no local TeX distribution required.
- Multi-engine support: pdfLaTeX, XeLaTeX, LuaLaTeX.
- Customizable recipes (`pdflatex → bibtex → makeindex → pdflatex × 2`, LaTeX Workshop compatible) with per-tool arguments and environment variables.
- "Compile with..." command with explicit, magic comment (`% !LW recipe`), and last-used recipe selection.
- Auto-compile on save (`texwasm.autoCompile`).
- Diagnostics: errors and warnings from the `.log` shown as VS Code diagnostics.
- Automatic bibliography processing (bibtex8 or biber) when citations are detected.
- On-demand CTAN package download with caching (`texwasm.autoDownloadPackages`) and optional texlive-extra bundle (`texwasm.includeExtraBundle`).
- System font resolution: `fontspec` family names rewritten to filenames via a cached index of OS fonts, plus configurable extra font directories.
- Root document detection via `% !TEX root`, `\documentclass`, explicit `texwasm.rootDocument` setting, or workspace scan.
- Magic comment support: `% !TEX program`, `% !TEX root`, `% !LW recipe`, `% !TEX options`.
- Forward search (SyncTeX) with `Ctrl+Alt+J`.
- Status bar integration and output channel ("TeXWASM: View Log").
- Commands: compile, compile with, view log, clean auxiliary files, stop compilation, download/update engine, forward search, clear/list CTAN package cache, rebuild system font index.
- Keybindings: `Ctrl+Alt+B` (compile) and `Ctrl+Alt+J` (forward search).

