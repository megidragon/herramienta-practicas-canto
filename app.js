'use strict';

/* =========================================================
   Navegación por pestañas
   ========================================================= */
const tabs = document.querySelectorAll('.tab');
const panels = {
  playback: document.getElementById('panel-playback'),
  scales: document.getElementById('panel-scales'),
  tuner: document.getElementById('panel-tuner'),
  multitrack: document.getElementById('panel-multitrack'),
};
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    Object.values(panels).forEach(p => { p.classList.remove('active'); p.hidden = true; });
    const target = panels[tab.dataset.tab];
    target.classList.add('active');
    target.hidden = false;
  });
});

/* =========================================================
   MODO 1 — Playback diferido (sin eco)
   ---------------------------------------------------------
   Ciclo continuo:
     1) GRABA durante "delay" segundos.
     2) REPRODUCE esa toma. Durante la reproducción la captura
        se pausa (isCapturing=false), de modo que el sonido que
        sale por los altavoces NO se vuelve a grabar -> sin eco.
     3) Vuelve a grabar. El flujo de micrófono nunca se cierra
        mientras la sesión está activa.
   ========================================================= */
const pb = {
  ctx: null, stream: null, source: null, processor: null, silentGain: null,
  analyser: null, byteData: null, floatData: null,
  scopeCanvas: null, scopeCtx: null,
  micToAnalyser: false,
  phase: 'idle',          // 'recording' | 'playing'
  capturing: false,
  chunks: [],
  recorded: 0,
  target: 0,
  startedAt: 0,
  playStart: 0,
  playDuration: 0,
  currentSource: null,
  rafId: null,
  lastPitch: 0,
  pitchHistory: [],
};

const delayInput = document.getElementById('delay');
const delayVal = document.getElementById('delay-val');
const pbToggle = document.getElementById('pb-toggle');
const pbLight = document.getElementById('pb-light');
const pbPhase = document.getElementById('pb-phase');
const pbDetail = document.getElementById('pb-detail');
const pbMeter = document.getElementById('pb-meter');
const pbProgress = document.getElementById('pb-progress');
const pbNote = document.getElementById('pb-note');
const pbSolf = document.getElementById('pb-solf');
const pbCents = document.getElementById('pb-cents');
const pbNeedle = document.getElementById('pb-needle');

delayInput.addEventListener('input', () => {
  delayVal.textContent = parseFloat(delayInput.value).toFixed(1) + ' s';
});

pbToggle.addEventListener('click', () => {
  if (pb.phase === 'idle') startPlayback();
  else stopPlayback();
});

async function startPlayback() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    pbDetail.textContent = 'Tu navegador no soporta acceso al micrófono.';
    return;
  }
  // Reutilizamos el stream si ya lo tenemos vivo -> no se vuelve a pedir permiso
  const hasLiveStream = pb.stream && pb.stream.getAudioTracks().some(t => t.readyState === 'live');
  if (!hasLiveStream) {
    try {
      pbDetail.textContent = 'Solicitando micrófono…';
      pb.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      pbDetail.textContent = 'No se pudo acceder al micrófono: ' + err.message;
      return;
    }
  }

  pb.ctx = new (window.AudioContext || window.webkitAudioContext)();
  pb.source = pb.ctx.createMediaStreamSource(pb.stream);

  // ScriptProcessor para capturar muestras crudas y poder "cortar" la captura.
  pb.processor = pb.ctx.createScriptProcessor(4096, 1, 1);
  pb.silentGain = pb.ctx.createGain();
  pb.silentGain.gain.value = 0; // no monitorizamos el micro en vivo (evita realimentación)

  // Analizador para el osciloscopio y la detección de nota
  pb.analyser = pb.ctx.createAnalyser();
  pb.analyser.fftSize = 2048;
  pb.analyser.smoothingTimeConstant = 0;
  pb.byteData = new Uint8Array(pb.analyser.fftSize);
  pb.floatData = new Float32Array(pb.analyser.fftSize);
  pb.micToAnalyser = false;

  // Preparar el canvas del osciloscopio con resolución nítida
  pb.scopeCanvas = document.getElementById('pb-scope');
  const dpr = window.devicePixelRatio || 1;
  pb.scopeCanvas.width = Math.max(300, Math.round(pb.scopeCanvas.clientWidth * dpr));
  pb.scopeCanvas.height = Math.round(120 * dpr);
  pb.scopeCtx = pb.scopeCanvas.getContext('2d');
  pb.pitchHistory = [];
  pb.lastPitch = 0;

  pb.processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    // Medidor de nivel (siempre, para feedback visual)
    if (pb.capturing) {
      let peak = 0;
      for (let i = 0; i < input.length; i++) {
        const a = Math.abs(input[i]);
        if (a > peak) peak = a;
      }
      pbMeter.style.height = Math.min(100, peak * 140) + '%';
    }
    if (!pb.capturing) return;
    pb.chunks.push(new Float32Array(input)); // copia: el buffer se reutiliza
    pb.recorded += input.length;
    if (pb.recorded >= pb.target) playbackTake();
  };

  pb.source.connect(pb.processor);
  pb.processor.connect(pb.silentGain);
  pb.silentGain.connect(pb.ctx.destination);

  pb.target = Math.floor(parseFloat(delayInput.value) * pb.ctx.sampleRate);

  pbToggle.textContent = '■ Detener';
  pbToggle.classList.remove('start');
  pbToggle.classList.add('stop');
  delayInput.disabled = true;

  beginRecording();
  visualLoop();
}

// Conecta/desconecta el micrófono del analizador (sin afectar a la captura)
function micAnalyser(on) {
  if (on && !pb.micToAnalyser) { pb.source.connect(pb.analyser); pb.micToAnalyser = true; }
  if (!on && pb.micToAnalyser) {
    try { pb.source.disconnect(pb.analyser); } catch (e) {}
    pb.micToAnalyser = false;
  }
}

function beginRecording() {
  pb.phase = 'recording';
  pb.chunks = [];
  pb.recorded = 0;
  pb.capturing = true;
  pb.startedAt = pb.ctx.currentTime;
  pb.pitchHistory = [];
  micAnalyser(true); // el osciloscopio/nota siguen al micro mientras cantas
  pbLight.className = 'status-light rec';
  pbPhase.textContent = '● Grabando…';
}

function playbackTake() {
  pb.capturing = false;              // <-- clave: no grabamos lo que se reproduce (sin eco)
  pb.phase = 'playing';
  pb.pitchHistory = [];
  pbMeter.style.height = '0%';
  pbLight.className = 'status-light play';
  pbPhase.textContent = '► Reproduciendo…';

  // Ensamblar las muestras grabadas en un AudioBuffer
  const buffer = pb.ctx.createBuffer(1, pb.recorded, pb.ctx.sampleRate);
  const channel = buffer.getChannelData(0);
  let offset = 0;
  for (const chunk of pb.chunks) {
    channel.set(chunk, offset);
    offset += chunk.length;
  }

  const src = pb.ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(pb.ctx.destination);
  // El osciloscopio/nota ahora siguen a lo que se reproduce
  micAnalyser(false);
  src.connect(pb.analyser);
  pb.currentSource = src;
  pb.playDuration = buffer.duration;
  pb.playStart = pb.ctx.currentTime;
  src.onended = () => {
    try { src.disconnect(); } catch (e) {}
    if (pb.phase !== 'playing') return; // se detuvo manualmente
    pb.currentSource = null;
    // Pequeña pausa de guarda para que muera la cola del altavoz antes de re-grabar
    setTimeout(() => { if (pb.phase === 'playing') beginRecording(); }, 150);
  };
  src.start();
}

/* Loop visual: osciloscopio + nota + tiempos. Corre toda la sesión. */
function visualLoop() {
  if (pb.phase === 'idle' || !pb.ctx) return;
  const now = pb.ctx.currentTime;

  drawScope();

  // Detección de tono limitada (~15 Hz) para no saturar la CPU
  let detection = null;
  if (now - pb.lastPitch > 0.065) {
    pb.lastPitch = now;
    pb.analyser.getFloatTimeDomainData(pb.floatData);
    detection = detectPitchMPM(pb.floatData, pb.ctx.sampleRate);
  }
  updateNoteDisplay(detection, now);

  // Tiempo y barra de progreso según la fase
  if (pb.phase === 'recording') {
    const total = parseFloat(delayInput.value);
    const elapsed = now - pb.startedAt;
    pbDetail.textContent = 'Canta — reproducción en ' + Math.max(0, total - elapsed).toFixed(1) + ' s';
    setProgress(elapsed / total);
  } else if (pb.phase === 'playing') {
    const total = pb.playDuration;
    const elapsed = Math.min(now - pb.playStart, total);
    pbDetail.textContent = 'Reproduciendo  ' + elapsed.toFixed(1) + ' / ' + total.toFixed(1) + ' s';
    setProgress(elapsed / total);
  }

  pb.rafId = requestAnimationFrame(visualLoop);
}

function setProgress(frac) {
  pbProgress.style.width = Math.max(0, Math.min(100, frac * 100)) + '%';
}

