import fs from "node:fs";
import path from "node:path";
import { parentPort } from "node:worker_threads";
import type {
	WorkerCompileRequest,
	WorkerDocstripRequest,
	WorkerInitRequest,
} from "./types";

// biome-ignore lint/suspicious/noExplicitAny: Emscripten types are not available
type EmscriptenModule = any;
type WorkerRequest =
	| WorkerInitRequest
	| WorkerCompileRequest
	| WorkerDocstripRequest;
// biome-ignore lint/suspicious/noExplicitAny: Emscripten Module factory signature is untyped
type BiberFactory = (moduleArg: any) => Promise<any>;

let assetsDirGlobal = "";
let includeExtraBundleGlobal = false;
// biome-ignore lint/suspicious/noExplicitAny: Emscripten Module factory signature is untyped
let cachedModuleFactory: ((opts: any) => Promise<any>) | null = null;
let biberFactoryGlobal: BiberFactory | null = null;
let biberAssetsDirGlobal = "";

// biome-ignore lint/suspicious/noExplicitAny: Return type is dynamic parsed JSON
function extractBalanced(src: string, marker: string, fromEnd = false): any {
	const start = fromEnd ? src.lastIndexOf(marker) : src.indexOf(marker);
	if (start === -1) throw new Error(`Marker "${marker}" not found`);
	let contentStart = start + marker.length;
	while (contentStart < src.length && src[contentStart] === " ") contentStart++;
	const openChar = src[contentStart];
	const closeMap: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
	const closeChar = closeMap[openChar];
	if (!closeChar) throw new Error(`Unexpected start char '${openChar}'`);
	let depth = 0;
	let pos = contentStart;
	for (; pos < src.length; pos++) {
		if (src[pos] === openChar) depth++;
		else if (src[pos] === closeChar) {
			depth--;
			if (depth === 0) break;
		}
	}
	if (depth !== 0) throw new Error("Unbalanced delimiter");
	return JSON.parse(src.slice(contentStart, pos + 1));
}

function loadDataPackage(
	M: EmscriptenModule,
	dataPath: string,
	jsPath: string,
): void {
	const src = fs.readFileSync(jsPath, "utf8");
	const metadata = extractBalanced(src, "loadPackage(", true);
	const compressedData = extractBalanced(src, "var compressedData = ");
	compressedData.data = new Uint8Array(fs.readFileSync(dataPath));
	M.LZ4.loadPackage({ metadata, compressedData }, false);
}

async function createModule(): Promise<EmscriptenModule> {
	if (!cachedModuleFactory) {
		const busytexJsPath = path.join(assetsDirGlobal, "busytex.js");
		if (!fs.existsSync(busytexJsPath)) {
			throw new Error(`busytex.js not found in ${assetsDirGlobal}`);
		}
		const mod = require(busytexJsPath);
		cachedModuleFactory = mod.default || mod;
	}
	const M: EmscriptenModule = await cachedModuleFactory?.({
		locateFile: (file: string) => path.join(assetsDirGlobal, file),
		thisProgram: "/bin/busytex",
		noExitRuntime: true,
	});

	loadDataPackage(
		M,
		path.join(assetsDirGlobal, "texlive-basic.data"),
		path.join(assetsDirGlobal, "texlive-basic.js"),
	);
	if (includeExtraBundleGlobal) {
		loadDataPackage(
			M,
			path.join(assetsDirGlobal, "texlive-extra.data"),
			path.join(assetsDirGlobal, "texlive-extra.js"),
		);
	}

	M.ENV = M.ENV || {};
	M.ENV.TEXMFCNF = "/texlive/texmf-dist/web2c";
	M.ENV.TEXMFDIST = "/texlive/texmf-dist";
	M.ENV.TEXMFVAR = "/texlive/texmf-dist/texmf-var";
	M.ENV.FONTCONFIG_PATH = "/texlive";
	M.ENV.ICU_DATA = "/texlive/";

	return M;
}

async function loadBiberFactory(): Promise<BiberFactory> {
	if (biberFactoryGlobal) return biberFactoryGlobal;
	const biberJsPath = path.join(biberAssetsDirGlobal, "biber.js");
	if (!fs.existsSync(biberJsPath)) {
		throw new Error(`biber.js not found in ${biberAssetsDirGlobal}`);
	}
	// biber.js is an Emscripten MODULARIZE factory (CommonJS export).
	const mod = require(biberJsPath) as BiberFactory | { default: BiberFactory };
	biberFactoryGlobal = (mod as { default?: BiberFactory }).default ?? (mod as BiberFactory);
	return biberFactoryGlobal;
}

