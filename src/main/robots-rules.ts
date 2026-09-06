/** Rules selected for our product token, independent of HTTP and cache state. */
export interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
  readonly parts: readonly string[];
  readonly exact: boolean;
}

export function parseRobots(input: string, productToken = "ReadingHub"): RobotsRule[] {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let group: typeof groups[number] | undefined;
  let hasRules = false;
  for (const rawLine of input.replace(/^\uFEFF/, "").split(/\r\n|[\r\n]/)) {
    const line = trimWhitespace(rawLine.replace(/#.*/, ""));
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = trimWhitespace(line.slice(0, separator)).toLowerCase();
    const value = trimWhitespace(line.slice(separator + 1));
    if (key === "user-agent") {
      if (!group || hasRules) {
        group = { agents: [], rules: [] };
        groups.push(group);
        hasRules = false;
      }
      if (/^(?:\*|[a-z_-]+)$/i.test(value)) group.agents.push(value.toLowerCase());
    } else if (group && (key === "allow" || key === "disallow")) {
      // Even an empty rule ends the agent header, but it restricts no path.
      hasRules = true;
      if (!value || !/^[/*]/.test(value) || /[\u0000-\u0020\u007f]/.test(value)) continue;
      const exact = value.endsWith("$");
      const body = exact ? value.slice(0, -1) : value;
      const parts = body.split("*").map(normalizeOctets);
      const pattern = parts.join("*") + (exact ? "$" : "");
      group.rules.push({ allow: key === "allow", pattern, parts, exact });
    }
    // Unknown records and blank lines do not terminate a group.
  }
  const specific = groups.filter(({ agents }) => agents.includes(productToken.toLowerCase()));
  const selected = specific.length ? specific : groups.filter(({ agents }) => agents.includes("*"));
  return selected.flatMap(({ rules }) => rules);
}

export function isRobotsPathAllowed(rules: readonly RobotsRule[], path: string): boolean {
  const normalized = normalizeOctets(path);
  if (normalized === "/robots.txt") return true;
  let winner: RobotsRule | undefined;
  for (const rule of rules) {
    if (winner && (rule.pattern.length < winner.pattern.length || (rule.pattern.length === winner.pattern.length && winner.allow))) continue;
    if (matches(rule, normalized)) winner = rule;
  }
  return winner?.allow ?? true;
}

function matches(rule: RobotsRule, path: string): boolean {
  const first = rule.parts[0];
  if (!path.startsWith(first)) return false;
  if (rule.parts.length === 1) return !rule.exact || path.length === first.length;
  let position = first.length;
  for (let index = 1; index < rule.parts.length; index++) {
    const part = rule.parts[index];
    if (rule.exact && index === rule.parts.length - 1) {
      return path.length - part.length >= position && path.endsWith(part);
    }
    // Ordered literal searches avoid executable regexes and wildcard
    // backtracking over untrusted remote patterns.
    const found = path.indexOf(part, position);
    if (found < 0) return false;
    position = found + part.length;
  }
  return true;
}

function trimWhitespace(value: string): string {
  // REP whitespace is ASCII space/tab; a non-ASCII space can be path data.
  return value.replace(/^[ \t]+|[ \t]+$/g, "");
}

/** Decode only unreserved ASCII; encoded separators keep their identity. */
function normalizeOctets(value: string): string {
  return value.replace(/%[0-9a-f]{2}|[^\x00-\x7f]|[*$]/giu, (character) => {
    if (character.startsWith("%")) {
      const decoded = String.fromCharCode(parseInt(character.slice(1), 16));
      return /^[a-z0-9._~-]$/i.test(decoded) ? decoded : character.toUpperCase();
    }
    if (character === "*") return "%2A";
    if (character === "$") return "%24";
    return Array.from(new TextEncoder().encode(character), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("");
  });
}
