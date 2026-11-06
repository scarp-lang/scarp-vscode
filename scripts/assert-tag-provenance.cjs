#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

/**
 * On manual release dispatch, a pre-existing version tag must resolve to
 * precisely the checked-out protected-main commit. The package must never be
 * built from one revision and attached to a release for another revision.
 *
 * The workflow fetches remote tags immediately before calling this script.
 * No tag is allowed: the workflow can create a new one from the approved SHA.
 */
const tag = process.argv[2];
if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag ?? '')) {
  console.error('Expected numeric pre-release tag vMAJOR.MINOR.PATCH.');
  process.exit(2);
}

function git(...args) {
  const result = spawnSync('git', args, {
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 64 * 1024
  });
  if (result.error) { throw result.error; }
  return result;
}

try {
  const ref = 'refs/tags/' + tag;
  const lookup = git('show-ref', '--verify', '--quiet', ref);
  if (lookup.status === 1) {
    console.log('No existing release tag ' + tag + '; new pre-release may be created.');
    process.exit(0);
  }
  if (lookup.status !== 0) {
    throw new Error('Cannot inspect existing release tag ' + tag);
  }

  const tagged = git('rev-parse', '--verify', ref + '^{commit}');
  const checkedOut = git('rev-parse', '--verify', 'HEAD');
  if (tagged.status !== 0 || checkedOut.status !== 0) {
    throw new Error('Cannot resolve a release tag and checked-out commit.');
  }
  const tagCommit = tagged.stdout.trim();
  const sourceCommit = checkedOut.stdout.trim();
  if (tagCommit !== sourceCommit) {
    throw new Error(
      'Refusing ' + tag + ': existing tag resolves to ' + tagCommit +
      ' but the manually approved main checkout is ' + sourceCommit +
      '. Never publish a VSIX from a different commit under an existing tag.'
    );
  }
  console.log('Verified existing ' + tag + ' tag matches checked-out commit ' + sourceCommit);
} catch (error) {
  console.error('Scarp release provenance refused: ' + String(error));
  process.exit(1);
}