/** Create a directory and all missing parents (Emscripten's FS.mkdir is single-level). */
function mkdirTree(M: EmscriptenModule, absDir: string): void {
	if (typeof M.FS.mkdirTree === "function") {
		try {
			M.FS.mkdirTree(absDir);
		} catch {}
		return;
	}
	let current = "";
	for (const segment of absDir.split("/")) {
		if (!segment) continue;
		current += `/${segment}`;
		try {
			M.FS.mkdir(current);
		} catch {}
	}
}

function writeFiles(
	M: EmscriptenModule,
	projectDir: string,
	files: Map<string, Uint8Array | string>,
): void {
	mkdirTree(M, projectDir);
	for (const [filePath, content] of files) {
		const dir = path.posix.dirname(filePath);
		if (dir && dir !== ".") {
			mkdirTree(M, path.posix.join(projectDir, dir));
		}
		M.FS.writeFile(path.posix.join(projectDir, filePath), content);
	}
	M.FS.chdir(projectDir);
}

// Extensions mounted from CTAN packages. .sty/.cls/.bbx/... are LaTeX inputs;
// .tex is needed for generic packages (e.g. xstring.sty does \input xstring.tex);
// .lua is needed for runtime Lua modules (e.g. polyglossia, fontspec).
const MOUNTABLE_EXTENSIONS = new Set([".sty", ".cls", ".def", ".cfg", ".fd", ".ltx", ".clo", ".bbx", ".cbx", ".lbx", ".ldf", ".dfu", ".tex", ".lua"]);

function mountExtraFiles(
	M: EmscriptenModule,
	extraFiles: { targetPath: string; content: Uint8Array }[],
	projectDir = "/project",
): void {
	for (const ef of extraFiles) {
		const ext = path.posix.extname(ef.targetPath).toLowerCase();
		if (MOUNTABLE_EXTENSIONS.has(ext)) {
			const fileName = path.posix.basename(ef.targetPath);
			try {
				M.FS.writeFile(path.posix.join(projectDir, fileName), ef.content);
			} catch {}
		}
	}
}

function readAllFiles(
	M: EmscriptenModule,
	projectDir: string,
): Map<string, Uint8Array> {
	const out = new Map<string, Uint8Array>();
	function walk(dir: string, prefix: string) {
		for (const f of M.FS.readdir(dir)) {
			if (f === "." || f === "..") continue;
			const fullPath = path.posix.join(dir, f);
			const relPath = prefix ? `${prefix}/${f}` : f;
			try {
				const stat = M.FS.stat(fullPath);
				if (M.FS.isDir(stat.mode)) {
					walk(fullPath, relPath);
				} else {
					out.set(
						relPath,
						M.FS.readFile(fullPath, { encoding: "binary" }),
					);
				}
			} catch {}
		}
	}
	walk(projectDir, "");
	return out;
}

function callMainSuppress(M: EmscriptenModule, args: string[]): void {
	try {
		M.callMain(args);
	} catch {}
}

function sendLog(message: string): void {
	parentPort?.postMessage({ type: "log", message });
}

function getEngineBinary(engine: string): string {
	if (engine === "pdflatex") return "pdflatex";
	if (engine === "xelatex") return "xelatex";
	if (engine === "lualatex") return "luahbtex";
	return engine;
}

function getEngineArgs(engine: string): string[] {
	if (engine === "pdflatex")
		return ["-progname=pdflatex", "-output-format=pdf", "-synctex=1"];
	if (engine === "xelatex")
		return ["-progname=xelatex", "-no-pdf", "-synctex=1"];
	if (engine === "lualatex")
		return ["-progname=luahblatex", "--output-format=pdf", "-synctex=1"];
	return [];
}

function isXelatex(engine: string): boolean {
	return engine === "xelatex";
}

function runEnginePass(
	M: EmscriptenModule,
	engine: string,
	texName: string,
	passLabel: string,
): void {
	const binary = getEngineBinary(engine);
	sendLog(`Running ${engine} (${passLabel})`);
	const args = getEngineArgs(engine);
	callMainSuppress(M, [binary, ...args, "-interaction=nonstopmode", texName]);

	if (isXelatex(engine)) {
		const xdvName = texName.replace(/\.tex$/i, ".xdv");
		sendLog("Running xdvipdfmx");
		callMainSuppress(M, ["xdvipdfmx", xdvName]);
	}
}

