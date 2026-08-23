import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AssetManager, showAssetDownloadError } from "../cache/assetManager";
import type { PackageCache } from "../cache/packageCache";
import {
	getAutoDownloadPackages,
	getDefaultRecipe,
	getFontNameLookup,
	getIncludeExtraBundle,
	getLastUsedRecipe,
	getOutputDirectory,
	getRecipeTools,
	getRecipes,
	getSystemFontDirectories,
} from "../config/settings";
import {
	clearDiagnostics,
	updateDiagnostics,
} from "../diagnostics/latexDiagnostics";
import type { Compiler } from "../engine/compiler";
import { resolveProjectFiles } from "../engine/fileResolver";
import {
	buildFontIndex,
	extractMacroDefinitions,
	mergeFontIndices,
	resolveFontReferences,
} from "../engine/fontResolver";
import { parseMagicComments } from "../engine/magicComments";
import { recipeToCompileConfig, resolveSelectedRecipe } from "../engine/recipe";
import { resolveRootDocument } from "../engine/rootResolver";
import type { CompileOptions, ProjectFile, StatusState } from "../engine/types";
import { parseLog } from "../output/logParser";
import { appendLog, showOutputChannel } from "../output/outputChannel";
import { openPdf } from "../pdf/pdfViewer";
import { getFontIndexDir } from "../cache/storage";
import { getOrBuildSystemFontIndex } from "../utils/systemFonts";

