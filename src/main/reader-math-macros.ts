import type { MathMacroDefinition } from "./mathjax-renderer";
export type MathMacroScope = Map<string, MathMacroDefinition>;
const MAX_MATH_MACROS = 128;
const MAX_MATH_MACRO_BODY_LENGTH = 12_000;

function normaliseMacroName(name: string): string | undefined {
  const normalised = name.replace(/^\\/, "").trim();
  return /^[A-Za-z]+$/.test(normalised) ? normalised : undefined;
}

function isSafeMacroDefinition(definition: MathMacroDefinition): boolean {
  return definition.body.length > 0
    && definition.body.length <= MAX_MATH_MACRO_BODY_LENGTH
    && (definition.argumentCount === undefined || (Number.isInteger(definition.argumentCount) && definition.argumentCount >= 0 && definition.argumentCount <= 9))
    && (definition.defaultValue === undefined || definition.defaultValue.length <= MAX_MATH_MACRO_BODY_LENGTH);
}

export function mergeMathMacros(target: MathMacroScope, additions: MathMacroScope): void {
  for (const [name, definition] of additions) {
    if (target.size >= MAX_MATH_MACROS && !target.has(name)) break;
    if (normaliseMacroName(name) && isSafeMacroDefinition(definition)) target.set(normaliseMacroName(name)!, definition);
  }
}

/** KaTeX safely infers ordinary `#1` arity from a macro body. */
export function katexMacros(macros: MathMacroScope): Record<string, string> {
  return Object.fromEntries([...macros].map(([name, definition]) => [`\\${name}`, definition.body]));
}

/**
 * Parses MathJax's object syntax with an inert, brace- and quote-aware
 * scanner. A regex cannot safely read `Macros: { rcos: ["\\\\mathop{…}", 1] }`
 * because the macro definition itself contains nested braces.
 */
export function extractMathJaxConfigMacros(input: string): MathMacroScope {
  const macros: MathMacroScope = new Map();
  const marker = /(?:Macros|macros)\s*:\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(input))) {
    const opening = input.indexOf("{", match.index);
    const object = readJavaScriptBalanced(input, opening, "{", "}");
    if (!object) continue;
    mergeMathMacros(macros, parseMathJaxMacroObject(object.content));
    marker.lastIndex = object.next;
  }
  return macros;
}

function parseMathJaxMacroObject(input: string): MathMacroScope {
  const macros: MathMacroScope = new Map();
  let cursor = 0;
  while (cursor < input.length) {
    cursor = skipJavaScriptSeparators(input, cursor);
    const key = readJavaScriptPropertyKey(input, cursor);
    if (!key) break;
    cursor = skipJavaScriptSeparators(input, key.next);
    if (input[cursor] !== ":") {
      cursor = key.next + 1;
      continue;
    }
    const value = readJavaScriptMacroValue(input, cursor + 1);
    if (!value) break;
    const name = normaliseMacroName(key.value);
    if (name && value.definition && isSafeMacroDefinition(value.definition)) macros.set(name, value.definition);
    cursor = value.next;
  }
  return macros;
}

function skipJavaScriptSeparators(input: string, start: number): number {
  let cursor = start;
  while (/[\s,;]/.test(input[cursor] || "")) cursor += 1;
  return cursor;
}

function readJavaScriptPropertyKey(input: string, start: number): { value: string; next: number } | undefined {
  const quote = input[start];
  if (quote === "'" || quote === '"') return readJavaScriptString(input, start);
  const match = input.slice(start).match(/^([A-Za-z][A-Za-z0-9_]*)/);
  return match ? { value: match[1], next: start + match[1].length } : undefined;
}

