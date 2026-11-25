#!/usr/bin/env node
'use strict';

// Static-only smoke check for editor snippets against an exact published compiler.
// Never execute snippets or interpret source using a shell.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseSnippetCutoff, snippetSupported } = require('./snippet-compatibility.cjs');
const binary = process.argv[2];
if (!binary || !path.isAbsolute(binary) || !fs.existsSync(binary)) {
  process.stderr.write('Usage: node scripts/verify-snippets.cjs <absolute-compiler-path>\n');
  process.exit(2);
}
// Numeric cutoffs are retained for historical v0.0.6 jobs. Full versions
// are required for newer compiler series so alpha numbering cannot reset.
let cutoff;
try {
  if (process.argv.length > 4) throw Error('Unexpected extra arguments');
  cutoff = parseSnippetCutoff(process.argv[3]);
} catch (error) {
  process.stderr.write('Optional second argument must be a positive v0.0.6 alpha number or a full v0.0.x-alpha.N version: ' + error.message + '\n');
  process.exit(2);
}
const snippets = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../snippets/scarp.code-snippets'), 'utf8'
));
function expand(body) {
  const seen = new Map();
  return body.join('\n')
    .replace(/\$\{([1-9][0-9]*):([^{}]*)\}/g, (_match, id, initial) => {
      if (!seen.has(id)) seen.set(id, initial);
      return seen.get(id);
    })
    .replace(/\$\{([1-9][0-9]*)\}/g, (_match, id) => {
      if (!seen.has(id)) throw Error('Unknown tab stop: ' + id);
      return seen.get(id);
    })
    .replace(/\$0/g, '');
}

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'scarp-snippets-'));
try {
  let count = 0;
  for (const [name, snippet] of Object.entries(snippets)) {
    if (!snippetSupported(name, cutoff)) continue;
    if (!Array.isArray(snippet.body)) throw Error('Malformed snippet: ' + name);
    const source = expand(snippet.body);
    if (source.includes('$' + '{') || /\$[0-9]+/.test(source)) {
      throw Error('Unexpanded snippet tab stop: ' + name);
    }
    const filename = path.join(folder, 'sample-' + count++ + '.srp');
    fs.writeFileSync(filename, source + '\n', 'utf8');
    const result = spawnSync(binary, ['verify', '--', filename], {
      shell: false, windowsHide: true, encoding: 'utf8',
      timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error || result.status !== 0) {
      throw Error(name + ': static compiler rejected snippet: ' +
        String(result.error || result.stderr || result.stdout || result.status));
    }
  }
  process.stdout.write('Verified ' + count + ' starter snippets.\n');
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}
