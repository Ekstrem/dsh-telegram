/**
 * Markdown -> Telegram HTML renderer.
 *
 * Telegram's `parse_mode: 'HTML'` accepts only a small tag set:
 *   b, strong, i, em, u, ins, s, strike, del, span.tg-spoiler, tg-spoiler,
 *   a[href], code, pre, pre>code[class=language-*], blockquote[expandable]
 *
 * Everything else must be escaped or transformed. This module owns that
 * transformation, including the two shapes Telegram has no tag for:
 *   - headings   -> bold lines
 *   - tables     -> column-aligned monospace inside <pre>
 *
 * Escaping rule: raw text is escaped ONCE, up front. Inline markdown patterns
 * are then applied to the already-escaped text, which is safe because escaping
 * removes every `<` and `>` so no pattern can forge a tag, and no pattern
 * matches `&`. Code spans and fences are lifted out before escaping and
 * restored afterwards so their contents never see emphasis processing.
 */

const PLACEHOLDER_START = '\u0000';
const PLACEHOLDER_END = '\u0001';

/**
 * URL body allowing one level of balanced parentheses, so `alert(1)` and
 * `Foo_(bar)` are consumed whole rather than stopping at the first `)`.
 */
const URL_BODY = '(?:[^()\\s]|\\([^()\\s]*\\))+';
const IMAGE_PATTERN = new RegExp(`!\\[([^\\]]*)\\]\\((${URL_BODY})(?:\\s+"[^"]*")?\\)`, 'g');
const LINK_PATTERN = new RegExp(`\\[([^\\]]+)\\]\\((${URL_BODY})(?:\\s+"[^"]*")?\\)`, 'g');
const STANDALONE_IMAGE = new RegExp(`^\\s*!\\[([^\\]]*)\\]\\((${URL_BODY})(?:\\s+"[^"]*")?\\)\\s*$`);

/** Escape the five characters that can break Telegram HTML parsing. */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape a string for use inside a double-quoted HTML attribute. */
export function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

/**
 * Display width of a string, counting East Asian wide characters as two
 * columns so table alignment survives CJK content.
 */
export function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    // Combining marks occupy no column.
    if (code >= 0x0300 && code <= 0x036f) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function padTo(text, width) {
  const pad = width - displayWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}

/** Pad a cell according to its column alignment. */
function padCell(text, width, align) {
  const deficit = Math.max(0, width - displayWidth(text));
  if (align === 'right') return ' '.repeat(deficit) + text;
  if (align === 'center') {
    const left = Math.floor(deficit / 2);
    return ' '.repeat(left) + text + ' '.repeat(deficit - left);
  }
  return text + ' '.repeat(deficit);
}

/* ------------------------------------------------------------------ *
 * Inline rendering
 * ------------------------------------------------------------------ */

/**
 * Render inline markdown to Telegram HTML.
 *
 * @param {string} source raw markdown fragment (single logical line)
 * @returns {string} Telegram-safe HTML
 */
