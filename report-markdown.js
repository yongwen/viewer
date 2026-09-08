// Reports are untrusted text. Only these generated tags enter the reader;
// report HTML, images, and non-HTTP links are never interpreted by the browser.
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

function sourceUrl(value) {
  if (!/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function markdownLink(text) {
  const prefix = /^(!?)\[([^\]\n]*)\]\(/.exec(text);
  if (!prefix) return null;
  let nesting = 1;
  for (let index = prefix[0].length; index < text.length; index += 1) {
    if (text[index] === '\n') return null;
    if (text[index] === '\\') { index += 1; continue; }
    if (text[index] === '(') nesting += 1;
    if (text[index] === ')') nesting -= 1;
    if (!nesting) {
      const destination = /^(?:<([^<>]*)>|(\S+?))(?:\s+(?:"[^"]*"|'[^']*'))?$/.exec(text.slice(prefix[0].length, index).trim());
      return destination ? { image: Boolean(prefix[1]), label: prefix[2], url: destination[1] ?? destination[2], length: index + 1 } : null;
    }
  }
  return null;
}

function inline(text, depth = 0, allowLinks = true) {
  if (depth > 8) return escapeHtml(text);
  let html = '';
  for (let index = 0; index < text.length;) {
    const rest = text.slice(index);
    const escaped = /^\\([\\`*_[\]{}()#+.!|>~-])/.exec(rest);
    if (escaped) { html += escapeHtml(escaped[1]); index += escaped[0].length; continue; }
    const ticks = /^`+/.exec(rest);
    if (ticks) {
      const end = text.indexOf(ticks[0], index + ticks[0].length);
      if (end !== -1) {
        const code = text.slice(index + ticks[0].length, end).replace(/\n/g, ' ');
        html += `<code>${escapeHtml(code)}</code>`;
        index = end + ticks[0].length;
        continue;
      }
    }
    // Image descriptions stay readable without creating a remote request.
    const link = markdownLink(rest);
    if (link) {
      const label = inline(link.label, depth + 1, false);
      const url = !link.image && allowLinks ? sourceUrl(link.url) : null;
      html += url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
      index += link.length;
      continue;
    }
    const emphasis = /^(\*\*\*|___|\*\*|__|\*|_)/.exec(rest);
    if (emphasis && !(emphasis[0].startsWith('_') && /[\p{L}\p{N}]/u.test(text[index - 1] || ''))) {
      const marker = emphasis[0];
      const end = text.indexOf(marker, index + marker.length);
      const content = end < 0 ? '' : text.slice(index + marker.length, end);
      if (content && !/^\s|\s$/.test(content)) {
        const formatted = inline(content, depth + 1, allowLinks);
        html += marker.length === 3 ? `<strong><em>${formatted}</em></strong>`
          : marker.length === 2 ? `<strong>${formatted}</strong>` : `<em>${formatted}</em>`;
        index = end + marker.length;
        continue;
      }
    }
    html += escapeHtml(text[index]);
    index += 1;
  }
  return html;
}

function tableCells(line) {
  const value = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  // Escaped pipes and inline code pipes do not start another cell.
  const cells = [];
  let cell = '', ticks = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\' && index + 1 < value.length) { cell += character + value[++index]; continue; }
    if (character === '`') {
      const marker = /^`+/.exec(value.slice(index))[0];
      if (!ticks) ticks = marker;
      else if (ticks === marker) ticks = '';
      cell += marker;
      index += marker.length - 1;
    } else if (character === '|' && !ticks) { cells.push(cell.trim()); cell = ''; }
    else cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function tableAt(lines, index) {
  if (!lines[index]?.includes('|') || !lines[index + 1]) return null;
  const headers = tableCells(lines[index]), separators = tableCells(lines[index + 1]);
  if (headers.length !== separators.length || !separators.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
  return { headers, alignment: separators.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center'
    : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : '') };
}

const listItem = line => /^(\s*)([-+*]|\d+[.)])\s+(.*)$/.exec(line);
const fence = line => /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
const heading = line => /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
const horizontalRule = line => /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);

function renderBlocks(lines, depth = 0) {
  if (depth > 12) return `<p>${escapeHtml(lines.join('\n'))}</p>`;
  const output = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const codeFence = fence(line);
    if (codeFence) {
      const code = [], marker = codeFence[1];
      const closing = new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`);
      index += 1;
      while (index < lines.length && !closing.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const title = heading(line);
    if (title) { output.push(`<h${title[1].length}>${inline(title[2].replace(/\s+#+$/, ''))}</h${title[1].length}>`); index += 1; continue; }
    if (horizontalRule(line)) { output.push('<hr>'); index += 1; continue; }
    if (/^\s{0,3}>/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) quoted.push(lines[index++].replace(/^\s{0,3}> ?/, ''));
      output.push(`<blockquote>${renderBlocks(quoted, depth + 1)}</blockquote>`);
      continue;
    }
    const table = tableAt(lines, index);
    if (table) {
      const cells = (values, tag) => table.headers.map((_, cellIndex) => `<${tag}${table.alignment[cellIndex] ? ` class="align-${table.alignment[cellIndex]}"` : ''}>${inline(values[cellIndex] || '')}</${tag}>`).join('');
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) rows.push(`<tr>${cells(tableCells(lines[index++]), 'td')}</tr>`);
      output.push(`<div class="report-table-wrap"><table><thead><tr>${cells(table.headers, 'th')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
      continue;
    }
    const item = listItem(line);
    if (item) {
      const ordered = /^\d/.test(item[2]), indentation = item[1].length, items = [];
      while (index < lines.length) {
        const next = listItem(lines[index]);
        if (!next || next[1].length !== indentation || /^\d/.test(next[2]) !== ordered) break;
        const body = [next[3]];
        index += 1;
        while (index < lines.length && lines[index].trim() && /^\s+/.test(lines[index]) && /^\s*/.exec(lines[index])[0].length > indentation) {
          const continuation = lines[index++];
          body.push(continuation.slice(Math.min(indentation + 2, /^\s*/.exec(continuation)[0].length)));
        }
        const content = body.length === 1 ? inline(body[0]) : renderBlocks(body, depth + 1);
        items.push(`<li>${content}</li>`);
      }
      const tag = ordered ? 'ol' : 'ul', start = ordered ? Number.parseInt(item[2], 10) : 1;
      output.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.join('')}</${tag}>`);
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !fence(lines[index]) && !heading(lines[index])
      && !horizontalRule(lines[index]) && !/^\s{0,3}>/.test(lines[index]) && !listItem(lines[index]) && !tableAt(lines, index)) {
      paragraph.push(lines[index++].trim());
    }
    output.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return output.join('\n');
}

export function renderReportMarkdown(markdown) {
  return renderBlocks(String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n'));
}