/* Dibuja la clásica línea de ondas (osciloscopio) */
function drawScope() {
  const c = pb.scopeCtx;
  const W = pb.scopeCanvas.width;
  const H = pb.scopeCanvas.height;
  pb.analyser.getByteTimeDomainData(pb.byteData);

  c.fillStyle = '#0c0e15';
  c.fillRect(0, 0, W, H);

  // línea central
  c.strokeStyle = '#222838';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(0, H / 2);
  c.lineTo(W, H / 2);
  c.stroke();

  // forma de onda
  c.lineWidth = Math.max(2, (window.devicePixelRatio || 1) * 1.5);
  c.strokeStyle = pb.phase === 'playing' ? '#2ecc71' : '#e74c3c';
  c.beginPath();
  const n = pb.byteData.length;
  const slice = W / n;
  let x = 0;
  for (let i = 0; i < n; i++) {
    const v = pb.byteData[i] / 128.0; // 0..2, centrado en 1
    const y = (v * H) / 2;
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    x += slice;
  }
  c.stroke();
}

/* Muestra la nota detectada con suavizado por mediana (evita notas erróneas) */
function updateNoteDisplay(detection, now) {
  if (detection) pb.pitchHistory.push({ midi: freqToMidiFloat(detection.freq), t: now });
  // descartar lecturas de más de 350 ms
  pb.pitchHistory = pb.pitchHistory.filter(h => h.t >= now - 0.35);

  if (pb.pitchHistory.length >= 3) {
    const sorted = pb.pitchHistory.map(h => h.midi).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const nearest = Math.round(median);
    const info = midiToInfo(nearest);
    const cents = Math.round((median - nearest) * 100);
    pbNote.textContent = info.label;
    pbSolf.textContent = info.solf;
    pbCents.textContent = (cents >= 0 ? '+' : '') + cents + '¢';
    const clamped = Math.max(-50, Math.min(50, cents));
    pbNeedle.style.left = (50 + clamped) + '%';
    pbNeedle.style.opacity = '1';
    pbNeedle.style.background = Math.abs(cents) <= 10 ? 'var(--good)'
      : Math.abs(cents) <= 25 ? '#f1c40f' : 'var(--danger)';
  } else {
    pbNote.textContent = '—';
    pbSolf.textContent = '';
    pbCents.textContent = '';
    pbNeedle.style.opacity = '0.25';
    pbNeedle.style.left = '50%';
  }
}

function freqToMidiFloat(f) { return 69 + 12 * Math.log2(f / 440); }

/* ----------------------------------------------------------
   McLeod Pitch Method (MPM) sobre la NSDF.
   Robusto frente a errores de octava; devuelve null si no hay
   suficiente confianza para no mostrar una nota incorrecta.
   ---------------------------------------------------------- */
function detectPitchMPM(buf, sampleRate) {
  const SIZE = buf.length;

  // 1) Energía: ignorar silencio/ruido bajo
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return null;

  const minFreq = 70, maxFreq = 1100;
  const maxTau = Math.min(SIZE - 1, Math.floor(sampleRate / minFreq));
  const minTau = Math.max(2, Math.floor(sampleRate / maxFreq));

  // 2) NSDF (función de diferencia cuadrática normalizada)
  const nsdf = new Float32Array(maxTau + 1);
  for (let tau = 0; tau <= maxTau; tau++) {
    let acf = 0, m = 0;
    for (let i = 0; i + tau < SIZE; i++) {
      const a = buf[i], b = buf[i + tau];
      acf += a * b;
      m += a * a + b * b;
    }
    nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
  }

  // 3) Selección de máximos clave (uno por lóbulo positivo)
  const maxPositions = [];
  let pos = 1;
  while (pos < maxTau && nsdf[pos] > 0) pos++;     // saltar lóbulo inicial (tau≈0)
  while (pos < maxTau && nsdf[pos] <= 0) pos++;     // hasta el siguiente lóbulo positivo
  let curMax = 0;
  while (pos < maxTau) {
    if (nsdf[pos] > nsdf[pos - 1] && nsdf[pos] >= nsdf[pos + 1]) {
      if (curMax === 0 || nsdf[pos] > nsdf[curMax]) curMax = pos;
    }
    pos++;
    if (pos < maxTau && nsdf[pos] <= 0) {
      if (curMax > 0) { maxPositions.push(curMax); curMax = 0; }
      while (pos < maxTau && nsdf[pos] <= 0) pos++;
    }
  }
  if (curMax > 0) maxPositions.push(curMax);
  if (maxPositions.length === 0) return null;

  // 4) Umbral relativo al máximo global -> primer pico que lo supere
  let highest = 0;
  for (const p of maxPositions) if (nsdf[p] > highest) highest = nsdf[p];
  if (highest < 0.9) return null; // poca periodicidad => no fiable

  const threshold = 0.9 * highest;
  let chosen = maxPositions[0];
  for (const p of maxPositions) { if (nsdf[p] >= threshold) { chosen = p; break; } }

  // 5) Interpolación parabólica para precisión sub-muestra
  let tauEst = chosen;
  if (chosen > 0 && chosen < maxTau) {
    const s0 = nsdf[chosen - 1], s1 = nsdf[chosen], s2 = nsdf[chosen + 1];
    const denom = s0 - 2 * s1 + s2;
    if (denom !== 0) {
      const delta = (0.5 * (s0 - s2)) / denom;
      if (delta > -1 && delta < 1) tauEst = chosen + delta;
    }
  }

  if (tauEst < minTau) return null;
  const freq = sampleRate / tauEst;
  if (freq < minFreq || freq > maxFreq) return null;
  return { freq: freq, clarity: nsdf[chosen] };
}

function stopPlayback() {
  pb.phase = 'idle';
  pb.capturing = false;
  cancelAnimationFrame(pb.rafId);
  if (pb.currentSource) { try { pb.currentSource.stop(); } catch (e) {} pb.currentSource = null; }
  pb.micToAnalyser = false;
  if (pb.processor) pb.processor.disconnect();
  if (pb.source) pb.source.disconnect();
  if (pb.analyser) pb.analyser.disconnect();
  if (pb.ctx) pb.ctx.close();
  pb.ctx = pb.source = pb.processor = pb.analyser = null;
  // Mantenemos pb.stream vivo a propósito: así reiniciar no vuelve a pedir permiso.

  if (pb.scopeCtx) pb.scopeCtx.clearRect(0, 0, pb.scopeCanvas.width, pb.scopeCanvas.height);
  pb.pitchHistory = [];
  pbLight.className = 'status-light';
  pbPhase.textContent = 'Detenido';
  pbDetail.textContent = 'Pulsa «Iniciar» y permite el micrófono.';
  pbMeter.style.height = '0%';
  setProgress(0);
  pbNote.textContent = '—';
  pbSolf.textContent = '';
  pbCents.textContent = '';
  pbNeedle.style.opacity = '0.25';
  pbNeedle.style.left = '50%';
  pbToggle.textContent = '▶ Iniciar';
  pbToggle.classList.add('start');
  pbToggle.classList.remove('stop');
  delayInput.disabled = false;
}

/* =========================================================
   MODO 2 — Escalas
   ========================================================= */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SOLFEGE = {
  'C': 'Do', 'C#': 'Do#', 'D': 'Re', 'D#': 'Re#', 'E': 'Mi', 'F': 'Fa',
  'F#': 'Fa#', 'G': 'Sol', 'G#': 'Sol#', 'A': 'La', 'A#': 'La#', 'B': 'Si',
};

// 6 patrones de escala. Cada uno es una secuencia de grados de la escala mayor.
const SCALES = {
  basic:     { name: 'Básica (1-2-3-2-1)',                  degrees: [1, 2, 3, 2, 1] },
  fifths:    { name: 'Quintas (1-2-3-4-5-4-3-2-1)',         degrees: [1, 2, 3, 4, 5, 4, 3, 2, 1] },
  triad:     { name: 'Arpegio / tríada (1-3-5-3-1)',        degrees: [1, 3, 5, 3, 1] },
  full:      { name: 'Escala completa (1…8…1)',             degrees: [1, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 1] },
  octaveArp: { name: 'Arpegio de octava (1-3-5-8-5-3-1)',   degrees: [1, 3, 5, 8, 5, 3, 1] },
  thirds:    { name: 'Terceras (1-3-2-4-3-5-4-2-1)',        degrees: [1, 3, 2, 4, 3, 5, 4, 2, 1] },
};

// Llenar el <select> de tipos de escala
const scaleTypeSel = document.getElementById('scale-type');
for (const [key, val] of Object.entries(SCALES)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = val.name;
  scaleTypeSel.appendChild(opt);
}

// Semitonos de la escala mayor para los grados 1..7 (se extiende por octavas)
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
function degreeToSemitone(d) {
  const idx = d - 1;
  const oct = Math.floor(idx / 7);
  const within = ((idx % 7) + 7) % 7;
  return oct * 12 + MAJOR_STEPS[within];
}
function noteToMidi(name, octave) { return (octave + 1) * 12 + NOTE_NAMES.indexOf(name); }
function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
function midiToInfo(m) {
  const n = NOTE_NAMES[((m % 12) + 12) % 12];
  const oct = Math.floor(m / 12) - 1;
  return { label: n + oct, solf: SOLFEGE[n] };
}

const sc = {
  ctx: null, master: null, playing: false,
  seq: [], noteIndex: 0, nextTime: 0, startTime: 0, noteDur: 0,
  schedTimer: null, rafId: null,
};

const bpmInput = document.getElementById('bpm');
const bpmVal = document.getElementById('bpm-val');
const scaleToggle = document.getElementById('scale-toggle');
const noteName = document.getElementById('note-name');
const noteSub = document.getElementById('note-sub');
const scaleProgress = document.getElementById('scale-progress');
const repInfo = document.getElementById('rep-info');

bpmInput.addEventListener('input', () => { bpmVal.textContent = bpmInput.value; });

scaleToggle.addEventListener('click', () => {
  if (sc.playing) stopScale();
  else startScale();
});

