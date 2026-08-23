import * as vscode from "vscode";
import { AssetManager, showAssetDownloadError } from "./cache/assetManager";
import { PackageCache } from "./cache/packageCache";
import { cleanAuxiliaryFiles } from "./commands/clean";
import { createHelloWorldFile } from "./commands/helloWorld";
import {
	compileDocument,
	setCompiler,
	setPackageCache,
	setStatusChangeHandler,
} from "./commands/compile";
import { compileWith } from "./commands/compileWith";
import { setCompilerRef, stopCompilation } from "./commands/stop";
import { synctexForward } from "./commands/synctex";
import { viewLog } from "./commands/viewLog";
import { viewPdf } from "./commands/viewPdf";
import {
	disposeWordCountChannel,
	wordCountActiveFile,
	wordCountWorkspace,
} from "./commands/wordCount";
import { getAutoCompile, getFormatIndentWidth } from "./config/settings";
import { clearDiagnostics } from "./diagnostics/latexDiagnostics";
import { Compiler } from "./engine/compiler";
import type { StatusState } from "./engine/types";
import { appendLog, disposeOutputChannel } from "./output/outputChannel";
import { getFontIndexDir } from "./cache/storage";
import { formatLatex } from "./utils/latexFormatter";
import { getOrBuildSystemFontIndex, invalidateSystemFontIndex } from "./utils/systemFonts";

let statusBarItem: vscode.StatusBarItem;
let statusState: StatusState = "idle";

export function activate(context: vscode.ExtensionContext): void {
	appendLog("[TeXWASM] Activating extension...");

	const compiler = new Compiler(context);
	const pkgCache = new PackageCache(context);
	pkgCache.setDocstripHandler((files) => compiler.docstrip(files));
	pkgCache.setExtraBundlePromptHandler(() => {
		void promptEnableExtraBundle();
	});

	setCompiler(compiler);
	setPackageCache(pkgCache);
	setCompilerRef(compiler);

	statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100,
	);
	statusBarItem.command = "texwasm.compile";
	updateStatusBar("idle");
	statusBarItem.show();

	setStatusChangeHandler((state: StatusState, _message?: string) => {
		statusState = state;
		updateStatusBar(state);
	});

	const compileCmd = vscode.commands.registerCommand("texwasm.compile", () => {
		compileDocument();
	});

	const compileWithCmd = vscode.commands.registerCommand(
		"texwasm.compileWith",
		() => {
			compileWith();
		},
	);

	const viewLogCmd = vscode.commands.registerCommand("texwasm.viewLog", () => {
		viewLog();
	});

	const cleanCmd = vscode.commands.registerCommand("texwasm.clean", () => {
		cleanAuxiliaryFiles();
	});

	const stopCmd = vscode.commands.registerCommand("texwasm.stop", () => {
		stopCompilation();
	});

	const synctexCmd = vscode.commands.registerCommand(
		"texwasm.synctexForward",
		() => {
			synctexForward();
		},
	);

	const wordCountCmd = vscode.commands.registerCommand(
		"texwasm.wordCount",
		() => {
			wordCountActiveFile();
		},
	);

	const wordCountWorkspaceCmd = vscode.commands.registerCommand(
		"texwasm.wordCountWorkspace",
		() => {
			wordCountWorkspace();
		},
	);

	const walkthroughCmd = vscode.commands.registerCommand(
		"texwasm.walkthrough",
		() => {
			void vscode.commands.executeCommand(
				"workbench.action.openWalkthrough",
				`${context.extension.id}#texwasm.gettingStarted`,
			);
		},
	);

	const createHelloWorldCmd = vscode.commands.registerCommand(
		"texwasm.createHelloWorld",
		() => {
			void createHelloWorldFile();
		},
	);

	const viewPdfCmd = vscode.commands.registerCommand("texwasm.viewPdf", () => {
		void viewPdf();
	});

		const downloadEngineCmd = vscode.commands.registerCommand(
			"texwasm.downloadEngine",
			async () => {
				const assetManager = new AssetManager(context);
				const result = await assetManager.ensureAssets();
				if (result) {
					vscode.window.showInformationMessage("TeXWASM: Engine assets ready.");
				} else {
					await showAssetDownloadError(
						"Failed to download engine assets.",
					);
					throw new Error("Failed to download engine assets.");
				}
			},
		);

	const clearPkgCacheCmd = vscode.commands.registerCommand(
		"texwasm.clearPackageCache",
		async () => {
			pkgCache.clearCache();
			vscode.window.showInformationMessage("TeXWASM: Package cache cleared.");
		},
	);

	const listPkgCacheCmd = vscode.commands.registerCommand(
		"texwasm.listPackageCache",
		async () => {
			const pkgs = pkgCache.listCachedPackages();
			if (pkgs.length === 0) {
				vscode.window.showInformationMessage("TeXWASM: No packages in cache.");
			} else {
				vscode.window.showInformationMessage(
					`TeXWASM: ${pkgs.length} cached package(s): ${pkgs.join(", ")}`,
				);
			}
		},
	);

	const rebuildFontIndexCmd = vscode.commands.registerCommand(
		"texwasm.rebuildFontIndex",
		async () => {
			const cacheDir = getFontIndexDir(context);
			await invalidateSystemFontIndex(cacheDir);
			const index = await getOrBuildSystemFontIndex(cacheDir, {
				onProgress: (msg) => appendLog(`[TeXWASM] ${msg}`),
			});
			vscode.window.showInformationMessage(
				`TeXWASM: Indexed ${index.size} system font(s).`,
			);
		},
	);

	const autoCompileDisposable = vscode.workspace.onDidSaveTextDocument(
		(document) => {
			if (
				document.languageId === "latex" &&
				getAutoCompile() &&
				statusState !== "compiling"
			) {
				compileDocument(document.uri);
			}
		},
	);

	// Format Document support for LaTeX: indents the contents of environments.
	const formatProvider = vscode.languages.registerDocumentFormattingEditProvider(
		"latex",
		{
			provideDocumentFormattingEdits(document) {
				const source = document.getText();
				const formatted = formatLatex(source, getIndentString(document));
				if (formatted === source) {
					return [];
				}
				return [
					vscode.TextEdit.replace(
						new vscode.Range(
							document.positionAt(0),
							document.positionAt(source.length),
						),
						formatted,
					),
				];
			},
		},
	);

	// Show the getting-started walkthrough once, the first time the extension
	// is activated in a new installation. VS Code's built-in open-on-install
	// only covers walkthroughs added after a fresh install, so this also
	// catches users who install from a .vsix or upgrade from an older version.
	const WALKTHROUGH_SHOWN_KEY = "texwasm.walkthrough.shown";
	if (!context.globalState.get<boolean>(WALKTHROUGH_SHOWN_KEY)) {
		void context.globalState.update(WALKTHROUGH_SHOWN_KEY, true);
		void vscode.commands.executeCommand(
			"workbench.action.openWalkthrough",
			`${context.extension.id}#texwasm.gettingStarted`,
		);
	}

	// Proactively download the texlive-extra bundle when the user enables
	// texwasm.includeExtraBundle, and tear down any active worker so the next
	// compile re-initializes with the new bundle flag (the worker only reads
	// the flag in its init handler — see wasmWorker.ts handleInit).
	const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(
		(e) => {
			if (!e.affectsConfiguration("texwasm.includeExtraBundle")) {
				return;
			}

			const includeExtra = vscode.workspace
				.getConfiguration("texwasm")
				.get<boolean>("includeExtraBundle", false);

			// Drop any cached worker so the next compile re-inits with the new flag.
			compiler.cancel();

			if (includeExtra) {
				const assetManager = new AssetManager(context);
				assetManager.ensureAssets().then((ok) => {
					if (!ok) {
						showAssetDownloadError(
							"Failed to download the texlive-extra bundle.",
						);
					}
				});
			}
		},
	);

	context.subscriptions.push(
		compileCmd,
		compileWithCmd,
		viewLogCmd,
		cleanCmd,
		stopCmd,
		synctexCmd,
		wordCountCmd,
		wordCountWorkspaceCmd,
		walkthroughCmd,
		createHelloWorldCmd,
		viewPdfCmd,
		downloadEngineCmd,
		clearPkgCacheCmd,
		listPkgCacheCmd,
		rebuildFontIndexCmd,
		autoCompileDisposable,
		formatProvider,
		configChangeDisposable,
		statusBarItem,
	);

	appendLog("[TeXWASM] Extension activated.");
}

