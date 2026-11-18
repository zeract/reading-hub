export function readerCodeLanguage(classes: string): string | undefined {
  const names = classes.toLowerCase().split(/\s+/);
  if (names.includes("mermaid") || names.includes("language-mermaid") || names.includes("lang-mermaid")) return "mermaid";
  for (const name of names) {
    const language = /^(?:lang|language)-([a-z0-9_+#.-]{1,32})$/.exec(name)?.[1];
    if (language) return language;
  }
  return undefined;
}
