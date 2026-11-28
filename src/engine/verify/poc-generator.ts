import type { EndpointHit, SinkHit } from '@/engine/intel';

function resolveEndpointUrl(value: string, origin: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  const cleanOrigin = origin.replace(/\/+$/, '');
  const path = value.startsWith('/') ? value : `/${value}`;
  return `${cleanOrigin}${path}`;
}

function shellEscapeSingle(value: string): string {
  return value.replace(/'/g, "'\\''");
}

/**
 * Generates a safe, environment-variable-placeholder `curl` inspection command
 * (equivalent to DevTools "Copy as cURL" — zero embedded credentials or exploit payloads).
 */
export function generateCurlSnippet(
  endpoint: Pick<EndpointHit, 'value' | 'methods' | 'category'>,
  origin: string,
): string {
  const method = endpoint.methods[0] ?? 'GET';
  const url = resolveEndpointUrl(endpoint.value, origin);
  const lines = [
    `curl -i -X ${method} '${shellEscapeSingle(url)}' \\`,
    `  -H 'Accept: application/json' \\`,
    `  -H 'Authorization: Bearer \${API_TOKEN}'`,
  ];
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    lines[lines.length - 1] += ' \\';
    lines.push("  -H 'Content-Type: application/json' \\");
    lines.push("  -d '{}'");
  }
  return lines.join('\n');
}

/**
 * Generates a safe Python `requests` reproduction snippet using environment variable placeholders.
 */
export function generatePythonRequestsSnippet(
  endpoint: Pick<EndpointHit, 'value' | 'methods' | 'category'>,
  origin: string,
): string {
  const method = (endpoint.methods[0] ?? 'GET').toLowerCase();
  const url = resolveEndpointUrl(endpoint.value, origin);
  const needsBody = method === 'post' || method === 'put' || method === 'patch';
  const lines = [
    'import os',
    'import requests',
    '',
    `url = ${JSON.stringify(url)}`,
    'headers = {',
    '    "Accept": "application/json",',
    '    "Authorization": f"Bearer {os.environ.get(\'API_TOKEN\', \'\')}",',
    '}',
    needsBody
      ? `response = requests.${method}(url, headers=headers, json={}, timeout=10)`
      : `response = requests.${method}(url, headers=headers, timeout=10)`,
    'print(response.status_code, response.text[:500])',
  ];
  return lines.join('\n');
}

/**
 * Generates a defensive origin-validation remediation snippet for unvalidated `postMessage` handlers.
 */
export function generatePostMessageFixSnippet(
  sink: Pick<SinkHit, 'title' | 'location'>,
  origin: string,
): string {
  return [
    `// Defensive fix for ${sink.title} (${sink.location.file}:${sink.location.line})`,
    `const ALLOWED_ORIGINS = new Set([${JSON.stringify(origin)}]);`,
    '',
    "window.addEventListener('message', (event) => {",
    '  if (!ALLOWED_ORIGINS.has(event.origin)) return;',
    '  // Validate event.data schema before processing',
    '});',
  ].join('\n');
}