function buildSequence() {
  const type = scaleTypeSel.value;
  const root = document.getElementById('root').value;
  const startOctave = parseInt(document.getElementById('start-octave').value, 10);
  const octaves = parseInt(document.getElementById('octaves').value, 10);
  const stepSemis = parseInt(document.getElementById('step').value, 10);
  const upDown = document.getElementById('updown').checked;
  const pauseFactor = parseFloat(document.getElementById('rep-pause').value) || 0;

  const pattern = SCALES[type].degrees;
  const span = octaves * 12;

  // Transposiciones del patrón: 0, paso, 2*paso, ... hasta cubrir las octavas pedidas
  const ascRoots = [];
  for (let t = 0; t <= span; t += stepSemis) ascRoots.push(t);
  let roots = ascRoots.slice();
  if (upDown) {
    const desc = ascRoots.slice(0, -1).reverse(); // sin repetir la cima
    roots = ascRoots.concat(desc);
  }

  const baseMidi = noteToMidi(root, startOctave);
  const patLen = pattern.length;
  // La escala dura patLen beats. La pausa dura "factor" veces esa duración
  // (por defecto 0.5 = la mitad). Cada repetición ocupa notas + pausa.
  const repBeats = patLen * (1 + pauseFactor);
  const seq = [];
  roots.forEach((rt, ri) => {
    const base = ri * repBeats;
    pattern.forEach((deg, j) => {
      const midi = baseMidi + rt + degreeToSemitone(deg);
      const info = midiToInfo(midi);
      seq.push({
        freq: midiToFreq(midi), degree: deg, label: info.label, solf: info.solf,
        rep: ri, beat: base + j,
      });
    });
  });
  const totalBeats = seq.length ? seq[seq.length - 1].beat + 1 : 0;
  return { seq, totalReps: roots.length, totalBeats };
}

function scheduleNote(freq, startT, dur, wave) {
  const osc = sc.ctx.createOscillator();
  const g = sc.ctx.createGain();
  osc.type = wave;
  osc.frequency.value = freq;
  const attack = 0.012, release = 0.07, level = 0.28;
  g.gain.setValueAtTime(0, startT);
  g.gain.linearRampToValueAtTime(level, startT + attack);
  g.gain.setValueAtTime(level, startT + Math.max(attack, dur - release));
  g.gain.linearRampToValueAtTime(0.0001, startT + dur);
  osc.connect(g);
  g.connect(sc.master);
  osc.start(startT);
  osc.stop(startT + dur + 0.03);
}

function startScale() {
  const built = buildSequence();
  sc.seq = built.seq;
  sc.totalReps = built.totalReps;
  sc.totalBeats = built.totalBeats;
  if (sc.seq.length === 0) return;

  sc.ctx = new (window.AudioContext || window.webkitAudioContext)();
  sc.master = sc.ctx.createGain();
  sc.master.gain.value = 0.9;
  sc.master.connect(sc.ctx.destination);

  const bpm = parseInt(bpmInput.value, 10);
  sc.noteDur = 60 / bpm;
  sc.noteIndex = 0;
  sc.playing = true;
  sc.startTime = sc.ctx.currentTime + 0.12;

  scaleToggle.textContent = '■ Detener';
  scaleToggle.classList.remove('start');
  scaleToggle.classList.add('stop');
  setScaleControlsDisabled(true);

  scheduler();
  uiLoop();
}

function scheduler() {
  const wave = document.getElementById('wave').value;
  // Programar por adelantado las notas que entran en los próximos 0.2 s
  // (cada nota suena en su "ranura": las ranuras de pausa quedan en silencio)
  while (sc.noteIndex < sc.seq.length) {
    const t = sc.startTime + sc.seq[sc.noteIndex].beat * sc.noteDur;
    if (t >= sc.ctx.currentTime + 0.2) break;
    scheduleNote(sc.seq[sc.noteIndex].freq, t, sc.noteDur * 0.9, wave);
    sc.noteIndex++;
  }
  if (sc.noteIndex >= sc.seq.length) {
    const endT = sc.startTime + sc.totalBeats * sc.noteDur;
    if (sc.ctx.currentTime >= endT) { stopScale(); return; }
  }
  sc.schedTimer = setTimeout(scheduler, 40);
}

function uiLoop() {
  if (!sc.playing) return;
  const elapsed = sc.ctx.currentTime - sc.startTime;
  const beat = elapsed / sc.noteDur;
  let note = null;
  for (const n of sc.seq) { if (beat >= n.beat && beat < n.beat + 1) { note = n; break; } }
  if (note) {
    noteName.textContent = note.label;
    noteSub.textContent = note.solf + ' · grado ' + note.degree;
    repInfo.textContent = 'Repetición ' + (note.rep + 1) + ' / ' + sc.totalReps;
  } else if (beat >= 0 && beat < sc.totalBeats) {
    noteName.textContent = '⏸';
    noteSub.textContent = 'Descanso';
  }
  const pct = Math.min(100, (elapsed / (sc.totalBeats * sc.noteDur)) * 100);
  scaleProgress.style.width = Math.max(0, pct) + '%';
  sc.rafId = requestAnimationFrame(uiLoop);
}

function stopScale() {
  sc.playing = false;
  clearTimeout(sc.schedTimer);
  cancelAnimationFrame(sc.rafId);
  if (sc.ctx) {
    const ctx = sc.ctx;
    setTimeout(() => { try { ctx.close(); } catch (e) {} }, 120);
    sc.ctx = null;
  }
  noteName.textContent = '—';
  noteSub.textContent = 'Listo para empezar';
  repInfo.textContent = '';
  scaleProgress.style.width = '0%';
  scaleToggle.textContent = '▶ Reproducir escala';
  scaleToggle.classList.add('start');
  scaleToggle.classList.remove('stop');
  setScaleControlsDisabled(false);
}

function setScaleControlsDisabled(disabled) {
  ['scale-type', 'root', 'start-octave', 'octaves', 'step', 'bpm', 'wave', 'updown', 'rep-pause']
    .forEach(id => { document.getElementById(id).disabled = disabled; });
}

// Liberar el micrófono al cerrar/recargar la pestaña
window.addEventListener('beforeunload', () => {
  if (pb.stream) pb.stream.getTracks().forEach(t => t.stop());
});

/* =========================================================
   MODO 3 — Multipista (mini estudio / looper)
   ========================================================= */
