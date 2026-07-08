// The unknown-type worksheet: per-code counts and example locations from the
// archive, regenerable on demand. The user's "What is it?" annotations are
// merged by code so no answer is ever lost; codes that gain mappings stop
// being unknown and drop off naturally. Private-workspace file — chat labels
// and timestamps only, never message content.

export interface UnknownTypeCodeEntry {
  code: string;
  count: number;
  examples: Array<{ chatLabel: string; timestampMs: number | null }>;
}

export function parseWorksheetAnnotations(markdown: string | null | undefined): Map<string, string> {
  const annotations = new Map<string, string>();
  for (const line of (markdown ?? "").split("\n")) {
    const match = line.match(/^\|\s*(\d+)\s*\|\s*[\d,]+\s*\|(.*)\|[^|]*\|\s*$/);
    if (!match) {
      continue;
    }
    const note = match[2].trim();
    if (note) {
      annotations.set(match[1], note);
    }
  }
  return annotations;
}

export function renderUnknownTypeReport(
  entries: UnknownTypeCodeEntry[],
  annotations: Map<string, string>,
  generatedAtIso: string
): string {
  const rows = entries.map((entry) => {
    const examples = entry.examples
      .map((example) => {
        const time = example.timestampMs == null ? "unknown time" : new Date(example.timestampMs).toLocaleString();
        return `${example.chatLabel} @ ${time}`;
      })
      .join("<br>");
    return `| ${entry.code} | ${entry.count} | ${annotations.get(entry.code) ?? ""} | ${examples} |`;
  });
  return [
    "# Unknown Android Message Type Codes — Mapping Worksheet",
    "",
    "Each `unknown_<code>` is a raw Android msgstore `message_type` the importer does not map yet.",
    "For each code, open one of the example messages in WhatsApp on your phone (chat + time below)",
    "and write what kind of message it is (poll, event, view-once photo, call, group invite, payment, ...).",
    "",
    "| Code | Count | What is it? (fill in) | Examples (chat @ local time) |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    `Generated ${generatedAtIso} from the local archive. Private — do not commit.`,
    ""
  ].join("\n");
}
