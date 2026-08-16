import * as vscode from "vscode";
import { fileExists } from "../utils/fs";

/** Return the resource a tab is showing, if it has one. */
function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
	const input = tab.input;
	if (input instanceof vscode.TabInputText) return input.uri;
	if (input instanceof vscode.TabInputCustom) return input.uri;
	return undefined;
}

/** Open a compiled PDF. Uses `vscode.open` so the resource resolves through the
 *  editor resolver and renders in VS Code's PDF viewer (the compiled PDF opens
 *  automatically after a successful build and on demand via "View PDF"). */
export function openPdf(pdfPath: string): void {
	if (!fileExists(pdfPath)) {
		vscode.window.showErrorMessage(`TeXWASM: PDF not found at ${pdfPath}`);
		return;
	}

	const pdfUri = vscode.Uri.file(pdfPath);

	// Reuse an already-open tab for this PDF (in whatever editor group it lives)
	// instead of stacking duplicates.
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			if (tabUri(tab)?.fsPath === pdfUri.fsPath) {
				openViaResolver(pdfUri, group.viewColumn);
				return;
			}
		}
	}

	openViaResolver(pdfUri, vscode.ViewColumn.Beside);
}

/** Open the PDF through the editor resolver (renders in VS Code's PDF viewer)
 *  and surface any failure instead of swallowing it. */
function openViaResolver(pdfUri: vscode.Uri, viewColumn: vscode.ViewColumn): void {
	void vscode.commands
		.executeCommand("vscode.open", pdfUri, {
			viewColumn,
			preserveFocus: true,
		})
		.then(undefined, (err: unknown) => {
			vscode.window.showErrorMessage(
				`TeXWASM: Could not open the PDF: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
}
