import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pkg from '../../package.json';

const extensionId = pkg.publisher + '.' + pkg.name;

describe('TeXWASM Compilation', function () {
  this.timeout(600_000);

  let texPath: string;
  let pdfPath: string;

  before(async function () {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('No workspace folder found');
    }

    const docDir = workspaceFolder.uri.fsPath;
    texPath = path.join(docDir, 'texwasm-compile-test.tex');
    pdfPath = texPath.replace(/\.tex$/i, '.pdf');

    const content = [
      '\\documentclass{article}',
      '\\usepackage{tabulary}',
      '\\begin{document}',
      'Hello, World!',
      '\\end{document}',
    ].join('\n');

    fs.writeFileSync(texPath, content, 'utf-8');

    const ext = vscode.extensions.getExtension(extensionId);
    if (!ext) {
      throw new Error(`Extension ${extensionId} not found`);
    }

    if (!ext.isActive) {
      await ext.activate();
    }

    console.log('[test] Ensuring engine assets are downloaded...');
    await vscode.commands.executeCommand('texwasm.downloadEngine');
    console.log('[test] Engine assets ready.');

    console.log('[test] Clearing package cache...');
    await vscode.commands.executeCommand('texwasm.clearPackageCache');
    console.log('[test] Package cache cleared.');
  });

  it('generates a PDF when compiling a simple LaTeX document', async function () {
    const doc = await vscode.workspace.openTextDocument(texPath);
    await vscode.window.showTextDocument(doc);

    assert.strictEqual(doc.languageId, 'latex');

    console.log('[test] Running compile command...');
    await vscode.commands.executeCommand('texwasm.compile');

    console.log('[test] Waiting for PDF...');
    let found = false;
    for (let i = 0; i < 120; i++) {
      if (fs.existsSync(pdfPath)) {
        found = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    assert.ok(found, 'PDF file should exist after compilation');

    const stats = fs.statSync(pdfPath);
    assert.ok(stats.size > 0, 'PDF should not be empty');
  });

  after(function () {
    const base = texPath.replace(/\.tex$/i, '');
    for (const ext of ['.tex', '.pdf', '.aux', '.log', '.out', '.synctex.gz', '.xdv']) {
      const p = base + ext;
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
  });
});
