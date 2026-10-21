import { readTeXGroup } from "./reader-math-macros";

/** Authored top-level AMS rows, not line breaks inside cases/substack/text.
 * Joining with `\\\\` reproduces the exact source, including row spacing. */
export function splitEquationRows(tex: string): string[] {
  const rows: string[] = [];
  let start = 0, braces = 0, environments = 0;
  for (let cursor = 0; cursor < tex.length; cursor++) {
    const character = tex[cursor];
    if (character === "%") {
      const newline = tex.indexOf("\n", cursor);
      cursor = newline < 0 ? tex.length : newline;
    } else if (character === "\\") {
      if (tex[cursor + 1] === "\\") {
        if (braces === 0 && environments <= 1) {
          rows.push(tex.slice(start, cursor));
          start = cursor + 2;
        }
        cursor++;
      } else {
        const command = /^\\([A-Za-z]+)/.exec(tex.slice(cursor));
        if (command) {
          if (command[1] === "begin" || command[1] === "end") {
            let opening = cursor + command[0].length;
            while (/\s/.test(tex[opening] || "")) opening++;
            const group = readTeXGroup(tex, opening);
            if (group) {
              environments += command[1] === "begin" ? 1 : -1;
              cursor = group.next - 1;
              continue;
            }
          }
          cursor += command[0].length - 1;
        } else {
          // Escaped braces/percent are not grouping or comment delimiters.
          cursor++;
        }
      }
    } else if (character === "{") braces++;
    else if (character === "}") braces--;
  }
  rows.push(tex.slice(start));
  return rows;
}
