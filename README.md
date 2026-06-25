# 🎤 Estudio Vocal — Herramienta de práctica para cantantes

Aplicación web (HTML + CSS + JS, sin dependencias) con cuatro modos de práctica.

## Modos

### 🔁 Playback diferido
El micrófono escucha y, tras el *delay* elegido (1–60 s), reproduce lo que cantaste.
Durante la reproducción la captura se pausa para que el audio reproducido **no se vuelva
a grabar** (evita el eco). Incluye osciloscopio, tiempo de reproducción y **detección de
la nota cantada** (McLeod Pitch Method, con filtros de claridad/RMS y suavizado por mediana
para no mostrar notas incorrectas).

### 🎹 Escalas
Patrones de calentamiento vocal: básica, quintas, arpegios, escala completa, terceras…
Configurable: nota raíz, octava inicial, octavas que sube, paso (semitono/tono), tempo,
timbre, subir/bajar y **pausa entre repeticiones** (por defecto la mitad de la duración
de la escala) para calentar/enfriar la voz.

### 🎯 Afinación
Piano clicable que reproduce cada nota de referencia y un **monitor de tono** que dibuja
en tiempo real lo que cantas sobre una rejilla de notas. La tecla cantada se resalta y un
indicador de *cents* muestra la afinación. Reutiliza el mismo detector de tono.

**Grabaciones de referencia:** con «⏺ Grabar afinación» guardas tu trazo de tono. Luego
«▶ Reproducir» lo **superpone en otro color** sobre el monitor en tiempo real (desplazándose
en bucle), para comprobar si tu línea (turquesa) coincide con la grabada. Puedes reproducir
varias a la vez (cada una con su color), oír un tono de referencia sintetizado («🔊 Oír
referencia») y borrarlas con 🗑. Las grabaciones se guardan en el navegador (`localStorage`),
así que persisten entre sesiones.

**Importar audio → tono:** «📂 Importar audio» analiza cualquier archivo de audio con el
mismo detector y crea una grabación de referencia a partir de su melodía. Útil para usar como
referencia la voz de una canción (idealmente una pista de voz aislada).

### 🎛️ Multipista
Mini estudio / looper: graba varias pistas con el micro (voz, guitarra, ritmo…), con
metrónomo y cuenta previa, sobregraba escuchando las demás, mueve los clips en la rejilla,
ajusta volumen/mute/solo, importa audio y exporta la mezcla a WAV.

## Cómo ejecutar

El micrófono necesita un **contexto seguro**: sirve la página desde `http://localhost`
(no abras el archivo como `file://`).

```bash
# con Node (servidor incluido, sin dependencias)
npm start                       # luego abre http://localhost:8000

# el puerto/host son configurables
PORT=3000 npm start
```

Otras alternativas:

```bash
python -m http.server 8000      # con Python
npx serve                       # con el paquete «serve»
```

En PhpStorm: usa «Open in Browser» (servidor interno en `http://localhost:63342/...`).

> 🎧 Se recomiendan auriculares en los modos con micrófono para evitar realimentación.
