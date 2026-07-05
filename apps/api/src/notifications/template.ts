// Pure template rendering for notification e-mails (vendor UG §22.1.1).
//
// Legacy semantics, kept: the Subject and Text fields mix literal text with
// @FieldName placeholders replaced at QUEUE time (EmailSent stores the final
// rendered e-mail); Text is HTML; entity-ish fields render as hyperlinks into
// the application (legacy used the ParamsMail.ContextURL ClickOnce launcher —
// ERP1 links into its web app via the notifications.baseUrl setting); the
// special @Table placeholder renders a tabular list (used by the planning
// summary notifications).

export type TemplateValue = string | number | null | undefined;
export type TemplateParams = Record<string, TemplateValue>;

export interface TemplateTable {
  columns: string[];
  rows: TemplateValue[][];
}

export interface RenderOptions {
  /** Public web-app origin for deep links; '' or undefined = plain text. */
  baseUrl?: string;
  /** Param name -> app path (e.g. { Ordr: '/orders/145915' }). */
  links?: Record<string, string>;
  /** Rendered in place of @Table. */
  table?: TemplateTable;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function asText(value: TemplateValue): string {
  if (value == null) return '';
  return typeof value === 'number' ? String(value) : value;
}

// Placeholders are @Word (letters/digits, starting with a letter). Longest
// param name wins where one prefixes another (@ItemCode vs @Item), which a
// single alternation of names sorted longest-first guarantees.
function placeholderRegex(params: TemplateParams, extra: string[] = []): RegExp | null {
  const names = [...new Set([...Object.keys(params), ...extra])]
    .filter((n) => /^[A-Za-z][A-Za-z0-9]*$/.test(n))
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return null;
  return new RegExp(`@(${names.join('|')})`, 'g');
}

/** Subject line: plain-text substitution, no escaping, no links. */
export function renderSubject(template: string | null | undefined, params: TemplateParams): string {
  const tpl = template ?? '';
  const re = placeholderRegex(params);
  if (!re) return tpl;
  return tpl.replace(re, (_m, name: string) => asText(params[name]));
}

export function renderTableHtml(table: TemplateTable): string {
  const head = table.columns.map((c) => `<td class="header">${escapeHtml(c)}</td>`).join('');
  const body = table.rows
    .map((row) => `<tr>${row.map((v) => `<td>${escapeHtml(asText(v))}</td>`).join('')}</tr>`)
    .join('\n');
  return `<table cellpadding="4" cellspacing="0">\n<tr>${head}</tr>\n${body}\n</table>`;
}

/**
 * Body: HTML template with @Field substitution. Values are HTML-escaped; a
 * field present in opts.links (and a configured baseUrl) renders as an <a>
 * into the web app. @Table renders opts.table.
 */
export function renderBody(template: string | null | undefined, params: TemplateParams, opts: RenderOptions = {}): string {
  const tpl = template ?? '';
  const base = (opts.baseUrl ?? '').replace(/\/+$/, '');
  const re = placeholderRegex(params, opts.table ? ['Table'] : []);
  if (!re) return tpl;
  return tpl.replace(re, (_m, name: string) => {
    if (name === 'Table' && opts.table) return renderTableHtml(opts.table);
    const text = escapeHtml(asText(params[name]));
    const path = opts.links?.[name];
    if (path && base && text !== '') return `<a href="${escapeHtml(base + path)}">${text}</a>`;
    return text;
  });
}

// The e-mail shell (style block taken from what the legacy renderer produced,
// so operator-authored templates look the same as they did in Outlook).
export function wrapHtml(inner: string): string {
  return `<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<title> </title>
<style type="text/css">
body { font-family: Helvetica, Arial; font-size: 75%; }
table { border-top: gray 1px solid; border-left: gray 1px solid; font-size: 90%; border-collapse: collapse; }
td { vertical-align: text-top; border-right: gray 1px solid; border-bottom: gray 1px solid; padding: 2px 6px; }
.header { text-align: center; font-weight: bold; background-color: #ffcc33; }
</style>
</head>
<body>
<div>${inner}</div>
</body>
</html>`;
}

/**
 * Recipient-list parsing (UG: semicolon-separated; commas tolerated). Returns
 * trimmed, deduplicated (case-insensitive) addresses that look like e-mail.
 */
export function parseRecipients(...lists: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (!list) continue;
    for (const raw of list.split(/[;,]/)) {
      const addr = raw.trim();
      if (!addr || !addr.includes('@')) continue;
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(addr);
    }
  }
  return out;
}
