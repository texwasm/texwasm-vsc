import * as fs from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";
import { collectPackageNames, scanForPackageRefs } from "../engine/packageScanner";
import type { ProjectFile } from "../engine/types";
import {
	type CtanPackageInfo,
	downloadTdsPackage,
	getSourceZipUrl,
	getTdsDownloadUrl,
	queryPackageInfo,
} from "./ctanApi";

/** Run async operations over items in parallel with a concurrency limit.
 *  Individual rejections are silently swallowed (use allSettled internally). */
async function concurrentPool<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<(R | undefined)[]> {
	if (concurrency < 1) concurrency = 1;
	const results: (R | undefined)[] = new Array(items.length);
	const executing = new Set<Promise<void>>();

	for (const [index, item] of items.entries()) {
		const task = fn(item, index).then(
			(r) => { results[index] = r; },
			() => { /* individual failures are swallowed */ },
		);
		const onDone = task.then(() => { executing.delete(onDone); });
		executing.add(onDone);
		if (executing.size >= concurrency) {
			await Promise.race(executing);
		}
	}

	await Promise.allSettled(executing);
	return results;
}
import { getPackageCacheDir, resolveAssetPath } from "./storage";

// Shared with wasmWorker.ts (duplicated to avoid cross-module dependency)
function extractBalanced(
	src: string,
	marker: string,
	fromEnd = false,
): unknown {
	const start = fromEnd ? src.lastIndexOf(marker) : src.indexOf(marker);
	if (start === -1) throw new Error(`Marker "${marker}" not found`);
	let contentStart = start + marker.length;
	while (contentStart < src.length && src[contentStart] === " ")
		contentStart++;
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

const TEX_LIVE_MOUNT = "/texlive/texmf-dist";
const PACKAGE_CACHE_METADATA = "metadata.json";

/** Extensions worth persisting from a docstrip run (mirrors MOUNTABLE_EXTENSIONS in wasmWorker). */
const DOCSTRIP_KEEP_EXTENSIONS = new Set([
	".sty",
	".cls",
	".def",
	".cfg",
	".fd",
	".ltx",
	".clo",
	".bbx",
	".cbx",
	".lbx",
	".ldf",
	".dfu",
	".bst",
	".tex",
	".lua",
]);

/** Scan a .dtx file's content for `%<*GUARD>` docstrip guard lines and return the
 *  list of guard names that look like package-source guards (i.e. they contain a
 *  \ProvidesPackage{...} or are named package/package-new/<pkgname>). */
function discoverDocstripGuards(
	dtxContent: string,
	packageName: string,
): string[] {
	const pkgLower = packageName.toLowerCase();
	const guardRegex = /^%\*<\+?([\w-]+)>/gm;
	const allGuards = new Set<string>();
	let m: RegExpExecArray | null;
	while ((m = guardRegex.exec(dtxContent)) !== null) {
		allGuards.add(m[1]);
	}
	// Drop known "documentation/install/driver" guards — they never carry the .sty code.
	const skipGuards = new Set(["install", "driver", "ignore", "test", "documentation", "readme"]);
	const guards = [...allGuards].filter((g) => !skipGuards.has(g.toLowerCase()));

	// Heuristic: keep guards that look like package guards. Order: package-new first
	// (Oberdiek style), then `package`, then the lowercase package name itself.
	const order = (g: string): number => {
		if (g === "package-new") return 0;
		if (g === pkgLower) return 1;
		if (g === "package") return 2;
		if (g === `${pkgLower}-new` || g === `${pkgLower}-pkg`) return 3;
		if (/^package/i.test(g)) return 4;
		if (g.toLowerCase() === pkgLower) return 5;
		return 6;
	};
	guards.sort((a, b) => order(a) - order(b));

	// If we found any package-style guards, return them (kept in priority order).
	// Otherwise return a sensible default list.
	const packageGuards = guards.filter(
		(g) =>
			g === "package" ||
			g === "package-new" ||
			g === pkgLower ||
			g.toLowerCase().startsWith(pkgLower),
	);
	if (packageGuards.length > 0) return packageGuards;
	if (guards.length > 0) return guards;
	return ["package", "package-new"];
}

/** Build a synthetic docstrip driver .ins that loads docstrip.tex and
 *  \generate\file{pkg.sty}\from{pkg.dtx}{guards}. */
function makeSyntheticIns(
	dtxBase: string,
	packageName: string,
	dtxContent: string,
): string {
	const guards = discoverDocstripGuards(dtxContent, packageName);
	const guardList = guards.join(",");
	return [
		"\\input docstrip.tex",
		"\\keepsilent",
		"\\askforoverwritefalse",
		`\\generate{\\file{${packageName}.sty}{\\from{${dtxBase}}{${guardList}}}}`,
		"\\endinput",
	].join("\n");
}

/** Generates .sty/.cls files from .dtx/.ins source files (runs docstrip in the WASM engine). */
export type DocstripHandler = (
	files: { path: string; content: Uint8Array }[],
) => Promise<{ path: string; content: Uint8Array }[]>;

export interface PreloadedInfo {
	/** Basenames of .sty and .cls files in the bundle (package/class names) */
	packages: Set<string>;
	/** Basenames of .def files in the bundle */
	defFiles: Set<string>;
}

/**
 * Parse a single preload .js file (e.g. texlive-basic.js) and return
 * the package/class names and .def file names it provides.
 * Exported for unit testing.
 */
export function parsePreloadFile(jsPath: string): PreloadedInfo {
	const packages = new Set<string>();
	const defFiles = new Set<string>();
	if (!fs.existsSync(jsPath)) return { packages, defFiles };

	const src = fs.readFileSync(jsPath, "utf8");
	let metadata: unknown;
	try {
		metadata = extractBalanced(src, "loadPackage(", true);
	} catch {
		return { packages, defFiles };
	}

	// metadata is either an array or an object with a `files` array
	const fileDescriptors: { filename?: string }[] = Array.isArray(metadata)
		? metadata
		: ((metadata as Record<string, unknown>)?.files as { filename?: string }[]) ?? [];

	for (const entry of fileDescriptors) {
		const fn = entry.filename;
		if (!fn) continue;
		const ext = path.extname(fn).toLowerCase();
		const base = path.basename(fn, ext);
		if (ext === ".sty" || ext === ".cls") {
			packages.add(base);
		} else if (ext === ".def") {
			defFiles.add(base);
		}
	}

	return { packages, defFiles };
}

export interface MountEntry {
	/** Virtual path in MEMFS (absolute) */
	targetPath: string;
	/** Content as Uint8Array */
	content: Uint8Array;
}

interface CachedPackage {
	name: string;
	version?: string;
	downloadedAt: number;
	files: string[];
}

export class PackageCache {
	private context: vscode.ExtensionContext;

	/** Cache of package info queries (CTAN JSON responses), keyed by package name */
	private resolvedInfo = new Map<string, CtanPackageInfo | null>();

	/** Set of package/class names available from the preloaded texlive bundles */
	private preloadedPackages: Set<string> | null = null;

	/** Set of .def file basenames available from the preloaded texlive bundles */
	private preloadedDefFiles: Set<string> | null = null;

	/** Optional docstrip handler for generating .sty/.cls from .ins sources */
	private docstripHandler: DocstripHandler | null = null;

	/** Whether the texlive-extra bundle will be loaded into the WASM filesystem */
	private includeExtraBundle = false;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
	}

	/** Inject the docstrip handler (provided by the Compiler, which owns the WASM worker). */
	setDocstripHandler(handler: DocstripHandler): void {
		this.docstripHandler = handler;
	}

	/** Must reflect the texwasm.includeExtraBundle setting so preload checks match reality. */
	setIncludeExtraBundle(value: boolean): void {
		if (this.includeExtraBundle !== value) {
			this.includeExtraBundle = value;
			// Bundle set changed → recompute preload info lazily
			this.preloadedPackages = null;
			this.preloadedDefFiles = null;
		}
	}

	/** Lazily populate the preloadedPackages and preloadedDefFiles sets from downloaded asset bundles.
	 *  Only bundles that are actually loaded into the WASM filesystem count:
	 *  texlive-basic is always loaded; texlive-extra only when includeExtraBundle is enabled. */
	private ensurePreloadedPackages(): void {
		if (this.preloadedPackages !== null) return;

		const pkgs = new Set<string>();
		const defs = new Set<string>();
		const jsFiles = ["texlive-basic.js"];
		if (this.includeExtraBundle) {
			jsFiles.push("texlive-extra.js");
		}

		for (const jsFile of jsFiles) {
			const jsPath = resolveAssetPath(this.context, jsFile);
			if (!jsPath) continue;
			try {
				const info = parsePreloadFile(jsPath);
				for (const n of info.packages) pkgs.add(n);
				for (const n of info.defFiles) defs.add(n);
			} catch {
				// skip malformed preload files
			}
		}

		this.preloadedPackages = pkgs;
		this.preloadedDefFiles = defs;
	}

	isPreloaded(packageName: string): boolean {
		this.ensurePreloadedPackages();
		return this.preloadedPackages?.has(packageName.toLowerCase()) ?? false;
	}

	/** Check if a .def file with the given basename is in the preloaded bundles */
	isPreloadedDef(basename: string): boolean {
		this.ensurePreloadedPackages();
		return this.preloadedDefFiles?.has(basename.toLowerCase()) ?? false;
	}

	get cacheDir(): string {
		return getPackageCacheDir(this.context);
	}

	private pkgDir(packageName: string): string {
		return path.join(this.cacheDir, "pkgs", packageName.toLowerCase());
	}

	hasPackage(packageName: string): boolean {
		const dir = this.pkgDir(packageName);
		return fs.existsSync(path.join(dir, PACKAGE_CACHE_METADATA));
	}

	/** Get the mount entries for a single cached package */
	getPackageMountEntries(packageName: string): MountEntry[] {
		const dir = this.pkgDir(packageName);
		const metaPath = path.join(dir, PACKAGE_CACHE_METADATA);
		if (!fs.existsSync(metaPath)) return [];

		const meta: CachedPackage = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
		const entries: MountEntry[] = [];
		let firstStyContent: Uint8Array | undefined;

		for (const filePath of meta.files) {
			const absPath = path.join(dir, filePath);
			if (!fs.existsSync(absPath)) continue;

			const relativeInTex = path.relative(dir, absPath);
			// Files are extracted with TDS structure under tex/
			// Map: tex/latex/foo/foo.sty → /texlive/texmf-dist/tex/latex/foo/foo.sty
			const posixRel = relativeInTex.replace(/\\/g, "/");
			const targetPath = `${TEX_LIVE_MOUNT}/${posixRel}`;

			let content: Uint8Array;
			try {
				content = fs.readFileSync(absPath);
			} catch {
				continue;
			}

			entries.push({ targetPath, content });

			// Track the first .sty file content for potential alias
			if (filePath.endsWith(".sty") && !firstStyContent) {
				firstStyContent = content;
			}
		}

		// If no .sty file is named {packageName}.sty, create an alias entry
		// so \usepackage{packageName} can find it (e.g. tabulary-v010.sty → tabulary.sty)
		const expectedSty = `${packageName}.sty`;
		const hasExact = entries.some(
			(e) => path.posix.basename(e.targetPath) === expectedSty,
		);
		if (firstStyContent && !hasExact) {
			entries.push({
				targetPath: `${TEX_LIVE_MOUNT}/${expectedSty}`,
				content: firstStyContent,
			});
		}

		return entries;
	}

	/** Get all mount entries for a list of package names */
	getMountEntriesForPackages(packageNames: string[]): MountEntry[] {
		const all: MountEntry[] = [];
		for (const name of packageNames) {
			all.push(...this.getPackageMountEntries(name));
		}

		// Deduplicate by targetPath (last wins)
		const map = new Map<string, MountEntry>();
		for (const e of all) {
			map.set(e.targetPath, e);
		}
		return Array.from(map.values());
	}

	/** Query CTAN API and cache package info */
	async resolvePackage(packageName: string): Promise<CtanPackageInfo | null> {
		if (this.resolvedInfo.has(packageName)) {
			return this.resolvedInfo.get(packageName) as CtanPackageInfo;
		}

		const info = await queryPackageInfo(packageName);
		this.resolvedInfo.set(packageName, info);
		return info;
	}

	/**
	 * If a cached package ships only .dtx/.ins sources (no usable .sty/.cls),
	 * run docstrip in the WASM engine to generate them and persist the results
	 * into the package cache. No-op when the package already has .sty/.cls
	 * files or no docstrip handler is configured.
	 */
	private async maybeGenerateFromIns(
		packageName: string,
		progress?: (msg: string) => void,
	): Promise<void> {
		if (!this.docstripHandler) return;
		const dir = this.pkgDir(packageName);
		const metaPath = path.join(dir, PACKAGE_CACHE_METADATA);
		if (!fs.existsSync(metaPath)) return;

		let meta: CachedPackage;
		try {
			meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
		} catch {
			return;
		}

		const hasSty = meta.files.some((f) => /\.(sty|cls)$/i.test(f));
		const insFiles = meta.files.filter((f) => /\.ins$/i.test(f));
		// DTX files without a matching .ins (e.g. pdflscape) often embed their
		// own install driver gated on \let\install=y. We synthesize a tiny
		// wrapper .ins to invoke the .dtx's install guard via docstrip.
		const dtxFiles = meta.files.filter(
			(f) => /\.dtx$/i.test(f) && !insFiles.some((i) => i.replace(/\.ins$/i, ".dtx").toLowerCase() === f.toLowerCase()),
		);

		if (hasSty || (insFiles.length === 0 && dtxFiles.length === 0)) return;

		const inputFiles: { path: string; content: Uint8Array }[] = [];
		const inputNames = new Set<string>();
		for (const rel of meta.files) {
			const absPath = path.join(dir, rel);
			if (!fs.existsSync(absPath)) continue;
			const base = path.basename(rel);
			inputNames.add(base.toLowerCase());
			try {
				inputFiles.push({ path: base, content: fs.readFileSync(absPath) });
			} catch {
				// skip unreadable files
			}
		}

		// Synthesize an install driver .ins for each .dtx that's missing its .ins.
		// We load docstrip.tex directly and call \generate with guards discovered
		// by scanning the .dtx for `%<*GUARD>` markers (e.g. `package-new`,
		// `package`, or the lowercase package name). Unknown guards are ignored by
		// docstrip, so an inert list is safe.
		for (const dtx of dtxFiles) {
			const dtxBase = path.basename(dtx);
			const synthBase = dtxBase.replace(/\.dtx$/i, "-driver.ins");
			if (inputNames.has(synthBase.toLowerCase())) continue;
			inputNames.add(synthBase.toLowerCase());
			let dtxContent = "";
			try {
				dtxContent = fs.readFileSync(path.join(dir, dtx), "utf-8");
			} catch {
				continue;
			}
			inputFiles.push({
				path: synthBase,
				content: Buffer.from(
					makeSyntheticIns(dtxBase, packageName, dtxContent),
					"utf-8",
				),
			});
		}

		progress?.(
			`Generating .sty for '${packageName}' from .ins/.dtx sources (docstrip)...`,
		);
		try {
			const generated = await this.docstripHandler(inputFiles);
			const newFiles: string[] = [];
			for (const g of generated) {
				const base = path.basename(g.path);
				const ext = path.extname(base).toLowerCase();
				if (inputNames.has(base.toLowerCase())) continue;
				if (!DOCSTRIP_KEEP_EXTENSIONS.has(ext)) continue;
				fs.writeFileSync(path.join(dir, base), g.content);
				newFiles.push(base);
			}
			if (newFiles.length > 0) {
				meta.files.push(...newFiles);
				fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
				progress?.(
					`Generated ${newFiles.join(", ")} for '${packageName}'.`,
				);
			}
		} catch {
			// Docstrip is best-effort; compilation continues without the package
		}
	}

	/** Download a TDS package from CTAN, extract to cache, return mount entries */
	async downloadPackage(
		packageName: string,
		progress?: (msg: string) => void,
	): Promise<MountEntry[]> {
		const nameLower = packageName.toLowerCase();
		const destDir = this.pkgDir(nameLower);

		// Ensure parent exists
		if (!fs.existsSync(path.dirname(destDir))) {
			fs.mkdirSync(path.dirname(destDir), { recursive: true });
		}

		// If already cached, just return the mount entries (healing first if needed)
		if (this.hasPackage(packageName)) {
			await this.maybeGenerateFromIns(nameLower, progress);
			return this.getPackageMountEntries(packageName);
		}

		// Skip CTAN query if this package is fully preloaded (both .sty/.cls and .def files present)
		if (this.isPreloaded(packageName) && this.isPreloadedDef(packageName)) {
			return [];
		}

		// Query CTAN API
		progress?.(`Querying CTAN for package '${packageName}'...`);
		const info = await this.resolvePackage(packageName);
		if (!info) {
			console.log(`[DEBUG] ${packageName}: no info from CTAN API`);
			return [];
		}

		// Try TDS download URL first, fall back to source zip
		const tdsUrl = getTdsDownloadUrl(info);
		const sourceUrl = getSourceZipUrl(info);
		const downloadPairs: [string, string][] = [];
		if (tdsUrl) downloadPairs.push([tdsUrl, "TDS"]);
		if (sourceUrl) downloadPairs.push([sourceUrl, "source"]);
		if (downloadPairs.length === 0) return [];

		if (!fs.existsSync(destDir)) {
			fs.mkdirSync(destDir, { recursive: true });
		}

		let extractedFiles: string[] = [];
		for (const [url, kind] of downloadPairs) {
			// Clean destDir before each attempt to avoid stale files
			if (fs.existsSync(destDir)) {
				fs.rmSync(destDir, { recursive: true, force: true });
			}
			fs.mkdirSync(destDir, { recursive: true });
			progress?.(`Downloading '${packageName}' (${kind} archive) from CTAN...`);
			try {
				extractedFiles = await downloadTdsPackage(
					url,
					destDir,
					kind === "source" ? packageName : undefined,
				);
				break;
			} catch (err) {
				progress?.(
					`Download of '${packageName}' (${kind} archive) failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				// fall through to next URL
			}
		}
		if (extractedFiles.length === 0) {
			progress?.(`Could not download '${packageName}' from CTAN.`);
			return [];
		}

		// Normalize file paths to be relative to destDir
		const relativeFiles = extractedFiles.map((f) => path.relative(destDir, f));

		// Save metadata
		const meta: CachedPackage = {
			name: packageName,
			version: info.version,
			downloadedAt: Date.now(),
			files: relativeFiles,
		};
		fs.writeFileSync(
			path.join(destDir, PACKAGE_CACHE_METADATA),
			JSON.stringify(meta, null, 2),
			"utf-8",
		);

		await this.maybeGenerateFromIns(nameLower, progress);
		return this.getPackageMountEntries(packageName);
	}

	/** Scan the cached files of the given packages for \usepackage / \RequirePackage /
	 *  \documentclass references and return names that are not in `exclude` and not
	 *  already in the CTAN-metadata cache. Used to recursively resolve transitive
	 *  dependencies that appear only inside downloaded .sty/.cls/.def files
	 *  (e.g. `acronym` → `suffix`). */
	private discoverDependencies(
		packageNames: string[],
		exclude: Set<string>,
	): string[] {
		const found = new Set<string>();
		for (const name of packageNames) {
			const dir = this.pkgDir(name);
			const metaPath = path.join(dir, PACKAGE_CACHE_METADATA);
			if (!fs.existsSync(metaPath)) continue;
			let meta: CachedPackage;
			try {
				meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
			} catch {
				continue;
			}
			for (const rel of meta.files) {
				if (!/\.(sty|cls|def|fd|cfg|lbx|ldf|ltx)$/i.test(rel)) continue;
				const abs = path.join(dir, rel);
				let content: string;
				try {
					content = fs.readFileSync(abs, "utf-8");
				} catch {
					continue;
				}
				for (const ref of scanForPackageRefs(content)) {
					if (exclude.has(ref.name)) continue;
					if (found.has(ref.name)) continue;
					found.add(ref.name);
				}
			}
		}
		return Array.from(found);
	}

	/** Given source content + project files, resolve all packages and download missing ones.
	 *  Returns mount entries for all downloaded packages.
	 *  CTAN API queries run in parallel (concurrency 10); downloads run in parallel (concurrency 5).
	 *  Dependencies discovered inside downloaded .sty/.cls files are resolved recursively
	 *  (up to MAX_RESOLVE_ITERATIONS passes) so transitive requirements like
	 *  `acronym` → `suffix` are fetched automatically. */
	async ensurePackages(
		sourceContent: string,
		projectFiles: ProjectFile[],
		progress?: (msg: string) => void,
	): Promise<MountEntry[]> {
		const initialNames = collectPackageNames(sourceContent, projectFiles);
		if (initialNames.length === 0) return [];

		const queued = new Set<string>();
		const queue: string[] = [];
		for (const name of initialNames) {
			if (this.isPreloaded(name)) continue;
			if (queued.has(name)) continue;
			queued.add(name);
			queue.push(name);
		}

		const allEntries: MountEntry[] = [];
		const MAX_ITERATIONS = 8;

		for (let iter = 0; iter < MAX_ITERATIONS && queue.length > 0; iter++) {
			const batch = queue.splice(0);

			// Phase 1: Batch-resolve CTAN API queries (high concurrency, lightweight)
			const toResolve = batch.filter(
				(name) =>
					!this.hasPackage(name) && !this.resolvedInfo.has(name),
			);
			if (toResolve.length > 0) {
				await concurrentPool(toResolve, 10, async (name) => {
					progress?.(`Querying CTAN for '${name}'...`);
					const info = await queryPackageInfo(name);
					this.resolvedInfo.set(name, info);
				});
			}

			// Phase 2: Batch-download packages (lower concurrency, bandwidth-heavy).
			// downloadPackage() serves already-cached packages from disk without
			// re-hitting the network.
			const toDownload = batch.filter((name) => {
				if (this.isPreloaded(name)) return false;
				const info = this.resolvedInfo.get(name);
				return this.hasPackage(name) || (info !== null && info !== undefined);
			});

			const rawResults = await concurrentPool(toDownload, 5, async (name) =>
				this.downloadPackage(name, progress),
			);
			for (const r of rawResults) {
				if (r) allEntries.push(...r);
			}

			// Phase 3: discover transitive deps from packages that are now cached,
			// and queue any not already known for the next iteration.
			const toScan = batch.filter((name) => this.hasPackage(name));
			if (toScan.length === 0) continue;
			const deps = this.discoverDependencies(toScan, queued);
			for (const d of deps) {
				if (this.isPreloaded(d)) continue;
				queued.add(d);
				queue.push(d);
			}
			if (deps.length > 0) {
				progress?.(
					`Discovered ${deps.length} transitive package(s): ${deps.join(", ")}.`,
				);
			}
		}

		// Deduplicate by targetPath (last wins)
		const map = new Map<string, MountEntry>();
		for (const e of allEntries) {
			map.set(e.targetPath, e);
		}
		return Array.from(map.values());
	}

	/** List all cached packages */
	listCachedPackages(): string[] {
		const pkgsDir = path.join(this.cacheDir, "pkgs");
		if (!fs.existsSync(pkgsDir)) return [];

		const result: string[] = [];
		const entries = fs.readdirSync(pkgsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const metaPath = path.join(pkgsDir, entry.name, PACKAGE_CACHE_METADATA);
				if (fs.existsSync(metaPath)) {
					result.push(entry.name);
				}
			}
		}
		return result;
	}

	/** Clear all cached packages */
	clearCache(): void {
		const pkgsDir = path.join(this.cacheDir, "pkgs");
		if (fs.existsSync(pkgsDir)) {
			fs.rmSync(pkgsDir, { recursive: true, force: true });
		}
	}
}