(function () {
  const HEAD_W = 190;   // ancho de la columna de controles
  const ROW_H = 84;     // alto de cada pista
  const PALETTE = ['#6c5ce7', '#00cec9', '#e17055', '#fdcb6e', '#0984e3', '#e84393', '#00b894', '#a29bfe'];

  const mt = {
    ctx: null, stream: null, master: null,
    tracks: [], idSeq: 1,
    playing: false, recording: false,
    playStartCtx: 0, playStartHead: 0, playhead: 0,
    captureStartCtx: 0, recStartHead: 0,
    sources: [], recChunks: [], recProcessor: null, recSource: null, recSilent: null,
    pxPerSec: 80, bpm: 100, beatsPerBar: 4,
    loop: false, latencyMs: 0, rafId: null,
  };

  const $ = (id) => document.getElementById(id);
  const recBtn = $('mt-rec'), playBtn = $('mt-play'), stopBtn = $('mt-stop'), toStartBtn = $('mt-tostart');
  const timeEl = $('mt-time'), bpmInput = $('mt-bpm');
  const metroChk = $('mt-metro'), countinChk = $('mt-countin'), loopChk = $('mt-loop'),
        monitorChk = $('mt-monitor'), snapChk = $('mt-snap');
  const masterInput = $('mt-master'), latencyInput = $('mt-latency'), latencyVal = $('mt-latency-val');
  const zoomIn = $('mt-zoom-in'), zoomOut = $('mt-zoom-out');
  const importBtn = $('mt-import'), fileInput = $('mt-file'), exportBtn = $('mt-export'), clearBtn = $('mt-clear');
  const rulerEl = $('mt-ruler'), tracksEl = $('mt-tracks'), playheadEl = $('mt-playhead'),
        contentEl = $('mt-content'), emptyEl = $('mt-empty');

  /* ---------- contexto y micrófono ---------- */
  function ensureCtx() {
    if (!mt.ctx) {
      mt.ctx = new (window.AudioContext || window.webkitAudioContext)();
      mt.master = mt.ctx.createGain();
      mt.master.gain.value = parseFloat(masterInput.value);
      mt.master.connect(mt.ctx.destination);
    }
    if (mt.ctx.state === 'suspended') mt.ctx.resume();
    return mt.ctx;
  }
  async function ensureMic() {
    const live = mt.stream && mt.stream.getAudioTracks().some(t => t.readyState === 'live');
    if (live) return mt.stream;
    mt.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    return mt.stream;
  }

  /* ---------- utilidades de tiempo/canción ---------- */
  function computeSongEnd() {
    let end = 0;
    for (const t of mt.tracks) end = Math.max(end, t.startTime + t.buffer.duration);
    return end;
  }
  function fmtTime(s) {
    s = Math.max(0, s);
    const m = Math.floor(s / 60);
    const sec = s - m * 60;
    const ss = sec.toFixed(1);
    return m + ':' + (sec < 10 ? '0' + ss : ss);
  }

  /* ---------- mezcla en vivo (volumen/mute/solo) ---------- */
  function applyGains() {
    const soloActive = mt.tracks.some(t => t.solo);
    for (const t of mt.tracks) {
      const audible = !t.muted && (!soloActive || t.solo);
      t.gainNode.gain.value = audible ? t.gain : 0;
    }
  }

  /* ---------- metrónomo ---------- */
  function scheduleClick(time, accent) {
    const o = mt.ctx.createOscillator();
    const g = mt.ctx.createGain();
    o.frequency.value = accent ? 1600 : 950;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(accent ? 0.55 : 0.32, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    o.connect(g);
    g.connect(mt.ctx.destination); // directo a la salida (independiente del master)
    o.start(time);
    o.stop(time + 0.06);
  }
  function scheduleClicks(fromHead, when, durationSec) {
    const beatDur = 60 / mt.bpm;
    const firstBeat = Math.ceil(fromHead / beatDur - 1e-6);
    for (let b = firstBeat; b * beatDur < fromHead + durationSec; b++) {
      const t = when + (b * beatDur - fromHead);
      if (t >= mt.ctx.currentTime) scheduleClick(t, b % mt.beatsPerBar === 0);
    }
  }

  /* ---------- programación de pistas ---------- */
  function scheduleTracks(fromHead, when) {
    applyGains();
    for (const t of mt.tracks) {
      const clipStart = t.startTime, clipEnd = t.startTime + t.buffer.duration;
      if (clipEnd <= fromHead) continue;
      const src = mt.ctx.createBufferSource();
      src.buffer = t.buffer;
      src.connect(t.gainNode);
      let startAt, offset;
      if (clipStart >= fromHead) { startAt = when + (clipStart - fromHead); offset = 0; }
      else { startAt = when; offset = fromHead - clipStart; }
      src.start(startAt, offset);
      mt.sources.push(src);
    }
  }
  function stopSources() {
    for (const s of mt.sources) { try { s.stop(); } catch (e) {} }
    mt.sources = [];
  }

  /* ---------- grabación ---------- */
  async function startRecording() {
    ensureCtx();
    if (mt.playing) pauseTransport();
    let stream;
    try { stream = await ensureMic(); }
    catch (e) { alert('No se pudo acceder al micrófono: ' + e.message); return; }

    mt.recording = true;
    recBtn.textContent = '● Detener';
    recBtn.classList.add('armed');
    playBtn.disabled = true;

    mt.recStartHead = mt.playhead;
    mt.recChunks = [];
    const beatDur = 60 / mt.bpm;
    const t0 = mt.ctx.currentTime + 0.15;
    const countBeats = countinChk.checked ? mt.beatsPerBar : 0;
    for (let i = 0; i < countBeats; i++) scheduleClick(t0 + i * beatDur, i === 0);
    const captureStart = t0 + countBeats * beatDur;
    mt.captureStartCtx = captureStart;

    mt.recSource = mt.ctx.createMediaStreamSource(stream);
    mt.recProcessor = mt.ctx.createScriptProcessor(4096, 1, 1);
    mt.recSilent = mt.ctx.createGain();
    mt.recSilent.gain.value = 0;
    mt.recProcessor.onaudioprocess = (e) => {
      if (!mt.recording) return;
      if (mt.ctx.currentTime < mt.captureStartCtx) return; // esperar al fin de la cuenta previa
      mt.recChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    mt.recSource.connect(mt.recProcessor);
    mt.recProcessor.connect(mt.recSilent);
    mt.recSilent.connect(mt.ctx.destination);

    if (monitorChk.checked && mt.tracks.length) scheduleTracks(mt.recStartHead, captureStart);
    if (metroChk.checked) scheduleClicks(mt.recStartHead, captureStart, 600);

    transportLoop();
  }

  function stopRecording() {
    mt.recording = false;
    recBtn.textContent = '● Grabar pista';
    recBtn.classList.remove('armed');
    playBtn.disabled = false;
    stopSources();
    if (mt.recProcessor) { mt.recProcessor.onaudioprocess = null; mt.recProcessor.disconnect(); mt.recProcessor = null; }
    if (mt.recSource) { mt.recSource.disconnect(); mt.recSource = null; }
    if (mt.recSilent) { mt.recSilent.disconnect(); mt.recSilent = null; }
    cancelAnimationFrame(mt.rafId);

    const total = mt.recChunks.reduce((a, c) => a + c.length, 0);
    if (total < mt.ctx.sampleRate * 0.1) { mt.recChunks = []; return; } // demasiado corto

    const buf = mt.ctx.createBuffer(1, total, mt.ctx.sampleRate);
    const ch = buf.getChannelData(0);
    let off = 0;
    for (const c of mt.recChunks) { ch.set(c, off); off += c.length; }
    mt.recChunks = [];

    const start = Math.max(0, mt.recStartHead - mt.latencyMs / 1000);
    addTrack(buf, 'Pista ' + (mt.tracks.length + 1), start);
    mt.playhead = mt.recStartHead;
    updatePlayheadUI();
  }

  /* ---------- transporte ---------- */
  function playTransport() {
    ensureCtx();
    if (!mt.tracks.length || mt.playing) return;
    if (mt.playhead >= computeSongEnd()) mt.playhead = 0;
    mt.playing = true;
    playBtn.textContent = '❚❚ Pausa';
    mt.playStartHead = mt.playhead;
    mt.playStartCtx = mt.ctx.currentTime + 0.08;
    scheduleTracks(mt.playStartHead, mt.playStartCtx);
    if (metroChk.checked) scheduleClicks(mt.playStartHead, mt.playStartCtx, computeSongEnd() - mt.playStartHead + 0.01);
    transportLoop();
  }
  function pauseTransport() {
    if (!mt.playing) return;
    mt.playing = false;
    playBtn.textContent = '▶ Reproducir';
    stopSources();
    cancelAnimationFrame(mt.rafId);
  }
  function setPlayhead(sec) {
    sec = Math.max(0, sec);
    mt.playhead = sec;
    if (mt.playing && mt.ctx) {
      stopSources();
      mt.playStartHead = sec;
      mt.playStartCtx = mt.ctx.currentTime + 0.05;
      scheduleTracks(sec, mt.playStartCtx);
      if (metroChk.checked) scheduleClicks(sec, mt.playStartCtx, computeSongEnd() - sec + 0.01);
    }
    updatePlayheadUI();
  }
  function transportLoop() {
    if (!mt.playing && !mt.recording) return;
    const now = mt.ctx.currentTime;
    if (mt.recording) {
      mt.playhead = mt.recStartHead + Math.max(0, now - mt.captureStartCtx);
    } else {
      mt.playhead = mt.playStartHead + (now - mt.playStartCtx);
      const end = computeSongEnd();
      if (mt.playhead >= end) {
        if (mt.loop && end > 0) { setPlayhead(0); }
        else { pauseTransport(); mt.playhead = end; updatePlayheadUI(); return; }
      }
    }
    updatePlayheadUI();
    mt.rafId = requestAnimationFrame(transportLoop);
  }
  function updatePlayheadUI() {
    playheadEl.style.left = (HEAD_W + Math.max(0, mt.playhead) * mt.pxPerSec) + 'px';
    timeEl.textContent = fmtTime(mt.playhead);
  }

  /* ---------- pistas (modelo + DOM) ---------- */
  function addTrack(buffer, name, startTime) {
    ensureCtx();
    const gainNode = mt.ctx.createGain();
    gainNode.connect(mt.master);
    const t = {
      id: mt.idSeq++, name: name, buffer: buffer, startTime: startTime || 0,
      gain: 1, muted: false, solo: false,
      color: PALETTE[mt.tracks.length % PALETTE.length], gainNode: gainNode,
    };
    mt.tracks.push(t);
    buildTrackRow(t);
    applyGains();
    relayout();
    updateEmpty();
  }

  function buildTrackRow(t) {
    const row = document.createElement('div');
    row.className = 'mt-track';
    row.dataset.id = t.id;
    row.style.height = ROW_H + 'px';
    row.innerHTML =
      '<div class="mt-head" style="border-left:4px solid ' + t.color + '">' +
        '<input class="mt-name" value="' + escapeHtml(t.name) + '">' +
        '<div class="mt-ctrls">' +
          '<button class="mt-mini act-mute" title="Silenciar">M</button>' +
          '<button class="mt-mini act-solo" title="Solo">S</button>' +
          '<button class="mt-mini act-up" title="Subir">▲</button>' +
          '<button class="mt-mini act-down" title="Bajar">▼</button>' +
          '<button class="mt-mini act-dl" title="Descargar WAV">⬇</button>' +
          '<button class="mt-mini danger act-del" title="Eliminar">🗑</button>' +
        '</div>' +
        '<input type="range" class="mt-vol" min="0" max="1.5" step="0.01" value="' + t.gain + '">' +
      '</div>' +
      '<div class="mt-lane"><div class="mt-clip"><canvas class="mt-wave"></canvas></div></div>';

    tracksEl.appendChild(row);
    t.row = row;
    t.laneEl = row.querySelector('.mt-lane');
    t.clipEl = row.querySelector('.mt-clip');
    t.canvas = row.querySelector('.mt-wave');

    row.querySelector('.mt-name').addEventListener('change', (e) => { t.name = e.target.value; });
    const mBtn = row.querySelector('.act-mute');
    mBtn.addEventListener('click', () => { t.muted = !t.muted; mBtn.classList.toggle('on', t.muted); applyGains(); });
    const sBtn = row.querySelector('.act-solo');
    sBtn.addEventListener('click', () => { t.solo = !t.solo; sBtn.classList.toggle('on', t.solo); applyGains(); });
    row.querySelector('.act-up').addEventListener('click', () => moveTrack(t, -1));
    row.querySelector('.act-down').addEventListener('click', () => moveTrack(t, 1));
    row.querySelector('.act-dl').addEventListener('click', () => downloadBlob(audioBufferToWav(t.buffer), (t.name || 'pista') + '.wav'));
    row.querySelector('.act-del').addEventListener('click', () => deleteTrack(t));
    row.querySelector('.mt-vol').addEventListener('input', (e) => { t.gain = parseFloat(e.target.value); applyGains(); });

    // mover el clip arrastrando
    t.clipEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX, orig = t.startTime;
      t.clipEl.classList.add('dragging');
      const move = (ev) => {
        let ns = Math.max(0, orig + (ev.clientX - startX) / mt.pxPerSec);
        if (snapChk.checked) { const beat = 60 / mt.bpm; ns = Math.round(ns / beat) * beat; }
        t.startTime = ns;
        t.clipEl.style.left = (ns * mt.pxPerSec) + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        t.clipEl.classList.remove('dragging');
        relayout();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    // clic en zona vacía de la pista -> mover cabezal
    t.laneEl.addEventListener('mousedown', (e) => {
      if (e.target !== t.laneEl) return;
      const rect = t.laneEl.getBoundingClientRect();
      setPlayhead((e.clientX - rect.left) / mt.pxPerSec);
    });
  }

  function moveTrack(t, dir) {
    const i = mt.tracks.indexOf(t), j = i + dir;
    if (j < 0 || j >= mt.tracks.length) return;
    mt.tracks.splice(i, 1);
    mt.tracks.splice(j, 0, t);
    mt.tracks.forEach(tr => tracksEl.appendChild(tr.row));
    relayout();
  }
  function deleteTrack(t) {
    if (mt.recording) return;
    const i = mt.tracks.indexOf(t);
    if (i < 0) return;
    try { t.gainNode.disconnect(); } catch (e) {}
    mt.tracks.splice(i, 1);
    t.row.remove();
    applyGains();
    relayout();
    updateEmpty();
  }
  function updateEmpty() { emptyEl.style.display = mt.tracks.length ? 'none' : 'block'; }

  /* ---------- layout / rejilla / formas de onda ---------- */
  function relayout() {
    const songEnd = computeSongEnd();
    const beatDur = 60 / mt.bpm, barDur = beatDur * mt.beatsPerBar;
    const minSeconds = Math.max(songEnd + 4, barDur * 8, 8);
    const totalBars = Math.ceil(minSeconds / barDur);
    const timelineSeconds = totalBars * barDur;
    const timelineWidth = timelineSeconds * mt.pxPerSec;

    contentEl.style.width = (HEAD_W + timelineWidth) + 'px';
    rulerEl.style.width = timelineWidth + 'px';

    rulerEl.innerHTML = '';
    for (let bar = 0; bar <= totalBars; bar++) {
      const x = bar * barDur * mt.pxPerSec;
      const tick = document.createElement('div');
      tick.className = 'mt-bar';
      tick.style.left = x + 'px';
      tick.innerHTML = '<span>' + (bar + 1) + '</span>';
      rulerEl.appendChild(tick);
      for (let bt = 1; bt < mt.beatsPerBar; bt++) {
        const bx = (bar * barDur + bt * beatDur) * mt.pxPerSec;
        if (bx > timelineWidth) break;
        const sub = document.createElement('div');
        sub.className = 'mt-beat';
        sub.style.left = bx + 'px';
        rulerEl.appendChild(sub);
      }
    }

    const barPx = barDur * mt.pxPerSec, beatPx = beatDur * mt.pxPerSec;
    for (const t of mt.tracks) {
      t.laneEl.style.width = timelineWidth + 'px';
      t.laneEl.style.backgroundImage =
        'repeating-linear-gradient(to right, rgba(255,255,255,0.09) 0 1px, transparent 1px ' + barPx + 'px),' +
        'repeating-linear-gradient(to right, rgba(255,255,255,0.035) 0 1px, transparent 1px ' + beatPx + 'px)';
      t.clipEl.style.left = (t.startTime * mt.pxPerSec) + 'px';
      drawClip(t);
    }
    updatePlayheadUI();
  }

  function drawClip(t) {
    const w = Math.max(2, Math.round(t.buffer.duration * mt.pxPerSec));
    const h = ROW_H - 8;
    const dpr = window.devicePixelRatio || 1;
    const cv = t.canvas;
    const cssW = Math.min(8000, w);
    t.clipEl.style.width = w + 'px';
    cv.width = cssW * dpr;
    cv.height = h * dpr;
    cv.style.width = cssW + 'px';
    cv.style.height = h + 'px';
    const c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    const data = t.buffer.getChannelData(0);
    const cw = cv.width, mid = cv.height / 2;
    const step = Math.max(1, Math.floor(data.length / cw));
    c.fillStyle = hexToRgba(t.color, 0.85);
    for (let x = 0; x < cw; x++) {
      let min = 1, max = -1;
      const s = x * step;
      for (let i = 0; i < step && s + i < data.length; i++) {
        const v = data[s + i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const y1 = mid + min * mid, y2 = mid + max * mid;
      c.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
  }

  /* ---------- exportación WAV ---------- */
  function audioBufferToWav(buffer) {
    const numCh = buffer.numberOfChannels, sr = buffer.sampleRate, frames = buffer.length;
    const blockAlign = numCh * 2, dataSize = frames * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize), view = new DataView(ab);
    let p = 0;
    const wStr = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i)); };
    const w32 = (v) => { view.setUint32(p, v, true); p += 4; };
    const w16 = (v) => { view.setUint16(p, v, true); p += 2; };
    wStr('RIFF'); w32(36 + dataSize); wStr('WAVE');
    wStr('fmt '); w32(16); w16(1); w16(numCh); w32(sr); w32(sr * blockAlign); w16(blockAlign); w16(16);
    wStr('data'); w32(dataSize);
    const chans = [];
    for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = Math.max(-1, Math.min(1, chans[c][i]));
        view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7FFF, true); p += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function exportMix() {
    const songEnd = computeSongEnd();
    if (songEnd <= 0) { alert('No hay nada que exportar.'); return; }
    const sr = mt.ctx.sampleRate;
    const off = new OfflineAudioContext(2, Math.ceil(songEnd * sr) + sr, sr);
    const master = off.createGain();
    master.gain.value = mt.master ? mt.master.gain.value : 1;
    master.connect(off.destination);
    const soloActive = mt.tracks.some(t => t.solo);
    for (const t of mt.tracks) {
      if (t.muted || (soloActive && !t.solo)) continue;
      const src = off.createBufferSource();
      src.buffer = t.buffer;
      const g = off.createGain();
      g.gain.value = t.gain;
      src.connect(g); g.connect(master);
      src.start(t.startTime);
    }
    const rendered = await off.startRendering();
    downloadBlob(audioBufferToWav(rendered), 'mezcla.wav');
  }

  /* ---------- helpers ---------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ---------- conexión de la interfaz ---------- */
  recBtn.addEventListener('click', () => { if (mt.recording) stopRecording(); else startRecording(); });
  playBtn.addEventListener('click', () => { if (mt.recording) return; if (mt.playing) pauseTransport(); else playTransport(); });
  stopBtn.addEventListener('click', () => { if (mt.recording) { stopRecording(); return; } pauseTransport(); setPlayhead(0); });
  toStartBtn.addEventListener('click', () => setPlayhead(0));
  rulerEl.addEventListener('click', (e) => {
    const rect = rulerEl.getBoundingClientRect();
    setPlayhead((e.clientX - rect.left) / mt.pxPerSec);
  });

  bpmInput.addEventListener('change', () => {
    mt.bpm = Math.min(240, Math.max(40, parseInt(bpmInput.value, 10) || 100));
    bpmInput.value = mt.bpm;
    relayout();
  });
  loopChk.addEventListener('change', () => { mt.loop = loopChk.checked; });
  masterInput.addEventListener('input', () => { if (mt.master) mt.master.gain.value = parseFloat(masterInput.value); });
  latencyInput.addEventListener('input', () => {
    mt.latencyMs = parseInt(latencyInput.value, 10);
    latencyVal.textContent = mt.latencyMs + ' ms';
  });
  zoomIn.addEventListener('click', () => { mt.pxPerSec = Math.min(400, mt.pxPerSec * 1.25); relayout(); });
  zoomOut.addEventListener('click', () => { mt.pxPerSec = Math.max(20, mt.pxPerSec / 1.25); relayout(); });

  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    ensureCtx();
    try {
      const buf = await mt.ctx.decodeAudioData(await f.arrayBuffer());
      addTrack(buf, f.name.replace(/\.[^.]+$/, ''), mt.playhead);
    } catch (e) { alert('No se pudo decodificar el audio.'); }
    fileInput.value = '';
  });
  exportBtn.addEventListener('click', () => { ensureCtx(); exportMix(); });
  clearBtn.addEventListener('click', () => {
    if (!mt.tracks.length) return;
    if (!confirm('¿Vaciar todas las pistas?')) return;
    if (mt.recording) stopRecording();
    pauseTransport();
    for (const t of mt.tracks) { try { t.gainNode.disconnect(); } catch (e) {} t.row.remove(); }
    mt.tracks = [];
    mt.playhead = 0;
    relayout();
    updateEmpty();
  });

  window.addEventListener('beforeunload', () => {
    if (mt.stream) mt.stream.getTracks().forEach(t => t.stop());
  });

  // estado inicial
  relayout();
  updateEmpty();
})();

