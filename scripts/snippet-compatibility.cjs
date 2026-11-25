'use strict';

// The historical numeric cutoff is deliberately limited to the 0.0.6 series.
// New series use the complete version so alpha.1 never sorts before alpha.20.
function parseAlphaVersion(value) {
  const match = /^v0\.0\.(0|[1-9][0-9]*)-alpha\.([1-9][0-9]*)$/.exec(value);
  if (!match) throw Error('Invalid Scarp alpha version: ' + value);
  const patch = Number(match[1]);
  const alpha = Number(match[2]);
  if (!Number.isSafeInteger(patch) || !Number.isSafeInteger(alpha)) {
    throw Error('Scarp alpha version exceeds safe integer range: ' + value);
  }
  return { patch, alpha };
}

function parseSnippetCutoff(value) {
  if (value === undefined) return undefined; // verify all snippets explicitly
  if (/^[1-9][0-9]*$/.test(value)) {
    return parseAlphaVersion('v0.0.6-alpha.' + value);
  }
  return parseAlphaVersion(value);
}

function snippetMinimum(name) {
  // Legacy labels remain valid, including names in already published packages.
  const legacy = /\(alpha\.([1-9][0-9]*)\)$/.exec(name);
  if (legacy) return parseAlphaVersion('v0.0.6-alpha.' + legacy[1]);
  const full = /\((v[^()]*)\)$/.exec(name);
  if (full) return parseAlphaVersion(full[1]);
  // Reject malformed version-like labels rather than treating them as ungated.
  if (/\((?:alpha\.|v0\.)[^()]*\)$/.test(name)) {
    throw Error('Invalid snippet compiler requirement: ' + name);
  }
  return undefined;
}

function snippetSupported(name, cutoff) {
  const minimum = snippetMinimum(name);
  if (!minimum || !cutoff) return true;
  return minimum.patch < cutoff.patch ||
    (minimum.patch === cutoff.patch && minimum.alpha <= cutoff.alpha);
}

module.exports = { parseAlphaVersion, parseSnippetCutoff, snippetMinimum, snippetSupported };
