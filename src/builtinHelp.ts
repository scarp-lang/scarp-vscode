import { BUILTIN_CONTEXT_LIMIT, blockedBuiltinName, builtinTokenLowerBound, previousCodeToken, scanBuiltinContext, type BuiltinToken } from './builtinLexicalContext';

/**
 * Lightweight, editor-only help for published numerical, text, input and collection Scarp built-ins.
 *
 * This table is a reference to the compiler's released contracts, not a
 * semantic analysis of user code or an installed-compiler capability probe.
 * It performs no I/O, code execution or network requests in Restricted Mode.
 */
export interface ScarpBuiltinHelp {
  readonly name: string;
  readonly signature: string;
  readonly introduced: string;
  /** First release supporting the additional variadic operands, if applicable. */
  readonly variadicSince?: string;
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
const alpha11 = 'v0.0.6-alpha.11';
const alpha12 = 'v0.0.6-alpha.12';
const alpha16 = 'v0.0.6-alpha.16';
const alpha17 = 'v0.0.6-alpha.17';
const alpha18 = 'v0.0.6-alpha.18';
const alpha7Series1 = 'v0.0.7-alpha.1';

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
  },
  decimal: {
    name: 'decimal',
    signature: 'decimal(value: string) -> decimal',
    introduced: alpha11,
    summary: 'Constructs a bounded exact base-10 decimal from ASCII text.',
    constraints: 'Optional ASCII sign and decimal point, but no whitespace, exponent or separators. At most 28 canonical coefficient digits and 18 fractional places.'
  },
  decimal_from_integer: {
    name: 'decimal_from_integer',
    signature: 'decimal_from_integer(value: integer) -> decimal',
    introduced: alpha11,
    summary: 'Explicitly converts a signed 64-bit integer to an exact decimal.',
    constraints: 'No implicit integer, float or bigint mixing. Canonical decimal coefficient limits still apply.'
  },
  decimal_to_integer: {
    name: 'decimal_to_integer',
    signature: 'decimal_to_integer(value: decimal) -> integer',
    introduced: alpha11,
    summary: 'Converts an exact whole decimal to a checked signed 64-bit integer.',
    constraints: 'Fractional decimals are rejected rather than rounded; out-of-range whole values fail.'
  },
  decimal_to_text: {
    name: 'decimal_to_text',
    signature: 'decimal_to_text(value: decimal) -> string',
    introduced: alpha11,
    summary: 'Formats an exact decimal as canonical text without adding display zeros.',
    constraints: 'Preserves mathematical value; use decimal_format for an exact requested number of displayed places.'
  },
  decimal_round: {
    name: 'decimal_round',
    signature: 'decimal_round(value: decimal, places: integer, mode: string) -> decimal',
    introduced: alpha11,
    summary: 'Rounds an exact decimal and returns a decimal value.',
    constraints: 'Places must be 0–18; modes: half_even, half_up, toward_zero, away_from_zero. Result has at most the requested fractional places.'
  },
  decimal_format: {
    name: 'decimal_format',
    signature: 'decimal_format(value: decimal, places: integer, mode: string) -> string',
    introduced: alpha11,
    summary: 'Formats an exact decimal with a fixed number of displayed fractional places.',
    constraints: 'Places must be 0–18; use half_even, half_up, toward_zero or away_from_zero. Returns text with exactly that many decimal places.'
  },
  decimal_div_rounded: {
    name: 'decimal_div_rounded',
    signature: 'decimal_div_rounded(left: decimal, right: decimal, places: integer, mode: string) -> decimal',
    introduced: alpha11,
    summary: 'Divides two exact decimals using an explicit target scale and rounding mode.',
    constraints: 'Places must be 0–18; mode must be half_even, half_up, toward_zero or away_from_zero. Zero divisor and coefficient overflows are errors.'
  },
  input_decimal: {
    name: 'input_decimal',
    signature: 'input_decimal(prompt: string) -> decimal',
    introduced: alpha11,
    summary: 'Prompts, reads and validates an exact decimal value.',
    constraints: 'Impure and requires --interactive and a selected input source; follows the decimal parser and program-input quotas.'
  },
  list_len: {
    name: 'list_len',
    signature: 'list_len(items: list<T>) -> integer',
    introduced: alpha12,
    summary: 'Returns the current length of a typed immutable list.',
    constraints: 'Bounded to 4096 elements. Pure, with no mutation of existing snapshots.'
  },
  list_push: {
    name: 'list_push',
    signature: 'list_push(items: list<T>, value: T) -> list<T>',
    introduced: alpha12,
    summary: 'Returns a new list snapshot with a value appended.',
    constraints: 'Value must match T exactly; capacity is 4096 entries, with fresh logical allocation charged to --max-array-bytes.'
  },
  list_set: {
    name: 'list_set',
    signature: 'list_set(items: list<T>, index: integer, value: T) -> list<T>',
    introduced: alpha12,
    summary: 'Returns a new list snapshot with one element replaced.',
    constraints: 'Zero-based integer index must be in range (E0079). Original list remains unchanged; allocation/work budgets apply.'
  },
  list_remove: {
    name: 'list_remove',
    signature: 'list_remove(items: list<T>, index: integer) -> list<T>',
    introduced: alpha12,
    summary: 'Returns a new list snapshot without the indexed element.',
    constraints: 'Zero-based integer index must be valid (E0079). Existing aliases retain their original snapshots.'
  },
  map_len: {
    name: 'map_len',
    signature: 'map_len(items: map<K, V>) -> integer',
    introduced: alpha12,
    summary: 'Returns the number of distinct keys in an immutable typed map.',
    constraints: 'At most 1024 entries. Maps retain canonical key order rather than insertion order.'
  },
  map_keys: {
    name: 'map_keys',
    signature: 'map_keys(items: map<K, V>) -> list<K>',
    introduced: alpha12,
    summary: 'Projects map keys into a new immutable typed list in canonical order.',
    constraints: 'Keys are integer, boolean or string; sorted numeric, false-before-true, or UTF-8 lexical. Allocation quotas apply.'
  },
  map_values: {
    name: 'map_values',
    signature: 'map_values(items: map<K, V>) -> list<V>',
    introduced: alpha12,
    summary: 'Projects map values into a new immutable list aligned with canonical keys.',
    constraints: 'Values follow the same key order as map_keys, not source insertion order. New list allocation is charged.'
  },
  map_contains: {
    name: 'map_contains',
    signature: 'map_contains(items: map<K, V>, key: K) -> boolean',
    introduced: alpha12,
    summary: 'Checks whether an exactly typed map key is present.',
    constraints: 'Map keys are integer, boolean or string. This is a pure lookup; no mutation.'
  },
  map_get_or: {
    name: 'map_get_or',
    signature: 'map_get_or(items: map<K, V>, key: K, fallback: V) -> V',
    introduced: alpha12,
    summary: 'Gets the stored value, or the provided typed fallback for a missing key.',
    constraints: 'All arguments are eagerly evaluated, including fallback even when the key exists. Exact K and V types required.'
  },
  map_set: {
    name: 'map_set',
    signature: 'map_set(items: map<K, V>, key: K, value: V) -> map<K, V>',
    introduced: alpha12,
    summary: 'Returns an immutable map snapshot with one key inserted or replaced.',
    constraints: 'At most 1024 distinct keys (E0081); key and value types must match. New snapshot charges --max-array-bytes.'
  },
  map_remove: {
    name: 'map_remove',
    signature: 'map_remove(items: map<K, V>, key: K) -> map<K, V>',
    introduced: alpha12,
    summary: 'Returns an immutable map snapshot without the specified key.',
    constraints: 'Missing keys may share the original snapshot. All existing aliases remain unchanged.'
  },
  median: {
    name: 'median',
    signature: 'median(values: vector) -> float',
    introduced: alpha16,
    summary: 'Returns the middle sorted numerical value, averaging the middle pair for even lengths.',
    constraints: 'Nonempty finite vector of at most 65,536 elements; a sorted copy charges --max-vector-bytes and bounded work. The input is not changed.'
  },
  quantile: {
    name: 'quantile',
    signature: 'quantile(values: vector, fraction: float) -> float',
    introduced: alpha16,
    summary: 'Computes the type-7 linearly interpolated numerical quantile.',
    constraints: 'Nonempty finite vector of at most 65,536 elements; fraction must be finite within 0.0–1.0. Sorted copy, work and vector-byte quotas apply.'
  },
  text_lower: {
    name: 'text_lower',
    signature: 'text_lower(value: string) -> string',
    introduced: alpha16,
    summary: 'Maps Unicode scalars to lowercase using locale-independent Unicode tables.',
    constraints: 'Case mapping may expand into several scalars; no Unicode normalization or contextual locale processing. Text length and work quotas apply.'
  },
  text_upper: {
    name: 'text_upper',
    signature: 'text_upper(value: string) -> string',
    introduced: alpha16,
    summary: 'Maps Unicode scalars to uppercase using locale-independent Unicode tables.',
    constraints: 'Case mapping may expand into several scalars, for example ß to SS; no locale-sensitive casing. Text length and work quotas apply.'
  },
  text_reverse: {
    name: 'text_reverse',
    signature: 'text_reverse(value: string) -> string',
    introduced: alpha16,
    summary: 'Reverses the sequence of Unicode scalar values.',
    constraints: 'Does not reverse grapheme clusters; a combining mark may separate from its base. UTF-8 text length and work quotas apply.'
  },
  text_from_codepoint: {
    name: 'text_from_codepoint',
    signature: 'text_from_codepoint(value: integer) -> string',
    introduced: alpha16,
    summary: 'Constructs a UTF-8 string containing one Unicode scalar.',
    constraints: 'Code point must be 0 through 0x10FFFF but not a surrogate from 0xD800 to 0xDFFF; invalid values are errors.'
  },
  text_rfind: {
    name: 'text_rfind',
    signature: 'text_rfind(value: string, needle: string) -> integer',
    introduced: alpha16,
    summary: 'Finds the last exact UTF-8 substring and returns its Unicode scalar index.',
    constraints: 'Returns -1 when absent; an empty needle returns the scalar length of value. Exact, case-sensitive search without normalization.'
  },
  text_count: {
    name: 'text_count',
    signature: 'text_count(value: string, needle: string) -> integer',
    introduced: alpha16,
    summary: 'Counts nonoverlapping exact UTF-8 substring occurrences from left to right.',
    constraints: 'An empty needle counts all Unicode scalar boundaries, including the start and end. Case-sensitive, non-regex matching.'
  },
  bits_count_ones: {
    name: 'bits_count_ones',
    signature: 'bits_count_ones(value: integer) -> integer',
    introduced: alpha16,
    summary: 'Counts set bits in the signed integer\'s 64-bit two\'s-complement pattern.',
    constraints: 'Includes the sign bit; negative inputs are inspected as all 64 bits, not as arbitrary-precision bigints.'
  },
  bits_leading_zeros: {
    name: 'bits_leading_zeros',
    signature: 'bits_leading_zeros(value: integer) -> integer',
    introduced: alpha16,
    summary: 'Counts leading zero bits in a signed 64-bit integer pattern.',
    constraints: 'Operates on all 64 bits, including the sign bit; zero has 64 leading zeros.'
  },
  bits_trailing_zeros: {
    name: 'bits_trailing_zeros',
    signature: 'bits_trailing_zeros(value: integer) -> integer',
    introduced: alpha16,
    summary: 'Counts trailing zero bits in a signed 64-bit integer pattern.',
    constraints: 'Operates on all 64 bits, including the sign bit; zero has 64 trailing zeros.'
  },
  bits_reverse: {
    name: 'bits_reverse',
    signature: 'bits_reverse(value: integer) -> integer',
    introduced: alpha16,
    summary: 'Reverses all 64 bits of an integer\'s bit pattern.',
    constraints: 'Returns the signed two\'s-complement interpretation of the reversed bits, which may be negative.'
  },
  bits_swap_bytes: {
    name: 'bits_swap_bytes',
    signature: 'bits_swap_bytes(value: integer) -> integer',
    introduced: alpha16,
    summary: 'Reverses the order of the eight bytes of a signed 64-bit integer.',
    constraints: 'Returns the signed two\'s-complement interpretation of the swapped 64-bit pattern.'
  },
  bits_rotate_left: {
    name: 'bits_rotate_left',
    signature: 'bits_rotate_left(value: integer, positions: integer) -> integer',
    introduced: alpha16,
    summary: 'Rotates the full 64-bit integer pattern left.',
    constraints: 'Rotation count must be 0 through 63; invalid counts produce E0046. Signed two\'s-complement result.'
  },
  bits_rotate_right: {
    name: 'bits_rotate_right',
    signature: 'bits_rotate_right(value: integer, positions: integer) -> integer',
    introduced: alpha16,
    summary: 'Rotates the full 64-bit integer pattern right.',
    constraints: 'Rotation count must be 0 through 63; invalid counts produce E0046. Signed two\'s-complement result.'
  },
  integer_abs: {
    name: 'integer_abs',
    signature: 'integer_abs(value: integer) -> integer',
    introduced: alpha16,
    summary: 'Returns the checked nonnegative magnitude of a signed 64-bit integer.',
    constraints: 'The minimum signed 64-bit integer has no representable positive magnitude and produces arithmetic overflow.'
  },
  integer_sign: {
    name: 'integer_sign',
    signature: 'integer_sign(value: integer) -> integer',
    introduced: alpha16,
    summary: 'Returns -1, 0 or 1 according to the input\'s sign.',
    constraints: 'Requires a signed 64-bit integer; does not silently convert from float, decimal or bigint.'
  },
  integer_gcd: {
    name: 'integer_gcd',
    signature: 'integer_gcd(left: integer, right: integer, ...more: integer) -> integer',
    introduced: alpha16,
    variadicSince: alpha7Series1,
    summary: 'Returns the greatest common divisor of signed 64-bit integers.',
    constraints: 'Binary calls require v0.0.6-alpha.16+; 2–1,024 operands require v0.0.7-alpha.1+ for more than two. Uses nonnegative magnitudes; gcd(0, 0) = 0. A nonrepresentable positive result causes overflow.'
  },
  integer_hcf: {
    name: 'integer_hcf',
    signature: 'integer_hcf(left: integer, right: integer, ...more: integer) -> integer',
    introduced: alpha7Series1,
    variadicSince: alpha7Series1,
    summary: 'Alias for integer_gcd: returns the highest common factor of signed 64-bit integers.',
    constraints: 'Requires 2–1,024 integer operands. Uses nonnegative magnitudes; all-zero operands return 0. A nonrepresentable positive result causes overflow.'
  },
  integer_lcm: {
    name: 'integer_lcm',
    signature: 'integer_lcm(left: integer, right: integer, ...more: integer) -> integer',
    introduced: alpha16,
    variadicSince: alpha7Series1,
    summary: 'Returns the nonnegative least common multiple of signed 64-bit integers.',
    constraints: 'Binary calls require v0.0.6-alpha.16+; more than two operands require v0.0.7-alpha.1+ (maximum 1,024). Any zero operand returns 0, including when a nonzero prefix would overflow; otherwise a nonrepresentable positive result causes arithmetic overflow.'
  },
  array_len: {
    name: 'array_len',
    signature: 'array_len(values: array<T, N>) -> integer',
    introduced: alpha17,
    summary: 'Returns the fixed length of an immutable array, including zero for a typed empty array.',
    constraints: 'Pure, constant-time length query. Arrays have at most 4,096 elements; use as the count in repeat array_len(values) as index.'
  },
  array_get_or: {
    name: 'array_get_or',
    signature: 'array_get_or(values: array<T, N>, index: integer, fallback: T) -> T',
    introduced: alpha17,
    summary: 'Returns the array element at an index, or a typed fallback for an invalid index.',
    constraints: 'A negative or out-of-bounds index returns the fallback. All three arguments, including the fallback, are eagerly evaluated exactly once in source order; the fallback must match the element type.'
  },
  array_set: {
    name: 'array_set',
    signature: 'array_set(values: array<T, N>, index: integer, replacement: T) -> array<T, N>',
    introduced: alpha18,
    summary: 'Returns a new fixed array with one element replaced, preserving the original and every existing alias.',
    constraints: 'Pure and persistent, not indexed assignment. Index must be nonnegative and within the array (E0063); replacement must match element type T. Arguments evaluate once in source order. Every successful update charges a new array allocation (E0064) against --max-array-bytes.'
  },
  array_concat: {
    name: 'array_concat',
    signature: 'array_concat(left: array<T, M>, right: array<T, N>) -> array<T, M + N>',
    introduced: alpha7Series1,
    summary: 'Pure, persistent concatenation of fixed arrays in source order; the resolver infers the combined length.',
    constraints: 'Both operands must have identical element types; the result must satisfy the 4,096-element and nested shape limits (E0062). Arguments evaluate once in source order. An empty operand may share the other snapshot; two nonempty operands charge new backing storage (E0064) and linear work.'
  },
  softplus: {
    name: 'softplus',
    signature: 'softplus(values: vector) -> vector',
    introduced: alpha7Series1,
    summary: 'Applies the numerically stable natural logarithm of one plus the exponential to each vector element.',
    constraints: 'Requires a vector, not a scalar. Preserves length and order, including empty vectors. Uses finite inputs and stable evaluation for large positive and negative values; ordinary vector allocation and work limits apply.'
  },
  input_boolean: {
    name: 'input_boolean',
    signature: 'input_boolean(prompt: string) -> boolean',
    introduced: alpha17,
    summary: 'Prompts for a typed Boolean value from the explicitly selected interactive input stream.',
    constraints: 'Impure; on alpha.17 exec and legacy run requires --interactive. Published alpha.18 exec accepts terminal prompts by default. Accepts only lowercase true or false with no surrounding whitespace. Invalid input reports E0084; immediate EOF reports E0055. Supports --input-file replay.'
  }
};

