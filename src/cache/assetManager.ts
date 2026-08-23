import * as fs from "node:fs";
import * as https from "node:https";
import * as path from "node:path";
import * as vscode from "vscode";
import * as pkg from "../../package.json";
import assetUrls from "./assetUrls.json";
import {
	getAssetsDir,
	getBiberDir,
	getExtensionAssetsDir,
	getExtensionBiberDir,
	resolveAssetPath,
	resolveAssetsDir,
	resolveBiberPath,
} from "./storage";

const BASE_ASSETS = [
	"busytex.js",
	"busytex.wasm",
	"texlive-basic.js",
	"texlive-basic.data",
];

const EXTRA_ASSETS = ["texlive-extra.js", "texlive-extra.data"];

const BIBER_FILES = ["biber.js", "biber.wasm", "biber.data"];

/** Marker file storing the version the cached assets were downloaded from. */
const VERSION_FILE = ".version";

/** The engine asset URL acts as the version identifier: the release tag (e.g.
 *  the date) is embedded in the URL and changes whenever a new busytex release
 *  is published. */
const ENGINE_VERSION = assetUrls.baseUrl;

/** Likewise, the biber release version is embedded in its download URL. */
const BIBER_VERSION = assetUrls.baseUrl;

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

/** A set of WASM assets that can be downloaded on demand. */
interface AssetBundle {
	/** File names that make up the bundle, fetched from baseUrl. */
	files: string[];
	/** Download URL prefix shared by all files. */
	baseUrl: string;
	/** Version written to the marker file once the download completes. */
	version: string;
	/** Download directory inside globalStorage. */
	dir: string;
	/** Label used when a download fails. */
	errorLabel: string;
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
		return this._includeExtra ? "~530 MB" : "~150 MB";
	}

	isDownloaded(): boolean {
		return this.requiredAssets.every(
			(file) => resolveAssetPath(this.context, file) !== undefined,
		);
	}

	biberDownloaded(): boolean {
		return BIBER_FILES.every(
			(file) => resolveBiberPath(this.context, file) !== undefined,
		);
	}

	/** True when a cached download in globalStorage is stale: a new release is
	 *  referenced by assetUrls.json, or the cache was written before the
	 *  version marker existed. Bundled assets ship with the extension, so they
	 *  are always current. */
	private needsUpdate(
		downloadDir: string,
		bundledDir: string,
		primaryFile: string,
		version: string,
	): boolean {
		if (fs.existsSync(path.join(bundledDir, primaryFile))) {
			return false;
		}
		if (!fs.existsSync(path.join(downloadDir, primaryFile))) {
			return false;
		}
		// No marker means the cache predates version tracking; refresh it.
		return readVersion(downloadDir) !== version;
	}

	async ensureAssets(): Promise<boolean> {
		const assetsDir = getAssetsDir(this.context);
		const biberDir = getBiberDir(this.context);
		if (
			this.needsUpdate(
				assetsDir,
				getExtensionAssetsDir(this.context),
				"busytex.js",
				ENGINE_VERSION,
			)
		) {
			removeCachedDir(assetsDir);
		}
		if (
			this.needsUpdate(
				biberDir,
				getExtensionBiberDir(this.context),
				"biber.js",
				BIBER_VERSION,
			)
		) {
			removeCachedDir(biberDir);
		}
		if (this.isDownloaded() && this.biberDownloaded()) {
			return true;
		}
		return this.downloadBundles(
			`TeXWASM: Downloading engine and biber assets (${this.sizeLabel})`,
			[
				{
					files: this.requiredAssets,
					baseUrl: assetUrls.baseUrl,
					version: ENGINE_VERSION,
					dir: assetsDir,
					errorLabel: "Failed to download engine assets",
				},
				{
					files: BIBER_FILES,
					baseUrl: assetUrls.baseUrl,
					version: BIBER_VERSION,
					dir: biberDir,
					errorLabel: "Failed to download biber WASM",
				},
			],
		);
	}

	/** Download the files of the given asset bundles into their directories,
	 *  skipping files that are already present, and record each bundle's
	 *  version on success. */
	private downloadBundles(
		title: string,
		bundles: AssetBundle[],
	): Promise<boolean> {
		const totalFiles = bundles.reduce(
			(sum, bundle) => sum + bundle.files.length,
			0,
		);
		return Promise.resolve(
			vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title,
					cancellable: true,
				},
				async (progress, token) => {
					let errorLabel = "Failed to download assets";
					try {
						for (const bundle of bundles) {
							errorLabel = bundle.errorLabel;
							if (!fs.existsSync(bundle.dir)) {
								fs.mkdirSync(bundle.dir, { recursive: true });
							}

							for (const file of bundle.files) {
								if (token.isCancellationRequested) {
									return false;
								}

								const destPath = path.join(bundle.dir, file);
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

								await downloadFile(
									`${bundle.baseUrl}/${file}`,
									destPath,
								);
							}

							writeVersion(bundle.dir, bundle.version);
						}
						return true;
					} catch (err) {
						await showAssetDownloadError(
							`${errorLabel}: ${err instanceof Error ? err.message : String(err)}`,
						);
						return false;
					}
				},
			),
		);
	}
}
