// Character ranges are source-string offsets; display columns expand tabs to 4.
export function columnOffset(text, column) {
  let width = 0, offset = 0;
  for (const char of text) {
    const size = char === "\t" ? 4 - width % 4 : /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60\u{1f300}-\u{1faff}]/u.test(char) ? 2 : /\p{Mark}/u.test(char) ? 0 : 1;
    if (column < width + size / 2) return offset;
    width += size;
    offset += char.length;
  }
  return text.length;
}

export function orderedRange(selection) {
  const { anchor, focus } = selection;
  return anchor.index < focus.index || (anchor.index === focus.index && anchor.offset <= focus.offset)
    ? [anchor, focus] : [focus, anchor];
}

export function selectedOffsets(selection, index, length) {
  if (!selection) return null;
  const [first, last] = orderedRange(selection);
  if (index < first.index || index > last.index) return null;
  return [index === first.index ? first.offset : 0, index === last.index ? last.offset : length];
}

export function selectedText(selection, rows) {
  if (!selection) return "";
  const [first, last] = orderedRange(selection);
  return rows.slice(first.index, last.index + 1).flatMap((row, i) => {
    const entry = selection.split ? row[selection.side] : row;
    if (!entry) return [];
    const text = entry?.text ?? "";
    const [start, end] = selectedOffsets(selection, first.index + i, text.length);
    return [text.slice(start, end)];
  }).join("\n");
}

export function wordRange(text, offset) {
  let start = Math.min(offset, Math.max(0, text.length - 1)), end = start;
  const word = /[\p{L}\p{N}_]/u;
  const matches = char => word.test(char) === word.test(text[start] ?? "") && /\s/u.test(char) === /\s/u.test(text[start] ?? "");
  while (start > 0 && matches(text[start - 1])) start--;
  while (end < text.length && matches(text[end])) end++;
  return [start, end];
}
