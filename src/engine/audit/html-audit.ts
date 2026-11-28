import {
  AUDIT_BEARER,
  AUDIT_JWT,
  AUDIT_PROVIDER_PREFIX,
  HTML_COMMENT_MARKER,
  HTML_COMMENT_PATH,
  HTML_COMMENT_SECRET_HINT,
  HTML_COMMENT_VERSION,
} from './patterns';
import { maskAuditValue } from './storage';
import type { HtmlAuditSummary, HtmlCommentHit, HtmlMetaTag } from './types';

export const MAX_HTML_COMMENTS = 80;
export const MAX_HTML_METAS = 25;

const INTERESTING_META_NAMES = new Set([
  'generator',
  'author',
  'version',
  'application-name',
  'build',
  'build-id',
  'commit',
  'release',
  'framework',
  'csrf-token',
  'csrf-param',
]);

const TRIVIAL_COMMENT = /^(?:\/?\$|!--|\[if\b|\[endif\]|lit-part|vue|svelte|astro|ng-|#|\s*$)/i;

function sanitizeCommentText(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  if (text.length > 260) text = `${text.slice(0, 259)}…`;

  // Mask any JWT or Bearer token inside comments so raw credentials never persist unmasked.
  const jwt = AUDIT_JWT.exec(text);
  if (jwt?.[1]) text = text.replace(jwt[1], maskAuditValue(jwt[1]));
  const bearer = AUDIT_BEARER.exec(text);
  if (bearer?.[1]) text = text.replace(bearer[1], maskAuditValue(bearer[1]));
  return text;
}

export function auditHtmlMetadata(
  rawComments: readonly string[],
  rawMetas: readonly { name: string; content: string }[],
): HtmlAuditSummary {
  const comments: HtmlCommentHit[] = [];
  const seenComments = new Set<string>();

  for (const raw of rawComments.slice(0, 300)) {
    const cleaned = sanitizeCommentText(raw);
    if (!cleaned || cleaned.length < 4 || TRIVIAL_COMMENT.test(cleaned)) continue;
    if (seenComments.has(cleaned)) continue;

    const tags: string[] = [];
    let level: HtmlCommentHit['level'] = 'info';

    const marker = HTML_COMMENT_MARKER.exec(cleaned);
    if (marker?.[1]) {
      const tag = marker[1].toUpperCase();
      tags.push(tag);
      if (tag === 'BYPASS' || tag === 'SECURITY' || tag === 'INTERNAL') level = 'high';
      else if (level === 'info') level = 'medium';
    }

    if (HTML_COMMENT_PATH.test(cleaned)) {
      tags.push('PATH');
      if (level === 'info') level = 'medium';
    }

    if (
      HTML_COMMENT_SECRET_HINT.test(cleaned) ||
      AUDIT_PROVIDER_PREFIX.test(raw) ||
      AUDIT_JWT.test(raw) ||
      AUDIT_BEARER.test(raw)
    ) {
      tags.push('SECRET_HINT');
      level = 'high';
    }

    if (HTML_COMMENT_VERSION.test(cleaned)) {
      tags.push('VERSION');
      if (level === 'info') level = 'low';
    }

    if (tags.length === 0) continue;

    seenComments.add(cleaned);
    comments.push({ text: cleaned, tags, level });
    if (comments.length >= MAX_HTML_COMMENTS) break;
  }

  const levelRank: Record<HtmlCommentHit['level'], number> = {
    high: 4,
    medium: 3,
    low: 2,
    info: 1,
  };
  comments.sort((a, b) => levelRank[b.level] - levelRank[a.level] || a.text.localeCompare(b.text));

  const metas: HtmlMetaTag[] = [];
  const seenMeta = new Set<string>();
  for (const m of rawMetas.slice(0, 100)) {
    const name = m.name.trim().toLowerCase();
    const content = m.content.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!name || !content || !INTERESTING_META_NAMES.has(name)) continue;
    const key = `${name}\u0000${content}`;
    if (seenMeta.has(key)) continue;
    seenMeta.add(key);
    metas.push({
      name,
      content: name === 'csrf-token' ? maskAuditValue(content) : content,
    });
    if (metas.length >= MAX_HTML_METAS) break;
  }

  return { comments, metas };
}