/** Parse LaTeX log for missing file errors, returning missing file names. */
function parseMissingFileErrors(logContent: string): string[] {
	const files = new Set<string>();

	// Standard LaTeX: File 'foo.sty' not found  (case-sensitive uppercase "File"
	// — using /i would also match the benign biblatex Info line "file 'X' not found")
	let match: RegExpExecArray | null;
	const filePattern = /File\s+[`'"]([^`'"]+)[`'"]\s+not found/g;
	while ((match = filePattern.exec(logContent)) !== null) {
		// Skip "bbl"-style messages: those are produced on the first pass before
		// biber/bibtex8 runs — they are normal multi-pass workflow, not missing packages.
		if (/\.bbl$/i.test(match[1])) continue;
		files.add(match[1]);
	}

	// biblatex: Style 'numeric' not found (case-sensitive — Info variants are lowercase)
	const stylePattern = /Style\s+[`'"]([^`'"]+)[`'"]\s+not found/g;
	while ((match = stylePattern.exec(logContent)) !== null) {
		const name = match[1];
		files.add(`${name}.bbx`);
		files.add(`${name}.cbx`);
	}

	// biblatex: Language 'english' not found
	const langPattern = /Language\s+[`'"]([^`'"]+)[`'"]\s+not found/g;
	while ((match = langPattern.exec(logContent)) !== null) {
		const name = match[1];
		files.add(`${name}.ldf`);
		files.add(`${name}.def`);
	}

	return Array.from(files);
}

/**
 * Derive CTAN package name candidates from a missing file name.
 * For example, "english.ldf" → ["babel", "english"] because
 * language definition files come from babel, not from a package
 * named after the language.
 */
function getPackageCandidates(fileName: string): string[] {
	const ext = path.extname(fileName);
	const stem = fileName.slice(0, -ext.length);
	const candidates = [stem];

	// Language definition files (.ldf) come from babel
	if (ext === ".ldf") {
		candidates.unshift("babel");
	}
	// .bbx/.cbx files come from biblatex (already handled by package scanner,
	// but include as fallback)
	if (ext === ".bbx" || ext === ".cbx") {
		candidates.unshift("biblatex");
	}

	return candidates;
}

/**
 * Detect the engine a document requires from its content.
 * Returns "lualatex" when Lua-only constructs are used, "xelatex" when
 * fontspec/polyglossia-style packages are used (works on xelatex or lualatex),
 * or undefined when any engine works.
 */
function detectRequiredEngine(
	sourceContent: string,
	projectFiles: ProjectFile[],
): "lualatex" | "xelatex" | undefined {
	const texts = [sourceContent];
	for (const pf of projectFiles) {
		if (typeof pf.content === "string") {
			texts.push(pf.content);
		}
	}
	// Strip comments so commented-out \usepackage lines don't trigger detection
	const combined = texts.join("\n").replace(/(?<!\\)%.*/gm, "");

	if (
		/\\(?:directlua|luaexec)\b/.test(combined) ||
		/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{luacode\}/.test(combined)
	) {
		return "lualatex";
	}
	if (
		/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{(?:fontspec|polyglossia|unicode-math)\}/.test(
			combined,
		) ||
		/\\(?:setmainfont|setsansfont|setmonofont|newfontfamily|setdefaultlanguage)\b/.test(
			combined,
		)
	) {
		return "xelatex";
	}
	return undefined;
}

/** Detect bibliography backend from source content (and all included project files). */
function detectBiblioBackend(
	sourceContent: string,
	projectFiles?: { path: string; content: string | Uint8Array }[],
): "biber" | "bibtex8" {
	const allSources: string[] = [sourceContent];
	if (projectFiles) {
		for (const f of projectFiles) {
			if (typeof f.content === "string") {
				allSources.push(f.content);
			}
		}
	}
	for (const src of allSources) {
		// Explicit backend option in biblatex
		const backendMatch = src.match(
			/\\usepackage\[[^\]]*backend\s*=\s*(biber|bibtex)[^\]]*\]\s*\{biblatex\}/,
		);
		if (backendMatch) {
			return backendMatch[1] === "biber" ? "biber" : "bibtex8";
		}
		// biblatex is used (default backend is biber)
		if (src.includes("\\usepackage") && src.includes("{biblatex}")) {
			return "biber";
		}
		if (src.includes("\\addbibresource")) {
			return "biber";
		}
	}
	return "bibtex8";
}

let compiler: Compiler | undefined;
let packageCache: PackageCache | undefined;
let onStatusChange:
	| ((state: StatusState, message?: string) => void)
	| undefined;

export function setCompiler(c: Compiler): void {
	compiler = c;
}

export function setPackageCache(cache: PackageCache): void {
	packageCache = cache;
}

export function setStatusChangeHandler(
	handler: (state: StatusState, message?: string) => void,
): void {
	onStatusChange = handler;
}

/** Find the most relevant open LaTeX document to compile. Prefers the active
 *  text editor, then any visible editor, then any open document. This lets
 *  "Compile" work from contexts without an active text editor (e.g. when the
 *  getting-started walkthrough page has focus). */
export function findLatexSourceUri(): vscode.Uri | undefined {
	const candidates: (vscode.TextDocument | undefined)[] = [
		vscode.window.activeTextEditor?.document,
		...vscode.window.visibleTextEditors.map((e) => e.document),
		...vscode.workspace.textDocuments,
	];
	const seen = new Set<string>();
	for (const document of candidates) {
		if (!document) continue;
		if (seen.has(document.uri.toString())) continue;
		seen.add(document.uri.toString());
		if (document.languageId === "latex") {
			return document.uri;
		}
	}
	return undefined;
}

export async function compileDocument(
	documentUri?: vscode.Uri,
	recipeName?: string,
): Promise<void> {
	if (!compiler) {
		vscode.window.showErrorMessage("TeXWASM: Compiler not initialized.");
		return;
	}

	const sourceUri = documentUri ?? findLatexSourceUri();
	if (!sourceUri) {
		vscode.window.showErrorMessage(
			"TeXWASM: No active LaTeX file. Open a .tex file first.",
		);
		return;
	}

	const document = await vscode.workspace.openTextDocument(sourceUri);
	if (document.languageId !== "latex") {
		vscode.window.showErrorMessage(
			"TeXWASM: Active file is not a LaTeX document.",
		);
		return;
	}

	const initialSourceContent = document.getText();

	// Derive workspace folder scope for per-folder settings
	const scopeUri = vscode.workspace.getWorkspaceFolder(sourceUri)?.uri;

	// Resolve root document for multi-file projects
	const rootResult = await resolveRootDocument(
		sourceUri,
		initialSourceContent,
		scopeUri,
	);
	const sourcePath = rootResult.rootPath;
	const sourceContent = rootResult.rootContent;
	const sourceDir = path.dirname(sourcePath);

	if (
		rootResult.method !== "selfDetected" &&
		rootResult.method !== "fallback"
	) {
		appendLog(
			`[TeXWASM] Root document: ${sourcePath} (detected via ${rootResult.method})`,
		);
	}

	// Ensure WASM engine and biber assets are downloaded before anything touches
	// the worker (package-cache docstrip and the main compile both init the
	// worker, which verifies asset presence and aborts with "Required asset not
	// found" if they're missing).
	const assetManager = new AssetManager(compiler.extensionContext);
	const assetsReady = await assetManager.ensureAssets();
	if (!assetsReady) {
		onStatusChange?.("error");
		await showAssetDownloadError(
			"Engine assets are not available.",
		);
		return;
	}

	onStatusChange?.("compiling");

	clearDiagnostics();

	let projectFiles = resolveProjectFiles(sourcePath);

	projectFiles = projectFiles.map((f) => ({
		path: path.relative(sourceDir, f.path).replace(/\\/g, "/"),
		content: f.content,
	}));

	// ── Recipe resolution ──────────────────────────────────────────────
	const magic = parseMagicComments(sourceContent);
	const tools = getRecipeTools(scopeUri);
	const recipes = getRecipes(scopeUri);
	const recipeDefault = getDefaultRecipe(scopeUri);
	const lastUsed = getLastUsedRecipe();

	const resolvedRecipe = resolveSelectedRecipe(
		recipes,
		recipeDefault,
		lastUsed,
		recipeName ?? magic.lwRecipe,
	);

	const recipeConfig = recipeToCompileConfig(resolvedRecipe, tools);

	// ── Engine resolution ─────────────────────────────────────────────
	// Priority: % !TEX program magic comment → recipe engine →
	// auto-upgrade when the source requires a more capable engine.
	let engine = recipeConfig.engine;
	if (magic.program && magic.program !== engine) {
		appendLog(
			`[TeXWASM] Engine override: % !TEX program = ${magic.program} (recipe specifies "${engine}").`,
		);
		engine = magic.program;
	}
	const requiredEngine = detectRequiredEngine(sourceContent, projectFiles);
	if (requiredEngine === "lualatex" && engine !== "lualatex") {
		appendLog(
			`[TeXWASM] Engine override: document uses Lua commands (\\directlua/luacode) which require lualatex. Switching from "${engine}" to "lualatex".`,
		);
		engine = "lualatex";
	} else if (requiredEngine === "xelatex" && engine === "pdflatex") {
		appendLog(
			`[TeXWASM] Engine override: document requires xelatex or lualatex (fontspec/polyglossia detected). Switching from "pdflatex" to "xelatex".`,
		);
		engine = "xelatex";
	}

	appendLog(`[TeXWASM] Compiling: ${sourcePath}`);
	appendLog(`[TeXWASM] Recipe: ${resolvedRecipe.name}`);
	appendLog(
		`[TeXWASM] Engine: ${engine} | Passes: ${recipeConfig.compilationPasses} | Bib: ${recipeConfig.bibtexEnabled ? recipeConfig.biblioBackend : "off"} | MakeIndex: ${recipeConfig.makeindexEnabled ? "on" : "off"}`,
	);

	if (recipeConfig.unhandledTools.length > 0) {
		appendLog(
			`[TeXWASM] Note: The following recipe tools are not yet supported in WASM: ${recipeConfig.unhandledTools.join(", ")}`,
		);
	}

	// Detect biblio backend from source content (and included project files) as a refinement
	const detectedBackend = detectBiblioBackend(sourceContent, projectFiles);
	if (recipeConfig.bibtexEnabled && recipeConfig.biblioBackend !== detectedBackend) {
		appendLog(
			`[TeXWASM] Biblio backend override: source indicates "${detectedBackend}", recipe specifies "${recipeConfig.biblioBackend}". Using source-detected backend.`,
		);
	}
	const effectiveBackend = recipeConfig.bibtexEnabled ? detectedBackend : recipeConfig.biblioBackend;

	// Pre-scan for packages and download missing ones ones
	let extraFiles: { targetPath: string; content: Uint8Array }[] = [];
	if (packageCache && getAutoDownloadPackages(scopeUri)) {
		try {
			packageCache.setIncludeExtraBundle(getIncludeExtraBundle(scopeUri));
			extraFiles = await packageCache.ensurePackages(
				sourceContent,
				projectFiles,
				(msg) => {
					appendLog(`[TeXWASM] ${msg}`);
				},
			);
			if (extraFiles.length > 0) {
				appendLog(
					`[TeXWASM] Mounting ${extraFiles.length} extra package file(s) from CTAN cache.`,
				);
			}
		} catch (err) {
			appendLog(
				`[TeXWASM] Package resolution warning: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// ── Font name resolution ────────────────────────────────────────
	// BusyTeX's WASM engine has no fontconfig, so fontspec cannot resolve
	// family names — only filenames. Rewrite \setmainfont{Foo} etc. using
	// (1) fonts found inside the workspace and (2) the system font index
	// (built once and cached in globalStorageUri) before sending the source
	// to the worker. For system fonts we also mount the actual file bytes
	// in the WASM virtual filesystem so LuaTeX/XeTeX can find them.
	let effectiveSourceContent = sourceContent;
	let effectiveProjectFiles = projectFiles;
	if (getFontNameLookup(scopeUri)) {
		const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(
			(f) => f.uri.fsPath,
		);

		// Build workspace index (project-local fonts) and merge with the
		// system font index (host-installed fonts). Workspace wins on
		// collision.
		const workspaceIndex = buildFontIndex(workspaceRoots, sourceDir);
		let systemIndex: Map<string, import("../engine/fontResolver").FontIndexEntry> =
			new Map();
		if (compiler) {
			try {
				const cacheDir = getFontIndexDir(compiler.extensionContext);
				systemIndex = await getOrBuildSystemFontIndex(cacheDir, {
					extraDirectories: getSystemFontDirectories(scopeUri),
					onProgress: (msg) => appendLog(`[TeXWASM] ${msg}`),
				});
			} catch (err) {
				appendLog(
					`[TeXWASM] System font index unavailable: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		const fontIndex = mergeFontIndices(workspaceIndex, systemIndex);

		// Collect font-holding macros (\def\fontType{Arial}, \newcommand\fontType{Arial})
		// from the root document AND every included file so a font name stored in a
		// variable resolves regardless of which file defines it.
		const fontMacros = extractMacroDefinitions(sourceContent);
		for (const pf of projectFiles) {
			if (typeof pf.content !== "string") continue;
			for (const [name, value] of extractMacroDefinitions(pf.content)) {
				fontMacros.set(name, value);
			}
		}

		if (fontIndex.size > 0) {
			const result = resolveFontReferences(
				sourceContent,
				fontIndex,
				{},
				sourceDir,
				fontMacros,
			);
			if (result.rewritten.length > 0) {
				appendLog(
					`[TeXWASM] Rewrote ${result.rewritten.length} font reference(s) in root: ${result.rewritten.map((r) => `${r.command}{${r.from}} → ${r.to} (line ${r.line})`).join("; ")}.`,
				);
			}
			for (const u of result.unresolved) {
				const loc = u.optionKey
					? `${u.command}[${u.optionKey}=${u.name}]`
					: `${u.command}{${u.name}}`;
				appendLog(
					`[TeXWASM] Font name not resolved in root (line ${u.line}): ${loc}. The font is not installed on the system and was not found in the project tree.`,
				);
			}
			effectiveSourceContent = result.source;

			// Collect all rewritten references from root + sub-files
			// so we know which system fonts to mount into MEMFS.
			const allRewritten: Array<{ command: string; from: string; to: string; line: number }> =
				[...result.rewritten];

			// Also rewrite \setmainfont etc. in included sub-files
			let subRewrites = 0;
			effectiveProjectFiles = projectFiles.map((f) => {
				if (typeof f.content !== "string") return f;
				const sub = resolveFontReferences(
					f.content,
					fontIndex,
					{},
					sourceDir,
					fontMacros,
				);
				if (sub.rewritten.length === 0 && sub.unresolved.length === 0) return f;
				allRewritten.push(...sub.rewritten);
				subRewrites += sub.rewritten.length;
				for (const u of sub.unresolved) {
					const loc = u.optionKey
						? `${u.command}[${u.optionKey}=${u.name}]`
						: `${u.command}{${u.name}}`;
					appendLog(
						`[TeXWASM] Font name not resolved in ${f.path} (line ${u.line}): ${loc}.`,
					);
				}
				return { ...f, content: sub.source };
			});
			if (subRewrites > 0) {
				appendLog(
					`[TeXWASM] Rewrote ${subRewrites} font reference(s) in included files.`,
				);
			}

			// Mount any referenced system fonts into MEMFS at <rootDir>/<stem>.<ext>
			// so LuaTeX/XeTeX can find them in TeX CWD.
			const referencedSystemFonts = new Set<string>();
			for (const r of allRewritten) {
				const entry = fontIndex.get(r.from.trim().toLowerCase());
				const src = entry && (entry as { sourcePath?: string }).sourcePath;
				if (src) referencedSystemFonts.add(src);
			}
			if (referencedSystemFonts.size > 0) {
				let mounted = 0;
				for (const src of referencedSystemFonts) {
					try {
						const bytes = await fs.promises.readFile(src);
						const entry = Array.from(systemIndex.values()).find(
							(e) => (e as { sourcePath?: string }).sourcePath === src,
						);
						if (!entry) continue;
						const mountPath = path
							.relative(sourceDir, path.join(sourceDir, `${entry.stem}${entry.ext}`))
							.replace(/\\/g, "/");
						effectiveProjectFiles = [
							...effectiveProjectFiles,
							{ path: mountPath, content: bytes },
						];
						mounted++;
					} catch (err) {
						appendLog(
							`[TeXWASM] Could not mount system font ${src}: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
				if (mounted > 0) {
					appendLog(
						`[TeXWASM] Mounted ${mounted} system font file(s) into the virtual filesystem.`,
					);
				}
			}
		}
	}

	const options: CompileOptions = {
		sourcePath,
		sourceContent: effectiveSourceContent,
		engine,
		outputDirectory: getOutputDirectory(scopeUri),
		bibtexEnabled: recipeConfig.bibtexEnabled,
		makeindexEnabled: recipeConfig.makeindexEnabled,
		biblioBackend: effectiveBackend,
		compilationPasses: recipeConfig.compilationPasses,
		includeExtraBundle: getIncludeExtraBundle(scopeUri),
		projectFiles: effectiveProjectFiles,
		extraFiles: extraFiles.length > 0 ? extraFiles : undefined,
	};

	try {
		let result = await compiler.compile(options);

		// Retry: if compilation failed due to missing files, download them and retry
		// until no new packages are found or compilation succeeds (max 5 rounds).
		if (!result.success && result.logContent && packageCache) {
			const attempted = new Set<string>();
			for (let round = 0; round < 5; round++) {
				const logContent = result.logContent;
				if (!logContent) break;
				const missingFiles = parseMissingFileErrors(logContent);
				if (missingFiles.length === 0) break;

				appendLog(
					`[TeXWASM] Missing files detected (round ${round + 1}): ${missingFiles.join(", ")}. Downloading from CTAN...`,
				);
				const retryExtraFiles = [...(options.extraFiles ?? [])];
				let addedNew = false;

				for (const fileName of missingFiles) {
					// Extract package name candidates from the missing file name
					for (const packageName of getPackageCandidates(fileName)) {
						if (attempted.has(packageName)) break;
						attempted.add(packageName);
						try {
							const entries = await packageCache.downloadPackage(packageName, (msg) => {
								appendLog(`[TeXWASM] ${msg}`);
							});
							if (entries.length > 0) {
								retryExtraFiles.push(...entries);
								addedNew = true;
							}
							break;
						} catch {
							// Try next candidate
						}
					}
				}

				if (!addedNew) {
					break; // Nothing new was downloaded — recompiling would not change anything
				}

				// Deduplicate by targetPath (cached packages may be re-added across rounds)
				const deduped = new Map<string, { targetPath: string; content: Uint8Array }>();
				for (const e of retryExtraFiles) {
					deduped.set(e.targetPath, e);
				}
				options.extraFiles = Array.from(deduped.values());

				appendLog(
					`[TeXWASM] Retrying compilation with ${options.extraFiles.length} package file(s).`,
				);
				result = await compiler.compile(options);
				if (result.success) break;
			}
		}

		if (result.success && result.pdfPath) {
			onStatusChange?.("done");
			appendLog(`[TeXWASM] Compilation successful: ${result.pdfPath}`);

			if (result.logContent) {
				const logUri = vscode.Uri.file(sourcePath);
				const entries = parseLog(result.logContent);
				if (entries.length > 0) {
					updateDiagnostics(logUri, entries);
				}
			}

			openPdf(result.pdfPath);
		} else {
			onStatusChange?.("error");
			appendLog(
				`[TeXWASM] Compilation failed: ${result.errorMessage || "Unknown error"}`,
			);

			if (result.logContent) {
				const logUri = vscode.Uri.file(sourcePath);
				const entries = parseLog(result.logContent);
				updateDiagnostics(logUri, entries);
			}

			showOutputChannel();
			vscode.window.showErrorMessage(
				`TeXWASM: Compilation failed. See log for details.`,
			);
		}
	} catch (err) {
		onStatusChange?.("error");
		appendLog(
			`[TeXWASM] Compilation error: ${err instanceof Error ? err.message : String(err)}`,
		);
		showOutputChannel();
		vscode.window.showErrorMessage(
			`TeXWASM: Compilation error. See log for details.`,
		);
	}
}
