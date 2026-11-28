import type { FindingRecord, Severity } from '@/core/db';
import type { AuditFinding } from '@/engine/audit';
import type { HintLevel, SinkCategory, SinkHit } from '@/engine/intel';

export type SarifLevel = 'error' | 'warning' | 'note';

export interface SarifDescriptor {
  id: string;
  name: string;
  shortDescription: { text: string };
  helpUri?: string;
  defaultConfiguration: { level: SarifLevel };
  properties: {
    tags: string[];
    'security-severity': string;
  };
}

export interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId: '%SRCROOT%' };
    region: {
      startLine: number;
      startColumn: number;
      snippet?: { text: string };
    };
  };
}

export interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations: SarifLocation[];
  partialFingerprints?: Record<string, string>;
}

export interface SarifLog {
  $schema: 'https://json.schemastore.org/sarif-2.1.0.json';
  version: '2.1.0';
  runs: [
    {
      tool: {
        driver: {
          name: 'MapHound';
          version: string;
          informationUri: 'https://github.com/sezercixq/maphound';
          rules: SarifDescriptor[];
        };
      };
      invocations: [{ executionSuccessful: true; properties: { origin: string } }];
      results: SarifResult[];
    },
  ];
}

const SECRET_LEVEL: Record<Severity, SarifLevel> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
  info: 'note',
};

const SECRET_SCORE: Record<Severity, string> = {
  critical: '9.5',
  high: '8.0',
  medium: '5.5',
  low: '3.0',
  info: '1.0',
};

const SINK_LEVEL: Record<HintLevel, SarifLevel> = {
  high: 'error',
  medium: 'warning',
  low: 'note',
  info: 'note',
};

const SINK_SCORE: Record<HintLevel, string> = {
  high: '7.5',
  medium: '5.0',
  low: '2.5',
  info: '1.0',
};

const SINK_CWE: Record<SinkCategory, string[]> = {
  'taint-flow': ['security', 'taint', 'external/cwe/cwe-79', 'external/cwe/cwe-94'],
  'dom-xss': ['security', 'external/cwe/cwe-79'],
  'code-injection': ['security', 'external/cwe/cwe-95'],
  messaging: ['security', 'external/cwe/cwe-346'],
  redirect: ['security', 'external/cwe/cwe-601'],
  'authz-idor': ['security', 'external/cwe/cwe-639', 'external/cwe/cwe-346'],
  crypto: ['security', 'external/cwe/cwe-327', 'external/cwe/cwe-338'],
  'supply-chain': [
    'security',
    'supply-chain',
    'external/cwe/cwe-353',
    'external/cwe/cwe-829',
    'external/cwe/cwe-1104',
  ],
  oauth: ['security', 'oauth', 'external/cwe/cwe-352', 'external/cwe/cwe-601'],
  framework: ['security', 'external/cwe/cwe-79'],
};

function sanitizeUri(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '') || 'bundle.js';
}