/* =========================================================
   MODO 4 — Afinación (piano clicable + monitor de tono)
   Reutiliza detectPitchMPM() / freqToMidiFloat() / midiToInfo().
   ========================================================= */
(function () {
  const GUTTER = 36;                    // margen izquierdo del gráfico (etiquetas)
  const BLACK_PC = [1, 3, 6, 8, 10];    // clases de nota que son teclas negras

  const tn = {
    ctx: null, stream: null, source: null, analyser: null, floatData: null,
    detecting: false, rafId: null, lastPitch: 0,
    history: [], medBuf: [],
    startOctave: 3, octaves: 3, midiLow: 0, midiHigh: 0,
    active: {}, sungEl: null, targetMidi: null,
    windowSec: 6,
    // --- grabaciones / referencia visual ---
    recording: false, recStart: null, recPoints: [],
    recordings: [], playbacks: [], hearRef: true,
  };

  const $ = (id) => document.getElementById(id);
  const micBtn = $('tn-mic'), octaveSel = $('tn-octave'), octavesSel = $('tn-octaves'), waveSel = $('tn-wave');
  const noteEl = $('tn-note'), solfEl = $('tn-solf'), centsEl = $('tn-cents'), needleEl = $('tn-needle');
  const graphCv = $('tn-graph'), keysEl = $('tn-keys');
  const recordBtn = $('tn-record'), importBtn = $('tn-import'), audioFileInput = $('tn-audiofile');
  const hearRefChk = $('tn-hearref'), clearAllBtn = $('tn-clearall');
  const recListEl = $('tn-reclist'), recStatusEl = $('tn-rec-status');
  const REC_STORE_KEY = 'vocalStudio.tunerRecordings';
  // Colores cálidos/distintos del trazo en vivo (turquesa) y del objetivo (violeta).
  const REC_COLORS = ['#ff9f43', '#ff6b6b', '#ff6bd6', '#feca57', '#b388ff', '#a3cb38'];

  /* ---------- audio ---------- */
  function ensureCtx() {
    if (!tn.ctx) {
      tn.ctx = new (window.AudioContext || window.webkitAudioContext)();
      tn.master = tn.ctx.createGain();
      tn.master.gain.value = 0.4;
      tn.master.connect(tn.ctx.destination);
    }
    if (tn.ctx.state === 'suspended') tn.ctx.resume();
    return tn.ctx;
  }
  async function getMic() {
    const live = tn.stream && tn.stream.getAudioTracks().some(t => t.readyState === 'live');
    if (live) return tn.stream;
    tn.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    return tn.stream;
  }

  /* ---------- teclas (sonido) ---------- */
  function noteOn(midi, el) {
    ensureCtx();
    if (tn.active[midi]) return;
    const osc = tn.ctx.createOscillator();
    const g = tn.ctx.createGain();
    osc.type = waveSel.value;
    osc.frequency.value = midiToFreq(midi);
    const t = tn.ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.3, t + 0.012);
    osc.connect(g);
    g.connect(tn.master);
    osc.start(t);
    tn.active[midi] = { osc, g };
    if (el) { el.classList.add('lit'); setTarget(midi, el); }
  }
  function noteOff(midi) {
    const a = tn.active[midi];
    if (!a) return;
    const t = tn.ctx.currentTime;
    a.g.gain.cancelScheduledValues(t);
    a.g.gain.setValueAtTime(0.3, t);
    a.g.gain.linearRampToValueAtTime(0.0001, t + 0.12);
    a.osc.stop(t + 0.16);
    delete tn.active[midi];
    const el = keysEl.querySelector('.tn-wkey[data-midi="' + midi + '"], .tn-bkey[data-midi="' + midi + '"]');
    if (el) el.classList.remove('lit');
  }
  function releaseAll() { Object.keys(tn.active).forEach(m => noteOff(+m)); }

  function setTarget(midi, el) {
    tn.targetMidi = midi;
    keysEl.querySelectorAll('.target').forEach(k => k.classList.remove('target'));
    if (el) el.classList.add('target');
    if (!tn.detecting) drawGrid(); // refrescar la línea objetivo aunque no haya micro
  }

  /* ---------- construcción del teclado ---------- */
  function buildKeyboard() {
    tn.startOctave = parseInt(octaveSel.value, 10) || 3;
    tn.octaves = parseInt(octavesSel.value, 10) || 3;
    tn.midiLow = noteToMidi('C', tn.startOctave);
    tn.midiHigh = noteToMidi('C', tn.startOctave + tn.octaves);

    // Contar teclas blancas para ajustar el ancho al contenedor (que entre todo)
    let whiteCount = 0;
    for (let m = tn.midiLow; m <= tn.midiHigh; m++) {
      if (BLACK_PC.indexOf(((m % 12) + 12) % 12) === -1) whiteCount++;
    }
    const avail = ((keysEl.parentElement && keysEl.parentElement.clientWidth) || 840) - 16;
    const whiteW = Math.max(22, Math.min(56, Math.floor(avail / whiteCount)));
    const blackW = Math.round(whiteW * 0.62);

    keysEl.innerHTML = '';
    let whiteIndex = 0;
    const blacks = [];
    for (let m = tn.midiLow; m <= tn.midiHigh; m++) {
      const pc = ((m % 12) + 12) % 12;
      const info = midiToInfo(m);
      if (BLACK_PC.indexOf(pc) === -1) {
        const key = document.createElement('div');
        key.className = 'tn-wkey';
        key.dataset.midi = m;
        key.style.left = (whiteIndex * whiteW) + 'px';
        key.style.width = whiteW + 'px';
        key.innerHTML = '<span class="tn-klabel">' + (pc === 0 ? info.label : NOTE_NAMES[pc]) + '</span>';
        keysEl.appendChild(key);
        whiteIndex++;
      } else {
        blacks.push({ m, pc, left: whiteIndex * whiteW - blackW / 2 });
      }
    }
    for (const b of blacks) {
      const key = document.createElement('div');
      key.className = 'tn-bkey';
      key.dataset.midi = b.m;
      key.style.left = b.left + 'px';
      key.style.width = blackW + 'px';
      keysEl.appendChild(key);
    }
    keysEl.style.width = (whiteIndex * whiteW) + 'px';

    keysEl.querySelectorAll('.tn-wkey, .tn-bkey').forEach(key => {
      const midi = parseInt(key.dataset.midi, 10);
      key.addEventListener('pointerdown', (e) => { e.preventDefault(); noteOn(midi, key); });
    });

    // Restaurar la marca de "objetivo" tras reconstruir
    if (tn.targetMidi != null) {
      const el = keysEl.querySelector('.tn-wkey[data-midi="' + tn.targetMidi + '"], .tn-bkey[data-midi="' + tn.targetMidi + '"]');
      if (el) el.classList.add('target');
    }
  }

  /* ---------- detección y dibujo ---------- */
  function startDetect() {
    ensureCtx();
    getMic().then(() => {
      tn.source = tn.ctx.createMediaStreamSource(tn.stream);
      tn.analyser = tn.ctx.createAnalyser();
      tn.analyser.fftSize = 2048;
      tn.analyser.smoothingTimeConstant = 0;
      tn.floatData = new Float32Array(tn.analyser.fftSize);
      tn.source.connect(tn.analyser);
      tn.detecting = true;
      tn.history = []; tn.medBuf = []; tn.lastPitch = 0;
      micBtn.textContent = '■ Detener micrófono';
      micBtn.classList.add('rec');
      sizeGraph();
      ensureLoop();
    }).catch(e => alert('No se pudo acceder al micrófono: ' + e.message));
  }
  function stopDetect() {
    tn.detecting = false;
    if (tn.recording) finishRecording();   // cerrar la grabación en curso al apagar el micro
    if (tn.source) { try { tn.source.disconnect(); } catch (e) {} tn.source = null; }
    micBtn.textContent = '🎤 Activar micrófono';
    micBtn.classList.remove('rec');
    tn.medBuf = [];
    updateReadout();
    // Si hay reproducciones, el bucle sigue; si no, se detiene solo y repinta la rejilla.
    if (tn.playbacks.length === 0) {
      if (tn.rafId) { cancelAnimationFrame(tn.rafId); tn.rafId = null; }
      drawGrid();
    }
  }

  function ensureLoop() {
    ensureCtx();
    if (tn.rafId == null) tn.rafId = requestAnimationFrame(frame);
  }
  function frame() {
    // El bucle sigue vivo mientras detectamos o haya alguna reproducción superpuesta.
    if (!tn.detecting && tn.playbacks.length === 0) {
      tn.rafId = null;
      drawGrid();
      return;
    }
    const now = tn.ctx.currentTime;
    if (tn.detecting && now - tn.lastPitch > 0.04) {
      tn.lastPitch = now;
      tn.analyser.getFloatTimeDomainData(tn.floatData);
      const det = detectPitchMPM(tn.floatData, tn.ctx.sampleRate);
      let midi = null;
      if (det) {
        midi = freqToMidiFloat(det.freq);
        tn.history.push({ t: now, midi });
        tn.medBuf.push(midi);
        if (tn.medBuf.length > 5) tn.medBuf.shift();
      } else {
        tn.history.push({ t: now, midi: null });
        tn.medBuf = [];
      }
      if (tn.recording) {
        if (tn.recStart == null) tn.recStart = now;
        tn.recPoints.push({ t: +(now - tn.recStart).toFixed(3), midi: midi == null ? null : +midi.toFixed(2) });
      }
      const cutoff = now - tn.windowSec;
      while (tn.history.length && tn.history[0].t < cutoff) tn.history.shift();
      updateReadout();
    }
    drawGraph(now);
    tn.rafId = requestAnimationFrame(frame);
  }

  function updateReadout() {
    if (tn.medBuf.length >= 3) {
      const s = tn.medBuf.slice().sort((a, b) => a - b);
      const med = s[Math.floor(s.length / 2)];
      const nearest = Math.round(med);
      const info = midiToInfo(nearest);
      const cents = Math.round((med - nearest) * 100);
      noteEl.textContent = info.label;
      solfEl.textContent = info.solf;
      centsEl.textContent = (cents >= 0 ? '+' : '') + cents + '¢';
      needleEl.style.left = (50 + Math.max(-50, Math.min(50, cents))) + '%';
      needleEl.style.opacity = '1';
      needleEl.style.background = Math.abs(cents) <= 10 ? 'var(--good)'
        : Math.abs(cents) <= 25 ? '#f1c40f' : 'var(--danger)';
      highlightSung(nearest);
    } else {
      noteEl.textContent = '—';
      solfEl.textContent = '';
      centsEl.textContent = '';
      needleEl.style.opacity = '0.25';
      needleEl.style.left = '50%';
      highlightSung(null);
    }
  }
  function highlightSung(midi) {
    if (tn.sungEl) { tn.sungEl.classList.remove('sung'); tn.sungEl = null; }
    if (midi != null) {
      const el = keysEl.querySelector('.tn-wkey[data-midi="' + midi + '"], .tn-bkey[data-midi="' + midi + '"]');
      if (el) { el.classList.add('sung'); tn.sungEl = el; }
    }
  }

  function sizeGraph() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = graphCv.clientWidth || 600;
    graphCv.width = Math.round(cssW * dpr);
    graphCv.height = Math.round(260 * dpr);
  }
  function midiToY(m, H) {
    const lo = tn.midiLow - 0.5, hi = tn.midiHigh + 0.5;
    const dpr = window.devicePixelRatio || 1;
    const top = 6 * dpr, bot = 6 * dpr;
    return top + ((hi - m) / (hi - lo)) * (H - top - bot);
  }
  function drawGrid(c) {
    c = c || graphCv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = graphCv.width, H = graphCv.height, GUT = GUTTER * dpr;
    c.fillStyle = '#0c0e15';
    c.fillRect(0, 0, W, H);
    for (let m = tn.midiLow; m <= tn.midiHigh; m++) {
      const pc = ((m % 12) + 12) % 12;
      const isBlack = BLACK_PC.indexOf(pc) !== -1;
      const y = midiToY(m, H);
      c.strokeStyle = pc === 0 ? '#3a4260' : (isBlack ? '#161a26' : '#232838');
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(GUT, y);
      c.lineTo(W, y);
      c.stroke();
      if (!isBlack) {
        const info = midiToInfo(m);
        c.fillStyle = pc === 0 ? '#8b90a3' : '#555c70';
        c.font = (11 * dpr) + 'px sans-serif';
        c.textBaseline = 'middle';
        c.fillText(info.label, 4 * dpr, y);
      }
    }
    if (tn.targetMidi != null) {
      const y = midiToY(tn.targetMidi, H);
      c.strokeStyle = 'rgba(108,92,231,0.95)';
      c.setLineDash([6 * dpr, 4 * dpr]);
      c.lineWidth = 2 * dpr;
      c.beginPath();
      c.moveTo(GUT, y);
      c.lineTo(W, y);
      c.stroke();
      c.setLineDash([]);
    }
  }
  function drawGraph(now) {
    const c = graphCv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = graphCv.width, H = graphCv.height, GUT = GUTTER * dpr;
    drawGrid(c);
    drawPlaybacks(now);   // referencias grabadas por debajo del trazo en vivo

    const tStart = now - tn.windowSec, xw = W - GUT;
    c.lineWidth = 2.4 * dpr;
    c.strokeStyle = 'rgba(0,206,201,0.95)';
    c.beginPath();
    let started = false;
    let lastX = 0, lastY = 0, lastMidi = null;
    for (const p of tn.history) {
      if (p.midi == null) { started = false; continue; }
      const x = GUT + ((p.t - tStart) / tn.windowSec) * xw;
      const y = midiToY(p.midi, H);
      if (!started) { c.moveTo(x, y); started = true; } else { c.lineTo(x, y); }
      lastX = x; lastY = y; lastMidi = p.midi;
    }
    c.stroke();

    // punto actual coloreado según afinación
    if (lastMidi != null) {
      const cents = (lastMidi - Math.round(lastMidi)) * 100;
      c.fillStyle = Math.abs(cents) <= 10 ? '#2ecc71' : Math.abs(cents) <= 25 ? '#f1c40f' : '#e74c3c';
      c.beginPath();
      c.arc(lastX, lastY, 5 * dpr, 0, Math.PI * 2);
      c.fill();
    }
  }

  /* =========================================================
     Grabaciones de afinación: referencia visual superpuesta
     ========================================================= */
  function recById(id) { return tn.recordings.find(r => r.id === id); }
  function colorFor(rec) { return REC_COLORS[rec.colorIndex % REC_COLORS.length]; }
  function isPlaying(id) { return tn.playbacks.some(p => p.recId === id); }
  function fmtDur(s) {
    s = Math.max(0, s || 0);
    const m = Math.floor(s / 60), sec = s - m * 60;
    return m + ':' + sec.toFixed(1).padStart(4, '0');
  }

  /* ----- persistencia (localStorage) ----- */
  function loadRecordings() {
    try {
      const raw = localStorage.getItem(REC_STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      tn.recordings = Array.isArray(arr) ? arr : [];
    } catch (e) { tn.recordings = []; }
  }
  function saveRecordings() {
    try { localStorage.setItem(REC_STORE_KEY, JSON.stringify(tn.recordings)); }
    catch (e) { recStatusEl.textContent = 'No se pudo guardar (almacenamiento lleno o bloqueado).'; }
  }

  function addRecording({ name, points, duration }) {
    // Elige el primer color libre para distinguir varias referencias a la vez.
    const used = tn.recordings.map(r => r.colorIndex);
    let colorIndex = 0;
    while (used.indexOf(colorIndex) !== -1 && colorIndex < REC_COLORS.length) colorIndex++;
    if (colorIndex >= REC_COLORS.length) colorIndex = tn.recordings.length % REC_COLORS.length;
    const rec = {
      id: 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
      name, points, duration, createdAt: Date.now(), colorIndex,
    };
    tn.recordings.push(rec);
    saveRecordings();
    renderRecList();
    return rec;
  }
  function deleteRecording(id) {
    const i = tn.playbacks.findIndex(p => p.recId === id);
    if (i >= 0) { stopOnePlayback(tn.playbacks[i]); tn.playbacks.splice(i, 1); }
    tn.recordings = tn.recordings.filter(r => r.id !== id);
    saveRecordings();
    renderRecList();
    stopLoopIfIdle();
  }
  function clearAllRecordings() {
    if (!tn.recordings.length) return;
    if (!confirm('¿Borrar todas las grabaciones de afinación? No se puede deshacer.')) return;
    tn.playbacks.slice().forEach(stopOnePlayback);
    tn.playbacks = [];
    tn.recordings = [];
    saveRecordings();
    renderRecList();
    stopLoopIfIdle();
  }
  function defaultName() {
    let t = '';
    try { t = new Date().toLocaleTimeString(); } catch (e) {}
    return 'Grabación ' + (tn.recordings.length + 1) + (t ? ' · ' + t : '');
  }

  /* ----- captura en vivo ----- */
  function toggleRecord() {
    if (tn.recording) { finishRecording(); return; }
    tn.recording = true;
    tn.recStart = null;
    tn.recPoints = [];
    recordBtn.textContent = '■ Detener grabación';
    recordBtn.classList.add('armed');
    recStatusEl.textContent = 'Grabando afinación…';
    if (!tn.detecting) startDetect();   // necesitamos el micrófono para capturar el tono
  }
  function finishRecording() {
    if (!tn.recording) return;
    tn.recording = false;
    recordBtn.textContent = '⏺ Grabar afinación';
    recordBtn.classList.remove('armed');
    const pts = tn.recPoints; tn.recPoints = []; tn.recStart = null;
    const dur = pts.length ? pts[pts.length - 1].t : 0;
    const voiced = pts.reduce((n, p) => n + (p.midi != null ? 1 : 0), 0);
    if (dur < 0.5 || voiced < 3) {
      recStatusEl.textContent = 'Grabación descartada (demasiado corta o sin voz detectada).';
      return;
    }
    smoothContour(pts);
    addRecording({ name: defaultName(), points: pts, duration: dur });
    recStatusEl.textContent = '';
  }

  // Filtro de mediana (ventana 5) sobre el contorno, respetando los huecos (null).
  function smoothContour(points) {
    const vals = points.map(p => p.midi);
    for (let i = 0; i < points.length; i++) {
      if (vals[i] == null) continue;
      const w = [];
      for (let k = -2; k <= 2; k++) { const v = vals[i + k]; if (v != null) w.push(v); }
      if (w.length >= 3) { w.sort((a, b) => a - b); points[i].midi = +w[Math.floor(w.length / 2)].toFixed(2); }
    }
  }

  /* ----- reproducción / superposición ----- */
  function togglePlayback(id) {
    const idx = tn.playbacks.findIndex(p => p.recId === id);
    if (idx >= 0) {
      stopOnePlayback(tn.playbacks[idx]);
      tn.playbacks.splice(idx, 1);
      renderRecList();
      stopLoopIfIdle();
      return;
    }
    ensureCtx();
    const osc = tn.ctx.createOscillator();
    const g = tn.ctx.createGain();
    osc.type = 'sine';
    g.gain.value = 0;
    osc.connect(g); g.connect(tn.master);
    osc.start();
    tn.playbacks.push({ recId: id, startCtx: tn.ctx.currentTime, osc, gain: g });
    ensureLoop();
    renderRecList();
  }
  function stopOnePlayback(pb) {
    if (!pb) return;
    try {
      const t = tn.ctx ? tn.ctx.currentTime : 0;
      if (pb.gain) pb.gain.gain.setTargetAtTime(0, t, 0.02);
      if (pb.osc) pb.osc.stop(t + 0.1);
    } catch (e) {}
  }
  function stopLoopIfIdle() {
    if (!tn.detecting && tn.playbacks.length === 0 && tn.rafId) {
      cancelAnimationFrame(tn.rafId); tn.rafId = null; drawGrid();
    }
  }

  // Muestra interpolada del contorno grabado en el instante tphase (segundos dentro de la toma).
  function sampleMidiAt(rec, tphase) {
    const pts = rec.points;
    if (!pts.length) return null;
    let lo = 0;
    while (lo < pts.length - 1 && pts[lo + 1].t < tphase) lo++;
    const a = pts[lo], b = pts[lo + 1];
    if (!b) return a.midi;
    if (a.midi == null || b.midi == null) return null;
    const span = b.t - a.t;
    const f = span > 0 ? (tphase - a.t) / span : 0;
    return a.midi + (b.midi - a.midi) * f;
  }

  // Dibuja el contorno grabado desplazándose en bucle, igual que el trazo en vivo
  // (el "ahora" queda en el borde derecho y lo pasado se va a la izquierda).
  function drawContour(rec, ptRaw, color) {
    const c = graphCv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = graphCv.width, H = graphCv.height, GUT = GUTTER * dpr;
    const xw = W - GUT, dur = rec.duration || 0.001;
    c.lineWidth = 2.2 * dpr;
    c.strokeStyle = color;
    c.beginPath();
    let started = false;
    const kMin = Math.floor((ptRaw - tn.windowSec) / dur);
    const kMax = Math.ceil(ptRaw / dur);
    for (let k = kMin; k <= kMax; k++) {
      const off = k * dur;
      for (let i = 0; i < rec.points.length; i++) {
        const p = rec.points[i];
        const age = ptRaw - (p.t + off);          // segundos antes de "ahora"
        if (age < 0 || age > tn.windowSec) { started = false; continue; }
        if (p.midi == null) { started = false; continue; }
        const x = GUT + ((tn.windowSec - age) / tn.windowSec) * xw;
        const y = midiToY(p.midi, H);
        if (!started) { c.moveTo(x, y); started = true; } else { c.lineTo(x, y); }
      }
    }
    c.stroke();
  }

  function drawPlaybacks(now) {
    if (!tn.playbacks.length) return;
    for (const pb of tn.playbacks) {
      const rec = recById(pb.recId);
      if (!rec || !rec.points.length) continue;
      const ptRaw = now - pb.startCtx;
      drawContour(rec, ptRaw, colorFor(rec));
      // tono de referencia audible
      if (pb.gain && pb.osc) {
        const dur = rec.duration || 0.001;
        const tphase = ((ptRaw % dur) + dur) % dur;
        const m = sampleMidiAt(rec, tphase);
        const t = tn.ctx.currentTime;
        if (m == null || !tn.hearRef) {
          pb.gain.gain.setTargetAtTime(0, t, 0.03);
        } else {
          pb.osc.frequency.setTargetAtTime(midiToFreq(m), t, 0.02);
          pb.gain.gain.setTargetAtTime(0.12, t, 0.03);
        }
      }
    }
  }

  /* ----- importar audio -> contorno de tono (reutiliza el detector MPM) ----- */
  async function importAudioFile(file) {
    if (!file) return;
    ensureCtx();
    recStatusEl.textContent = 'Leyendo «' + file.name + '»…';
    let audio;
    try {
      const arr = await file.arrayBuffer();
      audio = await tn.ctx.decodeAudioData(arr);
    } catch (e) {
      recStatusEl.textContent = 'No se pudo decodificar el audio (formato no soportado).';
      return;
    }
    const sr = audio.sampleRate, N = audio.length, chN = audio.numberOfChannels;
    const mono = new Float32Array(N);                 // mezcla a mono
    for (let c = 0; c < chN; c++) {
      const d = audio.getChannelData(c);
      for (let i = 0; i < N; i++) mono[i] += d[i] / chN;
    }
    const win = 2048, hop = Math.max(256, Math.round(sr * 0.04));
    const slice = new Float32Array(win);
    const points = [];
    const total = Math.max(1, Math.floor((N - win) / hop) + 1);
    let frameN = 0;
    for (let i = 0; i + win <= N; i += hop, frameN++) {
      slice.set(mono.subarray(i, i + win));
      const det = detectPitchMPM(slice, sr);
      points.push({ t: +(i / sr).toFixed(3), midi: det ? +freqToMidiFloat(det.freq).toFixed(2) : null });
      if (frameN % 40 === 0) {
        recStatusEl.textContent = 'Analizando tono… ' + Math.round((frameN / total) * 100) + '%';
        await new Promise(r => setTimeout(r));        // ceder el hilo para no congelar la interfaz
      }
    }
    const voiced = points.reduce((n, p) => n + (p.midi != null ? 1 : 0), 0);
    if (!voiced) { recStatusEl.textContent = 'No se detectó tono claro en el audio.'; return; }
    smoothContour(points);
    addRecording({ name: file.name.replace(/\.[^.]+$/, ''), points, duration: N / sr });
    recStatusEl.textContent = 'Importado: ' + file.name + ' (' + voiced + ' puntos de tono).';
  }

  /* ----- lista de grabaciones ----- */
  function renderRecList() {
    recListEl.innerHTML = '';
    clearAllBtn.hidden = tn.recordings.length === 0;
    if (!tn.recordings.length) {
      const empty = document.createElement('div');
      empty.className = 'tn-rec-empty';
      empty.textContent = 'Sin grabaciones. Pulsa «⏺ Grabar afinación» o importa un audio para crear una referencia.';
      recListEl.appendChild(empty);
      return;
    }
    for (const rec of tn.recordings) {
      const item = document.createElement('div');
      item.className = 'tn-recitem' + (isPlaying(rec.id) ? ' playing' : '');

      const sw = document.createElement('span');
      sw.className = 'tn-sw';
      sw.style.background = colorFor(rec);

      const info = document.createElement('div');
      info.className = 'tn-recinfo';
      const nm = document.createElement('div'); nm.className = 'tn-recnm'; nm.textContent = rec.name;
      const meta = document.createElement('div'); meta.className = 'tn-recmeta'; meta.textContent = fmtDur(rec.duration);
      info.appendChild(nm); info.appendChild(meta);

      const spacer = document.createElement('div'); spacer.className = 'tn-recspacer';

      const playBtn = document.createElement('button');
      playBtn.className = 'mt-btn small';
      playBtn.textContent = isPlaying(rec.id) ? '■ Detener' : '▶ Reproducir';
      playBtn.addEventListener('click', () => togglePlayback(rec.id));

      const delBtn = document.createElement('button');
      delBtn.className = 'mt-btn small danger';
      delBtn.textContent = '🗑';
      delBtn.title = 'Borrar esta grabación';
      delBtn.addEventListener('click', () => deleteRecording(rec.id));

      item.appendChild(sw); item.appendChild(info); item.appendChild(spacer);
      item.appendChild(playBtn); item.appendChild(delBtn);
      recListEl.appendChild(item);
    }
  }

  /* ---------- refresco al abrir la pestaña / cambiar rango ---------- */
  // Reconstruye el teclado para ajustarlo al ancho visible (que entre todo el rango).
  function refresh() {
    buildKeyboard();
    sizeGraph();
    drawGrid();
  }
  const rebuild = refresh;

  /* ---------- eventos ---------- */
  micBtn.addEventListener('click', () => { if (tn.detecting) stopDetect(); else startDetect(); });
  octaveSel.addEventListener('change', rebuild);
  octavesSel.addEventListener('change', rebuild);
  recordBtn.addEventListener('click', toggleRecord);
  importBtn.addEventListener('click', () => audioFileInput.click());
  audioFileInput.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    importAudioFile(f);
    audioFileInput.value = '';   // permite reimportar el mismo archivo
  });
  hearRefChk.addEventListener('change', () => { tn.hearRef = hearRefChk.checked; });
  clearAllBtn.addEventListener('click', clearAllRecordings);
  document.addEventListener('pointerup', releaseAll);
  document.addEventListener('pointercancel', releaseAll);
  window.addEventListener('resize', () => { if (panels.tuner && !panels.tuner.hidden) refresh(); });
  const tunerTab = document.querySelector('.tab[data-tab="tuner"]');
  if (tunerTab) tunerTab.addEventListener('click', () => setTimeout(refresh, 0));
  window.addEventListener('beforeunload', () => { if (tn.stream) tn.stream.getTracks().forEach(t => t.stop()); });

  // Fijar los valores por defecto en JS (algunos navegadores restauran el <select>
  // de una sesión anterior e ignoran el atributo "selected" del HTML).
  octaveSel.value = String(tn.startOctave);
  octavesSel.value = String(tn.octaves);
  buildKeyboard();

  // Grabaciones persistentes
  tn.hearRef = hearRefChk.checked;
  loadRecordings();
  renderRecList();
})();
