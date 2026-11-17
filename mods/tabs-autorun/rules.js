// Pure planning: ambiguity means no changes. No shell input is sent here.
export function missingTabs(spaces, rules) {
  const actions = [];
  if (!Array.isArray(spaces) || !rules || typeof rules !== "object" || Array.isArray(rules))
    return actions;
  for (const space of spaces) {
    if (!space.named || space.machine != null || typeof space.name !== "string") continue;
    if (spaces.filter(s => s.named && s.machine == null && s.name === space.name).length !== 1) continue;
    if (!Object.hasOwn(rules, space.name)) continue;
    const definitions = rules[space.name];
    if (!Array.isArray(definitions)) continue;
    const names = definitions.map(entry => entry?.name);
    if (names.some(name => typeof name !== "string" || !name.trim()) ||
        new Set(names).size !== names.length) continue;
    if (!Array.isArray(space.tabs)) continue;
    const present = new Set(space.tabs.map(tab => tab.name));
    for (const entry of definitions) {
      if (!present.has(entry.name)) {
        actions.push({ space: space.id, name: entry.name });
        present.add(entry.name);
      }
    }
  }
  return actions;
}
