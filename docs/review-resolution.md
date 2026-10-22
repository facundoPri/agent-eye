# Resolución del review completo (commit 06b6c64)

Cada hallazgo se verificó contra el código antes de cambiarlo. Toda la evidencia es simulada:
binarios falsos de `ffmpeg`/`ffprobe`/`adb`, un túnel TCP falso, HTTP local y fuentes sintéticas
`lavfi` de ffmpeg. No se abrió ninguna cámara ni se ejecutaron `record`, `snapshot`, `preview`
o `setup` reales. Solo se corrieron `doctor`, `devices` y `status` contra el hardware.

Pruebas: 28 → 68 (`npm test`, corridas repetidas sin fallos; también en Node 20.20.2).
Las pruebas nuevas usan `test/helpers/fakes.js`: los binarios falsos son lo único que hay en
`PATH` y cada prueba lo comprueba antes de empezar; además verifica que no quede vivo ningún proceso falso.

## Hechos medidos con ffmpeg 9.0.2 y fuentes sintéticas (sin cámara)

| Cómo termina ffmpeg | Código | ¿ffprobe lo lee? |
|---|---|---|
| `q` por stdin (cómo para Mac) | 0 | sí |
| EOF de stdin con H.264 cortado a mitad (cómo para Android) | 0 | sí |
| SIGINT (Ctrl-C en la terminal también le llega a ffmpeg) | 255 | sí, con trailer escrito |
| SIGKILL | 137 / señal | no: `moov atom not found` |

Por eso una grabación vale solo con código 0 o 255 **y** si ffprobe lee frames de ella.

## Hallazgos

