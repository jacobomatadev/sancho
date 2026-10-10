# Sancho

Tu escudero en Claude Code. Una sola fila encima del cuadro de texto que **solo aparece cuando hay algo que decidir o que mirar**. Sin paneles fijos, sin comandos que memorizar.

```
✎ 2 archivos cambiados · +24 −7   ✓ 2 agentes terminaron · ~0,05 $    [Revisar cambios] [Ver agentes] ⚙
```

## Qué hace

| Cuándo | Qué ves |
|---|---|
| Vas a continuar una conversación cuya caché se ha enfriado y releerla saldría caro | Tu mensaje espera con lo que costaría y dos opciones: **Empezar una nueva** o **Continuar aquí** |
| Claude reparte el trabajo entre subagentes | `◐ 2 agentes trabajando · ~0,31 $`. En el panel, qué hace cada uno, cuánto lleva y cuánto cuesta |
| Termina un turno que ha cambiado archivos | Un resumen y **Revisar cambios**: la lista de archivos tocados y cada edición con su diff, una a una |
| Hay un riesgo que se te podría pasar | `⚠ Ojo: un reintento puede cobrar dos veces`, con **Pregúntale a Claude** o **Entendido** |
| Corriges a Claude («no, usa pnpm») | `¿Guardar como regla?` en el `CLAUDE.md` del proyecto o en el global |

El resto del tiempo no se ve nada.

Todo se hace con botones. Si lo prefieres, pídeselo a Claude con tus palabras: «enséñame qué has cambiado», «enséñame los agentes», «abre los ajustes de Sancho».

## Instalación

Necesitas **Claude Code 2.1.287 o posterior**. Escribe en una sesión de Claude Code en el terminal:

```
/plugin install sancho --marketplace jacobomatadev/sancho
```

Contesta `y` para añadir el marketplace y elige el ámbito de usuario. Desde ese momento funciona en todas tus sesiones, también en la pestaña Code de la app de escritorio.

Para desactivarlo:

```bash
claude plugin disable sancho@sancho
```

## Ajustes

Pulsa **⚙** en la fila o abre la pestaña **Ajustes** del panel:

- Preguntar antes de continuar una conversación cara, a partir de 0,25 $, 0,50 $ (por defecto), 1 $ o 2 $.
- Avisarme de riesgos cuando Claude cambie archivos.
- Proponer guardar mis correcciones como reglas.

## Lo que conviene saber

- **Permisos.** Como cualquier mod, Sancho funciona con tus permisos. Lee los diffs de lo que edita Claude y escribe en `CLAUDE.md` solo cuando pulsas guardar una regla. No hace llamadas de red propias.
- **Coste.** Los avisos de riesgo y las reglas usan Haiku: una llamada pequeña por cada turno con cambios y por cada mensaje que suena a corrección. El resto no gasta nada.
- **Importes.** Son estimaciones con los precios de la API de octubre de 2026 (`hooks/pricing.ts`). Si tienes una suscripción no pagas por token, así que tómalos como referencia de lo que consume cada cosa.
- **Revisar cambios** muestra lo que Claude edita con sus herramientas. Los cambios hechos con comandos de terminal (`sed`, `mv`…) no aparecen.
- **Idioma.** La interfaz está en español.

## Inspiración

Sancho reúne en un solo mod, y con menos pantalla, lo que hacen estos mods:
[Savvy Progress](https://github.com/JohnnyVizz/claude-kit/tree/main/plugins/savvy-progress),
[Cache Tax](https://github.com/karanb192/cache-tax),
[Filetree](https://github.com/data-goblin/claude-code-filetree),
[Replay Theater](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/replay-theater),
[Reflect](https://github.com/BayramAnnakov/claude-reflect) y You Should Know, que viene incluido en Claude Code.

## Desarrollo

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
