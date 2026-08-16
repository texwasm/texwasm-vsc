TeXWASM compiles `.tex` sources to PDF entirely in your browser using WebAssembly. No local TeX distribution is installed.

Use the **Create Hello World** button above to generate a starter file, or open an existing `.tex` file from your project. A minimal document looks like this:

```latex
\documentclass{article}
\begin{document}
Hello, world!
\end{document}
```

The extension activates as soon as a LaTeX file is open and shows its status in the status bar. For multi-file projects it automatically detects the root document via `% !TEX root = main.tex` or the `\documentclass`, so you can compile from any included file.
