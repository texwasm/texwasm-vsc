import * as fs from "node:fs";
import * as https from "node:https";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as tar from "tar";
import * as vscode from "vscode";
import {
	getAssetsDir,
	getBiberDir,
	resolveAssetPath,
	resolveAssetsDir,
	resolveBiberPath,
} from "./storage";
import assetUrls from "./assetUrls.json";

const BASE_ASSETS = ["busytex.js", "busytex.wasm", "texlive-basic.js", "texlive-basic.data"];

const EXTRA_ASSETS = ["texlive-extra.js", "texlive-extra.data"];

const BIBER_FILES = ["biber_wasm.js", "biber_wasm_bg.wasm", "biber_wasm.d.ts", "biber_wasm_bg.wasm.d.ts"];

function getRequiredAssets(includeExtra: boolean): string[] {
	return includeExtra ? [...BASE_ASSETS, ...EXTRA_ASSETS] : BASE_ASSETS;
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

	async ensureAssets(): Promise<boolean> {
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

	async ensureBiber(): Promise<boolean> {
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

					return true;
				} catch (err) {
					vscode.window.showErrorMessage(
						`TeXWASM: Failed to download biber: ${err instanceof Error ? err.message : String(err)}`,
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

			return true;
		} catch (err) {
			vscode.window.showErrorMessage(
				`TeXWASM: Failed to download engine assets: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	}

	private downloadFile(filename: string, destPath: string): Promise<void> {
		const url = `${assetUrls.engineBaseUrl}/${filename}`;
		return downloadFile(url, destPath);
	}
}