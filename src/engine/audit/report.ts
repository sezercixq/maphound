import type { AuditRecord } from '@/core/db';
import { AUDIT_SEVERITY_ORDER, type AuditSeverity } from './types';

function code(value: string): string {
  const text = value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function cell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

const SEVERITIES: AuditSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function auditMarkdown(
  audits: readonly AuditRecord[],
  context: { origin: string; generator: string; exportedAt: string },
): string {
  const allFindings = audits
    .flatMap((audit) => audit.findings)
    .sort(
      (a, b) =>
        AUDIT_SEVERITY_ORDER[b.severity] - AUDIT_SEVERITY_ORDER[a.severity] ||
        a.category.localeCompare(b.category) ||
        a.subject.localeCompare(b.subject),
    );

  const lines: string[] = [
    `# MapHound security audit: ${context.origin}`,
    '',
    `Generated ${context.exportedAt} by ${context.generator}.`,
    '',
    `- **Audited pages:** ${audits.length}`,
    `- **Audit findings:** ${allFindings.length}`,
    '',
  ];

  if (audits.length === 0) {
    lines.push(
      'No document responses, cookies or Web Storage entries were audited for this site.',
      '',
    );
    return lines.join('\n');
  }

  for (const audit of audits) {
    lines.push(`## Page: ${code(audit.pageUrl)}`, '');
    if (audit.matrix.length > 0) {
      lines.push('| Security Header | Status | Value |', '| --- | --- | --- |');
      for (const row of audit.matrix) {
        lines.push(
          `| ${code(row.header)} | ${row.status} | ${row.value ? code(row.value) : '–'} |`,
        );
      }
      lines.push('');
    }
  }

  if (allFindings.length > 0) {
    lines.push('## Audit Findings', '');
    for (const severity of SEVERITIES) {
      const group = allFindings.filter((f) => f.severity === severity);
      if (group.length === 0) continue;
      lines.push(
        `### ${severity.charAt(0).toUpperCase()}${severity.slice(1)} (${group.length})`,
        '',
      );
      lines.push(
        '| Category | Title | Subject | Preview (masked) | Recommendation |',
        '| --- | --- | --- | --- | --- |',
      );
      for (const f of group) {
        lines.push(
          `| ${f.category} | ${cell(f.title)} | ${code(f.subject)} | ${f.preview ? code(f.preview) : '–'} | ${cell(f.recommendation)} |`,
        );
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
