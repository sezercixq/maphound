import type { SnapshotDiff } from './types';

function code(value: string): string {
  const text = value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function cell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

export function diffMarkdown(
  diff: SnapshotDiff,
  context: { origin: string; generator: string; exportedAt: string },
): string {
  const prevIso = new Date(diff.previous.createdAt).toISOString();
  const currIso = new Date(diff.current.createdAt).toISOString();

  const lines: string[] = [
    `# MapHound version diff: ${context.origin}`,
    '',
    `Generated ${context.exportedAt} by ${context.generator}.`,
    '',
    `- **Baseline snapshot:** ${prevIso} (\`${diff.previous.signature.slice(0, 12)}\`)`,
    `- **Current snapshot:** ${currIso} (\`${diff.current.signature.slice(0, 12)}\`)`,
    `- **Total changes:** ${diff.totalChanges}`,
    '',
  ];

  if (!diff.hasChanges) {
    lines.push('No differences detected between the compared snapshots.', '');
    return lines.join('\n');
  }

  if (
    diff.files.added.length > 0 ||
    diff.files.modified.length > 0 ||
    diff.files.removed.length > 0
  ) {
    lines.push('## Source Files', '');
    lines.push('| Change | File | Details |', '| --- | --- | --- |');
    for (const f of diff.files.added) lines.push(`| + Added | ${code(f.path)} | ${f.size} B |`);
    for (const f of diff.files.modified) {
      lines.push(`| ~ Modified | ${code(f.path)} | ${f.previousSize} B → ${f.currentSize} B |`);
    }
    for (const f of diff.files.removed) lines.push(`| - Removed | ${code(f.path)} | ${f.size} B |`);
    lines.push('');
  }

  if (diff.endpoints.added.length > 0 || diff.endpoints.removed.length > 0) {
    lines.push('## Endpoints', '');
    for (const ep of diff.endpoints.added) lines.push(`- **+** ${code(ep)}`);
    for (const ep of diff.endpoints.removed) lines.push(`- **-** ${code(ep)}`);
    lines.push('');
  }

  if (diff.routes.added.length > 0 || diff.routes.removed.length > 0) {
    lines.push('## Frontend Routes', '');
    for (const r of diff.routes.added) lines.push(`- **+** ${code(r)}`);
    for (const r of diff.routes.removed) lines.push(`- **-** ${code(r)}`);
    lines.push('');
  }

  if (diff.findings.added.length > 0 || diff.findings.resolved.length > 0) {
    lines.push('## Secret Findings', '');
    lines.push('| Status | Severity | Rule | Location |', '| --- | --- | --- | --- |');
    for (const f of diff.findings.added) {
      lines.push(
        `| + New | ${f.severity} | ${cell(f.ruleName)} | ${code(`${f.file}:${f.line}`)} |`,
      );
    }
    for (const f of diff.findings.resolved) {
      lines.push(
        `| - Resolved | ${f.severity} | ${cell(f.ruleName)} | ${code(`${f.file}:${f.line}`)} |`,
      );
    }
    lines.push('');
  }

  if (diff.sinks.added.length > 0 || diff.sinks.resolved.length > 0) {
    lines.push('## Code Hints / Sinks', '');
    lines.push('| Status | Level | Hint | Location |', '| --- | --- | --- | --- |');
    for (const s of diff.sinks.added) {
      lines.push(`| + New | ${s.level} | ${cell(s.title)} | ${code(`${s.file}:${s.line}`)} |`);
    }
    for (const s of diff.sinks.resolved) {
      lines.push(`| - Resolved | ${s.level} | ${cell(s.title)} | ${code(`${s.file}:${s.line}`)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