function readJavaScriptMacroValue(input: string, start: number): { definition?: MathMacroDefinition; next: number } | undefined {
  let cursor = skipJavaScriptSeparators(input, start);
  const quote = input[cursor];
  if (quote === "'" || quote === '"') {
    const value = readJavaScriptString(input, cursor);
    return value && { definition: { body: value.value }, next: value.next };
  }
  if (input[cursor] === "[") {
    const array = readJavaScriptBalanced(input, cursor, "[", "]");
    if (!array) return undefined;
    const values = readJavaScriptArrayValues(array.content);
    const body = typeof values[0] === "string" ? values[0] : undefined;
    const argumentCount = typeof values[1] === "number" && Number.isInteger(values[1]) && values[1] >= 0 && values[1] <= 9
      ? values[1]
      : undefined;
    const defaultValue = argumentCount !== undefined && argumentCount > 0 && typeof values[2] === "string" ? values[2] : undefined;
    return { definition: body ? { body, argumentCount, defaultValue } : undefined, next: array.next };
  }
  if (input[cursor] === "{") {
    const object = readJavaScriptBalanced(input, cursor, "{", "}");
    return object && { next: object.next };
  }
  while (cursor < input.length && !/[,;}]/.test(input[cursor])) cursor += 1;
  return { next: cursor };
}

function readJavaScriptArrayValues(input: string): Array<string | number | undefined> {
  const values: Array<string | number | undefined> = [];
  let cursor = 0;
  while (cursor < input.length) {
    cursor = skipJavaScriptSeparators(input, cursor);
    if (cursor >= input.length) break;
    const quote = input[cursor];
    if (quote === "'" || quote === '"') {
      const value = readJavaScriptString(input, cursor);
      if (!value) break;
      values.push(value.value);
      cursor = value.next;
      continue;
    }
    const number = input.slice(cursor).match(/^-?\d+/);
    if (number) {
      values.push(Number.parseInt(number[0], 10));
      cursor += number[0].length;
      continue;
    }
    const opener = input[cursor];
    if (opener === "[" || opener === "{") {
      const nested = readJavaScriptBalanced(input, cursor, opener, opener === "[" ? "]" : "}");
      if (!nested) break;
      values.push(undefined);
      cursor = nested.next;
      continue;
    }
    while (cursor < input.length && input[cursor] !== ",") cursor += 1;
    values.push(undefined);
  }
  return values;
}

function readJavaScriptString(input: string, start: number): { value: string; next: number } | undefined {
  const quote = input[start];
  let value = "";
  for (let cursor = start + 1; cursor < input.length; cursor += 1) {
    const character = input[cursor];
    if (character === quote) return { value, next: cursor + 1 };
    if (character !== "\\") {
      value += character;
      continue;
    }
    const escaped = input[cursor + 1];
    if (escaped === undefined) return undefined;
    cursor += 1;
    if (escaped === "n") value += "\n";
    else if (escaped === "r") value += "\r";
    else if (escaped === "t") value += "\t";
    else if (escaped === "b") value += "\b";
    else if (escaped === "f") value += "\f";
    else if (escaped === "v") value += "\v";
    else if (escaped === "0") value += "\0";
    else if (escaped === "\\") value += "\\";
    else value += `\\${escaped}`;
  }
  return undefined;
}

function readJavaScriptBalanced(input: string, start: number, opening: string, closing: string): { content: string; next: number } | undefined {
  if (input[start] !== opening) return undefined;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let cursor = start; cursor < input.length; cursor += 1) {
    const character = input[cursor];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === opening) depth += 1;
    if (character === closing) {
      depth -= 1;
      if (depth === 0) return { content: input.slice(start + 1, cursor), next: cursor + 1 };
    }
  }
  return undefined;
}

/**
 * MathJax pages may declare aliases in one equation and use them much later in
 * the article. Preserve enough declaration structure to replay the scope with
 * the exact argument count in the local MathJax renderer.
 */
export function extractMacroDeclarations(input: string): { tex: string; macros: MathMacroScope } {
  const macros: MathMacroScope = new Map();
  let output = "";
  let cursor = 0;
  const declaration = /\\(newcommand\*?|renewcommand\*?|providecommand\*?|DeclareMathOperator\*?|(?:g|e|x)?def)(?![A-Za-z])\s*/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(input))) {
    output += input.slice(cursor, match.index);
    const parsed = parseMacroDeclaration(input, declaration.lastIndex, match[1]);
    if (!parsed) {
      output += match[0];
      cursor = declaration.lastIndex;
      continue;
    }
    if (isSafeMacroDefinition(parsed.definition)) macros.set(parsed.name, parsed.definition);
    cursor = parsed.next;
    declaration.lastIndex = cursor;
  }
  output += input.slice(cursor);
  return { tex: output, macros };
}