function needsBibtex(M: EmscriptenModule, auxPath: string): boolean {
	try {
		const aux = M.FS.readFile(auxPath, { encoding: "utf8" });
		return aux.includes("\\citation");
	} catch {
		return false;
	}
}

function needsBiber(M: EmscriptenModule, auxPath: string): boolean {
	try {
		const aux = M.FS.readFile(auxPath, { encoding: "utf8" });
		return aux.includes("\\abx@aux@cite") || aux.includes("\\abx@aux@read");
	} catch {
		return false;
	}
}

function hasIndexEntries(M: EmscriptenModule, idxPath: string): boolean {
	try {
		M.FS.stat(idxPath);
		return true;
	} catch {
		return false;
	}
}

function findBibFiles(
	projectFiles: { path: string; content: string | Uint8Array }[],
): { name: string; content: string }[] {
	const bibFiles: { name: string; content: string }[] = [];
	for (const pf of projectFiles) {
		if (pf.path.toLowerCase().endsWith(".bib")) {
			// Keep the .bib extension — biber matches datasource names from the .bcf
			const content =
				typeof pf.content === "string"
					? pf.content
					: new TextDecoder().decode(pf.content);
			bibFiles.push({ name: pf.path, content });
		}
	}
	return bibFiles;
}

function findAuxBibFiles(
	M: EmscriptenModule,
	projectDir: string,
): { name: string; content: string }[] {
	const bibFiles: { name: string; content: string }[] = [];
	function walk(dir: string, prefix: string): void {
		let entries: string[];
		try {
			entries = M.FS.readdir(dir) as string[];
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry === "." || entry === "..") continue;
			const fullPath = path.posix.join(dir, entry);
			const relPath = prefix ? `${prefix}/${entry}` : entry;
			try {
				const stat = M.FS.stat(fullPath);
				if (M.FS.isDir(stat.mode)) {
					walk(fullPath, relPath);
				} else if (entry.toLowerCase().endsWith(".bib")) {
					const content = M.FS.readFile(fullPath, { encoding: "utf8" });
					bibFiles.push({ name: relPath, content });
				}
			} catch {}
		}
	}
	walk(projectDir, "");
	return bibFiles;
}