| ID | Veredicto | Arreglo | Prueba de regresión |
|---|---|---|---|
| 1 P1 ffmpeg queda vivo si falla la preparación de Android | Válido | `startSession` comprueba `adb` antes de lanzar ffmpeg, y cualquier fallo de arranque mata ffmpeg; `startAndroid` libera servidor, socket y `adb forward` en todas las rutas de error | `lifecycle`: falla `adb push` / falla `adb forward` → no queda ningún proceso |
| 2 P1 Ctrl-C/SIGTERM durante el arranque se pierde | Válido | La señal llega hasta `startSession`: corta la espera del túnel y, si ya estaba abortada al terminar el arranque, la sesión se detiene. El error es "Stopped before the camera started" (salida 1). En Mac, ffmpeg saliendo por el Ctrl-C de la terminal cuenta como cancelación. `stop` durante el arranque del worker usa el canal (ver 8) | `lifecycle`: abortar durante el arranque (Android y Mac), señal ya abortada; `cli`: Ctrl-C durante el arranque, `stop` durante el arranque del worker |
| 3 P1 MP4 incompleto reportado como correcto | Válido | `recordingProblem`: solo 0/255, sin SIGKILL, y ffprobe debe leer frames. Si no, salida 3 "Recording failed" y no se escribe `.json`; se borra el `.json` de una toma anterior al empezar. El worker entrega su resultado a `stop` por el canal | `lifecycle`: fallo al escribir el trailer, archivo ilegible con código 0, `.json` viejo; `cli`: `stop` devuelve salida 3; prueba unitaria de la tabla de códigos |
| 4 P1 previews concurrentes dejan sesiones sin dueño | Válido | Los cambios de preview se serializan; una petición superada por otra más nueva se descarta (409); al cerrar se espera a la que está abriendo y se libera | `server`: 3 starts concurrentes → 1 ffmpeg, gana el más nuevo; cerrar mientras abre → 0 procesos |
| 5 P1 dos `start` se pisan el estado | Válido | `start` reclama `recording.json` bajo `recording.lock` **antes** de lanzar el worker; escrituras atómicas (tmp+rename); cada actualización o borrado verifica el id de la grabación | `cli`: dos `start` simultáneos → uno graba y el otro recibe "already running"; luego `status`/`stop` |
| 6 P2 Android sin contrapresión | Válido | `socket.pipe(ff.stdin)` tras el primer bloque (el socket queda en pausa hasta entonces, sin perder bytes) | `lifecycle`: túnel inundando + ffmpeg detenido 1,5 s → salen menos de 64 MB del "teléfono"; `stop` en <5 s |
| 7 P2 timeout no cubre túnel silencioso | Válido | Cada intento de conexión respeta el plazo; la espera se interrumpe si sale el servidor, sale ffmpeg o se aborta. Si `start` agota sus 45 s, cancela el worker por el canal | `lifecycle`: túnel que conecta y no envía nada → error en <3 s y sin procesos (plazo de 0,7 s inyectado). La ruta de 45 s de `start` no tiene prueba (demasiado lenta) |
| 8 P2 `stop` puede interrumpir un proceso ajeno | Válido | Sin señales por pid. El worker escucha en 127.0.0.1 y responde a `stop`/`status` solo si la petición trae su id aleatorio. Un estado cuyo worker no responde se considera viejo y se limpia | `cli`: estado viejo con el pid de otro proceso vivo → `status` dice que no graba, `stop` falla y el otro proceso sigue vivo; después `start` funciona |
| 9 P2 cerrar la pestaña no libera la cámara | Válido (como fuga de recurso) | Se mantiene el contrato del README (Close / Ctrl-C) y además el servidor libera la cámara cuando ninguna pestaña mira el stream durante 10 s (`idleReleaseMs`). Si la pestaña vuelve a estar visible y su preview ya no existe, la página la reabre. El comando sigue esperando a Close/Ctrl-C (decisión: no cerrar el proceso por inactividad) | `server`: con un cliente mirando no se libera; al desconectarse se libera |
| 10 P2 el temporizador original sigue vivo | Válido | `clearTimeout` y retirada del listener en `finally`, en todas las ramas | `cli`: `record --duration 3600` + Ctrl-C termina en segundos (verificado por mutación: sin el arreglo la prueba se cuelga) |
| 11 P2 duración inválida graba indefinidamente | Válido | `--duration` debe ser un número > 0 (como máximo 2e6, el límite de `setTimeout`), salida 2, antes de abrir la cámara. Lo mismo para `--warmup` y `--port` | `cli`: `abc`, `30s`, `0`, `-5` y vacío → salida 2 sin lanzar ffmpeg |
| 12 P2 URL malformada tira el servidor | Válido (reproducido: `new URL('//%')` lanza `ERR_INVALID_URL`) | Se parsea dentro del bloque protegido → 400 | `server`: `GET //%` crudo → 400 y el servidor sigue respondiendo |
| 13 P2 la UI modifica recortes válidos | Válido; ampliado | El recorte guardado se conserva exacto (cualquier proporción o zoom) hasta tocar los controles de encuadre; la vista dibuja recortes no uniformes con su proporción real. El mismo defecto existía con fps fuera del menú (p. ej. 15 en Android, 25 en Mac) y con tamaños Mac sin lista de modos: también se conservan | `web`: el script real de la página en un VM: abrir y confirmar sin cambios devuelve el mismo perfil (3 recortes, fps 15, cuadro completo); tocar el zoom vuelve a un recorte proporcional |
| 14 P2 imagen de confirmación del perfil anterior | Válido | `save` exige que la preview actual tenga un frame y los mismos `source, width, height, fps, zoom, rotate`; si no, 409 "Confirm again once the new image shows" sin guardar nada. El recorte se aplica en el servidor desde el perfil guardado | `server`: rotación cambiada sin reiniciar → 409 y sin archivos; perfil coincidente → configuración e imagen guardadas con el recorte exacto |
| 15 P2 Windows no encuentra `ffmpeg.exe` | Parcial | `findBin` usa `PATHEXT` en Windows. El README declara que solo se probó con hosts macOS; Windows y Linux quedan "untested". No se agregó restricción `os` en package.json. `stop` ya no depende de señales POSIX | `util`: `ffmpeg.exe` en un `Path` estilo Windows; bit de ejecución en Unix |

## Notas

| ID | Veredicto | Arreglo | Prueba |
|---|---|---|---|
| N1 SOI partido entre bloques | Válido | Se conserva un `0xFF` final pendiente | `mjpeg`: `[ff]` + `[d8 … ff d9]` → 1 frame |
| N2 perfil `__proto__` | Válido (reproducido) | Se rechaza el nombre `__proto__`; las búsquedas usan `Object.hasOwn` (también `toString`, `constructor`…) | `config` |
| N3 sin ffprobe, `toFixed` lanza | Válido | `summaryText` tolera métricas ausentes; el resumen avisa "ffprobe is not installed: the file was not checked" | `cli`: `summaryText` sin métricas. La ruta completa sin ffprobe no se prueba: `findBin` siempre consulta también `/opt/homebrew/bin`, donde hay un ffprobe real |
| N4 falta `xdg-open` | Válido | Listener `error` en el proceso del navegador; la URL se imprime igual | Sin prueba (cambio de una línea) |
| N5 cobertura | Válido | +36 pruebas de ciclo de vida, HTTP, CLI como proceso, concurrencia, estado y la página | Mutaciones comprobadas: quitar el `clearTimeout`, la contrapresión, el kill en arranque fallido, la validación del archivo o el chequeo de señal abortada (Mac) hace fallar o colgar las pruebas; la versión original de `server.js`, `index.html`, `mjpeg.js` y `config.js` también las hace fallar |

