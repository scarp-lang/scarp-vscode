/**
 * Lightweight, editor-only help for published numerical, text and input Scarp built-ins.
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
const alpha6 = 'v0.0.6-alpha.6';
const alpha9 = 'v0.0.6-alpha.9';
const alpha10 = 'v0.0.6-alpha.10';

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
  },
  read_line: {
    name: 'read_line',
    signature: 'read_line() -> string',
    introduced: alpha6,
    summary: 'Reads the next UTF-8 logical line from explicitly redirected or piped program input.',
    constraints: 'Impure; alpha.6–alpha.9 require redirected input, while alpha.10+ permits terminal input with --interactive or explicit --input-file. EOF, invalid UTF-8 and input limits are errors.'
  },
  integer_to_text: {
    name: 'integer_to_text',
    signature: 'integer_to_text(value: integer) -> string',
    introduced: alpha6,
    summary: 'Formats a checked signed 64-bit integer as canonical decimal text.',
    constraints: 'Exact formatting; the new string is subject to text allocation limits.'
  },
  float_to_text: {
    name: 'float_to_text',
    signature: 'float_to_text(value: float) -> string',
    introduced: alpha6,
    summary: 'Formats a finite binary64 number, preserving the float marker and signed zero.',
    constraints: 'Finite floats only; formatting is not arbitrary-precision decimal arithmetic.'
  },
  text_to_integer: {
    name: 'text_to_integer',
    signature: 'text_to_integer(value: string) -> integer',
    introduced: alpha6,
    summary: 'Parses explicit decimal text as a checked signed 64-bit integer.',
    constraints: 'No whitespace, radix prefixes, underscores or non-ASCII digits; trim separately.'
  },
  text_to_float: {
    name: 'text_to_float',
    signature: 'text_to_float(value: string) -> float',
    introduced: alpha6,
    summary: 'Parses explicit decimal text to a finite binary64 floating-point value.',
    constraints: 'No whitespace, infinities or NaN; rounds to binary64 and rejects overflow.'
  },
  text_trim: {
    name: 'text_trim',
    signature: 'text_trim(value: string) -> string',
    introduced: alpha6,
    summary: 'Removes leading and trailing Unicode whitespace without changing the interior.',
    constraints: 'Does not normalize text or remove a byte-order mark and zero-width space.'
  },
  text_replace: {
    name: 'text_replace',
    signature: 'text_replace(value: string, search: string, replacement: string) -> string',
    introduced: alpha6,
    summary: 'Replaces nonoverlapping exact UTF-8 substring matches from left to right.',
    constraints: 'Search must not be empty. Case-sensitive literal matching, not regex.'
  },
  bigint: {
    name: 'bigint',
    signature: 'bigint(value: string) -> bigint',
    introduced: alpha9,
    summary: 'Constructs an exact signed integer from ASCII decimal text.',
    constraints: 'Accepts optional + or - followed by ASCII digits; no whitespace, decimal point, radix prefix, underscore or implicit integer conversion. Default 10,000-digit and 8 MiB limb-allocation quotas.'
  },
  bigint_from_integer: {
    name: 'bigint_from_integer',
    signature: 'bigint_from_integer(value: integer) -> bigint',
    introduced: alpha9,
    summary: 'Converts any signed 64-bit integer into an exact bigint.',
    constraints: 'Explicit conversion, including the minimum signed 64-bit integer; bigint and integer do not mix implicitly.'
  },
  bigint_to_integer: {
    name: 'bigint_to_integer',
    signature: 'bigint_to_integer(value: bigint) -> integer',
    introduced: alpha9,
    summary: 'Converts an exact bigint to a signed 64-bit integer.',
    constraints: 'Fails with E0044 when outside the i64 range; this is not a lossy or truncating conversion.'
  },
  bigint_abs: {
    name: 'bigint_abs',
    signature: 'bigint_abs(value: bigint) -> bigint',
    introduced: alpha9,
    summary: 'Returns the nonnegative absolute value of an exact signed bigint.',
    constraints: 'Uses immutable shared magnitude storage; BigInt remains interpreter-only and subject to bounded work and allocation limits.'
  },
  read_line_or: {
    name: 'read_line_or',
    signature: "read_line_or(fallback: string) -> string",
    introduced: alpha10,
    summary: "Reads one line, returning the fallback only at immediate EOF.",
    constraints: "Requires a supplied input reader; a blank line is not EOF. Impure and subject to input quotas."
  },
  try_read_line: {
    name: 'try_read_line',
    signature: "try_read_line() -> tuple<boolean, string>",
    introduced: alpha10,
    summary: "Reads a line and reports whether one was available.",
    constraints: "Returns (false, \"\") at EOF and (true, \"\") for an empty input line; errors still propagate."
  },
  ask: {
    name: 'ask',
    signature: "ask(prompt: string) -> string",
    introduced: alpha10,
    summary: "Displays and flushes a prompt before reading a line.",
    constraints: "Requires --interactive and a selected input reader. Impure; prompt remains visible on later errors."
  },
  ask_or: {
    name: 'ask_or',
    signature: "ask_or(prompt: string, fallback: string) -> string",
    introduced: alpha10,
    summary: "Prompts and returns the fallback only if the input source reaches EOF.",
    constraints: "Requires --interactive; a blank line is not EOF. Both arguments are evaluated before prompting."
  },
  input: {
    name: 'input',
    signature: "input(prompt: string) -> string",
    introduced: alpha10,
    summary: "Interactive prompt alias for ask.",
    constraints: "Requires --interactive; reads a bounded UTF-8 input line."
  },
  input_integer: {
    name: 'input_integer',
    signature: "input_integer(prompt: string) -> integer",
    introduced: alpha10,
    summary: "Prompts and parses a signed 64-bit decimal integer.",
    constraints: "Requires --interactive; rejects whitespace, radix prefixes and out-of-range input."
  },
  input_float: {
    name: 'input_float',
    signature: "input_float(prompt: string) -> float",
    introduced: alpha10,
    summary: "Prompts and parses a finite binary64 floating-point value.",
    constraints: "Requires --interactive; rejects malformed input, nonfinite values and overflow."
  },
  input_bigint: {
    name: 'input_bigint',
    signature: "input_bigint(prompt: string) -> bigint",
    introduced: alpha10,
    summary: "Prompts and parses an exact signed decimal BigInt.",
    constraints: "Requires --interactive; subject to BigInt digit, limb, text and input quotas."
  },
  flush_stdout: {
    name: 'flush_stdout',
    signature: "flush_stdout() -> unit",
    introduced: alpha10,
    summary: "Flushes the selected standard-output stream.",
    constraints: "Impure, takes no arguments; immediate under --interactive, replayed after ordinary successful execution."
  },
  flush_stderr: {
    name: 'flush_stderr',
    signature: "flush_stderr() -> unit",
    introduced: alpha10,
    summary: "Flushes the selected standard-error stream.",
    constraints: "Impure, takes no arguments; immediate under --interactive, replayed after ordinary successful execution."
  },
  bigint_pow: {
    name: 'bigint_pow',
    signature: "bigint_pow(value: bigint, exponent: integer) -> bigint",
    introduced: alpha10,
    summary: "Raises an exact integer to a nonnegative integer power.",
    constraints: "0^0 is 1; result digits, allocation and work remain bounded."
  },
  bigint_gcd: {
    name: 'bigint_gcd',
    signature: "bigint_gcd(left: bigint, right: bigint) -> bigint",
    introduced: alpha10,
    summary: "Computes nonnegative greatest common divisor of two exact integers.",
    constraints: "gcd(0, 0) is zero; both inputs may be negative."
  },
  bigint_lcm: {
    name: 'bigint_lcm',
    signature: "bigint_lcm(left: bigint, right: bigint) -> bigint",
    introduced: alpha10,
    summary: "Computes nonnegative least common multiple of two exact integers.",
    constraints: "lcm(0, x) is zero; work and allocation quotas apply."
  },
  bigint_sqrt: {
    name: 'bigint_sqrt',
    signature: "bigint_sqrt(value: bigint) -> bigint",
    introduced: alpha10,
    summary: "Computes the floor of the square root of an exact integer.",
    constraints: "Input must be nonnegative; returns an exact integer result."
  },
  bigint_bit_length: {
    name: 'bigint_bit_length',
    signature: "bigint_bit_length(value: bigint) -> integer",
    introduced: alpha10,
    summary: "Returns the bit width of an exact integer magnitude.",
    constraints: "Zero has bit length zero; uses the signed integer result type."
  },
  bigint_to_text: {
    name: 'bigint_to_text',
    signature: "bigint_to_text(value: bigint) -> string",
    introduced: alpha10,
    summary: "Formats an exact integer as canonical signed decimal text.",
    constraints: "Consumes text and work budgets; no implicit BigInt-to-string conversion."
  },
  bigint_from_radix: {
    name: 'bigint_from_radix',
    signature: "bigint_from_radix(value: string, base: integer) -> bigint",
    introduced: alpha10,
    summary: "Parses an exact integer in a radix from 2 through 36.",
    constraints: "ASCII digits and letters; limits apply to input and normalized decimal digits."
  },
  bigint_to_radix: {
    name: 'bigint_to_radix',
    signature: "bigint_to_radix(value: bigint, base: integer) -> string",
    introduced: alpha10,
    summary: "Formats an exact integer in a radix from 2 through 36.",
    constraints: "Uses lowercase alphabetic digits and consumes text/work budgets."
  },
  bigint_and: {
    name: 'bigint_and',
    signature: "bigint_and(left: bigint, right: bigint) -> bigint",
    introduced: alpha10,
    summary: "Bitwise AND with infinite signed two's-complement semantics.",
    constraints: "Both operands must be bigint; bounded interpreter work applies."
  },
  bigint_or: {
    name: 'bigint_or',
    signature: "bigint_or(left: bigint, right: bigint) -> bigint",
    introduced: alpha10,
    summary: "Bitwise OR with infinite signed two's-complement semantics.",
    constraints: "Both operands must be bigint; bounded interpreter work applies."
  },
  bigint_xor: {
    name: 'bigint_xor',
    signature: "bigint_xor(left: bigint, right: bigint) -> bigint",
    introduced: alpha10,
    summary: "Bitwise XOR with infinite signed two's-complement semantics.",
    constraints: "Both operands must be bigint; bounded interpreter work applies."
  },
  bigint_not: {
    name: 'bigint_not',
    signature: "bigint_not(value: bigint) -> bigint",
    introduced: alpha10,
    summary: "Bitwise complement with infinite signed two's-complement semantics.",
    constraints: "Returns the exact signed complement; not a fixed-width mask."
  },
  bigint_shl: {
    name: 'bigint_shl',
    signature: "bigint_shl(value: bigint, bits: integer) -> bigint",
    introduced: alpha10,
    summary: "Shifts an exact signed integer left.",
    constraints: "Shift count must be nonnegative; work, digit and allocation quotas apply."
  },
  bigint_shr: {
    name: 'bigint_shr',
    signature: "bigint_shr(value: bigint, bits: integer) -> bigint",
    introduced: alpha10,
    summary: "Shifts an exact signed integer right with sign extension.",
    constraints: "Shift count must be nonnegative; arithmetic right shift retains sign."
  },
  bigint_pow_mod: {
    name: 'bigint_pow_mod',
    signature: "bigint_pow_mod(value: bigint, exponent: integer, modulus: bigint) -> bigint",
    introduced: alpha10,
    summary: "Computes an exact modular power.",
    constraints: "Exponent must be nonnegative and modulus positive; variable-time arithmetic, not cryptographic constant-time."
  },
  bigint_divmod: {
    name: 'bigint_divmod',
    signature: "bigint_divmod(left: bigint, right: bigint) -> tuple<bigint, bigint>",
    introduced: alpha10,
    summary: "Returns exact quotient and remainder together.",
    constraints: "Division truncates toward zero; remainder follows the dividend's sign. Divisor must be nonzero."
  }
};

/** Read-only published builtin metadata; never consult inherited object properties. */
export function scarpBuiltinByName(name: string): ScarpBuiltinHelp | undefined {
  return Object.prototype.hasOwnProperty.call(HELP, name) ? HELP[name] : undefined;
}

/** Immutable list for read-only editor completion; no runtime feature probing. */
export const PUBLISHED_SCARP_BUILTINS: readonly ScarpBuiltinHelp[] =
  Object.freeze(Object.values(HELP));

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
        const help = scarpBuiltinByName(name);
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