export function buildSarifLog(input: {
  findings: readonly FindingRecord[];
  sinks: readonly SinkHit[];
  auditFindings?: readonly AuditFinding[];
  origin: string;
  version: string;
}): SarifLog {
  const rulesMap = new Map<string, SarifDescriptor>();
  const results: SarifResult[] = [];

  for (const f of input.findings) {
    if (!rulesMap.has(f.ruleId)) {
      rulesMap.set(f.ruleId, {
        id: f.ruleId,
        name: f.ruleName,
        shortDescription: { text: f.ruleName },
        ...(f.references[0] ? { helpUri: f.references[0] } : {}),
        defaultConfiguration: { level: SECRET_LEVEL[f.severity] },
        properties: {
          tags: ['security', 'secret', 'external/cwe/cwe-798'],
          'security-severity': SECRET_SCORE[f.severity],
        },
      });
    }

    const locs =
      f.locations.length > 0
        ? f.locations
        : [
            {
              file: f.file,
              line: f.line,
              column: f.column,
            },
          ];

    // Never emit `f.secret`: SARIF uses masked `f.preview` and masked `f.snippet` only.
    results.push({
      ruleId: f.ruleId,
      level: SECRET_LEVEL[f.severity],
      message: {
        text: `${f.ruleName} detected (${f.confidence}, preview: ${f.preview}).`,
      },
      locations: locs.slice(0, 10).map((loc) => ({
        physicalLocation: {
          artifactLocation: { uri: sanitizeUri(loc.file), uriBaseId: '%SRCROOT%' },
          region: {
            startLine: Math.max(1, loc.line),
            startColumn: Math.max(1, loc.column + 1),
            ...(f.snippet ? { snippet: { text: f.snippet } } : {}),
          },
        },
      })),
      partialFingerprints: { primaryLocationLineHash: f.secretHash },
    });
  }

  for (const s of input.sinks) {
    const sarifRuleId = `sink/${s.ruleId}`;
    if (!rulesMap.has(sarifRuleId)) {
      rulesMap.set(sarifRuleId, {
        id: sarifRuleId,
        name: s.title,
        shortDescription: { text: s.title },
        defaultConfiguration: { level: SINK_LEVEL[s.level] },
        properties: {
          tags: SINK_CWE[s.category],
          'security-severity': SINK_SCORE[s.level],
        },
      });
    }

    const traceSuffix = s.trace
      ? ` Flow: ${s.trace.sourceExpr} (line ${s.trace.sourceLine}) -> line ${s.trace.sinkLine}.`
      : '';
    results.push({
      ruleId: sarifRuleId,
      level: SINK_LEVEL[s.level],
      message: { text: `${s.title} (${s.category}).${traceSuffix}` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: sanitizeUri(s.location.file), uriBaseId: '%SRCROOT%' },
            region: {
              startLine: Math.max(1, s.location.line),
              startColumn: Math.max(1, s.location.column + 1),
              ...(s.snippet ? { snippet: { text: s.snippet } } : {}),
            },
          },
        },
      ],
      partialFingerprints: {
        primaryLocationLineHash: `${s.ruleId}:${s.location.file}:${s.location.line}`,
      },
    });
  }

  for (const a of input.auditFindings ?? []) {
    if (a.category !== 'supply-chain' && a.category !== 'oauth') continue;
    const sarifRuleId = `audit/${a.ruleId}`;
    if (!rulesMap.has(sarifRuleId)) {
      rulesMap.set(sarifRuleId, {
        id: sarifRuleId,
        name: a.title,
        shortDescription: { text: a.title },
        defaultConfiguration: { level: SECRET_LEVEL[a.severity] },
        properties: {
          tags: SINK_CWE[a.category],
          'security-severity': SECRET_SCORE[a.severity],
        },
      });
    }
    results.push({
      ruleId: sarifRuleId,
      level: SECRET_LEVEL[a.severity],
      message: { text: `${a.title}: ${a.detail}` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: sanitizeUri(a.subject), uriBaseId: '%SRCROOT%' },
            region: { startLine: 1, startColumn: 1 },
          },
        },
      ],
      partialFingerprints: { primaryLocationLineHash: a.id },
    });
  }

  const rules = [...rulesMap.values()].sort((a, b) => a.id.localeCompare(b.id));

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'MapHound',
            version: input.version || '0.4.0',
            informationUri: 'https://github.com/sezercixq/maphound',
            rules,
          },
        },
        invocations: [{ executionSuccessful: true, properties: { origin: input.origin } }],
        results,
      },
    ],
  };
}

export function sarifJson(input: {
  findings: readonly FindingRecord[];
  sinks: readonly SinkHit[];
  auditFindings?: readonly AuditFinding[];
  origin: string;
  version: string;
}): string {
  return `${JSON.stringify(buildSarifLog(input), null, 2)}\n`;
}
