# Herdr App Plus

Configuración personal de Herdr App y mods independientes. La instalación y
actualización las realiza un agente, siguiendo la receta de este documento;
no hay instalador automático ni servicio en segundo plano.

## Uso con un agente

Indica al agente la URL de este repositorio y el alcance, por ejemplo:

> Instala mi entorno Herdr desde `<URL-del-repositorio>`, siguiendo su README.

Para actualizar, sustituye «instala» por «actualiza». Para un mod independiente,
indica «instala» o «actualiza solo Changes Plus». El agente debe usar la
versión del repositorio solicitada y no publicar cambios sin autorización.

## Componentes

- [`mods/changes-plus/`](mods/changes-plus/README.md): diffs, comentarios,
  commits y revisión de PR. Se puede instalar independientemente.
- [`mods/tabs-autorun/`](mods/tabs-autorun/README.md): barra experimental con
  comandos por pestaña; **no se instala** con el entorno por defecto.
- [`setup/`](setup/README.md): plantilla de ajustes, atajos, tema y layout
  personal `nightfox-setup`.

## Receta para el agente

### Reglas previas

1. Lee `~/.config/herdr-app/AGENTS.md` si existe y estas instrucciones. No leas
   variables de entorno ni secretos. Identifica el destino de Herdr antes de
   actuar. Los archivos de Herdr se aplican en caliente.
2. Inspecciona el repositorio y su estado; no descartes cambios locales. Si ya
   existe un checkout, no hagas `git pull` sobre trabajo local sin comprobarlo;
   no uses reset ni fuerces actualizaciones. Si hay dudas, consulta al usuario.
3. Muestra qué archivos crearías, actualizarías o conservarías. No modifiques
   archivos incluidos de fábrica por Herdr, su estado interno, espacios,
   pestañas, datos históricos ni copias de seguridad. No cierres buffers.
   Rechaza enlaces simbólicos y destinos de tipo inesperado en las rutas afectadas.
4. Antes de sustituir un archivo, guarda una copia fuera de la carpeta `mods/`,
   en una carpeta privada nueva con fecha e inventario de rutas originales.
   No incluyas respaldos en Git. Indica cómo restaurarlos. No copies
   `AGENTS.md`, `.git`, cachés, `node_modules`, `gpui-kit.d.ts`, `herdr.d.ts` ni
   `jsconfig.json` generado.
5. Compara antes de actualizar. Si no puedes distinguir cambios propios de una
   versión anterior, pregunta antes de reemplazarlos. Nunca sobrescribas
   preferencias, atajos o ajustes personales sin autorización. Si se interrumpe
   una operación, inspecciona los archivos y el respaldo antes de continuar.

### Instalar o actualizar solo Changes Plus

1. Necesitas Herdr App y herdr-core (`hc`); Git es necesario para sus funciones
   de repositorio y Python 3 para sus utilidades. `gh` autenticado es opcional
   para PR Comments. Comprueba las dependencias sin acceder a credenciales.
2. Copia los archivos de `mods/changes-plus/` a
   `~/.config/herdr-app/mods/changes-plus/`, excluyendo los archivos indicados
   arriba. En una instalación nueva usa el `mod.json` del mod. El campo
   `settings` de `setup/config/mods/changes-plus.json` es una plantilla
   **opcional** para reproducir las preferencias capturadas; no es necesario
   para instalar el mod de forma independiente.
3. En una actualización, conserva el `settings` del `mod.json` instalado,
   incluidos sus ajustes del editor; compara las demás propiedades. Conserva
   también archivos locales adicionales. Un archivo de código distinto no
   demuestra que se pueda sustituir: identifica su procedencia o pregunta.
   Haz el respaldo antes de modificar cualquier archivo.
4. Ejecuta `herdr-app check ~/.config/herdr-app/mods/changes-plus` y comprueba
   `herdr-app status`. El check solo valida carga y renderizado inicial, no
   eventos ni apariencia. Para usar el mod en otro layout personal consulta
   [su README](mods/changes-plus/README.md).

### Instalar o actualizar el entorno completo

1. Sigue primero los pasos de Changes Plus. No instales Tabs Autorun por defecto.
2. Compara y copia los archivos de la [tabla de Setup](setup/README.md), salvo
   la plantilla opcional del mod. Crea archivos ausentes; para archivos
   existentes conserva claves, atajos y preferencias personales. Presenta los
   conflictos y pregunta antes de reemplazar cualquier valor diferente.
   Alt+G en `layout:nightfox-setup` activa `changes-plus.toggle`; no elimines
   automáticamente un atajo global antiguo.
3. Comprueba que `nightfox-setup` y el tema `nightfox` están disponibles antes
   de seleccionar el layout. No alteres el layout personal anterior ni los
   archivos incluidos de fábrica. Si se solicita activar el layout, usa
   `herdr-app do layout.switch --name nightfox-setup`; comunica cómo volver al
   layout previo. Comprueba `herdr-app status` y los archivos de error de
   configuración si existen.
4. Distingue comprobaciones automáticas y visuales. Pide al usuario probar
   Files, Changes y el atajo configurado; indica los pasos exactos y el resultado
   esperado. No declares validada la interfaz solo por `herdr-app check`.

La configuración versionada **no respalda ni restaura espacios, pestañas o
terminales de herdr-core**. Conserva el respaldo hasta que el usuario decida
retirarlo. Para restaurar archivos, compara primero su estado actual con el
respaldo; pide autorización si han cambiado desde la instalación y no cierres
buffers con cambios.
