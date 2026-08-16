import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

const HELLO_WORLD_CONTENT = `\\documentclass{article}
\\begin{document}
Hello, world!
\\end{document}
`;

/** Create a `hello.tex` starter file in the workspace and open it. If the file
 *  already exists it is opened as-is, so an existing file is never overwritten. */
export async function createHelloWorldFile(): Promise<void> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		vscode.window.showErrorMessage(
			"TeXWASM: Open a folder first so the starter file has somewhere to live.",
		);
		return;
	}

	// Prefer the workspace folder containing the active editor, then the first folder.
	const activeUri = vscode.window.activeTextEditor?.document.uri;
	const targetFolder =
		(activeUri && vscode.workspace.getWorkspaceFolder(activeUri)?.uri) ??
		folders[0].uri;

	const targetPath = path.join(targetFolder.fsPath, "hello.tex");
	const uri = vscode.Uri.file(targetPath);

	if (!fs.existsSync(targetPath)) {
		await fs.promises.writeFile(targetPath, HELLO_WORLD_CONTENT, "utf8");
	}

	const document = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(document, { preview: true });
}
