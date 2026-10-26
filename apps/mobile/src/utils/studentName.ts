const SUFFIXES = new Set([
  'jr', 'jr.',
  'sr', 'sr.',
  'i', 'ii', 'iii', 'iv', 'v', 'vi',
  'junior', 'senior',
  'esq', 'esq.',
  'phd', 'm.d.', 'md',
  'dds', 'j.d.', 'jd',
]);

const SURNAME_PREFIXES = [
  // Multi-token prefixes
  "in 't", 'int \'t', 'van der', 'van den', 'van de', 'von der', 'von den', 'von de', 'op den', 'op de',
  'de las', 'de los', 'de la', 'di stefano',
  // Single-token prefixes
  'dela', 'della', 'delle', 'degli', 'del', 'des', 'de', 'di', 'da', 'du', 'van', 'von', 'ten', 'ter', 'zum', 'zur',
  'le', 'la', 'lo', 'st.', 'saint', 'ben', 'bin', 'ibn', 'ap',
].sort((a, b) => b.length - a.length);

function clean(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function findPrefixStart(tokens: string[]) {
  const normalizedTokens = tokens.map(compareValue);
  for (let index = 0; index < tokens.length; index += 1) {
    for (const prefix of SURNAME_PREFIXES) {
      const prefixTokens = prefix.split(' ');
      const candidate = normalizedTokens.slice(index, index + prefixTokens.length).join(' ');
      if (candidate === prefix) return index;
    }
  }
  return -1;
}

function compareValue(value: string) {
  return value.toLocaleLowerCase().replace(/[.,]/g, '');
}

function isSuffix(value: string) {
  return SUFFIXES.has(compareValue(value));
}

function extractSuffixes(tokens: string[]) {
  const nameTokens: string[] = [];
  const suffixTokens: string[] = [];
  for (const token of tokens) {
    if (isSuffix(token)) suffixTokens.push(token);
    else nameTokens.push(token);
  }
  return { tokens: nameTokens, suffix: suffixTokens.join(' ') };
}

function splitLastName(tokens: string[]) {
  if (tokens.length === 0) return { lastNames: [] as string[], lastName: '' };
  if (tokens.length === 1) return { lastNames: [tokens[0]], lastName: tokens[0] };

  const normalizedTokens = tokens.map(compareValue);
  for (const prefix of SURNAME_PREFIXES) {
    const prefixTokens = prefix.split(' ');
    const start = tokens.length - 1 - prefixTokens.length;
    if (start < 0) continue;
    const candidate = normalizedTokens.slice(start, tokens.length - 1).join(' ');
    if (candidate === prefix) {
      const lastNames = [...tokens.slice(start, tokens.length - 1), tokens[tokens.length - 1]];
      return { lastNames, lastName: lastNames.join(' ') };
    }
  }
  return { lastNames: [tokens[tokens.length - 1]], lastName: tokens[tokens.length - 1] };
}

export type ParseStudentNameOptions = { middleNameCount?: number };
export type ParsedStudentName = {
  firstNames: string[];
  middleNames: string[];
  lastNames: string[];
  suffix: string;
  firstName: string;
  middleName: string;
  lastName: string;
};

/** Parses names using the same suffix, comma-order, prefix, and middleNameCount rules as the supplied reference. */
export function parseStudentName(input: unknown, options: ParseStudentNameOptions = {}): ParsedStudentName {
  const { middleNameCount = 1 } = options;
  if (typeof input !== 'string' || !input.trim()) throw new TypeError('Name must be a non-empty string.');

  const value = clean(input);
  const commaParts = value.split(',').map(clean).filter(Boolean);
  let suffix = '';
  let firstNames: string[] = [];
  let middleNames: string[] = [];
  let lastNames: string[] = [];

  if (commaParts.length >= 2) {
    const left = extractSuffixes(commaParts[0].split(' '));
    const right = extractSuffixes(commaParts.slice(1).join(' ').split(' '));
    suffix = [...left.suffix.split(' ').filter(Boolean), ...right.suffix.split(' ').filter(Boolean)].join(' ');
    lastNames = left.tokens;
    const givenTokens = right.tokens;
    const prefixStart = findPrefixStart(givenTokens);

    if (prefixStart > 0) {
      firstNames = givenTokens.slice(0, prefixStart);
      middleNames = givenTokens.slice(prefixStart);
    } else if (givenTokens.length <= middleNameCount) {
      firstNames = [givenTokens[0]].filter(Boolean);
      middleNames = givenTokens.slice(1);
    } else {
      const middleStart = givenTokens.length - middleNameCount;
      firstNames = givenTokens.slice(0, middleStart);
      middleNames = givenTokens.slice(middleStart);
    }
  } else {
    const parsed = extractSuffixes(value.split(' '));
    suffix = parsed.suffix;
    const tokens = parsed.tokens;

    if (tokens.length === 1) {
      firstNames = [tokens[0]];
      middleNames = [];
      lastNames = [];
    } else {
      const surname = splitLastName(tokens);
      lastNames = surname.lastNames;
      const givenTokens = tokens.slice(0, tokens.length - lastNames.length);
      const prefixStart = findPrefixStart(givenTokens);

      if (prefixStart > 0) {
        firstNames = givenTokens.slice(0, prefixStart);
        middleNames = givenTokens.slice(prefixStart);
      } else if (givenTokens.length <= middleNameCount) {
        firstNames = [givenTokens[0]].filter(Boolean);
        middleNames = givenTokens.slice(1);
      } else {
        const middleStart = givenTokens.length - middleNameCount;
        firstNames = givenTokens.slice(0, middleStart);
        middleNames = givenTokens.slice(middleStart);
      }
    }
  }

  return {
    firstNames,
    middleNames,
    lastNames,
    suffix,
    firstName: firstNames.join(' '),
    middleName: middleNames.join(' '),
    lastName: lastNames.join(' '),
  };
}

/** Import rows may have an empty name cell, so this wrapper returns empty fields for that case. */
export function parseStudentFullName(input: string): Pick<ParsedStudentName, 'firstName' | 'middleName' | 'lastName' | 'suffix'> {
  if (!input.trim()) return { firstName: '', middleName: '', lastName: '', suffix: '' };
  const { firstName, middleName, lastName, suffix } = parseStudentName(input);
  return { firstName, middleName, lastName, suffix };
}

export function extractStudentSuffixes(value: string) {
  const parsed = extractSuffixes(clean(value).split(' ').filter(Boolean));
  return { value: parsed.tokens.join(' '), suffix: parsed.suffix };
}

export function formatStudentName(parts: Partial<ParsedStudentName>) {
  return [parts.firstName, parts.middleName, parts.lastName, parts.suffix]
    .map((part) => clean(part ?? ''))
    .filter(Boolean)
    .join(' ');
}
