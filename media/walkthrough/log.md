When a build fails, errors and warnings from the `.log` file appear as inline diagnostics in the editor, and the full log is available in the TeXWASM output channel.

A few things to try:

- **Missing packages** are fetched automatically from CTAN (`texwasm.autoDownloadPackages`). If a download fails, enabling `texwasm.includeExtraBundle` preloads thousands of packages at once.
- **Fonts** - `\setmainfont{Arial}` is resolved automatically from your installed fonts. After installing new fonts, run `TeXWASM: Rebuild System Font Index`.
- **Biber** - if you use `biblatex`, prefer `backend=bibtex` for full compatibility.

Run `TeXWASM: Clean Auxiliary Files` to remove `.aux`, `.log` and other build artifacts.
