# Changes Plus para Herdr

Incluye vista de diff, selección de líneas y envío de comentarios a sesiones de OpenCode del espacio actual, contexto ampliable, resaltado de sintaxis y consulta de hilos de revisión de GitHub.

## Instalación

### Manual

Copia `mods/changes-plus/` a `~/.config/herdr-app/mods/changes-plus/` **sin sobrescribir una instalación existente**. Para usarlo en un layout personal, configura un bloque con `{"mod": "changes-plus", "props": {"mode": "sidebar"}}`. No modifiques directamente los layouts incluidos con Herdr. La migración desde Better Changes y sus datos aún está pendiente de validación.

Comprueba el mod con `herdr-app check ~/.config/herdr-app/mods/changes-plus`.

### Con un agente

Indícale a tu agente, sustituyendo la URL por la de este repositorio:

```text
Instala solo el mod Changes Plus desde <URL-del-repositorio>, siguiendo
la receta del README. Conserva cualquier preferencia y cambio local.
```

## Funcionalidades

### Changes

- Consulta los archivos modificados, agrupados en **Staged** y **Unstaged**, y filtra la lista por ruta.
- Alterna entre vista de árbol y lista, y prepara o retira archivos del área de preparación individualmente o por grupo.
- Examina diffs en vista unificada o dividida, con resaltado de sintaxis y controles para ampliar o reducir el contexto.
- Selecciona texto arrastrando; **Ctrl+C** lo copia sin números ni marcadores del diff. Doble clic selecciona una palabra y triple clic una línea. En vista dividida la selección permanece en una sola columna.
- Descarta los cambios de un archivo con confirmación. La operación restaura el archivo desde `HEAD`, incluidos sus cambios preparados; no está disponible para archivos nuevos.
- Abre el archivo del diff en el editor configurado desde su cabecera o con la tecla **E**.

### Comments

- Añade un comentario desde el icono que aparece junto a la línea bajo el cursor o al final del texto seleccionado. Seleccionar texto no abre el comentario automáticamente.
- Envía el comentario y su referencia a OpenCode con **Enviar (Enter)**. Si hay varias sesiones en el espacio, permite elegir el destinatario.
- El envío utiliza `hc send` y requiere que el agente esté disponible.

### Commits

- Consulta el historial de commits y abre el detalle y los archivos modificados de cada uno.
- Crea commits con los cambios preparados y un mensaje.
- Permite modificar el último commit mediante **amend**. Los cambios sin preparar permanecen intactos.

### PR Comments

- Consulta con `gh` el pull request abierto de la rama actual y muestra sus hilos de revisión sin resolver.
- Conserva los comentarios en memoria al cambiar de pestaña; el botón de recarga vuelve a consultarlos.
- Muestra junto al diff los hilos vigentes que tienen una línea identificable y permite abrir el diff del archivo entre la base y la cabecera del PR.
- Permite añadir o quitar una reacción 👍 y resolver hilos cuando el usuario tiene permisos en GitHub.
- Requiere `gh` autenticado en la máquina del repositorio y los commits del PR disponibles en Git. No hace `fetch`, no publica respuestas ni incluye comentarios generales del PR.

## Configuración

### Editor

Abre los ajustes con el **engranaje** de la cabecera de Changes y elige cómo abrir archivos:

- **Neovim**: reutiliza una sesión accesible del espacio; si hay varias, permite elegir una y, si no hay ninguna, abre una nueva.
- **Comando personalizado**: introduce una lista JSON con el ejecutable y sus argumentos. `{archivo}` es obligatorio y `{linea}` es opcional. Por ejemplo:

  ```json
  ["code", "--goto", "{archivo}:{linea}"]
  ```

El comando personalizado se ejecuta **sin shell**, en el equipo local, y no admite archivos de máquinas remotas. Los ajustes se guardan en `~/.config/herdr-app/mods/changes-plus/mod.json`; el propio panel comprueba si el archivo ha cambiado antes de sobrescribirlo.

### Atajo de Changes

En los ajustes de Changes Plus, introduce una combinación como `alt-g` o
`ctrl-shift-f8` y pulsa **Guardar**. Se aplica únicamente al layout activo
y modifica su sección en `~/.config/herdr-app/keys.json`; no sustituye otros
atajos existentes. Si el archivo ha cambiado desde que abriste los ajustes,
vuelve a abrirlos antes de guardar.

Como excepción, se permite `alt-g` si el único conflicto es el atajo global
antiguo de Better Changes: el atajo del layout tiene prioridad y el global
permanece intacto para otros layouts.

El atajo y el editor se guardan en archivos distintos: si falla la segunda
escritura después de guardar el atajo, el panel indica que el guardado fue parcial.

El campo admite combinaciones de `ctrl`, `alt`, `shift` y `cmd` con letras,
números, `f1`–`f12` o las teclas de navegación indicadas por Herdr. El layout
debe incluir el controlador de Changes Plus para que el atajo funcione.

## Licencias y procedencia

Basado en el mod [better-changes de munza/herdr-mods](https://github.com/munza/herdr-mods/tree/main/better-changes), bajo Apache 2.0: ver `LICENSE`. Esta versión modifica el comportamiento y la presentación del mod original.

`mods/changes-plus/syntax.js` procede de [Herdr Annotator](https://github.com/jakub-tucek/herdr-annotator), bajo licencia MIT: ver `LICENSE-ANNOTATOR-MIT`.