export function deactivate(): void {
	clearDiagnostics();
	disposeOutputChannel();
	disposeWordCountChannel();
	appendLog("[TeXWASM] Extension deactivated.");
}

/** When a CTAN package download fails while the texlive-extra bundle is
 *  disabled, ask the user whether to enable texwasm.includeExtraBundle:
 *  the extra bundle preloads far more packages, so on-demand CTAN downloads
 *  (which just failed) are rarely needed. */
async function promptEnableExtraBundle(): Promise<void> {
	const action = await vscode.window.showWarningMessage(
		"TeXWASM: Could not download a package from CTAN. Enabling 'texwasm.includeExtraBundle' preloads many more packages and avoids CTAN downloads.",
		"Enable includeExtraBundle",
	);
	if (action !== "Enable includeExtraBundle") return;

	await vscode.workspace
		.getConfiguration("texwasm")
		.update("includeExtraBundle", true, vscode.ConfigurationTarget.Global);
}

/** Returns the indentation string used by the LaTeX formatter: the configured
 *  texwasm.formatting.indentWidth when set, otherwise the editor's tab
 *  size / insert-spaces settings for the document. */
function getIndentString(document: vscode.TextDocument): string {
	const configured = getFormatIndentWidth(document.uri);
	if (configured !== null && configured > 0) {
		return " ".repeat(configured);
	}
	const editorConfig = vscode.workspace.getConfiguration(
		"editor",
		document.uri,
	);
	const insertSpaces = editorConfig.get<boolean>("insertSpaces", true);
	const tabSize = editorConfig.get<number>("tabSize", 4);
	return insertSpaces
		? " ".repeat(typeof tabSize === "number" && tabSize > 0 ? tabSize : 4)
		: "\t";
}

function updateStatusBar(state: StatusState): void {
	switch (state) {
		case "idle":
			statusBarItem.text = "$(server) TeXWASM";
			statusBarItem.tooltip = "TeXWASM \u2014 Click to compile";
			statusBarItem.backgroundColor = undefined;
			break;
		case "compiling":
			statusBarItem.text = "$(sync~spin) TeXWASM [compiling...]";
			statusBarItem.tooltip = "TeXWASM \u2014 Compiling...";
			statusBarItem.backgroundColor = undefined;
			break;
		case "done":
			statusBarItem.text = "$(check) TeXWASM";
			statusBarItem.tooltip = "TeXWASM \u2014 Compilation successful";
			statusBarItem.backgroundColor = new vscode.ThemeColor(
				"statusBarItem.prominentBackground",
			);
			break;
		case "error":
			statusBarItem.text = "$(error) TeXWASM";
			statusBarItem.tooltip = "TeXWASM \u2014 Compilation failed";
			statusBarItem.backgroundColor = new vscode.ThemeColor(
				"statusBarItem.errorBackground",
			);
			break;
	}
}
