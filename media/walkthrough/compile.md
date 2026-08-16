The first time you compile, TeXWASM downloads the WebAssembly engine (~100-500 MB) and caches it locally. Later compiles are instant.

The status bar shows the current state at a glance:

- **TeXWASM** - idle, click to compile
- **TeXWASM [compiling...]** - a build is running
- **TeXWASM** (highlighted) - compilation succeeded
- **TeXWASM** (red) - compilation failed

By default, files also compile automatically each time you save (`texwasm.autoCompile`), and the resulting PDF opens beside your source. Use `Ctrl+Alt+B` (`Cmd+Alt+B` on macOS) to compile manually.
