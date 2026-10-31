/**
 * Markdown → Telegram rich blocks.
 *
 * Telegram's `sendRichMessage` accepts a structured document rather than a
 * formatting string: real `<table>`, real `<ul>`/`<ol>`, headings, dividers and
 * expandable `<details>`. That removes the compromise the HTML path is built
 * around.
 *
 * The HTML path can only send `b i u s a code pre blockquote`, so a markdown
 * table has to be *drawn* — column-aligned text inside `<pre>`. That drawing is
 * still text, so it soft-wraps on a narrow screen and the columns shear apart;
 * a real product table sheared on a phone, which is what prompted this module.
 * A rich table wraps inside its cells instead and cannot shear.
 *
 * Two properties are preserved from the HTML renderer:
 *
 * 1. **Nothing is escaped here.** Rich text is transported as JSON values, so
 *    the API escapes on our behalf. Passing HTML-escaped text through this path
 *    would show a literal `&amp;` to the user.
 * 2. **Reasoning never leaks.** `stripReasoning` runs before parsing, exactly
 *    as it does in `renderMarkdown`.
 *
 * The HTML renderer stays in place: it is the fallback whenever this path is
 * unavailable, and it remains the only way to edit a message in place.
 */

import { stripReasoning } from './markdown.js';

/** Telegram rejects a rich message whose block list is empty. */
const MAX_HEADING_SIZE = 6;

/* ------------------------------------------------------------------ *
 * Inline text
 * ------------------------------------------------------------------ */

/**
 * Parse inline markdown into a RichText value.
 *
 * Returns a plain string when there is no markup — the API accepts a bare
 * string wherever RichText is expected, and avoiding a single-element array
 * keeps the payload small and readable in logs.
 *
 * @param {string} source inline markdown
 * @returns {any} RichText: a string, or an array of strings and rich nodes
 */
export function parseInline(source) {
  const text = String(source ?? '');
  if (!text) return '';

  /** @type {any[]} */
  const parts = [];
  let buffer = '';

  const flush = () => {
    if (buffer) {
      parts.push(buffer);
      buffer = '';
    }
  };

  // Ordered by precedence: code first, because its content is literal and must
  // not be re-parsed for emphasis.
  const RULES = [
    { re: /^`([^`]+)`/, node: (m) => ({ type: 'code', text: m[1] }) },
    { re: /^\*\*\*([\s\S]+?)\*\*\*/, node: (m) => ({ type: 'bold', text: { type: 'italic', text: parseInline(m[1]) } }) },
    { re: /^\*\*([\s\S]+?)\*\*/, node: (m) => ({ type: 'bold', text: parseInline(m[1]) }) },
    { re: /^__([\s\S]+?)__/, node: (m) => ({ type: 'bold', text: parseInline(m[1]) }) },
    { re: /^~~([\s\S]+?)~~/, node: (m) => ({ type: 'strikethrough', text: parseInline(m[1]) }) },
    { re: /^\|\|([\s\S]+?)\|\|/, node: (m) => ({ type: 'spoiler', text: parseInline(m[1]) }) },
    {
      re: /^!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/,
      node: (m) => ({ type: 'url', text: m[1] || m[2], url: m[2] }),
    },
    {
      re: /^\[([^\]]+)\]\(([^)\s]+)[^)]*\)/,
      node: (m) => ({ type: 'url', text: parseInline(m[1]), url: m[2] }),
    },
  ];

  let rest = text;
  while (rest) {
    let matched = false;

    for (const rule of RULES) {
      const match = rule.re.exec(rest);
      if (!match) continue;
      flush();
      parts.push(rule.node(match));
      rest = rest.slice(match[0].length);
      matched = true;
      break;
    }
    if (matched) continue;

    // Single-character emphasis needs a word boundary on the left, so that
    // snake_case identifiers and a*b do not become italics.
    const emphasis = /^([*_])(?!\s)([^*_\n]+?)\1/.exec(rest);
    if (emphasis && !/[\w]$/.test(buffer)) {
      flush();
      parts.push({ type: 'italic', text: parseInline(emphasis[2]) });
      rest = rest.slice(emphasis[0].length);
      continue;
    }

    // A bare URL is linkified so it stays tappable.
    const bare = /^(https?:\/\/[^\s<>()]+)/.exec(rest);
    if (bare) {
      flush();
      parts.push({ type: 'url', text: bare[1], url: bare[1] });
      rest = rest.slice(bare[0].length);
      continue;
    }

    buffer += rest[0];
    rest = rest.slice(1);
  }

  flush();

  // A single part needs no array: RichText accepts a string or one node
  // directly, and unwrapping keeps payloads small and logs readable.
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return parts;
}

/* ------------------------------------------------------------------ *
 * Blocks
 * ------------------------------------------------------------------ */

/**
 * Parse a markdown document into Telegram rich blocks.
 *
 * @param {string} markdown source document
 * @returns {any[]} `InputRichBlock[]`, empty when the document has no content
 */
export function parseBlocks(markdown) {
  const lines = stripReasoning(markdown).replace(/\r\n?/g, '\n').split('\n');
  /** @type {any[]} */
  const blocks = [];
  /** @type {string[]} */
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join('\n').trim();
    paragraph = [];
    if (text) blocks.push({ type: 'paragraph', text: parseInline(text) });
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];

    // Fenced code
    const fence = /^(\s*)(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const [, , marker, language] = fence;
      const closing = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`);
      const body = [];
      index += 1;
      while (index < lines.length && !closing.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // consume the closing fence
      const block = { type: 'pre', text: body.join('\n') };
      if (language) block.language = language;
      blocks.push(block);
      continue;
    }

    // Table
    if (isTableSeparator(lines[index + 1]) && line.includes('|')) {
      flushParagraph();
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(lines[index]);
        index += 1;
      }
      const table = buildTable(rows);
      if (table) blocks.push(table);
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quoted = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      const inner = parseBlocks(quoted.join('\n'));
      if (inner.length > 0) blocks.push({ type: 'blockquote', blocks: inner });
      continue;
    }

    // Heading
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const title = heading[2].replace(/\s*#+\s*$/, '').trim();
      if (title) {
        blocks.push({
          type: 'heading',
          text: parseInline(title),
          size: Math.min(heading[1].length, MAX_HEADING_SIZE),
        });
      }
      index += 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushParagraph();
      blocks.push({ type: 'divider' });
      index += 1;
      continue;
    }

    // List run — bullets and ordered items are collected together so that a
    // list interrupted by neither a blank line nor a paragraph stays one block.
    if (isListItem(line)) {
      flushParagraph();
      const consumed = collectList(lines, index);
      blocks.push(consumed.block);
      index = consumed.next;
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      index += 1;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  return blocks;
}

