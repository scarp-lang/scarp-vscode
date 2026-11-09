/**
 * Lightweight, editor-only help for published numerical Scarp built-ins.
 *
 * This table is a reference to the compiler's released contracts, not a
 * semantic analysis of user code or an installed-compiler capability probe.
 * It performs no I/O, code execution or network requests in Restricted Mode.
 */
export interface ScarpBuiltinHelp {
  readonly name: string;
  readonly signature: string;
  readonly introduced: string;
  readonly summary: string;
  readonly constraints: string;
}

interface ScarpBuiltinCall {
  readonly help: ScarpBuiltinHelp;
  readonly start: number;
  readonly end: number;
}

const alpha3 = 'v0.0.6-alpha.3';
const alpha4 = 'v0.0.6-alpha.4';
const alpha5 = 'v0.0.6-alpha.5';

const HELP: Readonly<Record<string, ScarpBuiltinHelp>> = {
  topk: {
    name: 'topk',
    signature: 'topk(scores: vector, count: integer) -> integers',
    introduced: alpha3,
    summary: 'Returns original zero-based indices of the highest scores, breaking ties by original index.',
    constraints: 'Count must be between 0 and the visible vector length; zero is valid. No random sampling.'
  },
  topk_values: {
    name: 'topk_values',
    signature: 'topk_values(scores: vector, count: integer) -> vector',
    introduced: alpha3,
    summary: 'Returns the highest original score values in deterministic descending order.',
    constraints: 'Count must be between 0 and the visible vector length; equal scores retain original index order.'
  },
  softmax_temp: {
    name: 'softmax_temp',
    signature: 'softmax_temp(scores: vector, temperature: float) -> vector',
    introduced: alpha3,
    summary: 'Converts finite scores to temperature-adjusted probabilities.',
    constraints: 'Scores must be nonempty and temperature must be finite and strictly positive. Deterministic, not sampling.'
  },
  logsoftmax_temp: {
    name: 'logsoftmax_temp',
    signature: 'logsoftmax_temp(scores: vector, temperature: float) -> vector',
    introduced: alpha3,
    summary: 'Returns natural-log temperature-adjusted probabilities.',
    constraints: 'Scores must be nonempty and temperature must be finite and strictly positive. Unrepresentable results are errors.'
  },
  sample_area: {
    name: 'sample_area',
    signature: 'sample_area(x: vector, y: vector) -> float',
    introduced: alpha4,
    summary: 'Approximates the definite integral of sampled y-values by the trapezoidal rule.',
    constraints: 'The vectors must have the same length of at least two, with strictly increasing x coordinates.'
  },
  sample_slopes: {
    name: 'sample_slopes',
    signature: 'sample_slopes(x: vector, y: vector) -> vector',
    introduced: alpha4,
    summary: 'Computes interval-by-interval secant slopes between consecutive samples.',
    constraints: 'The vectors must have the same length of at least two, with strictly increasing x; output has N-1 elements.'
  },
  sample_cumulative_area: {
    name: 'sample_cumulative_area',
    signature: 'sample_cumulative_area(x: vector, y: vector) -> vector',
    introduced: alpha4,
    summary: 'Computes cumulative trapezoidal area from the first sample to each coordinate.',
    constraints: 'Requires matching vectors of at least two samples and strictly increasing x; output has N elements.'
  },
  cosine_similarity: {
    name: 'cosine_similarity',
    signature: 'cosine_similarity(left: vector, right: vector) -> float',
    introduced: alpha4,
    summary: 'Measures the uncentered orientation of equal-length vectors; returns a value in [-1, 1].',
    constraints: 'Vectors must have equal nonzero length; neither can be all zeros. Different from centered Pearson correlation.'
  },
  top_p: {
    name: 'top_p',
    signature: 'top_p(probabilities: vector, mass: float) -> integers',
    introduced: alpha5,
    summary: 'Returns original indices of the smallest descending-probability prefix reaching the requested mass.',
    constraints: 'Probabilities must be nonempty, finite, nonnegative and normalized; 0 < mass <= 1. Stable ties, no randomness.'
  },
  top_p_values: {
    name: 'top_p_values',
    signature: 'top_p_values(probabilities: vector, mass: float) -> vector',
    introduced: alpha5,
    summary: 'Returns probability values for the deterministic descending Top-P prefix.',
    constraints: 'Probabilities must be nonempty, finite, nonnegative and normalized; 0 < mass <= 1. Not random sampling.'
  },
  pearson_correlation: {
    name: 'pearson_correlation',
    signature: 'pearson_correlation(left: vector, right: vector) -> float',
    introduced: alpha5,
    summary: 'Measures centered linear correlation of paired numerical observations; returns a value in [-1, 1].',
    constraints: 'Requires equal lengths of at least two and nonconstant inputs on both axes.'
  }
};

function identifierStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_]/.test(ch);
}

function identifierPart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_0-9]/.test(ch);
}

/**
 * Find help only when the pointer is on a real, unqualified call-name token.
 * Scarp double-quoted strings do not span source lines; // starts a comment.
 *
 * The following line is inspected solely for an opening parenthesis after
 * whitespace, allowing calls formatted as "topk\n(". File-sized parsing and
 * all compiler invocation are deliberately avoided on mouse movement.
 */
export function scarpBuiltinAt(
  line: string, character: number, nextLine = ''
): ScarpBuiltinCall | undefined {
  if (!Number.isSafeInteger(character) || character < 0 ||
      character >= line.length || line.length > 16384 || nextLine.length > 16384) {
    return undefined;
  }

  let i = 0;
  let previousToken = '';
  while (i < line.length) {
    const ch = line[i];
    if (ch === '/' && line[i + 1] === '/') { return undefined; }
    if (ch === '"') {
      // Match the TextMate string boundary: escaped quotes do not end a string.
      i++;
      while (i < line.length) {
        if (line[i] === '\\') { i = Math.min(line.length, i + 2); }
        else if (line[i++] === '"') { break; }
      }
      previousToken = 'string';
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (identifierStart(ch)) {
      const start = i++;
      while (identifierPart(line[i])) { i++; }
      const name = line.slice(start, i);
      if (character >= start && character < i) {
        const help = HELP[name];
        if (!help || previousToken === 'funcra' || previousToken === '.') {
          return undefined;
        }
        // A lexical hint only: imports or local declarations may still
        // affect semantic resolution, which remains the compiler's job.
        const lookahead = line.slice(i) + '\n' + nextLine;
        if (!/^\s*\(/.test(lookahead)) { return undefined; }
        return { help, start, end: i };
      }
      previousToken = name;
      continue;
    }
    previousToken = ch;
    i++;
  }
  return undefined;
}
