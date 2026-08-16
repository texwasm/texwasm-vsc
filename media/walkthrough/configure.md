Everything is configurable from the settings UI. The most useful options:

| Setting | Default | Effect |
| --- | --- | --- |
| `texwasm.engine` | `pdflatex` | Default engine (`pdflatex`, `xelatex`, `lualatex`) |
| `texwasm.autoCompile` | `true` | Compile on save |
| `texwasm.compilationPasses` | `3` | Maximum pdflatex passes |
| `texwasm.includeExtraBundle` | `false` | Preload the texlive-extra bundle (~331 MB) |
| `texwasm.recipes` | _see settings_ | Custom tool sequences, e.g. `pdflatex -> bibtex -> pdflatex x 2` |

Per-file overrides are supported with magic comments at the top of a `.tex` file, e.g. `% !TEX program = xelatex` or `% !TEX root = main.tex`. They take precedence over the corresponding settings.
