import * as path from "node:path";
import * as vscode from "vscode";
import { readFile } from "../utils/fs";
import {
	countWordsInSource,
	type WordCountFileResult,
	type WordCountStats,
	type WordCountWorkspaceResult,
} from "../utils/wordCount";

let wordCountChannel: vscode.OutputChannel | undefined;

function getWordCountChannel(): vscode.OutputChannel {
	if (!wordCountChannel) {
		wordCountChannel = vscode.window.createOutputChannel(
			"TeXWASM Word Count",
		);
	}
	return wordCountChannel;
}

export function disposeWordCountChannel(): void {
	if (wordCountChannel) {
		wordCountChannel.dispose();
		wordCountChannel = undefined;
	}
}

export async function wordCountActiveFile(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showErrorMessage("TeXWASM: No active editor.");
		return;
	}

	const document = editor.document;
	if (document.languageId !== "latex") {
		vscode.window.showErrorMessage(
			"TeXWASM: Active file is not a LaTeX document.",
		);
		return;
	}

	const stats = countWordsInSource(document.getText());
	const result: WordCountFileResult = {
		...stats,
		fileName: path.basename(document.uri.fsPath),
		filePath: document.uri.fsPath,
	};
	displayFileResult(result);
}

export async function wordCountWorkspace(): Promise<void> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		vscode.window.showErrorMessage(
			"TeXWASM: No workspace folder is open.",
		);
		return;
	}

	const files = await vscode.workspace.findFiles(
		"**/*.tex",
		"{**/node_modules/**,**/.git/**,**/dist/**,**/.vscode-test/**,**/.test-tmp*/**}",
	);
	if (files.length === 0) {
		vscode.window.showInformationMessage(
			"TeXWASM: No .tex files found in the workspace.",
		);
		return;
	}

	const fileResults: WordCountFileResult[] = [];
	for (const uri of files) {
		const content = readFile(uri.fsPath);
		if (content === undefined) continue;
		const stats = countWordsInSource(content);
		fileResults.push({
			...stats,
			fileName: path.basename(uri.fsPath),
			filePath: uri.fsPath,
		});
	}

	if (fileResults.length === 0) {
		vscode.window.showErrorMessage(
			"TeXWASM: No readable .tex files found in the workspace.",
		);
		return;
	}

	displayWorkspaceResult({
		files: fileResults,
		total: aggregate(fileResults),
	});
}

function aggregate(files: WordCountFileResult[]): WordCountStats {
	const total: WordCountStats = {
		textWords: 0,
		headerWords: 0,
		captionWords: 0,
		footnoteWords: 0,
		totalWords: 0,
		headers: 0,
		tables: 0,
		figures: 0,
		mathInlines: 0,
	};
	for (const file of files) {
		total.textWords += file.textWords;
		total.headerWords += file.headerWords;
		total.captionWords += file.captionWords;
		total.footnoteWords += file.footnoteWords;
		total.headers += file.headers;
		total.tables += file.tables;
		total.figures += file.figures;
		total.mathInlines += file.mathInlines;
	}
	total.totalWords =
		total.textWords +
		total.headerWords +
		total.captionWords +
		total.footnoteWords;
	return total;
}

function displayFileResult(result: WordCountFileResult): void {
	const channel = getWordCountChannel();
	channel.clear();
	channel.appendLine("TeXWASM Word Count");
	channel.appendLine("==================");
	channel.appendLine("");
	channel.appendLine(`File: ${result.filePath}`);
	channel.appendLine("");
	appendStats(channel, result);
	channel.show(true);
	vscode.window.showInformationMessage(
		`TeXWASM: ${result.totalWords} words in ${result.fileName} (${result.headers} headers, ${result.tables} tables, ${result.figures} figures, ${result.mathInlines} math inlines).`,
	);
}

function displayWorkspaceResult(result: WordCountWorkspaceResult): void {
	const channel = getWordCountChannel();
	channel.clear();
	channel.appendLine("TeXWASM Word Count \u2014 Workspace");
	channel.appendLine("==================================");
	channel.appendLine("");
	channel.appendLine(`Files: ${result.files.length}`);
	channel.appendLine("");
	for (const file of result.files) {
		channel.appendLine(`${file.fileName} \u2014 ${file.totalWords} words`);
	}
	channel.appendLine("");
	channel.appendLine("Totals");
	channel.appendLine("------");
	appendStats(channel, result.total);
	channel.show(true);
	vscode.window.showInformationMessage(
		`TeXWASM: ${result.total.totalWords} words across ${result.files.length} file(s).`,
	);
}

function appendStats(
	channel: vscode.OutputChannel,
	stats: WordCountStats,
): void {
	channel.appendLine(`  Words in text:       ${stats.textWords}`);
	channel.appendLine(`  Words in headers:    ${stats.headerWords}`);
	channel.appendLine(`  Words in captions:   ${stats.captionWords}`);
	channel.appendLine(`  Words in footnotes:  ${stats.footnoteWords}`);
	channel.appendLine("  -----------------------------------");
	channel.appendLine(`  Total words:         ${stats.totalWords}`);
	channel.appendLine("");
	channel.appendLine(`  Headers:             ${stats.headers}`);
	channel.appendLine(`  Tables:              ${stats.tables}`);
	channel.appendLine(`  Figures:             ${stats.figures}`);
	channel.appendLine(`  Math inlines:        ${stats.mathInlines}`);
}
