import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import * as vscode from 'vscode';
import * as pkg from '../../package.json';

const extensionId = pkg.publisher + '.' + pkg.name;

describe('TeXWASM Extension', () => {
  let extension: vscode.Extension<unknown> | undefined;

  before(() => {
    extension = vscode.extensions.getExtension(extensionId);
  });

  it('is installed', () => {
    assert.notStrictEqual(extension, undefined);
  });

  it('activates', async () => {
    await extension!.activate();
    assert.strictEqual(extension!.isActive, true);
  });

  it('registers all commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    const expected = [
      'texwasm.compile',
      'texwasm.compileWith',
      'texwasm.viewLog',
      'texwasm.clean',
      'texwasm.stop',
      'texwasm.synctexForward',
      'texwasm.downloadEngine',
      'texwasm.clearPackageCache',
      'texwasm.listPackageCache',
      'texwasm.walkthrough',
      'texwasm.createHelloWorld',
      'texwasm.viewPdf',
    ];
    for (const cmd of expected) {
      assert.ok(commands.includes(cmd), `Command ${cmd} should be registered`);
    }
  });

  it('shows status bar item after activation', () => {
    const statusBar = vscode.window.createStatusBarItem;
    assert.strictEqual(typeof statusBar, 'function');
  });
});
