import * as fs from "node:fs";
import * as https from "node:https";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as tar from "tar";
import * as vscode from "vscode";
import {
	getAssetsDir,
	getBiberDir,
	getExtensionAssetsDir,
	getExtensionBiberDir,
	resolveAssetPath,
	resolveAssetsDir,
	resolveBiberPath,
} from "./storage";
import assetUrls from "./assetUrls.json";
import * as pkg from "../../package.json";

const BASE_ASSETS = ["busytex.js", "busytex.wasm", "texlive-basic.js", "texlive-basic.data"];

const EXTRA_ASSETS = ["texlive-extra.js", "texlive-extra.data"];

const BIBER_FILES = ["biber_wasm.js", "biber_wasm_bg.wasm", "biber_wasm.d.ts", "biber_wasm_bg.wasm.d.ts"];

/** Marker file storing the version the cached assets were downloaded from. */
const VERSION_FILE = ".version";

/** The engine asset URL acts as the version identifier: the release tag (e.g.
 *  the date) is embedded in the URL and changes whenever a new busytex release
 *  is published. */
const ENGINE_VERSION = assetUrls.engineBaseUrl;

/** Likewise, the biber release version is embedded in its download URL. */
const BIBER_VERSION = assetUrls.biber;

function readVersion(dir: string): string | undefined {
	try {
		const version = fs.readFileSync(path.join(dir, VERSION_FILE), "utf8");
		return version.length > 0 ? version : undefined;
	} catch {
		return undefined;
	}
}

function writeVersion(dir: string, version: string): void {
	fs.writeFileSync(path.join(dir, VERSION_FILE), version, "utf8");
}

/** Remove a whole cache directory (and any version marker inside it). */
function removeCachedDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function getRequiredAssets(includeExtra: boolean): string[] {
	return includeExtra ? [...BASE_ASSETS, ...EXTRA_ASSETS] : BASE_ASSETS;
}

const GITHUB_RELEASES_URL = `${pkg.repository.url}/releases`;

/**
 * Show an error when WASM assets could not be downloaded and direct the user to
 * the pre-bundled alternative: the '*-with-assets.vsix' file produced by the
 * release workflow (see .github/workflows/release.yml) on the GitHub releases
 * page, which ships the assets inside the extension itself.
 */
export async function showAssetDownloadError(detail: string): Promise<void> {
	const action = await vscode.window.showErrorMessage(
		`TeXWASM: ${detail} If the download is not possible, install the '*-with-assets.vsix' file from the GitHub releases page instead \u2014 it bundles the WASM assets with the extension.`,
		"Open GitHub Releases",
	);
	if (action === "Open GitHub Releases") {
		await vscode.env.openExternal(vscode.Uri.parse(GITHUB_RELEASES_URL));
	}
}

function downloadFile(url: string, destPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		https
			.get(url, (response) => {
				if (response.statusCode === 302 || response.statusCode === 301) {
					const redirectUrl = response.headers.location;
					if (redirectUrl) {
						downloadFile(redirectUrl, destPath).then(resolve, reject);
						return;
					}
				}
				if (response.statusCode !== 200) {
					reject(new Error(`HTTP ${response.statusCode} for ${url}`));
					return;
				}
				const file = fs.createWriteStream(destPath);
				response.pipe(file);
				file.on("finish", () => {
					file.close();
					resolve();
				});
			})
			.on("error", (err) => {
				fs.unlink(destPath, () => {});
				reject(err);
			});
	});
}

function downloadToBuffer(url: string): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		https
			.get(url, (response) => {
				if (response.statusCode === 302 || response.statusCode === 301) {
					const redirectUrl = response.headers.location;
					if (redirectUrl) {
						downloadToBuffer(redirectUrl).then(resolve, reject);
						return;
					}
				}
				if (response.statusCode !== 200) {
					reject(new Error(`HTTP ${response.statusCode} for ${url}`));
					return;
				}
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => resolve(Buffer.concat(chunks)));
				response.on("error", reject);
			})
			.on("error", reject);
	});
}

