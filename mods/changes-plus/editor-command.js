export function parseEditorCommand(value) {
  let args;
  try { args = JSON.parse(value); }
  catch { throw new Error("El comando debe ser una lista JSON de argumentos."); }
  if (!Array.isArray(args) || !args.length || args.some(arg => typeof arg !== "string" || arg.includes("\0")) || !args[0].trim())
    throw new Error("Introduce una lista de textos con el ejecutable en primer lugar.");
  if (!args.some(arg => arg.includes("{archivo}")))
    throw new Error("Incluye {archivo} en uno de los argumentos.");
  return args;
}

export function editorCommand(args, file, line) {
  return args.map(arg => arg.replace(/\{archivo\}|\{linea\}/g, token => token === "{archivo}" ? file : String(line || 1)));
}
