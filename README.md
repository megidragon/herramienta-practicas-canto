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

### 🎛️ Multipista
Mini estudio / looper: graba varias pistas con el micro (voz, guitarra, ritmo…), con
metrónomo y cuenta previa, sobregraba escuchando las demás, mueve los clips en la rejilla,
ajusta volumen/mute/solo, importa audio y exporta la mezcla a WAV.

## Cómo ejecutar

El micrófono necesita un **contexto seguro**: sirve la página desde `http://localhost`
(no abras el archivo como `file://`).

```bash
# con Python
python -m http.server 8000      # luego abre http://localhost:8000

# o con Node
npx serve
```

En PhpStorm: usa «Open in Browser» (servidor interno en `http://localhost:63342/...`).

> 🎧 Se recomiendan auriculares en los modos con micrófono para evitar realimentación.
