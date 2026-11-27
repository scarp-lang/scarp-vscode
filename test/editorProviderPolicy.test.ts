import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
function source(file: string): string {
  return fs.readFileSync(path.join(root, file), 'utf8');
}
const pkg = JSON.parse(source('package.json')) as {
  activationEvents: string[];
  contributes: {
    commands: Array<{ command: string; title: string }>;
    menus: { commandPalette: Array<{ command: string; when?: string }> };
  };
  version: string;
};
const commands = [
  'scarp.browseWorkspaceImports',
  'scarp.browseWorkspaceProjects',
  'scarp.exportNativeObject'
];
test('on-demand Scarp workspace explorer commands are registered', () => {
  for (const name of commands) {
    assert.ok(pkg.activationEvents.includes('onCommand:' + name), name);
    assert.ok(pkg.contributes.commands.some(item =>
      item.command === name && item.title.startsWith('Scarp: ')), name);
  }
});
test('workspace explorer commands are hidden from Restricted Mode palette', () => {
  for (const name of commands) {
    const item = pkg.contributes.menus.commandPalette.find(x =>
      x.command === name);
    assert.ok(item);
    assert.equal(item.when, 'isWorkspaceTrusted', name);
  }
});
test('commands have unique identifiers and no aliases that bypass trust', () => {
  const ids = pkg.contributes.commands.map(item => item.command);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(pkg.activationEvents.filter(event =>
    event === 'onCommand:scarp.browseWorkspaceImports').length, 1);
});
test('source structural providers do not spawn the compiler or a shell', () => {
  for (const file of [
    'src/editorStructure.ts', 'src/sourceCompletion.ts', 'src/editorFolding.ts',
    'src/editorSelection.ts', 'src/editorStructureCache.ts',
    'src/editorWorkspaceReport.ts', 'src/editorProjectTree.ts',
    'src/editorProjectCatalog.ts', 'src/editorImportGraph.ts'
  ]) {
    const text = source(file);
    assert.doesNotMatch(text, /from ['"]node:child_process['"]/,
      file + ' must remain compiler-free');
    assert.doesNotMatch(text, /spawnSync|execFile|shell:\s*true/,
      file + ' must not execute a process');
    assert.doesNotMatch(text, /https?:\/\/api\.github/,
      file + ' must not fetch from the network');
  }
});
test('local import navigator checks realpath containment before linking', () => {
  const content = source('src/editorImports.ts');
  assert.match(content, /fs\.realpath\(options\.workspaceRoot\)/);
  assert.match(content, /fs\.realpath\(candidate\)/);
  assert.match(content, /within\(realRoot, realTarget\)/);
  assert.match(content, /targetStat\.isFile\(\)/);
});
test('read-only providers work in Restricted Mode while links are gated', () => {
  const provider = source('src/editorProviders.ts');
  assert.match(provider, /registerFoldingRangeProvider/);
  assert.match(provider, /registerSelectionRangeProvider/);
  assert.match(provider, /registerDocumentLinkProvider/);
  assert.match(provider, /!vscode\.workspace\.isTrusted/);
  assert.match(provider, /cache\.get\(document\.uri\.toString\(\)/);
});
test('project and import browsers explicitly check trust before disk access', () => {
  for (const file of [
    'src/editorWorkspaceExplorer.ts',
    'src/editorProjectExplorer.ts'
  ]) {
    const content = source(file);
    // Trust is enforced at the command entrypoint; the project explorer
    // also has a helper that is reachable only after the trusted picker.
    const commandBody = content.slice(content.indexOf(
      "return vscode.commands.registerCommand("));
    const trust = commandBody.indexOf('if (!vscode.workspace.isTrusted)');
    const findFiles = commandBody.indexOf('vscode.workspace.findFiles');
    assert.ok(trust >= 0 && findFiles > trust,
      file + ' must enforce trust before enumerating source files');
    assert.match(content, /fs\.realpath/);
    assert.match(content, /fs\.lstat/);
  }
});
test('no new command silently activates the runtime or downloads an executable', () => {
  for (const file of [
    'src/editorWorkspaceExplorer.ts',
    'src/editorProjectExplorer.ts',
    'src/editorProviders.ts'
  ]) {
    const content = source(file);
    assert.doesNotMatch(content, /installOfficialCompiler|executeProcess/);
    assert.doesNotMatch(content, /scarp\.runFile|scarp\.launchProject/);
    assert.doesNotMatch(content, /child_process/);
  }
});
test('the extension keeps its experimental version and stable-release restriction', () => {
  assert.match(pkg.version, /^0\.1\.\d+$/);
  assert.match(source('README.md'), /Never publish a stable extension/);
  assert.match(source('docs/RELEASING.md'), /pre-release|prerelease/i);
});
test('Scarp syntax and manifest registration remain intact', () => {
  const p = JSON.parse(source('package.json')) as {
    contributes: { languages: Array<{ id: string; extensions?: string[]; filenames?: string[] }> };
  };
  assert.ok(p.contributes.languages.some(item =>
    item.id === 'scarp' && item.extensions?.includes('.srp')));
  assert.ok(p.contributes.languages.some(item =>
    item.id === 'scarp-project' && item.filenames?.includes('scarp.project')));
});
test('the structural helper implementation stays within explicit bounds', () => {
  assert.match(source('src/editorStructure.ts'), /DEFAULT_MAX_LENGTH = 2_000_000/);
  assert.match(source('src/editorStructure.ts'), /DEFAULT_MAX_TOKENS = 120_000/);
  assert.match(source('src/editorStructure.ts'), /DEFAULT_MAX_DEPTH = 256/);
  assert.match(source('src/editorWorkspaceInventory.ts'), /DEFAULT_MAX_FILES = 512/);
  assert.match(source('src/editorProjectCatalog.ts'), /MAX_MANIFEST_BYTES = 4096/);
  assert.match(source('src/editorStructureCache.ts'), /DEFAULT_BYTES = 12_000_000/);
});
test('project browsing offers only navigation actions, never automatic Run', () => {
  const content = source('src/editorProjectExplorer.ts');
  assert.match(content, /Open Project Entry/);
  assert.match(content, /Open Project Manifest/);
  assert.match(content, /Browse Project Source Tree/);
  assert.doesNotMatch(content, /executeCommand\('scarp\./);
});
test('import report UI opens an in-memory Markdown document', () => {
  const content = source('src/editorWorkspaceExplorer.ts');
  assert.match(content, /formatScarpWorkspaceReport\(graph, inventory\)/);
  assert.match(content, /language: 'markdown', content: report/);
  assert.doesNotMatch(content, /fs\.writeFile/);
});

test('native export is separate from runtime and requires trust, consent and capability checks', () => {
  const command = source('src/nativeObjectCommand.ts');
  const core = source('src/nativeObject.ts');
  assert.match(command, /if \(!vscode\.workspace\.isTrusted\)/);
  assert.ok(command.indexOf('if (!vscode.workspace.isTrusted)') <
    command.indexOf('vscode.workspace.openTextDocument'));
  assert.match(command, /document\.isDirty/);
  assert.match(command, /modal: true/);
  assert.match(command, /consent !== 'Export Object'/);
  assert.match(command, /guide', 'native-object/);
  assert.match(command, /nativeObjectAdvertised/);
  assert.match(command, /registerNativeObjectExport/);
  assert.match(core, /parseNativeObjectReport/);
  assert.match(core, /validNativeObjectHeader/);
  assert.match(core, /fs\.link\(object, output\)/);
  assert.doesNotMatch(command + core, /createTerminal|sendText|installOfficialCompiler|shell:\s*true/);
  assert.match(source('src/extension.ts'), /registerNativeObjectExport\(validateCompiler, output\)/);
});
