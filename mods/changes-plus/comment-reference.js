// The exact diff reference shared by comments and clipboard copying.
export function commentReference(selection, rows, pairedRows) {
  if (!selection) throw new Error("No hay líneas seleccionadas.");
  const start = Math.min(selection.start, selection.end ?? selection.start);
  const end = Math.max(selection.start, selection.end ?? selection.start);
  let excerpt, description;
  if (selection.layout === "text") {
    const source = selection.split ? pairedRows : rows;
    const entries = source.slice(start, end + 1).map(row => selection.split ? row[selection.side] : row).filter(Boolean);
    if (!entries.length) throw new Error("No hay líneas seleccionadas.");
    const first = entries[0], last = entries[entries.length - 1];
    const side = selection.split ? selection.side === "left" ? "versión anterior" : "versión nueva" : "diff";
    const number = row => selection.split && selection.side === "left" ? row.old : row.next ?? row.old;
    description = `${side}, líneas ${number(first) ?? "?"}-${number(last) ?? "?"}`;
    excerpt = selection.excerpt;
  } else if (selection.layout === "split") {
    const selected = pairedRows.slice(start, end + 1);
    if (!selected.length || selected.some(row => row.kind !== "pair"))
      throw new Error("Selecciona un rango dentro del mismo bloque del diff.");
    const before = selected.filter(row => row.left).map(row => `${row.left.old}: ${row.left.text}`).join("\n") || "(sin líneas)";
    const after = selected.filter(row => row.right).map(row => `${row.right.next}: ${row.right.text}`).join("\n") || "(sin líneas)";
    excerpt = `Antes:\n${before}\n\nDespués:\n${after}`;
    description = "ambos lados del diff";
  } else {
    const selected = rows.filter(row => row[selection.side] >= start && row[selection.side] <= end);
    const numbers = selected.map(row => row[selection.side]);
    if (numbers.length !== end - start + 1 || numbers.some((number, i) => number !== start + i))
      throw new Error("El rango debe contener líneas consecutivas visibles del mismo lado del diff.");
    excerpt = selected.map(row => `${row[selection.side]}: ${row.text}`).join("\n");
    description = `${selection.side === "old" ? "versión anterior" : "versión nueva"}, líneas ${start}-${end}`;
  }
  return `diff de ${selection.path} (${description}):\n\n\`\`\`\n${excerpt}\n\`\`\``
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
