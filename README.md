# TeXWASM

A VS Code extension that compiles LaTeX to PDF **without a local TeX distribution**. Powered by [TeXlyre-BusyTeX](https://github.com/TeXlyre/texlyre-busytex-build) — the BusyTeX WASM build of pdfTeX, XeTeX, LuaTeX, and bibtex8 compiled to WebAssembly via Emscripten.

## Requirements

- VS Code 1.96+
- Internet connection on first use (~100–500MB download for engine assets from [TeXlyre-BusyTeX Mirror](https://github.com/texwasm/texlyre-busytex-mirror))

## Features

- **Getting-started walkthrough** — an interactive checklist (auto-shown on first use, or via `TeXWASM: Open Getting Started Walkthrough`) that creates a `hello.tex` starter file and guides you through your first compile, viewing the PDF, reading the log, and configuring the extension
- **Compile LaTeX to PDF** — `Ctrl+Alt+B` (or `Cmd+Alt+B` on macOS); the PDF opens in VS Code's built-in viewer
- **View PDF** — reopen the compiled PDF for the current document at any time (`TeXWASM: View PDF`)
- **No TeX distribution needed** — pdflatex runs as WebAssembly
- **Multi-engine support** — pdfLaTeX, XeLaTeX, LuaLaTeX
- **Customizable recipes** — define tool sequences like `pdflatex → bibtex → pdflatex × 2` (LaTeX Workshop compatible)
- **Auto-compile on save** — compiles automatically when you save a `.tex` file
- **Diagnostics** — errors and warnings from the `.log` appear as VS Code diagnostics
- **Bibliography support** — automatic bibtex8 or biber runs when citations are detected (select via `texwasm.biblioBackend`)
- **Status bar integration** — shows compilation state at a glance
- **Output channel** — full log accessible via "TeXWASM: View Log"
- **On-demand package download** — missing CTAN packages (`\usepackage`) are auto-fetched and cached
- **System font resolution** — `fontspec` family names like `\setmainfont{Arial}` work out of the box using the fonts installed on your OS (`C:\Windows\Fonts`, `/usr/share/fonts`, etc.) — no manual alias file needed
- **Root document detection** — auto-detects the root `.tex` file via `% !TEX root`, `\documentclass`, or explicit setting
- **Forward search** — `Ctrl+Alt+J` to jump from `.tex` source to PDF page
- **Word count** — count words in the active `.tex` file or across the whole workspace, with separate counts for text, section headers, captions, and footnotes, plus counts of headers, tables, figures, and inline math
- **Formatting** — Format Document (Shift+Alt+F) indents the contents of each `\begin{...}/\end{...}` environment one level relative to its parent. Verbatim-style environments (`verbatim`, `lstlisting`, `minted`, …) keep their bodies byte-for-byte, and the indent width follows your editor's tab settings unless overridden with `texwasm.formatting.indentWidth`

## Commands

| Command | Keybinding | Description |
|---------|-----------|-------------|
| `TeXWASM: Compile LaTeX to PDF` | `Ctrl+Alt+B` | Compile the active `.tex` file |
| `TeXWASM: Compile with...` | — | Choose a recipe (custom tool sequence) |
| `TeXWASM: View Log` | — | Open the compilation log |
| `TeXWASM: View PDF` | — | Open the compiled PDF for the current LaTeX document |
| `TeXWASM: Clean Auxiliary Files` | — | Remove `.aux`, `.log`, `.out`, etc. |
| `TeXWASM: Stop Compilation` | — | Cancel a running compilation |
| `TeXWASM: Download/Update Engine` | — | Force re-download of WASM assets |
| `TeXWASM: Forward Search (SyncTeX)` | `Ctrl+Alt+J` | Jump from `.tex` source to PDF page |
| `TeXWASM: Clear CTAN Package Cache` | — | Remove all cached CTAN packages |
| `TeXWASM: List Cached Packages` | — | Show cached CTAN packages in output |
| `TeXWASM: Rebuild System Font Index` | — | Re-scan system font directories and refresh the cache |
| `TeXWASM: Word Count (Current File)` | — | Count words and structures in the active `.tex` file |
| `TeXWASM: Word Count (Workspace)` | — | Count words across all `.tex` files in the workspace |
| `TeXWASM: Open Getting Started Walkthrough` | — | Re-open the interactive getting-started walkthrough |
| `TeXWASM: Create Hello World .tex File` | — | Create a starter `hello.tex` in the workspace and open it |

## Settings

| Key | Default | Description |
|-----|---------|-------------|
| `texwasm.engine` | `pdflatex` | Default engine (`pdflatex`, `xelatex`, or `lualatex`) |
| `texwasm.autoCompile` | `true` | Compile on save |
| `texwasm.bibtexEnabled` | `true` | Run the bibliography processor automatically when citations are detected |
| `texwasm.biblioBackend` | `"bibtex8"` | Bibliography processor backend (`"bibtex8"` or `"biber"`) |
| `texwasm.compilationPasses` | `3` | Max pdflatex passes (1–5) |
| `texwasm.outputDirectory` | `""` | Output directory for PDF (relative to `.tex`) |
| `texwasm.autoDownloadPackages` | `true` | Auto-download missing packages from CTAN |
| `texwasm.includeExtraBundle` | `false` | Download the ~331 MB extra bundle (TikZ, hyperref, amsmath, etc.) |
| `texwasm.rootDocument` | `""` | Root `.tex` path (relative to workspace). Auto-detected when empty. |
| `texwasm.fontNameLookup` | `true` | Rewrite `\setmainfont{Family}` to filename references via the system font index |
| `texwasm.systemFontDirectories` | `[]` | Additional font directories to scan (in addition to OS defaults) |
| `texwasm.formatting.indentWidth` | `null` | Indent width (in spaces) used by Format Document. When `null`, the editor's "Tab Size" and "Insert Spaces" settings are used. |
| `texwasm.tools` | *(see below)* | Tool definitions (command + args) referenced by recipes |
| `texwasm.recipes` | *(see below)* | Recipe definitions (ordered tool sequences) for building |
| `texwasm.recipe.default` | `"first"` | Which recipe to use by default (`"first"`, `"lastUsed"`, or a recipe name) |
| `texwasm.recipe.lastUsed` | `""` | Last recipe selected via "Compile with..." (set automatically) |

## Magic Comments

Per-file overrides can be set with magic comments at the top of your `.tex` file. They take precedence over the corresponding settings.

| Comment | Effect |
|---------|--------|
| `% !TEX program = xelatex` | Override the engine. Accepts `pdflatex`, `xelatex`, `lualatex` (plus the aliases `pdftex`, `xetex`, `luatex`). |
| `% !TEX root = main.tex` | Use `main.tex` as the root document (relative to the current file). Overrides root detection for the whole project. |
| `% !LW recipe = recipe-name` | Build with the recipe named `recipe-name` (from `texwasm.recipes`). |
| `% !TEX options = ...` | Parsed for compatibility, but engine options (e.g. `-shell-escape`) are **not** supported in the WASM engine. |

Note: only one `% !TEX program` value is honored, and the magic-comment engine wins over both the `texwasm.engine` setting and auto-detection.

## Recipes

Recipes define ordered sequences of tools to run when building. Inspired by LaTeX Workshop's recipe system, this gives you fine-grained control over the build process.

**Default tools:**

```json
[
  { "name": "pdflatex", "command": "pdflatex", "args": ["-synctex=1", "-interaction=nonstopmode", "-file-line-error", "%DOC%"] },
  { "name": "xelatex",  "command": "xelatex",  "args": ["-synctex=1", "-interaction=nonstopmode", "-file-line-error", "%DOC%"] },
  { "name": "lualatex", "command": "lualatex", "args": ["-synctex=1", "-interaction=nonstopmode", "-file-line-error", "%DOC%"] },
  { "name": "bibtex",   "command": "bibtex",   "args": ["%DOCFILE%"] },
  { "name": "biber",    "command": "biber",    "args": ["%DOCFILE%"] },
  { "name": "makeindex", "command": "makeindex", "args": ["%DOCFILE%"] }
]
```

**Default recipes:**

```json
[
  { "name": "pdflatex • bibtex • makeindex • pdflatex × 2", "tools": ["pdflatex", "bibtex", "makeindex", "pdflatex", "pdflatex"] },
  { "name": "pdflatex × 2",                                 "tools": ["pdflatex", "pdflatex"] },
  { "name": "xelatex • bibtex • makeindex • xelatex × 2",   "tools": ["xelatex", "bibtex", "makeindex", "xelatex", "xelatex"] },
  { "name": "lualatex • bibtex • makeindex • lualatex × 2", "tools": ["lualatex", "bibtex", "makeindex", "lualatex", "lualatex"] }
]
```

Each tool's `command` maps to a WASM operation:
- **pdflatex / xelatex / lualatex** — single engine pass (counted toward `compilationPasses`)
- **bibtex / bibtex8** — bibliography processing
- **biber** — biber bibliography processing
- **makeindex** — index processing (runs `makeindex` on the `.idx` after the first pass if the document produces one)

### Recipe selection

1. **Explicit** — chosen via `TeXWASM: Compile with...`
2. **Magic comment** — `% !LW recipe = recipe-name` in the root file
3. **`texwasm.recipe.default`** — `"first"` (default), `"lastUsed"`, or a specific recipe name
4. **`texwasm.recipe.lastUsed`** — auto-tracked when using `Compile with...`


## Using with LaTeX Workshop

Many users also install [LaTeX Workshop](https://marketplace.visualstudio.com/items?itemName=James-Yu.latex-workshop), which provides editing, preview, and SyncTeX UI features. **This extension is a great companion for TeXWASM** for those conveniences.

However, LaTeX Workshop assumes a **local TeX distribution** and its default auto-build will error out on save when none is installed. To avoid those errors, disable its automatic build in your VS Code settings (see the [LaTeX Workshop compile wiki](https://github.com/James-Yu/latex-workshop/wiki/Compile#auto-build-latex)):

```json
{
  "latex-workshop.latex.autoBuild.run": "never"
}
```

With auto-build disabled, LaTeX Workshop won't attempt to compile, and **TeXWASM handles all compilation** (`Ctrl+Alt+B` or on save) via its own WASM engine — so you get LaTeX Workshop's editing/preview features without needing a TeX distribution.


## Limitations

- **No shell-escape** — `minted`, `gnuplot`, and similar packages are not supported
- **Biber** — biber runs as the full Perl biber compiled to WASM (from TeXlyre's busytex build), giving complete biblatex support
- **Fontspec** — BusyTeX's WASM engine has no `fontconfig`, so family names must be resolved to filenames. TeXWASM does this automatically by reading the font name tables of every `.ttf`/`.otf` installed on your OS (`C:\Windows\Fonts`, `/usr/share/fonts`, `/Library/Fonts`, etc.) and rewriting `\setmainfont{Arial}` to `\setmainfont[Path=...,Extension=.ttf]{arial}` before sending the source to the engine. The referenced font is then mounted from disk into the WASM virtual filesystem. The first compile after installation performs a one-time scan (~5–15 s) and caches the index in extension storage; subsequent compiles are instant. If a family name cannot be found, it is left untouched and `fontspec` will report a missing-file error in the log. Add extra search paths via `texwasm.systemFontDirectories` or run `TeXWASM: Rebuild System Font Index` after installing new fonts.
- **TrueType Collections (.ttc)** — `fontspec` cannot address a single face inside a `.ttc` using `Path=`/`Extension=`, so multi-face collections are skipped during indexing. Use a standalone `.ttf`/`.otf` instead.
- **Asset size** — first download is 100–500MB; subsequent compiles use a local cache

## License

AGPL-3.0 — see [LICENSE](LICENSE). License inherited from [TeXlyre-BusyTeX](https://github.com/TeXlyre/texlyre-busytex-build).