/** Read-only published builtin metadata; never consult inherited object properties. */
export function scarpBuiltinByName(name: string): ScarpBuiltinHelp | undefined {
  return Object.prototype.hasOwnProperty.call(HELP, name) ? HELP[name] : undefined;
}

/** Immutable list for read-only editor completion; no runtime feature probing. */
export const PUBLISHED_SCARP_BUILTINS: readonly ScarpBuiltinHelp[] =
  Object.freeze(Object.values(HELP));

/**
 * Find help only on an unqualified call name. Bounded preceding lines preserve
 * lexical context for declarations and qualified names split across lines.
 * Following-line lookahead intentionally does not jump over comments.
 */
export function scarpBuiltinAt(
  line: string, character: number, nextLine = '', preceding = ''
): ScarpBuiltinCall | undefined {
  if (!Number.isSafeInteger(character) || character < 0 ||
      character >= line.length || nextLine.length > BUILTIN_CONTEXT_LIMIT) return undefined;
  const tokens = scanBuiltinContext(preceding + line);
  if (!tokens) return undefined;
  const source = preceding + line + '\n' + nextLine;
  return scarpBuiltinFromTokens(tokens, source, preceding.length + character,
    preceding.length, source.length);
}

/** Query cached full-prefix tokens, retaining the existing one-line lookahead. */
export function scarpBuiltinFromTokens(
  tokens: readonly BuiltinToken[], source: string, cursor: number,
  lineStart: number, lookaheadEnd: number
): ScarpBuiltinCall | undefined {
  if (!Number.isSafeInteger(cursor) || !Number.isSafeInteger(lineStart) ||
      !Number.isSafeInteger(lookaheadEnd) || lineStart < 0 || cursor < lineStart ||
      cursor >= source.length || lookaheadEnd > source.length || lookaheadEnd <= cursor) return undefined;
  const at = builtinTokenLowerBound(tokens, cursor);
  const index = tokens[at]?.start === cursor ? at : at - 1;
  const token = tokens[index];
  if (!token || token.kind !== 'word' || token.start < lineStart || cursor >= token.end ||
      blockedBuiltinName(previousCodeToken(tokens, index))) return undefined;
  const help = scarpBuiltinByName(token.text);
  if (!help || !/^\s*\(/.test(source.slice(token.end, lookaheadEnd))) return undefined;
  return { help, start: token.start - lineStart, end: token.end - lineStart };
}
