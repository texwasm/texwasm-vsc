import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { getOutputDirectory } from "../config/settings";
import { resolveRootDocument } from "../engine/rootResolver";
import { openPdf } from "../pdf/pdfViewer";
import { findLatexSourceUri } from "./compile";

/** Open the compiled PDF for the current LaTeX document. Resolves the root
 *  document and honors `texwasm.outputDirectory`, mirroring where the compiler
 *  writes the PDF. */
export async function viewPdf(): Promise<void> {
	try {
		const sourceUri = findLatexSourceUri();
		if (!sourceUri) {
			vscode.window.showErrorMessage(
				"TeXWASM: No active LaTeX file. Open a .tex file first.",
			);
			return;
		}

		const document = await vscode.workspace.openTextDocument(sourceUri);
		const scopeUri = vscode.workspace.getWorkspaceFolder(sourceUri)?.uri;
		const rootResult = await resolveRootDocument(
			sourceUri,
			document.getText(),
			scopeUri,
		);
		const sourcePath = rootResult.rootPath;

		const pdfName = path.basename(sourcePath).replace(/\.tex$/i, ".pdf");
		const pdfPath = getOutputDirectory(scopeUri)
			? path.resolve(
					path.dirname(sourcePath),
					getOutputDirectory(scopeUri),
					pdfName,
				)
			: path.resolve(path.dirname(sourcePath), pdfName);

		if (!fs.existsSync(pdfPath)) {
			vscode.window.showWarningMessage(
				"TeXWASM: No PDF found. Compile the document first.",
			);
			return;
		}

		openPdf(pdfPath);
	} catch (err) {
		vscode.window.showErrorMessage(
			`TeXWASM: Could not open the PDF: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
