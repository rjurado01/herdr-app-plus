# Herdr Tabs Autorun

Barra personal de pestañas con comandos configurables por nombre exacto.
Cada regla puede aplicarse a todos los espacios o a uno nombrado explícitamente;
actúa solamente sobre la terminal de la pestaña pulsada. Una regla específica
tiene prioridad sobre una global para la misma pestaña. Espacio y pestaña
se comparan exactamente, distinguiendo mayúsculas. Sustituye la barra nativa en el layout y
debe revisarse cuando Herdr actualice su barra.

## Estado e instalación

**Experimental.** Pulsa el engranaje de la barra para añadir, editar o eliminar
reglas. Se guardan en `mods/tabs-autorun/config.json`; consérvalo al actualizar.
Por defecto `Opencode` ejecuta `opencode`. Los nombres distinguen mayúsculas.
Solo se ejecuta al hacer clic en una pestaña nombrada que tenga un único panel
con terminal identificado como shell. No se ejecuta al navegar con teclado.

**Riesgo aceptado:** el texto se envía con `hc send`; una shell puede contener
un borrador y la comprobación no es atómica. El comando puede llegar a otro
programa o ejecutar texto pendiente, incluso después de una espera. No uses
esta función con trabajo sin guardar en la línea de comandos.

La creación automática de pestañas del prototipo anterior no está integrada en
esta barra. La sustitución del layout y la persistencia del panel necesitan una
prueba visual y funcional en Herdr antes de darse por terminadas.

Desde esta carpeta: `npm test` y `herdr-app check .`.
