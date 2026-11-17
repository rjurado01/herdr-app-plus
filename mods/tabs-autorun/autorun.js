export const DEFAULT_RULES = [{ name: "Opencode", command: "opencode" }];

export function validateRules(value) {
  if (!Array.isArray(value)) throw new Error("Las reglas deben ser una lista.");
  const names = new Set();
  return value.map(rule => {
    if (!rule || typeof rule.name !== "string" || !rule.name.trim() ||
        typeof rule.command !== "string" || !rule.command.trim() ||
        /[\x00-\x1f\x7f]/.test(rule.name) || /[\x00-\x1f\x7f]/.test(rule.command))
      throw new Error("Cada regla necesita un nombre y un comando en una línea.");
    if (names.has(rule.name)) throw new Error(`Nombre duplicado: ${rule.name}`);
    names.add(rule.name);
    return { name: rule.name, command: rule.command };
  });
}

export function targetForClick(space, tab, allPanes, rules) {
  if (!space || !tab?.named) return null;
  const matches = rules.filter(rule => rule.name === tab.name);
  if (matches.length !== 1) return null;
  const relevant = allPanes.filter(p => p.tab === tab.id);
  if (relevant.length !== 1) return null;
  const pane = relevant[0];
  if (!pane.terminal || !pane.program?.shell) return null;
  return { terminal: pane.terminal, command: matches[0].command };
}
