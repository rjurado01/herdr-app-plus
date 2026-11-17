const ACTION = "changes-plus.toggle";
const ORDER = ["ctrl", "alt", "shift", "cmd"];

export function normalizeShortcut(value) {
  const parts = String(value ?? "").trim().toLowerCase().split("-");
  const key = parts.pop();
  if (!key || !/^(?:[a-z0-9]|f(?:[1-9]|1[0-2])|left|right|up|down|pageup|pagedown|home|end|insert|delete|space|tab)$/.test(key))
    throw new Error("Usa una tecla reconocida, por ejemplo alt-g o ctrl-shift-f8.");
  if (!parts.length || parts.some(p => !ORDER.includes(p)) || new Set(parts).size !== parts.length)
    throw new Error("Indica al menos un modificador: ctrl, alt, shift o cmd.");
  return [...ORDER.filter(modifier => parts.includes(modifier)), key].join("-");
}

export function currentShortcut(keys, layoutName) {
  const bindings = keys?.[`layout:${layoutName}`];
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return "";
  return Object.keys(bindings).find(key => bindings[key] === ACTION) ?? "";
}

export function changeShortcut(keys, layoutName, value) {
  if (!keys || typeof keys !== "object" || Array.isArray(keys) ||
      typeof layoutName !== "string" || !layoutName.trim())
    throw new Error("No se puede identificar el layout o el archivo de atajos.");
  const section = `layout:${layoutName}`;
  const next = normalizeShortcut(value);
  const sectionBindings = keys[section] ?? {};
  if (!sectionBindings || typeof sectionBindings !== "object" || Array.isArray(sectionBindings))
    throw new Error(`La sección ${section} no es válida.`);
  const previous = Object.keys(sectionBindings).filter(key => sectionBindings[key] === ACTION);
  const unchanged = previous.some(key => {
    try { return normalizeShortcut(key) === next; } catch { return false; }
  });
  if (!unchanged) {
    for (const [scope, bindings] of Object.entries(keys)) {
      if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) continue;
      for (const [key, action] of Object.entries(bindings)) {
        let normalized;
        try { normalized = normalizeShortcut(key); } catch { continue; }
        // The old layout uses this global binding. A layout-specific Alt+G
        // already intentionally overrides it without modifying that layout.
        const legacyAltG = scope === "global" && normalized === "alt-g" &&
          action === "tab-host.toggle:better-changes";
        if (normalized === next && !legacyAltG && !(scope === section && action === ACTION))
          throw new Error(`El atajo ya está asignado en ${scope}; no se ha sustituido.`);
      }
    }
  }
  const updated = { ...sectionBindings };
  for (const key of previous) delete updated[key];
  updated[next] = ACTION;
  return { ...keys, [section]: updated };
}
