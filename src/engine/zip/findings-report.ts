import type { FindingRecord, Severity } from '@/core/db';
import { CONFIDENCE_ORDER, SEVERITY_ORDER } from '@/engine/scan/types';

export interface ReportContext {
  origin: string;
  generator: string;
  exportedAt: string;
  /** Put raw secret values into findings.json. FINDINGS.md always stays masked. */
  includeSecrets: boolean;
}

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function sortFindings(findings: readonly FindingRecord[]): FindingRecord[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
      CONFIDENCE_ORDER[b.confidence] - CONFIDENCE_ORDER[a.confidence] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
}

export function countBySeverity(findings: readonly FindingRecord[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return counts;
}

export function findingsJson(findings: readonly FindingRecord[], context: ReportContext): string {
  const sorted = sortFindings(findings);
  return `${JSON.stringify(
    {
      generator: context.generator,
      exportedAt: context.exportedAt,
      origin: context.origin,
      rawSecretsIncluded: context.includeSecrets,
      summary: { total: sorted.length, bySeverity: countBySeverity(sorted) },
      findings: sorted.map((f) => ({
        id: f.id,
        rule: f.ruleId,
        ruleName: f.ruleName,
        severity: f.severity,
        confidence: f.confidence,
        file: f.file,
        line: f.line,
        column: f.column,
        locationKind: f.locationKind,
        preview: f.preview,
        ...(context.includeSecrets ? { secret: f.secret } : {}),
        secretSha256: f.secretHash,
        occurrences: f.occurrences,
        snippet: f.snippet,
        locations: f.locations,
        references: f.references,
      })),
    },
    null,
    2,
  )}\n`;
}

/** Inline code span that survives backticks and table pipes. */
function code(value: string): string {
  const text = value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function cell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

/** Human-readable report. Secrets are always masked here, whatever `includeSecrets` says. */
export function findingsMarkdown(
  findings: readonly FindingRecord[],
  context: ReportContext,
): string {
  const sorted = sortFindings(findings);
  const counts = countBySeverity(sorted);
  const lines = [
    `# MapHound findings: ${context.origin}`,
    '',
    `Generated ${context.exportedAt} by ${context.generator}.`,
    '',
  ];
  if (sorted.length === 0) {
    lines.push('No secrets were found in the scanned scripts and source maps.', '');
    return lines.join('\n');
  }
  lines.push(
    `**${sorted.length} finding${sorted.length === 1 ? '' : 's'}:** ${SEVERITIES.filter(
      (s) => counts[s] > 0,
    )
      .map((s) => `${counts[s]} ${s}`)
      .join(', ')}.`,
    '',
    context.includeSecrets
      ? '> Raw secret values are included in `findings.json`. Treat this archive as sensitive and revoke the keys.'
      : '> Secret values are masked. Raw values were not exported.',
    '',
  );
  for (const severity of SEVERITIES) {
    const group = sorted.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    lines.push(`## ${severity.charAt(0).toUpperCase()}${severity.slice(1)} (${group.length})`, '');
    lines.push(
      '| Rule | Confidence | Location | Secret | Seen |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const f of group) {
      const where = `${code(`${f.file}:${f.line}:${f.column + 1}`)}${f.locationKind === 'source' ? '' : ` (${f.locationKind})`}`;
      lines.push(
        `| ${cell(f.ruleName)} | ${f.confidence} | ${where} | ${code(f.preview)} | ${f.occurrences}× |`,
      );
    }
    lines.push('');
  }
  lines.push('## Details', '');
  for (const f of sorted) {
    lines.push(`### ${cell(f.ruleName)}: ${code(`${f.file}:${f.line}`)}`, '');
    lines.push(`- Severity: **${f.severity}**, confidence: ${f.confidence}`);
    lines.push(`- Context: ${code(f.snippet)}`);
    const scripts = [...new Set(f.locations.map((l) => l.scriptUrl))];
    lines.push(
      `- Script${scripts.length === 1 ? '' : 's'}: ${scripts.map((url) => code(url)).join(', ')}`,
    );
    if (f.locations.length > 1) {
      lines.push(
        `- Also at: ${f.locations
          .slice(1, 6)
          .map((l) => code(`${l.file}:${l.line}`))
          .join(', ')}`,
      );
    }
    if (f.references.length > 0) lines.push(`- Reference: ${f.references[0]}`);
    lines.push('');
  }
  return lines.join('\n');
}
