import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pkg from '../../package.json';

const extensionId = pkg.publisher + '.' + pkg.name;

describe('TeXWASM Biber Bibliography', function () {
  this.timeout(600_000);

  let texPath: string;
  let bibPath: string;
  let pdfPath: string;
  let biberAvailable = false;

  before(async function () {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('No workspace folder found');
    }

    const docDir = workspaceFolder.uri.fsPath;
    texPath = path.join(docDir, 'texwasm-biber-test.tex');
    bibPath = path.join(docDir, 'texwasm-biber-test.bib');
    pdfPath = texPath.replace(/\.tex$/i, '.pdf');

    // Check if biber WASM assets are available
    const ext = vscode.extensions.getExtension(extensionId);
    if (!ext) {
      throw new Error(`Extension ${extensionId} not found`);
    }
    if (!ext.isActive) {
      await ext.activate();
    }

    // Biber WASM assets are downloaded on-demand during compilation.
    // No pre-check needed — the compile command will download them automatically.
    biberAvailable = true;

    const bibContent = [
      '@book{knuth1984,',
      '  author    = {Donald E. Knuth},',
      '  title     = {The TeXbook},',
      '  year      = {1984},',
      '  publisher = {Addison-Wesley}',
      '}',
      '@inproceedings{knuth1968,',
      '  author    = {Donald E. Knuth},',
      '  title     = {Lex and Yacc},',
      '  booktitle = {Turing Award Lecture},',
      '  year      = {1996}',
      '}',
    ].join('\n');

    const texContent = [
      '\\documentclass{article}',
      '\\usepackage[backend=biber]{biblatex}',
      '\\addbibresource{texwasm-biber-test.bib}',
      '\\begin{document}',
      'Hello, World!',
      'A citation: \\cite{knuth1984}.',
      'Another citation: \\cite{knuth1968}.',
      '\\printbibliography',
      '\\end{document}',
    ].join('\n');

    fs.writeFileSync(bibPath, bibContent, 'utf-8');
    fs.writeFileSync(texPath, texContent, 'utf-8');

    console.log('[test] Setting biber as biblio backend...');
    await vscode.workspace.getConfiguration().update(
      'texwasm.biblioBackend',
      'biber',
      vscode.ConfigurationTarget.Global,
    );

    console.log('[test] Ensuring engine assets are downloaded...');
    await vscode.commands.executeCommand('texwasm.downloadEngine');
    console.log('[test] Engine assets ready.');
  });

  it('generates a PDF with biber bibliography', async function () {
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

    const base = texPath.replace(/\.tex$/i, '');

    const bcfPath = base + '.bcf';
    assert.ok(fs.existsSync(bcfPath), '.bcf (Biber control file) should be generated');
    const bcfStats = fs.statSync(bcfPath);
    assert.ok(bcfStats.size > 16, `.bcf should be nonempty (got ${bcfStats.size} bytes)`);

    const bblPath = base + '.bbl';
    assert.ok(fs.existsSync(bblPath), '.bbl (bibliography file) should be generated');
    const bblStats = fs.statSync(bblPath);
    assert.ok(bblStats.size > 16, `.bbl should be nonempty (got ${bblStats.size} bytes)`);
  });

  after(function () {
    const base = texPath.replace(/\.tex$/i, '');
    for (const ext of ['.tex', '.pdf', '.aux', '.log', '.out', '.synctex.gz', '.bbl', '.bcf', '.run.xml']) {
      const p = base + ext;
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
    if (fs.existsSync(bibPath)) {
      try {
        fs.unlinkSync(bibPath);
      } catch {
        /* ignore */
      }
    }
    vscode.workspace.getConfiguration().update(
      'texwasm.biblioBackend',
      'bibtex8',
      vscode.ConfigurationTarget.Global,
    );
  });
});