## Segunda revisión (dos revisores sobre los arreglos)

Diez hallazgos nuevos, todos verificados y válidos; ninguno de severidad alta.

| Hallazgo | Arreglo | Prueba |
|---|---|---|
| Dos pestañas visibles se pelean por la cámara (el sondeo reabría la preview cada segundo) | La página ya no reabre sola: muestra "camera was released" y reabre con un clic o al volver a hacerse visible | `web`: otra pestaña toma la cámara → ningún `start` hasta el clic |
| El sondeo en vuelo podía duplicar un reinicio | Se compara contra el id capturado antes del `await` | Cubierto por la prueba anterior |
| La etiqueta del recorte ignoraba la rotación | Usa las dimensiones rotadas | Sin prueba (solo texto) |
| Clic para centrar ignoraba el recorte guardado | El clic usa el recorte que se ve | Sin prueba |
| ffprobe lento (>20 s) declaraba rota una grabación buena | Límite de 3 min; si se agota, el archivo queda "sin comprobar" con aviso, no fallido | `lifecycle`: `recordingProblem` con `unchecked` |
| Ctrl-C en `start` dejaba el worker separado grabando | `start` detiene al worker por el canal y sale con 1 | `cli`: Ctrl-C durante el arranque → sin worker ni cámara |
| Ctrl-C no respondía en pasos no cancelables (adb push colgado) | Un segundo Ctrl-C sale enseguida (130) | Sin prueba |
| `snapshot` sin cancelación | `takeSnapshot` recibe la señal y libera la sesión | Sin prueba propia |
| Un reclamo que no llegó a lanzar el worker bloqueaba `start` 60 s | Se libera si falla abrir el log o lanzar el proceso | `cli`: `worker.log` inutilizable → estado liberado |
| El helper de pruebas identificaba procesos por pid (reutilizable) y no vigilaba workers | Identifica por línea de comandos (directorio privado de la prueba) e incluye workers | Todas las pruebas de procesos |

También se agregó una prueba con Ctrl-C a todo el grupo de procesos (ffmpeg sale con 255 por su cuenta) → resumen correcto.

## Cambios de contrato (documentados en README.md y SKILL.md)

- `record`/`stop` salen con 3 "Recording failed" cuando el archivo no está terminado; `stop` puede
  salir con 1 cuando no hay resultado conocido o se detuvo antes de empezar.
- `start` rechaza una segunda grabación en el mismo proyecto aunque llegue a la vez.
- `status --json` devuelve `{ running, pid, out, ready, profile, startedAtMs }` y, si la última
  grabación terminó sin que nadie llamara a `stop`, `last` con su resultado.
- Confirm en el navegador necesita una preview viva con los ajustes confirmados.
- La preview se libera unos 10 s después de cerrar la pestaña.

## Pendiente de validación física

Nada de esto está probado con cámaras reales:

1. Android 240 fps con recorte o rotación: memoria del proceso, latencia y `measuredFps` con contrapresión; tiempo de `stop`.
2. Ctrl-C real en terminal durante `record` (ffmpeg recibe SIGINT y sale con 255) en Mac y Android: el resumen debe salir correcto.
3. `start`/`stop`/`status` reales en Mac y Android, incluido `stop` durante el arranque del teléfono (que el servidor scrcpy y `adb forward` desaparezcan).
4. Navegadores reales: liberación al cerrar la pestaña, pestaña en segundo plano (¿mantiene Chrome/Safari el stream MJPEG?) y reapertura al volver.
5. Dibujo de un recorte no proporcional en la página y el mensaje 409 al confirmar durante un reinicio.
6. Windows y Linux: sin probar.

## Veredicto

Los cinco P1 y los P2 tienen arreglo y prueba de regresión sin hardware. Antes de publicar en npm
conviene pasar la lista de validación física (al menos los puntos 1–4). Sin esa pasada, la
evidencia es solo de procesos simulados.
