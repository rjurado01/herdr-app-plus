export const DEFAULT_RULES = [{ name: "Opencode", command: "opencode" }];

export function validateRules(value) {
  if (!Array.isArray(value)) throw new Error("Las reglas deben ser una lista.");
  const names = new Set();
  return value.map(rule => {
    if (!rule || typeof rule.name !== "string" || !rule.name.trim() ||
        typeof rule.command !== "string" || !rule.command.trim() ||
        (rule.space !== undefined && typeof rule.space !== "string") ||
        /[\x00-\x1f\x7f]/.test(rule.space ?? "") ||
        /[\x00-\x1f\x7f]/.test(rule.name) || /[\x00-\x1f\x7f]/.test(rule.command))
      throw new Error("Cada regla necesita un nombre y un comando en una línea.");
    const space = rule.space ?? "";
    if (space && !space.trim()) throw new Error("El espacio debe estar vacío o tener un nombre.");
    const key = JSON.stringify([space, rule.name]);
    if (names.has(key)) throw new Error(`Regla duplicada: ${space || "todos"} / ${rule.name}`);
    names.add(key);
    return { space, name: rule.name, command: rule.command };
  });
}

export function targetForClick(space, tab, allPanes, rules) {
  if (!space || !tab?.named) return null;
  const specific = space.named ? rules.filter(rule => rule.name === tab.name && rule.space === space.name && rule.space !== "") : [];
  const matches = specific.length ? specific : rules.filter(rule => rule.name === tab.name && !rule.space);
  if (matches.length !== 1) return null;
  const relevant = allPanes.filter(p => p.tab === tab.id);
  if (relevant.length !== 1) return null;
  const pane = relevant[0];
  if (!pane.terminal || !pane.program?.shell) return null;
  return { terminal: pane.terminal, command: matches[0].command };
}
