import * as vscode from "vscode";
import { fileExists } from "../utils/fs";

export function openPdf(pdfPath: string): void {
	if (!fileExists(pdfPath)) {
		vscode.window.showErrorMessage(`TeXWASM: PDF not found at ${pdfPath}`);
		return;
	}

	const pdfUri = vscode.Uri.file(pdfPath);

	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			if (
				tab.input instanceof vscode.TabInputText &&
				tab.input.uri.fsPath === pdfUri.fsPath
			) {
				void vscode.window.showTextDocument(pdfUri, {
					viewColumn: group.viewColumn,
					preserveFocus: true,
				});
				return;
			}
		}
	}

	void vscode.window.showTextDocument(pdfUri, {
		viewColumn: vscode.ViewColumn.Beside,
		preserveFocus: true,
	});
}
