import type { ExtractionRule } from "../shared/types";

/** User choice owns a selector; browser requirements only describe execution.
 * Legacy rules have no provenance, so retain their previous conservative
 * field-selector protection until the user confirms a new choice. */
export function isManualExtractionRule(rule?: ExtractionRule): boolean {
  if (!rule?.itemRootSelector) return false;
  if (rule.selection !== undefined) return rule.selection === "manual";
  return Boolean(rule.titleSelector || rule.timeSelector
    || rule.authorSelector || rule.imageSelector || rule.summarySelector);
}