export class AssetManager {
	private context: vscode.ExtensionContext;
	private _includeExtra = false;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		this._includeExtra = vscode.workspace
			.getConfiguration("texwasm")
			.get<boolean>("includeExtraBundle", false);
	}

	get assetsDir(): string {
		return resolveAssetsDir(this.context);
	}

	get biberDir(): string {
		return getBiberDir(this.context);
	}

	private get requiredAssets(): string[] {
		return getRequiredAssets(this._includeExtra);
	}

	private get sizeLabel(): string {
		return this._includeExtra ? "~500 MB" : "~120 MB";
	}

	isDownloaded(): boolean {
		return this.requiredAssets.every(
			(file) => resolveAssetPath(this.context, file) !== undefined,
		);
	}

	biberDownloaded(): boolean {
		return BIBER_FILES.some(
			(file) => resolveBiberPath(this.context, file) !== undefined,
		);
	}

	/** True when the downloaded assets in globalStorage are stale: a new
	 *  busytex release is referenced by assetUrls.json, or assets were cached
	 *  before the version marker existed. */
	private needsEngineUpdate(): boolean {
		// Bundled assets ship with the extension, so they are always current.
		if (fs.existsSync(path.join(getExtensionAssetsDir(this.context), "busytex.js"))) {
			return false;
		}
		const assetsDir = getAssetsDir(this.context);
		if (!fs.existsSync(path.join(assetsDir, "busytex.js"))) {
			return false;
		}
		const cachedVersion = readVersion(assetsDir);
		// No marker means the cache predates version tracking; refresh it.
		return cachedVersion !== ENGINE_VERSION;
	}

	async ensureAssets(): Promise<boolean> {
		if (this.needsEngineUpdate()) {
			removeCachedDir(getAssetsDir(this.context));
		}
		if (this.isDownloaded()) {
			return true;
		}

		const result = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `TeXWASM: Downloading engine assets (${this.sizeLabel})`,
				cancellable: true,
			},
			async (progress, token) => {
				return this.downloadAssets(progress, token);
			},
		);

		return result;
	}

	/** True when the downloaded biber in globalStorage is stale: a new biber
	 *  release is referenced by assetUrls.json, or biber was cached before the
	 *  version marker existed. */
	private needsBiberUpdate(): boolean {
		// Bundled biber ships with the extension, so it is always current.
		if (fs.existsSync(path.join(getExtensionBiberDir(this.context), "biber_wasm.js"))) {
			return false;
		}
		const biberDir = getBiberDir(this.context);
		if (!fs.existsSync(path.join(biberDir, "biber_wasm.js"))) {
			return false;
		}
		const cachedVersion = readVersion(biberDir);
		// No marker means the cache predates version tracking; refresh it.
		return cachedVersion !== BIBER_VERSION;
	}

	async ensureBiber(): Promise<boolean> {
		if (this.needsBiberUpdate()) {
			removeCachedDir(getBiberDir(this.context));
		}
		if (this.biberDownloaded()) {
			return true;
		}

		const result = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "TeXWASM: Downloading biber WASM (~4 MB)",
				cancellable: true,
			},
			async (progress, token) => {
				try {
					progress.report({ message: "Downloading biber WASM..." });
					if (!fs.existsSync(this.biberDir)) {
						fs.mkdirSync(this.biberDir, { recursive: true });
					}

					const buffer = await downloadToBuffer(assetUrls.biber);

					if (token.isCancellationRequested) return false;

					progress.report({ message: "Extracting biber WASM..." });
					const gunzip = zlib.createGunzip();
					await new Promise<void>((resolve, reject) => {
						const extractor = tar.extract({ cwd: this.biberDir });
						extractor.on("finish", () => resolve());
						extractor.on("error", reject);
						gunzip.pipe(extractor);
						gunzip.end(buffer);
					});

					writeVersion(this.biberDir, BIBER_VERSION);
					return true;
				} catch (err) {
					await showAssetDownloadError(
						`Failed to download biber WASM: ${err instanceof Error ? err.message : String(err)}`,
					);
					return false;
				}
			},
		);

		return result;
	}

	private async downloadAssets(
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		token: vscode.CancellationToken,
	): Promise<boolean> {
		try {
			const downloadDir = getAssetsDir(this.context);
			if (!fs.existsSync(downloadDir)) {
				fs.mkdirSync(downloadDir, { recursive: true });
			}

			const assets = this.requiredAssets;
			const totalFiles = assets.length;

			for (const file of assets) {
				if (token.isCancellationRequested) {
					return false;
				}

				const destPath = path.join(downloadDir, file);
				if (fs.existsSync(destPath)) {
					progress.report({
						message: `${file} (already cached)`,
						increment: (1 / totalFiles) * 100,
					});
					continue;
				}

				progress.report({
					message: `Downloading ${file}...`,
					increment: (1 / totalFiles) * 100,
				});

				await this.downloadFile(file, destPath);
			}

			writeVersion(downloadDir, ENGINE_VERSION);
			return true;
		} catch (err) {
			await showAssetDownloadError(
				`Failed to download engine assets: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	}

	private downloadFile(filename: string, destPath: string): Promise<void> {
		const url = `${assetUrls.engineBaseUrl}/${filename}`;
		return downloadFile(url, destPath);
	}
}