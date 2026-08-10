import * as fs from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";

export function getStorageDir(context: vscode.ExtensionContext): string {
	return context.globalStorageUri.fsPath;
}

export function getAssetsDir(context: vscode.ExtensionContext): string {
	return path.join(getStorageDir(context), "assets");
}

/** Directory inside the extension root where WASM engine assets may be bundled. */
export function getExtensionAssetsDir(context: vscode.ExtensionContext): string {
	return path.join(context.extensionPath, "assets", "busytex");
}

/**
 * Locate a WASM engine asset file. Assets bundled in the extension root folder
 * take priority; if they are not available there, fall back to the assets
 * downloaded into globalStorage.
 */
export function resolveAssetPath(
	context: vscode.ExtensionContext,
	fileName: string,
): string | undefined {
	const bundledPath = path.join(getExtensionAssetsDir(context), fileName);
	if (fs.existsSync(bundledPath)) return bundledPath;
	const globalPath = path.join(getAssetsDir(context), fileName);
	if (fs.existsSync(globalPath)) return globalPath;
	return undefined;
}

/**
 * Resolve the directory that provides the WASM engine assets. If the assets are
 * available in the extension root folder, they are used; otherwise fall back to
 * the assets downloaded into globalStorage.
 */
export function resolveAssetsDir(context: vscode.ExtensionContext): string {
	if (fs.existsSync(path.join(getExtensionAssetsDir(context), "busytex.js"))) {
		return getExtensionAssetsDir(context);
	}
	return getAssetsDir(context);
}

export function getBiberDir(context: vscode.ExtensionContext): string {
	return path.join(getStorageDir(context), "biber");
}

/** Directory inside the extension root where biber WASM assets may be bundled. */
export function getExtensionBiberDir(context: vscode.ExtensionContext): string {
	return path.join(context.extensionPath, "assets", "biber");
}

/**
 * Locate a biber WASM asset file. Assets bundled in the extension root folder
 * take priority; if they are not available there, fall back to the assets
 * downloaded into globalStorage.
 */
export function resolveBiberPath(
	context: vscode.ExtensionContext,
	fileName: string,
): string | undefined {
	const bundledPath = path.join(getExtensionBiberDir(context), fileName);
	if (fs.existsSync(bundledPath)) return bundledPath;
	const globalPath = path.join(getBiberDir(context), fileName);
	if (fs.existsSync(globalPath)) return globalPath;
	return undefined;
}

/**
 * Resolve the directory that provides the biber WASM assets. If the assets are
 * available in the extension root folder, they are used; otherwise fall back to
 * the assets downloaded into globalStorage.
 */
export function resolveBiberDir(context: vscode.ExtensionContext): string {
	if (fs.existsSync(path.join(getExtensionBiberDir(context), "biber_wasm.js"))) {
		return getExtensionBiberDir(context);
	}
	return getBiberDir(context);
}

export function getPackageCacheDir(context: vscode.ExtensionContext): string {
	return path.join(getStorageDir(context), "packages");
}

export function getFontIndexDir(context: vscode.ExtensionContext): string {
	return path.join(getStorageDir(context), "font-index");
}

export function getBusytexJsPath(context: vscode.ExtensionContext): string {
	return path.join(getAssetsDir(context), "busytex.js");
}

export function getBusytexWasmPath(context: vscode.ExtensionContext): string {
	return path.join(getAssetsDir(context), "busytex.wasm");
}