export function renderInline(source) {
  const spans = [];

  // 1. Lift code spans out before anything else touches the text.
  let text = String(source).replace(/(`+)([\s\S]*?)\1/g, (match, ticks, body) => {
    const index = spans.length;
    spans.push(`<code>${escapeHtml(trimCodeSpan(body))}</code>`);
    return PLACEHOLDER_START + index + PLACEHOLDER_END;
  });

  // 2. Lift links and images out too; their URLs must not be emphasised.
  //    The URL pattern tolerates one level of balanced parentheses so that
  //    `javascript:alert(1)` and wiki-style `..._(disambiguation)` links are
  //    consumed whole instead of leaving a stray `)` behind.
  text = text.replace(IMAGE_PATTERN, (match, alt, url) => {
    const index = spans.length;
    const label = alt || 'image';
    const href = normalizeUrl(url);
    spans.push(
      href
        ? `<a href="${escapeAttr(href)}">${escapeHtml(label)}</a>`
        : escapeHtml(label),
    );
    return PLACEHOLDER_START + index + PLACEHOLDER_END;
  });

  text = text.replace(LINK_PATTERN, (match, label, url) => {
    const index = spans.length;
    const href = normalizeUrl(url);
    if (!href) return escapeHtml(label);
    // The label may itself contain emphasis; render it recursively.
    spans.push(`<a href="${escapeAttr(href)}">${renderInline(label)}</a>`);
    return PLACEHOLDER_START + index + PLACEHOLDER_END;
  });

  // 3. Escape everything that remains.
  text = escapeHtml(text);

  // 4. Apply emphasis to the escaped text.
  text = text
    // ||spoiler||
    .replace(/\|\|([^|]+)\|\|/g, '<tg-spoiler>$1</tg-spoiler>')
    // ~~strike~~
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>')
    // ***bold italic***
    .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<b><i>$1</i></b>')
    // **bold**
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<b>$1</b>')
    // __underline__ (Telegram convention)
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<u>$1</u>')
    // *italic* — not part of a ** run
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, '$1<i>$2</i>')
    // _italic_ — word-boundary guarded so snake_case survives
    .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, '$1<i>$2</i>');

  // 5. Restore the lifted spans.
  return restore(text, spans);
}

function restore(text, spans) {
  if (spans.length === 0) return text;
  return text.replace(
    new RegExp(`${PLACEHOLDER_START}(\\d+)${PLACEHOLDER_END}`, 'g'),
    (match, index) => spans[Number(index)] ?? match,
  );
}

/** CommonMark strips one leading/trailing space from a code span. */
function trimCodeSpan(body) {
  if (body.length > 1 && body.startsWith(' ') && body.endsWith(' ') && body.trim() !== '') {
    return body.slice(1, -1);
  }
  return body;
}

/**
 * Accept only schemes Telegram will render as a link. Anything else falls
 * back to plain text so the message still sends.
 */
function normalizeUrl(url) {
  const trimmed = String(url).trim();
  if (/^(https?|tg):\/\//i.test(trimmed)) return trimmed;
  if (/^mailto:/i.test(trimmed)) return trimmed;
  if (/^www\./i.test(trimmed)) return `https://${trimmed}`;
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Block rendering
 * ------------------------------------------------------------------ */

/**
 * Reasoning blocks some models emit inline. They are the model thinking to
 * itself, not part of the answer, so they must never reach the chat.
 */
const REASONING_TAG = 'think|thinking|reasoning';
/**
 * Order matters. A balanced pair is consumed first; only then does the
 * unterminated case apply, and it takes everything to the end of the string —
 * a stream cut mid-thought has no answer after it, so keeping the tail would
 * publish raw reasoning. A stray closing tag is dropped last.
 */
const REASONING_PATTERN = new RegExp(
  `<(${REASONING_TAG})>[\\s\\S]*?<\\/\\1>|<(?:${REASONING_TAG})>[\\s\\S]*$|<\\/(?:${REASONING_TAG})>`,
  'gi',
);

/**
 * Strip inline reasoning from a raw assistant message.
 *
 * Removal happens on the SOURCE, before rendering, escaping, or chunking.
 * Escaping first would turn `<think>` into visible `&lt;think&gt;` text, and
 * chunking first could split a block across two messages so neither half
 * matched. Doing it here also keeps the plain-text fallback clean, since that
 * path shares this entry point.
 *
 * An unterminated opening tag (a truncated stream) still drops, because the
 * alternation matches a bare tag as well as a balanced pair.
 *
 * @param {string} markdown raw assistant text
 * @returns {string} the answer with reasoning removed
 */
export function stripReasoning(markdown) {
  return String(markdown ?? '')
    .replace(REASONING_PATTERN, '')
    .replace(/^\s+/, '');
}

/**
 * Render a full markdown document to Telegram HTML.
 *
 * @param {string} markdown source document
 * @param {{ imagesAsLinks?: boolean }} [options]
 * @returns {string} Telegram-safe HTML
 */
export function renderMarkdown(markdown, options = {}) {
  const lines = stripReasoning(markdown).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    // Fenced code block
    const fence = /^(\s*)(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      const [, , marker, language] = fence;
      const body = [];
      index += 1;
      while (index < lines.length) {
        const closing = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`);
        if (closing.test(lines[index])) {
          index += 1;
          break;
        }
        body.push(lines[index]);
        index += 1;
      }
      const code = escapeHtml(body.join('\n'));
      out.push(
        language
          ? `<pre><code class="language-${escapeAttr(language)}">${code}</code></pre>`
          : `<pre>${code}</pre>`,
      );
      continue;
    }

    // Table
    if (isTableSeparator(lines[index + 1]) && line.includes('|')) {
      const table = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
        table.push(lines[index]);
        index += 1;
      }
      out.push(renderTable(table));
      continue;
    }

    // Blockquote (consume the whole run)
    if (/^\s*>\s?/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      const inner = renderMarkdown(quoted.join('\n'), options);
      out.push(`<blockquote>${inner}</blockquote>`);
      continue;
    }

    // Heading
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`<b>${renderInline(heading[2].replace(/\s*#+\s*$/, ''))}</b>`);
      index += 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push('──────────');
      index += 1;
      continue;
    }

    // Standalone image — the media extractor normally removes these, so a
    // leftover renders as a labelled link rather than vanishing.
    const standaloneImage = STANDALONE_IMAGE.exec(line);
    if (standaloneImage && options.imagesAsLinks !== false) {
      const [, alt, url] = standaloneImage;
      const href = normalizeUrl(url);
      out.push(
        href
          ? `<a href="${escapeAttr(href)}">🖼 ${escapeHtml(alt || 'image')}</a>`
          : `🖼 ${escapeHtml(alt || url)}`,
      );
      index += 1;
      continue;
    }

    // List item
    const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line);
    if (bullet) {
      const [, indent, , content] = bullet;
      const depth = Math.floor(indent.replace(/\t/g, '  ').length / 2);
      const marker = depth === 0 ? '•' : depth === 1 ? '◦' : '▪';
      out.push(`${'  '.repeat(depth)}${marker} ${renderInline(stripTaskMarker(content))}`);
      index += 1;
      continue;
    }

    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      const [, indent, number, content] = ordered;
      const depth = Math.floor(indent.replace(/\t/g, '  ').length / 2);
      out.push(`${'  '.repeat(depth)}${number}. ${renderInline(stripTaskMarker(content))}`);
      index += 1;
      continue;
    }

    // Ordinary paragraph line
    out.push(renderInline(line));
    index += 1;
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripTaskMarker(content) {
  const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
  if (!task) return content;
  return `${task[1] === ' ' ? '☐' : '☑'} ${task[2]}`;
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
 * Widest monospace table that survives a phone screen.
 *
 * This governs the HTML fallback only. `sendRichMessage` renders a real
 * `<table>` (see `rich.js`) and is preferred; this path runs when that method
 * is unavailable, and when editing a streaming preview in place.
 *
 * `sendMessage` has no table markup — `<table>` is rejected outright with
 * `Unsupported start tag "table"`, and a markdown pipe table is just text. A
 * column-aligned grid inside `<pre>` is therefore a *drawing* of a table, and
 * it holds together only while every line fits the viewport: past that the
 * client soft-wraps mid-row and the columns shear apart, which is worse than
 * having no grid at all.
 *
 * A narrow phone in portrait shows roughly 34 monospace characters. This is
 * deliberately conservative — being slightly narrower than necessary costs a
 * little whitespace, while being one column too wide destroys the layout.
 */
const TABLE_MAX_WIDTH = 34;

/**
 * Render a markdown table for Telegram.
 *
 * Narrow tables keep the aligned grid, which is the most scannable form. Wide
 * ones become one labelled record per row: taller, but every value stays
 * attached to its column name and nothing shears. The choice is made on
 * measured width rather than column count, because two long columns wrap while
 * five short ones do not.
 */
export function renderTable(lines) {
  if (lines.length < 2) return escapeHtml(lines.join('\n'));

  const header = splitRow(lines[0]);
  const alignments = splitRow(lines[1]).map((spec) => {
    const left = spec.startsWith(':');
    const right = spec.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
  const body = lines.slice(2).map(splitRow);

  const columns = Math.max(header.length, ...body.map((row) => row.length));
  const plain = (cell) => stripInlineMarkup(cell ?? '');

  const widths = [];
  for (let col = 0; col < columns; col += 1) {
    let width = displayWidth(plain(header[col]));
    for (const row of body) width = Math.max(width, displayWidth(plain(row[col])));
    widths.push(width);
  }

  // Column widths plus the two-space gutters between them.
  const totalWidth = widths.reduce((sum, width) => sum + width, 0) + (columns - 1) * 2;
  if (totalWidth > TABLE_MAX_WIDTH) {
    return renderTableAsRecords(header, body, columns);
  }

  const renderRow = (cells) =>
    cells
      .map((cell, col) => padCell(plain(cell), widths[col], alignments[col] ?? 'left'))
      .join('  ')
      .trimEnd();

  const paddedHeader = [];
  for (let col = 0; col < columns; col += 1) paddedHeader.push(header[col] ?? '');

  const rows = [renderRow(paddedHeader), widths.map((width) => '─'.repeat(width)).join('  ')];
  for (const row of body) {
    const padded = [];
    for (let col = 0; col < columns; col += 1) padded.push(row[col] ?? '');
    rows.push(renderRow(padded));
  }

  return `<pre>${escapeHtml(rows.join('\n'))}</pre>`;
}

/**
 * Render a too-wide table as one labelled block per row.
 *
 * The first column is treated as the row's subject and becomes a bold title,
 * because in practice it is the name the other columns describe. Remaining
 * cells become `label: value` lines that wrap harmlessly — a wrapped sentence
 * is still readable, a wrapped grid is not.
 *
 * Inline markup is kept here (unlike the monospace path, which must strip it to
 * measure width) so links and emphasis inside cells survive.
 */
function renderTableAsRecords(header, body, columns) {
  const labels = [];
  for (let col = 0; col < columns; col += 1) labels.push(stripInlineMarkup(header[col] ?? '').trim());

  const blocks = body.map((row) => {
    const lines = [];
    const subject = (row[0] ?? '').trim();
    if (subject) lines.push(`<b>${renderInline(subject)}</b>`);

    for (let col = 1; col < columns; col += 1) {
      const value = (row[col] ?? '').trim();
      if (!value) continue;
      const label = labels[col];
      lines.push(label ? `${escapeHtml(label)}: ${renderInline(value)}` : renderInline(value));
    }
    return lines.join('\n');
  });

  return blocks.filter(Boolean).join('\n\n');
}

/** Remove inline markdown markers, keeping the visible text only. */
function stripInlineMarkup(cell) {
  return String(cell)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*\*([\s\S]*?)\*\*\*/g, '$1')
    .replace(/\*\*([\s\S]*?)\*\*/g, '$1')
    .replace(/__([\s\S]*?)__/g, '$1')
    .replace(/~~([\s\S]*?)~~/g, '$1')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1$2')
    .replace(/(^|[^_\w])_([^_\n]+)_/g, '$1$2');
}

/* ------------------------------------------------------------------ *
 * Chunking
 * ------------------------------------------------------------------ */

/**
 * Split a markdown document into chunks whose RENDERED html fits `maxLength`.
 *
 * Splitting the source (not the html) guarantees each chunk renders to
 * well-formed HTML with balanced tags — slicing rendered html could cut a
 * message in half mid-tag and make Telegram reject the whole send.
 *
 * @param {string} markdown source document
 * @param {number} maxLength Telegram's per-message cap (4096)
 * @returns {string[]} markdown chunks, each safe to render independently
 */
export function chunkMarkdown(markdown, maxLength = 4096) {
  // Strip reasoning before measuring: a long reasoning block would otherwise
  // force a split that the rendered output does not need.
  const source = stripReasoning(markdown);
  if (!source.trim()) return [];
  if (renderMarkdown(source).length <= maxLength) return [source];

  const chunks = [];
  let current = [];
  let insideFence = false;
  let fenceHeader = '';

  const flush = () => {
    if (current.length === 0) return;
    const text = current.join('\n');
    if (text.trim()) chunks.push(text);
    current = [];
  };

  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (insideFence) {
        insideFence = false;
        fenceHeader = '';
      } else {
        insideFence = true;
        fenceHeader = line;
      }
    }

    const candidate = [...current, line].join('\n');
    const rendered = renderMarkdown(insideFence ? `${candidate}\n${closingFor(fenceHeader)}` : candidate);

    if (rendered.length > maxLength && current.length > 0) {
      if (insideFence) {
        // Close the fence in this chunk and reopen it in the next one so both
        // halves stay valid code blocks.
        current.push(closingFor(fenceHeader));
        flush();
        current.push(fenceHeader);
      } else {
        flush();
      }
    }

    current.push(line);
  }

  flush();

  // A single line may still exceed the cap on its own; hard-split its rendered
  // form on a safe boundary as a last resort.
  return chunks.flatMap((chunk) =>
    renderMarkdown(chunk).length <= maxLength ? [chunk] : hardSplit(chunk, maxLength),
  );
}

function closingFor(header) {
  const marker = /^\s*(`{3,}|~{3,})/.exec(header);
  return marker ? marker[1] : '```';
}

/** Last-resort split of an over-long single block, on word boundaries. */
function hardSplit(chunk, maxLength) {
  const budget = Math.max(256, Math.floor(maxLength * 0.6));
  const pieces = [];
  let rest = chunk;
  while (rest.length > budget) {
    let cut = rest.lastIndexOf(' ', budget);
    if (cut < budget * 0.5) cut = budget;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * Render markdown into ready-to-send HTML messages.
 *
 * @param {string} markdown source document
 * @param {number} maxLength per-message cap
 * @returns {string[]} HTML strings, each within the cap
 */
export function renderToMessages(markdown, maxLength = 4096) {
  return chunkMarkdown(markdown, maxLength)
    .map((chunk) => renderMarkdown(chunk))
    .filter((html) => html.trim().length > 0);
}

/**
 * Strip markdown to readable plain text. Used as the fallback when Telegram
 * rejects a rendered HTML payload, so a formatting bug degrades the message
 * instead of losing it.
 */
export function toPlainText(markdown) {
  return stripReasoning(markdown)
    .replace(/```[A-Za-z0-9_+-]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1 ($2)')
    .replace(/\*\*\*([\s\S]*?)\*\*\*/g, '$1')
    .replace(/\*\*([\s\S]*?)\*\*/g, '$1')
    .replace(/__([\s\S]*?)__/g, '$1')
    .replace(/~~([\s\S]*?)~~/g, '$1')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1$2')
    .replace(/^\s*>\s?/gm, '')
    .trim();
}
