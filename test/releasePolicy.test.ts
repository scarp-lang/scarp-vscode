import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

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

test('manual runs qualify without publishing unless GitHub release is explicitly approved', () => {
  const publish = repoFile('.github/workflows/prerelease.yml');
  const githubInput = publish.indexOf('      publish_github:');
  const marketplaceInput = publish.indexOf('      publish_marketplace:');
  const openVsxInput = publish.indexOf('      publish_openvsx:');
  assert.ok(githubInput > 0 && githubInput < marketplaceInput &&
    marketplaceInput < openVsxInput, 'Manual publishing inputs must be explicit');
  for (const next of [marketplaceInput, openVsxInput, publish.indexOf('  release:', openVsxInput)]) {
    assert.ok(next > 0);
  }
  for (const chunk of [
    publish.slice(githubInput, marketplaceInput),
    publish.slice(marketplaceInput, openVsxInput),
    publish.slice(openVsxInput, publish.indexOf('  release:', openVsxInput))
  ]) {
    assert.match(chunk, /type: boolean/);
    assert.match(chunk, /default: false/);
  }

  const consent = publish.indexOf('name: Require explicit GitHub release opt-in before registry publishing');
  const compiler = publish.indexOf('name: Smoke-test pinned official compiler');
  const checked = publish.indexOf('name: Verify release-ready VSIX before any GitHub upload');
  const dryRun = publish.indexOf('name: Upload qualified pre-release VSIX to this Actions run');
  const attach = publish.indexOf('name: Ensure approved GitHub pre-release has the VSIX');
  const reverify = publish.indexOf('name: Reverify released VSIX after any GitHub download');
  const marketplace = publish.indexOf('name: Publish Visual Studio Marketplace');
  assert.ok(consent > 0 && consent < compiler && compiler < checked &&
    checked < dryRun && dryRun < attach && attach < reverify && reverify < marketplace,
  'All checks must run before an artifact, and a public release must be opt-in');
  const consentStep = publish.slice(consent, compiler);
  assert.match(consentStep, /PUBLISH_GITHUB:/);
  assert.match(consentStep, /PUBLISH_MARKETPLACE:/);
  assert.match(consentStep, /PUBLISH_OPENVSX:/);
  assert.match(consentStep, /\$PUBLISH_GITHUB" != "true"/);
  assert.match(consentStep, /\$PUBLISH_MARKETPLACE" == "true"/);
  assert.match(consentStep, /\$PUBLISH_OPENVSX" == "true"/);
  assert.match(publish.slice(dryRun, attach), /if: github\.event_name == 'workflow_dispatch' && !inputs\.publish_github/);
  assert.match(publish.slice(dryRun, attach), /actions\/upload-artifact@v4/);
  assert.match(publish.slice(dryRun, attach), /retention-days: 7/);
  for (const section of [publish.slice(attach, reverify), publish.slice(reverify, marketplace)]) {
    assert.match(section, /if: github\.event_name == 'release' \|\| inputs\.publish_github/);
  }
  assert.match(publish, /github\.event\.release\.prerelease == true/);
  assert.match(publish, /--prerelease/);
});

test('public experimental releases require reviewed notes, not development drafts', () => {
  const publish = repoFile('.github/workflows/prerelease.yml');
  const notes = repoFile('docs/releases/v0.1.5-public.md');
  assert.match(publish, /notes_file="docs\/releases\/\$TAG-public\.md"/);
  assert.match(publish, /if \[\[ ! -f "\$notes_file" \]\]; then/);
  assert.match(publish, /--notes-file "\$notes_file"/);
  assert.doesNotMatch(publish, /--notes-file "docs\/releases\/\$TAG\.md"/);
  assert.match(notes, /Experimental Pre-release/);
  assert.match(notes, /v0\.0\.6-alpha\.3/);
  assert.match(notes, /sample_area/);
  assert.match(notes, /sample_slopes/);
  assert.match(notes, /not available in published\s+alpha\.3 binaries/);
  assert.doesNotMatch(notes, /not published|development draft|under review/i);
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
  assert.match(ci, /TAMPER_MEMBER=/);
  assert.match(ci, /\[Content_Types\]\.xml/);
  assert.match(ci, /duplicate ZIP member/);
  const compare = repoFile('scripts/compare-vsix.sh');
  assert.match(compare, /zipfile\.ZipFile/);
  assert.match(compare, /archive\.namelist\(\)/);
  assert.match(compare, /len\(names\) != len\(set\(names\)\)/);
  assert.match(compare, /sha256\(built, name\)/);

  // A brand-new release has no existing GitHub VSIX to compare against.
  // Validate each uploaded candidate structurally before the first upload.
  const validator = repoFile('scripts/verify-vsix.sh');
  assert.match(validator, /zipfile\.ZipFile/);
  assert.match(validator, /Duplicate VSIX ZIP member/);
  assert.match(validator, /Unsafe VSIX ZIP member path/);
  assert.match(validator, /Symlinked VSIX ZIP member/);
  assert.match(validator, /Encrypted VSIX ZIP member/);
  assert.match(validator, /Required VSIX metadata missing/);
  assert.match(ci, /if bash scripts\/verify-vsix\.sh "\$tampered" "\$version"; then/);
  assert.match(ci, /traversal ZIP path/);
  assert.match(ci, /symlink ZIP member/);
  assert.match(ci, /missing VSIX metadata/);
});

test('manual prerelease version tags must resolve to exact checked-out source revision', () => {
  const publish = repoFile('.github/workflows/prerelease.yml');
  const guard = publish.indexOf('name: Reject manual publication against an unrelated existing release tag');
  const build = publish.indexOf('name: Build verified pre-release package');
  const attach = publish.indexOf('name: Ensure approved GitHub pre-release has the VSIX');
  assert.ok(guard > 0 && guard < build && build < attach,
    'Reject conflicting release tags before packaging or any upload');
  assert.match(publish, /git fetch --tags origin/);
  assert.ok(publish.includes('node scripts/assert-tag-provenance.cjs "$TAG"'));
  assert.ok(publish.slice(guard, build).includes(
    "if: github.event_name == 'workflow_dispatch' && inputs.publish_github"),
  'A qualification-only run must not fail because a different release tag exists');

  // Real Git fixture: exercise absent, lightweight, annotated, and stale
  // tags rather than merely checking the workflow text for a guard.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scarp-release-tag-'));
  const script = path.join(process.cwd(), 'scripts/assert-tag-provenance.cjs');
  const git = (...args: string[]): string => {
    const result = spawnSync('git', args, {
      cwd: dir, encoding: 'utf8', timeout: 10_000, windowsHide: true
    });
    assert.equal(result.status, 0,
      'Git fixture failed: git ' + args.join(' ') + ': ' + result.stderr);
    return result.stdout.trim();
  };
  const verify = (tag: string) => spawnSync(process.execPath, [script, tag], {
    cwd: dir, encoding: 'utf8', timeout: 10_000, windowsHide: true
  });
  try {
    git('init', '-q');
    git('config', 'user.email', 'ci@example.invalid');
    git('config', 'user.name', 'Scarp CI');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'sample.txt'), 'first\\n');
    git('add', 'sample.txt');
    git('commit', '-qm', 'first');
    assert.equal(verify('v0.1.5').status, 0, 'No tag permits a new release');
    assert.equal(verify('not-a-version').status, 2, 'Invalid tag input must fail');
    git('tag', 'v0.1.5');
    assert.equal(verify('v0.1.5').status, 0, 'Matching lightweight tag is safe');
    git('tag', '-a', 'v0.1.6', '-m', 'annotated tag');
    assert.equal(verify('v0.1.6').status, 0, 'Annotated tag peels to HEAD');
    fs.writeFileSync(path.join(dir, 'sample.txt'), 'second\\n');
    git('commit', '-am', 'second');
    const older = verify('v0.1.5');
    assert.equal(older.status, 1,
      'A previous commit must never be published as the current source version');
    assert.match(older.stderr, /existing tag resolves to/);
    assert.equal(verify('v0.1.6').status, 1,
      'Annotated tags pointing to another commit must also fail');
    git('tag', 'v0.1.7');
    assert.equal(verify('v0.1.7').status, 0, 'New tag on HEAD is accepted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  const untrustedJob = ci.slice(ci.indexOf('  editor-untrusted:'));
  const runUntrusted = untrustedJob.indexOf('xvfb-run -a npm run test:untrusted');
  const packageAfter = untrustedJob.indexOf('npm run package:pre');
  const verifyAfter = untrustedJob.indexOf('bash scripts/verify-vsix.sh');
  assert.ok(runUntrusted >= 0 && packageAfter > runUntrusted &&
    verifyAfter > packageAfter,
  'CI must package and verify a VSIX after the Restricted Mode editor download');
});

test('published compiler alpha.1 through alpha.4 remain independently qualified', () => {
  const ci = repoFile('.github/workflows/ci.yml');
  const publish = repoFile('.github/workflows/prerelease.yml');
  // Preserve original protected-branch check names for alpha.1 compatibility.
  assert.equal((ci.match(/ref: v0\.0\.6-alpha\.1/g) ?? []).length, 2);
  assert.equal((ci.match(/ref: v0\.0\.6-alpha\.2/g) ?? []).length, 1);
  assert.equal((ci.match(/ref: v0\.0\.6-alpha\.3/g) ?? []).length, 1);
  assert.equal((ci.match(/ref: v0\.0\.6-alpha\.4/g) ?? []).length, 1);
  assert.equal((publish.match(/ref: v0\.0\.6-alpha\.4/g) ?? []).length, 1);
  assert.doesNotMatch(publish, /ref: v0\.0\.6-alpha\.[12]/);
  const alpha2 = ci.slice(ci.indexOf('  compiler-alpha2-compatibility:'),
    ci.indexOf('  editor-untrusted:'));
  assert.match(alpha2, /name: Official Scarp alpha\.2 compatibility \(Linux\)/);
  assert.match(alpha2, /ref: v0\.0\.6-alpha\.2/);
  assert.match(alpha2, /grep -F '0\.0\.6-alpha\.2'/);
  assert.match(alpha2, /scarp verify test\/fixtures\/hello\.srp/);
  assert.match(alpha2, /scarp exec test\/fixtures\/hello\.srp/);
  assert.match(alpha2, /scarp inspect modules --json/);
  assert.match(alpha2, /scarp inspect references --json/);
  assert.match(alpha2, /scarp launch --/);
  assert.match(alpha2, /xvfb-run -a npm run test:integration/);
  const alpha3 = ci.slice(ci.indexOf('  compiler-alpha3-compatibility:'),
    ci.indexOf('  compiler-alpha4-compatibility:'));
  const alpha4 = ci.slice(ci.indexOf('  compiler-alpha4-compatibility:'),
    ci.indexOf('  editor-untrusted:'));
  assert.match(alpha3, /name: Official Scarp alpha\.3 compatibility \(Linux\)/);
  assert.match(alpha3, /ref: v0\.0\.6-alpha\.3/);
  assert.match(alpha3, /grep -F '0\.0\.6-alpha\.3'/);
  assert.match(alpha3, /xvfb-run -a npm run test:integration/);
  assert.match(alpha3, /scarp inspect references --json/);
  assert.match(alpha4, /name: Official Scarp alpha\.4 compatibility \(Linux\)/);
  assert.match(alpha4, /ref: v0\.0\.6-alpha\.4/);
  assert.match(alpha4, /grep -F '0\.0\.6-alpha\.4'/);
  assert.match(alpha4, /xvfb-run -a npm run test:integration/);
  for (const workflow of [alpha3, alpha4, publish]) {
    assert.match(workflow, /for example in topk_scores temperature_softmax/);
    assert.match(workflow, /scarp verify "compiler\/examples\/\$example\.srp"/);
    assert.match(workflow, /diff -u "compiler\/examples\/\$example\.stdout"/);
  }
  for (const workflow of [alpha4, publish]) {
    assert.match(workflow, /sampled_calculus sample_cumulative_area cosine_similarity/);
  }
  assert.match(publish, /grep -F '0\.0\.6-alpha\.4'/);
  // Release verification must still include all supported public CLI contracts.
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
