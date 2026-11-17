# Configuración de Herdr

Los archivos versionados reproducen el aspecto y los ajustes personales:

| Origen | Destino en `~/.config/herdr-app/` |
| --- | --- |
| `config/settings.json` | `settings.json` |
| `config/keys.json` | `keys.json` |
| `config/themes/nightfox.json` | `themes/nightfox.json` |
| `layouts/nightfox-setup.json` | `layouts/nightfox-setup.json` |
| `config/mods/changes-plus.json` | Solo sus `settings` son preferencias iniciales opcionales para `mods/changes-plus/mod.json`. |

La instalación y actualización se delegan en un agente siguiendo la
[receta principal](../README.md#receta-para-el-agente). No hay instalador ni
servicio en segundo plano. El layout utiliza Changes Plus y componentes nativos
de Herdr; no necesita Tab Host. La plantilla define Alt+G solo para este layout.

Los ajustes son una plantilla: en una instalación existente el agente debe
compararlos y conservar los valores personales; no reemplazarlos a ciegas.
La configuración de espacios, pestañas, datos de mods, estado de la interfaz y
respaldos no forma parte de esta plantilla.