function isListItem(line) {
  return /^(\s*)([-*+]|\d+[.)])\s+/.test(line ?? '');
}

/**
 * Collect one list run into a single list block.
 *
 * Nesting is flattened to a label prefix rather than modelled as nested lists:
 * the depth of an agent's markdown list is rarely meaningful and a nested rich
 * list costs a full tree walk for a distinction users do not notice.
 */
function collectList(lines, start) {
  const items = [];
  let index = start;
  let ordered = false;

  while (index < lines.length && isListItem(lines[index])) {
    const line = lines[index];
    const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line);
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    const match = bullet ?? numbered;
    if (!match) break;
    if (numbered) ordered = true;

    const [, indent, marker, content] = match;
    const depth = Math.floor(indent.replace(/\t/g, '  ').length / 2);
    const item = { blocks: [{ type: 'paragraph', text: parseInline(stripTaskMarker(content)) }] };

    const task = /^\[([ xX])\]\s+/.exec(content);
    if (task) {
      item.has_checkbox = true;
      if (task[1] !== ' ') item.is_checked = true;
    }
    if (numbered) item.value = Number(marker);
    if (depth > 0) item.label = '  '.repeat(depth) + (depth === 1 ? '◦' : '▪');

    items.push(item);
    index += 1;
  }

  const block = { type: 'list', items };
  if (ordered) block.type = 'list';
  return { block, next: index };
}

function stripTaskMarker(content) {
  return String(content).replace(/^\[([ xX])\]\s+/, '');
}

function isTableSeparator(line) {
  if (typeof line !== 'string') return false;
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
}

function splitRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

/**
 * Build a real Telegram table.
 *
 * Column alignment from the markdown separator row is carried onto every cell,
 * so a numeric column stays right-aligned as the author intended. Ragged rows
 * are padded with invisible cells: `text` is optional, and omitting it is the
 * documented way to leave a cell blank without breaking the grid.
 */
function buildTable(rows) {
  if (rows.length < 2) return undefined;

  const header = splitRow(rows[0]);
  const alignments = splitRow(rows[1]).map((spec) => {
    const left = spec.startsWith(':');
    const right = spec.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
  const body = rows.slice(2).map(splitRow);
  const columns = Math.max(header.length, ...body.map((row) => row.length));

  const cellsFor = (values, isHeader) => {
    const out = [];
    for (let col = 0; col < columns; col += 1) {
      const value = (values[col] ?? '').trim();
      /** @type {any} */
      const cell = {};
      if (value) cell.text = parseInline(value);
      if (isHeader) cell.is_header = true;
      const align = alignments[col];
      if (align && align !== 'left') cell.align = align;
      out.push(cell);
    }
    return out;
  };

  const cells = [cellsFor(header, true), ...body.map((row) => cellsFor(row, false))];
  return { type: 'table', cells, is_bordered: true, is_striped: body.length > 2 };
}

/* ------------------------------------------------------------------ *
 * Splitting
 * ------------------------------------------------------------------ */

/**
 * Split a block list so each message stays under the API's size limit.
 *
 * Splitting happens on block boundaries: a rich message is a structured
 * document, so cutting inside a table or a list would produce a fragment that
 * is not merely ugly but semantically wrong. A single oversized block (a very
 * long code listing) is passed through intact and left for the API to reject,
 * which is a clearer failure than silently truncating a user's code.
 *
 * @param {any[]} blocks parsed blocks
 * @param {number} maxLength approximate serialized budget per message
 * @returns {any[][]} one block list per message
 */
export function splitBlocks(blocks, maxLength = 4096) {
  if (blocks.length === 0) return [];

  const groups = [];
  let current = [];
  let size = 0;

  for (const block of blocks) {
    const cost = JSON.stringify(block).length;
    if (current.length > 0 && size + cost > maxLength) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(block);
    size += cost;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Render markdown straight to message-sized rich block lists.
 *
 * @param {string} markdown source document
 * @param {number} [maxLength] serialized budget per message
 * @returns {any[][]} one `InputRichBlock[]` per outgoing message
 */
export function renderToBlocks(markdown, maxLength = 4096) {
  return splitBlocks(parseBlocks(markdown), maxLength);
}
