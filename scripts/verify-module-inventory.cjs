#!/usr/bin/env node
'use strict';

// A real, static compiler-inventory compatibility gate. This never executes
// Scarp program statements, installs binaries or runs a shell.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseBrowsableProjectModules } = require('../dist/src/projectModules.js');

const binary = process.argv[2];
const sourceArg = process.argv[3];
const expectedVersion = Number(process.argv[4]);
if (!binary || !path.isAbsolute(binary) || !fs.existsSync(binary) ||
    !sourceArg || ![4, 5].includes(expectedVersion) ||
    !/^[45]$/.test(process.argv[4] || '')) {
  process.stderr.write(
    'Usage: node scripts/verify-module-inventory.cjs <absolute-compiler> <source.srp> <4|5>\n');
  process.exit(2);
}

const source = fs.realpathSync(path.resolve(sourceArg));
if (path.extname(source).toLowerCase() !== '.srp') {
  throw Error('The module inventory smoke input must be a .srp file.');
}
const root = fs.realpathSync(path.dirname(source));
const result = spawnSync(binary, ['modules', '--json', '--', source], {
  cwd: root, shell: false, windowsHide: true, encoding: 'utf8',
  timeout: 20000, maxBuffer: 4 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe']
});
if (result.error || result.status !== 0) {
  throw Error('Published Scarp module inspection failed: ' +
    String(result.error || result.stderr || result.status));
}
const inventory = JSON.parse(result.stdout);
if (inventory.schema_version !== expectedVersion) {
  throw Error('Expected published module schema v' + expectedVersion +
    ', got ' + String(inventory.schema_version));
}
const files = parseBrowsableProjectModules(result.stdout, root);
if (files.length < 1 || files.filter(item => item.isEntry).length !== 1) {
  throw Error('Compiler module browser lost its single entry module.');
}
const canonicalFile = path.resolve(source);
if (!files.some(item => item.isEntry && path.resolve(item.filename) === canonicalFile)) {
  throw Error('Entry module path does not match the trusted canonical source.');
}
process.stdout.write('Validated published module schema v' +
  expectedVersion + ' with ' + files.length + ' safe source module(s).\n');
