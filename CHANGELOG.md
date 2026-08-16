# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Getting-started walkthrough: an interactive checklist (auto-shown on first activation or via `TeXWASM: Open Getting Started Walkthrough`) with steps to create a `hello.tex` starter file, run the first compile, view the compiled PDF, diagnose failures with the log, and configure engines/recipes.
- `TeXWASM: Create Hello World .tex File` command: creates a starter `hello.tex` in the workspace and opens it, wired into the walkthrough's first step.
- `TeXWASM: View PDF` command: opens the compiled PDF for the current LaTeX document (honors `texwasm.outputDirectory` and root-document detection), exposed as a "View the PDF" walkthrough step.

### Fixed

- The PDF now renders in VS Code's built-in PDF viewer. Previously it was opened with `showTextDocument`, which displays a binary/unsupported-encoding text tab instead of the rendered document; "TeXWASM: View PDF" and the PDF auto-opened after compilation now use `vscode.open` (through the editor resolver) so the resource opens as a real PDF.
- "Compile LaTeX to PDF" no longer fails with "No active editor" when triggered from the getting-started walkthrough (or anywhere the walkthrough page has focus instead of a text editor). Compilation now falls back to the active, visible, or any open LaTeX document.
- The compiled PDF no longer replaces the LaTeX source in split-window layouts. Previously `vscode.open` was called without a view column, so the PDF opened in the active editor group and took over the pane containing the `.tex` file. The PDF now reuses an already-open tab (in whatever editor group it lives) or opens beside the active editor, and focus is preserved so the source stays active after compilation.

## [0.4.0] - 2026-08-16

### Added

- Word count feature: count words in the active `.tex` file (`TeXWASM: Word Count (Current File)`) or across all `.tex` files in the workspace (`TeXWASM: Word Count (Workspace)`). Words are reported for text, section headers, captions and footnotes separately, along with counts of headers, tables, figures and inline math.
- LaTeX document formatting (Format Document / Shift+Alt+F): the contents of each `\begin{...}/\end{...}` environment are indented one level relative to their parent. Verbatim-style environments (`verbatim`, `lstlisting`, `minted`, …) keep their bodies unchanged, blank lines and CRLF line endings are preserved, and leading/trailing whitespace is trimmed. The indent width follows the editor's tab size / insert-spaces settings and can be overridden with `texwasm.formatting.indentWidth`.

### Changed

- Cached engine (busytex) and biber WASM assets are now refreshed automatically: when the release referenced in `src/cache/assetUrls.json` changes, the previously downloaded assets are deleted from global storage and the new version is downloaded.

### Fixed

- "Querying CTAN for..." progress messages were shown even when the CTAN API was not called because package info was already resolved in memory. The query message now only appears for real CTAN API calls; packages served from the cache no longer print a misleading message.

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

