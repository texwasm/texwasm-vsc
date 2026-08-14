import { describe, it, before, after } from "mocha";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import * as pkg from '../../package.json';

const extensionId = pkg.publisher + '.' + pkg.name;

/**
 * Font name + an expected absolute path. We pick the first one that exists
 * on the host system. The family name is what goes in the .tex document;
 * the path is the file the extension will mount into WASM MEMFS.
 */
const FONT_CANDIDATES: Array<{ family: string; path: string }> = [
	// Windows
	{ family: "Arial", path: "C:\\Windows\\Fonts\\arial.ttf" },
	{ family: "Segoe UI", path: "C:\\Windows\\Fonts\\segoeui.ttf" },
	{ family: "Calibri", path: "C:\\Windows\\Fonts\\calibri.ttf" },
	{ family: "Tahoma", path: "C:\\Windows\\Fonts\\tahoma.ttf" },
	// macOS
	{ family: "Arial", path: "/System/Library/Fonts/Supplemental/Arial.ttf" },
	{ family: "Arial", path: "/Library/Fonts/Arial.ttf" },
	// Linux (Debian/Ubuntu, Fedora, Arch)
	{ family: "DejaVu Sans", path: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf" },
	{ family: "Liberation Sans", path: "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf" },
	{ family: "DejaVu Sans", path: "/usr/share/fonts/TTF/DejaVuSans.ttf" },
	{ family: "DejaVu Sans", path: "/usr/share/fonts/dejavu/DejaVuSans.ttf" },
	{ family: "Liberation Sans", path: "/usr/share/fonts/liberation/LiberationSans-Regular.ttf" },
];

function pickFont(): { family: string; path: string } | undefined {
	for (const c of FONT_CANDIDATES) {
		try {
			if (fs.existsSync(c.path) && fs.statSync(c.path).isFile()) {
				return c;
			}
		} catch {
			/* ignore */
		}
	}
	return undefined;
}

describe("TeXWASM font name resolution (lualatex)", function () {
	this.timeout(600_000);

	let texPath: string;
	let pdfPath: string;
	let fontChoice: { family: string; path: string } | undefined;

	before(async function () {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			throw new Error("No workspace folder found");
		}

		const docDir = workspaceFolder.uri.fsPath;
		texPath = path.join(docDir, "texwasm-font-name-test.tex");
		pdfPath = texPath.replace(/\.tex$/i, ".pdf");

		// Pick a font that's actually installed on the host. The family name
		// goes in the document; the extension will find the same family in
		// the system font index, rewrite the reference, and mount the file
		// from `fontChoice.path` into WASM MEMFS at the TeX CWD.
		fontChoice = pickFont();

		const content = [
			"% !TEX program = lualatex",
			"\\documentclass{article}",
			"\\usepackage{fontspec}",
			fontChoice
				? `\\setmainfont{${fontChoice.family}}`
				: "\\setmainfont{NoFontAvailable}",
			"",
			"\\begin{document}",
			"Hello, World!",
			"",
			"\\textbf{Bold text}",
			"\\textit{Italic text}",
			"\\textbf{\\textit{Bold Italic text}}",
			"\\end{document}",
		].join("\n");

		fs.writeFileSync(texPath, content, "utf-8");

		const ext = vscode.extensions.getExtension(extensionId);
		if (!ext) {
			throw new Error(`Extension ${extensionId} not found`);
		}
		if (!ext.isActive) {
			await ext.activate();
		}

		console.log("[test] Ensuring engine assets are downloaded...");
		await vscode.commands.executeCommand("texwasm.downloadEngine");
		console.log("[test] Engine assets ready.");

		// Ensure the system font index is fresh — pickFont may have selected
		// a font that wasn't indexed on a previous test run, or the cache may
		// have been deleted by another test.
		console.log("[test] Rebuilding system font index...");
		await vscode.commands.executeCommand("texwasm.rebuildFontIndex");
		console.log("[test] System font index ready.");
	});

	before(function () {
		if (!fontChoice) {
			console.log(
				`[test] No system font found in known paths; skipping lualatex font resolution test.`,
			);
			this.skip();
		}
	});

	it("resolves a system font family name to a mounted file and produces a PDF >= 2 KB", async function () {
		const doc = await vscode.workspace.openTextDocument(texPath);
		await vscode.window.showTextDocument(doc);

		assert.strictEqual(doc.languageId, "latex");

		console.log(`[test] Using system font: ${fontChoice!.family} (${fontChoice!.path})`);
		console.log("[test] Running compile command...");

		const start = Date.now();
		await vscode.commands.executeCommand("texwasm.compile");
		console.log(`[test] Compile command returned in ${Date.now() - start}ms.`);

		console.log("[test] Waiting for PDF...");
		let found = false;
		for (let i = 0; i < 180; i++) {
			if (fs.existsSync(pdfPath)) {
				found = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
		assert.ok(found, "PDF file should exist after compilation");

		const stats = fs.statSync(pdfPath);
		console.log(`[test] PDF size: ${stats.size} bytes`);
		assert.ok(
			stats.size >= 2 * 1024,
			`PDF should be at least 2 KB (got ${stats.size} bytes)`,
		);
	});

	it("resolves a font name stored in a macro defined in an included file", async function () {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) throw new Error("No workspace folder found");
		const docDir = workspaceFolder.uri.fsPath;

		const rootPath = path.join(docDir, "texwasm-font-macro-test.tex");
		const defsPath = path.join(docDir, "texwasm-font-macro-defs.tex");
		const rootPdfPath = rootPath.replace(/\.tex$/i, ".pdf");

		// The font name lives in a variable defined in a separate included file:
		//   defs.tex:  \def \fontType {Arial}
		//   main.tex:  \input{defs} \setmainfont{\fontType}
		fs.writeFileSync(defsPath, `\\def \\fontType {${fontChoice!.family}}\n`, "utf-8");
		const rootContent = [
			"% !TEX program = lualatex",
			"\\documentclass{article}",
			"\\usepackage{fontspec}",
			"\\input{texwasm-font-macro-defs}",
			"\\setmainfont{\\fontType}",
			"",
			"\\begin{document}",
			"Hello from a macro-defined font!",
			"\\end{document}",
		].join("\n");
		fs.writeFileSync(rootPath, rootContent, "utf-8");

		const doc = await vscode.workspace.openTextDocument(rootPath);
		await vscode.window.showTextDocument(doc);
		assert.strictEqual(doc.languageId, "latex");

		console.log(`[test] Compiling with macro-defined font: \\fontType = ${fontChoice!.family}`);
		await vscode.commands.executeCommand("texwasm.compile");

		let found = false;
		for (let i = 0; i < 180; i++) {
			if (fs.existsSync(rootPdfPath)) {
				found = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
		assert.ok(found, "PDF should exist after compiling with a macro-defined font");

		const stats = fs.statSync(rootPdfPath);
		assert.ok(
			stats.size >= 2 * 1024,
			`PDF should be at least 2 KB (got ${stats.size} bytes)`,
		);

		// Clean up this test's artifacts
		const base = rootPath.replace(/\.tex$/i, "");
		for (const ext of [".tex", ".pdf", ".aux", ".log", ".out", ".synctex.gz", ".xdv"]) {
			const p = base + ext;
			if (fs.existsSync(p)) {
				try {
					fs.unlinkSync(p);
				} catch {
					/* ignore */
				}
			}
		}
		if (fs.existsSync(defsPath)) {
			try {
				fs.unlinkSync(defsPath);
			} catch {
				/* ignore */
			}
		}
	});

	after(function () {
		const base = texPath?.replace(/\.tex$/i, "");
		if (base) {
			for (const ext of [
				".tex",
				".pdf",
				".aux",
				".log",
				".out",
				".synctex.gz",
				".xdv",
				".bbl",
				".bcf",
				".run.xml",
			]) {
				const p = base + ext;
				if (fs.existsSync(p)) {
					try {
						fs.unlinkSync(p);
					} catch {
						/* ignore */
					}
				}
			}
		}
	});
});
