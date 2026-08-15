import * as vscode from "vscode";
import { DEFAULT_RECIPES, DEFAULT_TOOLS } from "../engine/recipe";
import type { BiblioBackendType, EngineType, Recipe, RecipeTool } from "../engine/types";

export function getEngine(resourceUri?: vscode.Uri): EngineType {
	return vscode.workspace
		.getConfiguration("texwasm", resourceUri ?? null)
		.get<EngineType>("engine", "pdflatex");
}

export function getOutputDirectory(resourceUri?: vscode.Uri): string {
	return vscode.workspace
		.getConfiguration("texwasm", resourceUri ?? null)
		.get<string>("outputDirectory", "");
}

export function getAutoCompile(resourceUri?: vscode.Uri): boolean {
	return vscode.workspace
		.getConfiguration("texwasm", resourceUri ?? null)
		.get<boolean>("autoCompile", true);
}

export function getBibtexEnabled(resourceUri?: vscode.Uri): boolean {
	return vscode.workspace
		.getConfiguration("texwasm", resourceUri ?? null)
		.get<boolean>("bibtexEnabled", true);
}

export function getBiblioBackend(resourceUri?: vscode.Uri): BiblioBackendType {
	return vscode.workspace
		.getConfiguration("texwasm", resourceUri ?? null)
		.get<BiblioBackendType>("biblioBackend", "bibtex8");
}

export function getCompilationPasses(resourceUri?: vscode.Uri): number {
	return vscode.workspace
		.getConfiguration("texwasm", resourceUri ?? null)
		.get<number>("compilationPasses", 3);
}

export function getAutoDownloadPackages(resourceUri?: vscode.Uri): boolean {
	return vscode.workspace
		.getConfiguration("texwasm", resourceUri ?? null)
		.get<boolean>("autoDownloadPackages", true);
}

export function getIncludeExtraBundle(resourceUri?: vscode.Uri): boolean {
	return vscode.workspace
		.getConfiguration("texwasm", resourceUri ?? null)
		.get<boolean>("includeExtraBundle", false);
}

export function getRootDocument(resourceUri?: vscode.Uri): string {
	return vscode.workspace
		.getConfiguration("texwasm", resourceUri ?? null)
		.get<string>("rootDocument", "");
}

export function getRecipeTools(resourceUri?: vscode.Uri): RecipeTool[] {
	const configured = vscode.workspace
		.getConfiguration("texwasm", resourceUri ?? null)
		.get<RecipeTool[]>("tools", DEFAULT_TOOLS);
	return configured.length > 0 ? configured : DEFAULT_TOOLS;
}

export function getRecipes(resourceUri?: vscode.Uri): Recipe[] {
	const configured = vscode.workspace
		.getConfiguration("texwasm", resourceUri ?? null)
		.get<Recipe[]>("recipes", DEFAULT_RECIPES);
	return configured.length > 0 ? configured : DEFAULT_RECIPES;
}

export function getDefaultRecipe(resourceUri?: vscode.Uri): string {
	return vscode.workspace
		.getConfiguration("texwasm", resourceUri ?? null)
		.get<string>("recipe.default", "first");
}

export function getLastUsedRecipe(): string | undefined {
	return vscode.workspace
		.getConfiguration("texwasm")
		.get<string>("recipe.lastUsed");
}

export async function setLastUsedRecipe(recipeName: string): Promise<void> {
	await vscode.workspace
		.getConfiguration("texwasm")
		.update("recipe.lastUsed", recipeName, vscode.ConfigurationTarget.Global);
}

export function getFontNameLookup(resourceUri?: vscode.Uri): boolean {
	return vscode.workspace
		.getConfiguration("texwasm", resourceUri ?? null)
		.get<boolean>("fontNameLookup", true);
}

export function getSystemFontDirectories(resourceUri?: vscode.Uri): string[] {
	return vscode.workspace
		.getConfiguration("texwasm", resourceUri ?? null)
		.get<string[]>("systemFontDirectories", []);
}

export function getFormatIndentWidth(resourceUri?: vscode.Uri): number | null {
	return vscode.workspace
		.getConfiguration("texwasm", resourceUri ?? null)
		.get<number | null>("formatting.indentWidth", null);
}