function parseMacroDeclaration(input: string, start: number, kind: string): { name: string; definition: MathMacroDefinition; next: number } | undefined {
  let cursor = skipTeXWhitespace(input, start);
  if (kind.endsWith("def")) {
    const nameMatch = input.slice(cursor).match(/^\\([A-Za-z]+)/);
    if (!nameMatch) return undefined;
    const name = nameMatch[1];
    cursor += nameMatch[0].length;
    let argumentCount = 0;
    while (true) {
      cursor = skipTeXWhitespace(input, cursor);
      const parameter = input.slice(cursor).match(/^#([1-9])/);
      if (!parameter) break;
      argumentCount = Math.max(argumentCount, Number.parseInt(parameter[1], 10));
      cursor += parameter[0].length;
    }
    const definition = readTeXGroup(input, cursor);
    return definition ? { name, definition: { body: definition.content, argumentCount: argumentCount || undefined }, next: definition.next } : undefined;
  }

  if (kind.startsWith("DeclareMathOperator")) {
    const nameGroup = readTeXGroup(input, cursor);
    if (!nameGroup) return undefined;
    const definitionGroup = readTeXGroup(input, skipTeXWhitespace(input, nameGroup.next));
    const name = normaliseMacroName(nameGroup.content);
    if (!definitionGroup || !name) return undefined;
    return { name, definition: { body: `\\operatorname{${definitionGroup.content}}` }, next: definitionGroup.next };
  }

  const nameGroup = readTeXGroup(input, cursor);
  if (!nameGroup) return undefined;
  cursor = skipTeXWhitespace(input, nameGroup.next);
  // \newcommand may include a parameter count and a default argument.
  // KaTeX can apply #1…#9 replacements, so retain the body and discard only
  // these declaration wrappers.
  const optionalGroups: string[] = [];
  let optional: { content: string; next: number } | undefined;
  while ((optional = readTeXOptionalGroup(input, cursor))) {
    optionalGroups.push(optional.content);
    cursor = skipTeXWhitespace(input, optional.next);
  }
  const definitionGroup = readTeXGroup(input, cursor);
  const name = normaliseMacroName(nameGroup.content);
  if (!definitionGroup || !name) return undefined;
  const parsedArgumentCount = optionalGroups[0] && /^\d+$/.test(optionalGroups[0])
    ? Number.parseInt(optionalGroups[0], 10)
    : undefined;
  const argumentCount = parsedArgumentCount !== undefined && parsedArgumentCount >= 0 && parsedArgumentCount <= 9
    ? parsedArgumentCount
    : undefined;
  const defaultValue = argumentCount !== undefined && argumentCount > 0 && optionalGroups[1] !== undefined ? optionalGroups[1] : undefined;
  return {
    name,
    definition: { body: definitionGroup.content, argumentCount, defaultValue },
    next: definitionGroup.next
  };
}

export function skipTeXWhitespace(input: string, start: number): number {
  let cursor = start;
  while (/\s/.test(input[cursor] || "")) cursor += 1;
  return cursor;
}

export function readTeXOptionalGroup(input: string, start: number): { content: string; next: number } | undefined {
  if (input[start] !== "[") return undefined;
  const close = input.indexOf("]", start + 1);
  return close < 0 ? undefined : { content: input.slice(start + 1, close), next: close + 1 };
}

export function readTeXGroup(input: string, start: number): { content: string; next: number } | undefined {
  if (input[start] !== "{") return undefined;
  let depth = 0;
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === "{" && input[index - 1] !== "\\") depth += 1;
    if (input[index] === "}" && input[index - 1] !== "\\") {
      depth -= 1;
      if (depth === 0) return { content: input.slice(start + 1, index), next: index + 1 };
    }
  }
  return undefined;
}

