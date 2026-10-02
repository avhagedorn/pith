import * as ansi from './ansi.js';
import { DASH } from './render.js';

const BULLET = '•';
const BAR = '│';
const RULE_LENGTH = 40;
const COLUMN_GAP = '  ';

const dim = (text: string) => `${ansi.DIM}${text}${ansi.END_WEIGHT}`;

const FENCE = /^\s*```/;
const HEADING = /^#{1,6}\s+(.*)$/;
const HEADING_MARKERS = /\*\*|__|`/g;
const HORIZONTAL_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_ROW = /^\s*\|/;
const TABLE_DIVIDER = /^[\s|:-]+$/;
const OUTER_PIPES = /^\||\|$/g;
const CELL_BREAK = /(?<!\\)\|/;
const RIGHT_ALIGNED = /^-+:$/;
const ESCAPED_PIPE = /\\\|/g;
const LIST_ITEM = /^(\s*)[-*+]\s+/;
const CODE_SPAN = /(`[^`]+`)/;
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const STRIKETHROUGH = /(?<!\\)~~(?=\S)(.+?)(?<=[^\s\\])~~/g;
const ESCAPED = /\\([*_~`\\[\]#>|-])/g;
const EMPHASIS_CHARACTERS = /[*_~]/g;

// Emphasised text starts and ends on a non-space ("2 * 3" is not italic) and is not escaped.
// Underscores also need word boundaries, so snake_case is left alone.
const INSIDE = '(?=\\S)(.+?)(?<=[^\\s\\\\])';
const emphasis = (length: number, on: string, off: string) => ({
  stars: new RegExp(`(?<![\\\\*])\\*{${length}}${INSIDE}\\*{${length}}(?!\\*)`, 'g'),
  underscores: new RegExp(`(?<![\\w_\\\\])_{${length}}${INSIDE}_{${length}}(?![\\w_])`, 'g'),
  styled: `${on}$1${off}`,
});
// Longest marker first, so *** is not read as ** plus *.
const EMPHASIS = [
  emphasis(3, ansi.BOLD_ITALIC, ansi.END_BOLD_ITALIC),
  emphasis(2, ansi.BOLD, ansi.END_WEIGHT),
  emphasis(1, ansi.ITALIC, ansi.END_ITALIC),
];

function inline(text: string): string {
  // Splitting on code spans leaves them at the odd indexes, where nothing restyles them.
  const parts = text.split(CODE_SPAN).map((part, index) => {
    if (index % 2) return `${ansi.CYAN}${part.slice(1, -1)}${ansi.END_COLOR}`;

    // Emphasis characters in a URL are escaped so the passes below skip them.
    let styled = part.replace(LINK, (_, label: string, url: string) => {
      const literalUrl = url.replace(EMPHASIS_CHARACTERS, '\\$&');
      return `${ansi.UNDERLINE}${label}${ansi.END_UNDERLINE} ${dim(`(${literalUrl})`)}`;
    });
    for (const { stars, underscores, styled: replacement } of EMPHASIS) {
      styled = styled.replace(stars, replacement).replace(underscores, replacement);
    }
    return styled
      .replace(STRIKETHROUGH, `${ansi.STRIKE}$1${ansi.END_STRIKE}`)
      .replace(ESCAPED, '$1');
  });
  return parts.join('');
}

// Columns padded to their widest cell, the header in bold with a rule under it.
// A table too wide for `maxWidth` becomes "Header: value" lines, which the terminal can wrap.
function table(rows: string[], maxWidth: number): string[] {
  const cells = rows.map(row =>
    row
      .trim()
      .replace(OUTER_PIPES, '')
      .split(CELL_BREAK)
      .map(cell => cell.trim()),
  );
  const hasHeader = rows.length > 1 && TABLE_DIVIDER.test(rows[1]!);
  const rightAligned = hasHeader ? cells[1]!.map(cell => RIGHT_ALIGNED.test(cell)) : [];

  const body = cells
    .filter((_, index) => !(hasHeader && index === 1))
    .map((row, index) =>
      row.map(cell => {
        const styled = inline(cell.replace(ESCAPED_PIPE, '|'));
        return hasHeader && index === 0 ? `${ansi.BOLD}${styled}${ansi.END_WEIGHT}` : styled;
      }),
    );
  const columns = Math.max(0, ...body.map(row => row.length));
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(...body.map(row => ansi.visibleLength(row[column] ?? ''))),
  );
  const gridWidth = widths.reduce((sum, width) => sum + width, COLUMN_GAP.length * (columns - 1));

  if (gridWidth > maxWidth) {
    const header = hasHeader ? body[0]! : [];
    const records = hasHeader ? body.slice(1) : body;
    return records.flatMap((row, index) => [
      ...(index ? [''] : []),
      ...row.map((cell, column) => (header[column] ? `${header[column]}: ${cell}` : cell)),
    ]);
  }

  const lines = body.map(row =>
    widths
      .map((width, column) => {
        const cell = row[column] ?? '';
        const padding = ' '.repeat(width - ansi.visibleLength(cell));
        return rightAligned[column] ? padding + cell : cell + padding;
      })
      .join(COLUMN_GAP)
      .trimEnd(),
  );
  if (hasHeader) lines.splice(1, 0, dim(widths.map(width => DASH.repeat(width)).join(COLUMN_GAP)));
  return lines;
}

export interface MarkdownStyler {
  push(line: string): string[];
  flush(): string[];
}

/**
 * Styles model markdown as lines finish. Most lines come straight back. Table rows are held
 * until the table ends, because column widths need every row; `flush` releases what is held.
 * `width` is the room a table may take.
 * Not attempted: checkboxes, images, HTML and emphasis that spans lines.
 */
export function markdownStyler(
  color: boolean,
  width: () => number = () => Infinity,
): MarkdownStyler {
  if (!color) return { push: line => [line], flush: () => [] };

  let inFence = false;
  let tableRows: string[] = [];
  const flush = () => {
    const lines = table(tableRows, width());
    tableRows = [];
    return lines;
  };

  const styleLine = (line: string) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return dim(line);
    }
    if (inFence) return `${ansi.CYAN}${line}${ansi.RESET}`;

    const heading = HEADING.exec(line);
    if (heading) {
      return `${ansi.BOLD_YELLOW}${heading[1]!.replace(HEADING_MARKERS, '')}${ansi.RESET}`;
    }
    if (HORIZONTAL_RULE.test(line)) return dim(DASH.repeat(RULE_LENGTH));

    const quote = QUOTE.exec(line);
    if (quote) return `${dim(BAR)} ${ansi.ITALIC}${inline(quote[1]!)}${ansi.END_ITALIC}`;

    return inline(line.replace(LIST_ITEM, `$1${BULLET} `));
  };

  return {
    push(line) {
      if (!inFence && TABLE_ROW.test(line)) {
        tableRows.push(line);
        return [];
      }
      return [...flush(), styleLine(line)];
    },
    flush,
  };
}