async function runBiber(
	M: EmscriptenModule,
	texName: string,
	bibFiles: { name: string; content: string }[],
): Promise<boolean> {
	const projectDir = "/project";
	try {
		const factory = await loadBiberFactory();
		const bcfPath = path.posix.join(projectDir, texName.replace(/\.tex$/i, ".bcf"));
		let bcfContent = "";
		try {
			bcfContent = M.FS.readFile(bcfPath, { encoding: "utf8" });
		} catch (err) {
			console.error(`[TeXWASM] Biber failed to read .bcf at ${bcfPath}: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
		if (!bcfContent) {
			console.error(`[TeXWASM] Biber: .bcf at ${bcfPath} is empty`);
			return false;
		}
		if (bibFiles.length === 0) {
			console.error(`[TeXWASM] Biber: no .bib files available to process ${bcfPath}`);
			return false;
		}

		// biber is a Perl interpreter compiled to WASM. It tears down its
		// interpreter on exit, so every run gets a fresh instance.
		const output: string[] = [];
		const mod = await factory({
			noInitialRun: true,
			locateFile: (file: string) => {
				if (file.endsWith(".wasm")) {
					return path.join(biberAssetsDirGlobal, "biber.wasm");
				}
				if (file.endsWith(".data")) {
					return path.join(biberAssetsDirGlobal, "biber.data");
				}
				return file;
			},
			print: (text: string) => {
				output.push(text);
				sendLog(text);
			},
			printErr: (text: string) => {
				output.push(text);
				sendLog(text);
			},
		});

		const BFS = mod.FS;
		// biber resolves datasources relative to the control file, so the .bcf
		// and all .bib files are written into one directory, keeping their
		// project-relative layout.
		const workDir = "/home/web_user/biber";
		const bcfName = path.posix.basename(bcfPath);
		const bblName = bcfName.replace(/\.bcf$/i, ".bbl");

		BFS.chdir(workDir);
		BFS.writeFile(path.posix.join(workDir, bcfName), bcfContent);
		for (const bib of bibFiles) {
			const relPath = path.posix.normalize(bib.name);
			const dir = path.posix.dirname(relPath);
			if (dir && dir !== ".") {
				mkdirTree(mod, path.posix.join(workDir, dir));
			}
			BFS.writeFile(path.posix.join(workDir, relPath), bib.content);
		}

		let exitCode = 0;
		try {
			exitCode = mod.callMain([
				"/opt/perl-wasm/bin/biber",
				"--output-format=bbl",
				`--outfile=${bblName}`,
				"--nolog",
				bcfName,
			]);
		} catch (err) {
			exitCode =
				typeof err === "object" && err !== null && "status" in err &&
				typeof (err as { status: unknown }).status === "number"
					? ((err as { status: number }).status)
					: 1;
		}
		if (exitCode !== 0) {
			console.error(
				`[TeXWASM] Biber failed (exit code ${exitCode})\n${output.join("\n")}`,
			);
			return false;
		}

		const bblFull = path.posix.join(workDir, bblName);
		let bblOutput: string | null = null;
		try {
			if (BFS.analyzePath(bblFull).exists) {
				bblOutput = BFS.readFile(bblFull, { encoding: "utf8" });
			}
		} catch {}
		if (!bblOutput) {
			console.error(`[TeXWASM] Biber returned empty .bbl for ${bcfPath}`);
			return false;
		}
		const bblPath = path.posix.join(projectDir, texName.replace(/\.tex$/i, ".bbl"));
		M.FS.writeFile(bblPath, bblOutput);
		return true;
	} catch (err) {
		console.error(`[TeXWASM] Biber failed: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

async function handleInit(request: WorkerInitRequest): Promise<void> {
	try {
		assetsDirGlobal = request.assetsDir;
		biberAssetsDirGlobal = request.biberAssetsDir;
		includeExtraBundleGlobal = request.includeExtraBundle;
		// Verify assets exist
		const required = ["busytex.js", "busytex.wasm", "texlive-basic.js", "texlive-basic.data"];
		if (includeExtraBundleGlobal) {
			required.push("texlive-extra.js", "texlive-extra.data");
		}
		for (const f of required) {
			if (!fs.existsSync(path.join(assetsDirGlobal, f))) {
				throw new Error(`Required asset not found: ${f}`);
			}
		}
		parentPort?.postMessage({
			type: "init-result",
			requestId: request.requestId,
			success: true,
		});
	} catch (err) {
		parentPort?.postMessage({
			type: "init-result",
			requestId: request.requestId,
			success: false,
			errorMessage: err instanceof Error ? err.message : String(err),
		});
	}
}

async function handleCompile(request: WorkerCompileRequest): Promise<void> {
	try {
		// Adopt the latest setting on each compile so a worker initialized before
		// the user toggled texwasm.includeExtraBundle still picks up the new value
		// when createModule() runs below.
		if (request.includeExtraBundle !== undefined) {
			includeExtraBundleGlobal = request.includeExtraBundle;
		}

		const projectDir = "/project";
		const texName = request.texName;
		const auxName = texName.replace(/\.tex$/i, ".aux");
		const pdfName = texName.replace(/\.tex$/i, ".pdf");
		const logName = texName.replace(/\.tex$/i, ".log");

		let savedFiles: Map<string, Uint8Array>;

		// Module A: create files, Pass 1, bibliography processor, save results
		{
			const M1 = await createModule();

			// Mount extra package files first so that project files win on
			// name collisions (writeFiles overwrites).
			mkdirTree(M1, projectDir);
			if (request.extraFiles && request.extraFiles.length > 0) {
				mountExtraFiles(M1, request.extraFiles);
			}

			const files = new Map<string, Uint8Array | string>();
			for (const pf of request.projectFiles) {
				files.set(pf.path, pf.content);
			}
			files.set(texName, request.sourceContent);
			writeFiles(M1, projectDir, files);

			runEnginePass(M1, request.engine, texName, `pass 1/${request.compilationPasses}`);

			if (request.bibtexEnabled) {
				const auxPath = path.posix.join(projectDir, auxName);
				if (request.biblioBackend === "biber") {
					const bibFiles = findBibFiles(request.projectFiles);
					if (bibFiles.length === 0) {
						const memBibFiles = findAuxBibFiles(M1, projectDir);
						bibFiles.push(...memBibFiles);
					}
					if (needsBiber(M1, auxPath)) {
						sendLog("Running biber");
						await runBiber(M1, texName, bibFiles);
					}
				} else if (request.biblioBackend === "bibtex8") {
					if (needsBibtex(M1, auxPath)) {
						sendLog("Running bibtex8");
						callMainSuppress(M1, [
							"bibtex8",
							"-8",
							texName.replace(/\.tex$/i, ""),
						]);
					}
				}
			}

			if (request.makeindexEnabled) {
				const idxPath = path.posix.join(
					projectDir,
					texName.replace(/\.tex$/i, ".idx"),
				);
				if (hasIndexEntries(M1, idxPath)) {
					sendLog("Running makeindex");
					callMainSuppress(M1, [
						"makeindex",
						texName.replace(/\.tex$/i, ""),
					]);
				}
			}

			savedFiles = readAllFiles(M1, projectDir);
		}

		// Module B: fresh Module (clean memory, no glyph_unicode_tree issue)
		{
			const M2 = await createModule();

			// Extras first (project files win on collisions), same as Module A
			mkdirTree(M2, projectDir);
			if (request.extraFiles && request.extraFiles.length > 0) {
				mountExtraFiles(M2, request.extraFiles);
			}
			writeFiles(M2, projectDir, savedFiles);

			for (let i = 1; i < request.compilationPasses; i++) {
				runEnginePass(M2, request.engine, texName, `pass ${i + 1}/${request.compilationPasses}`);
			}

			let logContent = "";
			try {
				logContent = M2.FS.readFile(path.posix.join(projectDir, logName), {
					encoding: "utf8",
				});
			} catch {}

			let pdfBytes: Uint8Array | null = null;
			try {
				pdfBytes = M2.FS.readFile(path.posix.join(projectDir, pdfName), {
					encoding: "binary",
				});
			} catch {}

			const auxFiles: { [name: string]: Uint8Array } = {};
			const auxNames = texName.replace(/\.tex$/i, "");
			const auxExts = [".bcf", ".bbl"];
			if (request.makeindexEnabled) {
				auxExts.push(".idx", ".ind", ".ilg");
			}
			for (const ext of auxExts) {
				try {
					const data = M2.FS.readFile(path.posix.join(projectDir, auxNames + ext), {
						encoding: "binary",
					});
					auxFiles[ext] = data;
				} catch {}
			}

			parentPort?.postMessage({
				type: "compile-result",
				requestId: request.requestId,
				success: pdfBytes !== null,
				pdfBytes,
				logContent,
				auxFiles,
			});
		}
	} catch (err) {
		parentPort?.postMessage({
			type: "compile-result",
			requestId: request.requestId,
			success: false,
			errorMessage: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Generate .sty/.cls files from CTAN source packages (.dtx/.ins) via docstrip.
 * Some CTAN packages (e.g. acronym) have no .tds.zip archive and their source
 * zip contains only .dtx/.ins — the .sty must be generated by running the .ins
 * through LaTeX. Runs in a fresh module so the first callMain is safe.
 */
async function handleDocstrip(request: WorkerDocstripRequest): Promise<void> {
	try {
		const projectDir = "/project";
		const M = await createModule();

		const files = new Map<string, Uint8Array | string>();
		for (const f of request.files) {
			files.set(path.posix.basename(f.path), f.content);
		}
		writeFiles(M, projectDir, files);

		const insNames = request.files
			.map((f) => path.posix.basename(f.path))
			.filter((p) => p.toLowerCase().endsWith(".ins"));

		for (const ins of insNames) {
			callMainSuppress(M, [
				"pdflatex",
				"-progname=pdflatex",
				"-interaction=nonstopmode",
				ins,
			]);
		}

		const inputNames = new Set(
			request.files.map((f) => path.posix.basename(f.path).toLowerCase()),
		);
		const generated: { path: string; content: Uint8Array }[] = [];
		for (const [name, content] of readAllFiles(M, projectDir)) {
			if (!inputNames.has(path.posix.basename(name).toLowerCase())) {
				generated.push({ path: name, content });
			}
		}

		parentPort?.postMessage({
			type: "docstrip-result",
			requestId: request.requestId,
			success: true,
			files: generated,
		});
	} catch (err) {
		parentPort?.postMessage({
			type: "docstrip-result",
			requestId: request.requestId,
			success: false,
			errorMessage: err instanceof Error ? err.message : String(err),
		});
	}
}

async function handleRequest(request: WorkerRequest): Promise<void> {
	switch (request.type) {
		case "init":
			return handleInit(request);
		case "compile":
			return handleCompile(request);
		case "docstrip":
			return handleDocstrip(request);
		default:
			parentPort?.postMessage({
				type: "error",
				requestId: 0,
				errorMessage: `Unknown request type`,
			});
	}
}

if (parentPort) {
	parentPort.on("message", handleRequest);
}
