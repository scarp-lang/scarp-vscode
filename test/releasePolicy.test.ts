import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

function repoFile(filename: string): string {
  return fs.readFileSync(path.join(process.cwd(), filename), 'utf8');
}

test('stable publishing remains blocked and routine pushes cannot publish', () => {
  const publish = repoFile('.github/workflows/prerelease.yml');
  assert.match(publish, /release:\s*\n\s*types: \[published\]/);
  assert.match(publish, /github\.event\.release\.prerelease == true/);
  assert.match(publish, /github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(publish, /^\s*push:\s*$/m);
  assert.match(publish, /npx vsce publish --pre-release --packagePath "\$VSIX" --oidc/);
  assert.match(publish, /ovsx@1\.3\.0 publish "\$VSIX"/);
});

test('experimental GitHub releases must build the approved tagged revision', () => {
  const publish = repoFile('.github/workflows/prerelease.yml');
  assert.match(publish, /github\.event\.release\.tag_name \|\| github\.ref/);
  assert.match(publish, /git merge-base --is-ancestor HEAD origin\/main/);
  assert.match(publish, /tag_name/);
  assert.match(publish, /'release' && github\.event\.release\.tag_name/);
});

test('release contents are verified before attaching or publishing', () => {
  const publish = repoFile('.github/workflows/prerelease.yml');
  const before = publish.indexOf('name: Verify release-ready VSIX before any GitHub upload');
  const attach = publish.indexOf('name: Ensure approved GitHub pre-release has the VSIX');
  const after = publish.indexOf('name: Reverify released VSIX after any GitHub download');
  const market = publish.indexOf('name: Publish Visual Studio Marketplace');
  assert.ok(before > 0 && before < attach && attach < after && after < market);
  assert.match(publish, /bash scripts\/compare-vsix\.sh "\$VSIX" "release-package\/\$VSIX"/);
  assert.match(publish, /bash scripts\/verify-vsix\.sh "\$VSIX" "\$VERSION"/);
  const ci = repoFile('.github/workflows/ci.yml');
  assert.match(ci, /bash scripts\/verify-vsix\.sh/);
  assert.match(ci, /bash scripts\/compare-vsix\.sh/);
  assert.match(ci, /tampered-release|scarp-tampered/);
});

test('pre-release publishing reruns trusted and Restricted Mode editor tests before any asset upload', () => {
  const publish = repoFile('.github/workflows/prerelease.yml');
  const ci = repoFile('.github/workflows/ci.yml');
  const pinnedCompiler = publish.indexOf('name: Smoke-test pinned official compiler');
  const compile = publish.indexOf('cargo build --locked --release');
  const sourceChecks = publish.indexOf('run: npm run check');
  const trusted = publish.indexOf('name: Gate release on trusted VS Code Extension Host integration');
  const untrusted = publish.indexOf('name: Gate release on real untrusted VS Code Restricted Mode');
  const packageStep = publish.indexOf('name: Build verified pre-release package');
  const attach = publish.indexOf('name: Ensure approved GitHub pre-release has the VSIX');
  const marketplace = publish.indexOf('name: Publish Visual Studio Marketplace');
  const openVsx = publish.indexOf('name: Publish Open VSX');
  assert.ok(pinnedCompiler >= 0 && compile > pinnedCompiler &&
    sourceChecks > compile && trusted > sourceChecks && untrusted > trusted &&
    packageStep > untrusted && attach > packageStep &&
    marketplace > attach && openVsx > marketplace,
  'Both real VS Code editor suites must pass before packaging or registry publication');
  assert.match(publish, /SCARP_TEST_BINARY: \$\{\{ github\.workspace \}\}\/compiler\/target\/release\/scarp/);
  assert.match(publish, /xvfb-run -a npm run test:integration/);
  assert.match(publish, /xvfb-run -a npm run test:untrusted/);
  assert.match(ci, /name: VS Code Extension Host \(Linux\)/);
  assert.match(ci, /name: VS Code Restricted Mode \(Linux\)/);
});

test('published compiler 0.0.6-alpha.1 is pinned in both verification workflows', () => {
  const ci = repoFile('.github/workflows/ci.yml');
  const publish = repoFile('.github/workflows/prerelease.yml');
  assert.equal((ci.match(/ref: v0\.0\.6-alpha\.1/g) ?? []).length, 2);
  assert.equal((publish.match(/ref: v0\.0\.6-alpha\.1/g) ?? []).length, 1);
  for (const workflow of [ci, publish]) {
    assert.match(workflow, /scarp verify test\/fixtures\/hello\.srp/);
    assert.match(workflow, /scarp exec test\/fixtures\/hello\.srp/);
    assert.match(workflow, /scarp inspect modules --json/);
    assert.match(workflow, /scarp inspect references --json/);
  }
});

test('release safety scripts stay out of published package', () => {
  const ignore = repoFile('.vscodeignore');
  assert.match(ignore, /^scripts\/\*\*$/m);
  assert.match(ignore, /^compiler\/\*\*$/m);
  assert.match(ignore, /^\.vscode-test\/\*\*$/m);
  assert.match(ignore, /^release-requests\/\*\*$/m);
  const verify = repoFile('scripts/verify-vsix.sh');
  assert.match(verify, /Microsoft\.VisualStudio\.Code\.PreRelease/);
  assert.match(verify, /extension\/dist\/src\/extension\.js/);
  assert.match(verify, /\\\.vscode-test/);
  assert.match(verify, /p\.publisher !== "ScarpLang"/);
});
