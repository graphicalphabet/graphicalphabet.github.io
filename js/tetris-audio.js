/*
  tetris-audio.js
  ═══════════════
  Procedural hip-hop / trap audio engine for Tetris.
  Built entirely on the Web Audio API — zero dependencies, no samples.

  iOS SILENT MODE STRATEGY
  ─────────────────────────
  Web Audio API output is routed through a MediaStreamDestination node into
  a real HTML5 <audio> element (playsinline, muted=false). iOS plays <audio>
  elements through the media channel, which ignores the hardware silent switch.
  Web Audio acts purely as a synthesis engine; the <audio> element is the actual
  output device iOS sees. This is the only approach that works reliably across
  all iOS versions.

  PUBLIC API
  ──────────
  TetrisAudio.init()           — call once on first user interaction
  TetrisAudio.start()          — begin music (new game)
  TetrisAudio.stop()           — stop music + kill scheduled notes
  TetrisAudio.pause()          — duck music to near-silence
  TetrisAudio.resume()         — restore music after pause
  TetrisAudio.setLevel(n)      — update tempo + intensity for level n (1–12+)
  TetrisAudio.mute()           — toggle mute; returns new muted state (bool)
  TetrisAudio.sfx.rotate()
  TetrisAudio.sfx.drop()
  TetrisAudio.sfx.lineClear(n) — n = lines cleared (1–4)
  TetrisAudio.sfx.levelUp()
  TetrisAudio.sfx.gameOver()
  TetrisAudio.sfx.pause()
  TetrisAudio.sfx.resume()
  TetrisAudio.sfx.newGame()
*/

var TetrisAudio = (function () {
  'use strict';
  
  /* ── State ───────────────────────────────────────────────────────────────────── */
  var ac           = null;   /* AudioContext                  */
  var masterGain   = null;   /* master volume node            */
  var musicGain    = null;   /* music sub-bus                 */
  var sfxGain      = null;   /* sfx  sub-bus                  */
  var audioEl      = null;   /* <audio> element — iOS output  */
  var ready        = false;
  var muted        = false;
  var musicActive  = false;
  var currentLevel = 1;
  
  /* Scheduler state */
  var scheduleTimer = null;
  var nextBeatTime  = 0;
  var beatIndex     = 0;
  var totalBeats    = 64;    /* 4 bars × 16 steps before pattern loops */
  
  /* ── Init (must be called from a user gesture) ───────────────────────────────── */
  function init() {
    if (ready) return;
  
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) { return; }
  
    /* Resume context — required on iOS even inside a gesture */
    if (ac.state === 'suspended') {
      ac.resume().catch(function () {});
    }
  
    /* ── iOS silent-mode fix ─────────────────────────────────────────────────────
       Route all Web Audio output through a MediaStreamDestination → <audio>.
       iOS plays <audio playsinline> through the media channel, which is NOT
       affected by the hardware silent switch. Web Audio on its own uses the
       ringer channel and IS muted by the switch. By making <audio> the actual
       output device, we bypass silent mode entirely on all iOS versions.
    ─────────────────────────────────────────────────────────────────────────── */
    var streamDest;
    try {
      streamDest = ac.createMediaStreamDestination();
    } catch (e) {
      /* Browser doesn't support MediaStreamDestination — fall back to direct output */
      streamDest = null;
    }
  
    masterGain = ac.createGain();
    masterGain.gain.value = 0.85;
  
    if (streamDest) {
      /* Web Audio → masterGain → MediaStream → <audio> element */
      masterGain.connect(streamDest);
  
      audioEl = document.createElement('audio');
      audioEl.srcObject   = streamDest.stream;
      audioEl.playsinline = true;
      audioEl.setAttribute('playsinline', '');
      audioEl.setAttribute('webkit-playsinline', '');
      audioEl.volume = 1.0;
      audioEl.muted  = false;
  
      /* play() must be called inside the user gesture — we're still in init() */
      var playPromise = audioEl.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(function () {
          /* Autoplay blocked — try again on next interaction */
          document.addEventListener('touchstart', function retry() {
            audioEl.play().catch(function () {});
            document.removeEventListener('touchstart', retry);
          }, { once: true, passive: true });
        });
      }
    } else {
      /* Non-iOS fallback: connect directly to speakers */
      masterGain.connect(ac.destination);
    }
  
    musicGain = ac.createGain();
    musicGain.gain.value = 0.72;
    musicGain.connect(masterGain);
  
    sfxGain = ac.createGain();
    sfxGain.gain.value = 1.0;
    sfxGain.connect(masterGain);
  
    ready = true;
  }
  
  /* ── Utility ─────────────────────────────────────────────────────────────────── */
  function now() { return ac ? ac.currentTime : 0; }
  
  function bpm() {
    /* 90 BPM at level 1, ramps to 138 BPM at level 12, capped there */
    return Math.round(90 + Math.min(11, currentLevel - 1) * 4.4);
  }
  
  function beatDur() {
    /* Duration of one 16th note in seconds */
    return (60 / bpm()) / 4;
  }
  
  function intensity() {
    /* 0–1 based on level */
    return Math.min(1, (currentLevel - 1) / 10);
  }
  
  function env(gainNode, at, attack, hold, release, peak) {
    peak = peak || 1;
    gainNode.gain.setValueAtTime(0, at);
    gainNode.gain.linearRampToValueAtTime(peak, at + attack);
    gainNode.gain.setValueAtTime(peak, at + attack + hold);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, at + attack + hold + release);
  }
  
  function chain(nodes, dest) {
    for (var i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    nodes[nodes.length - 1].connect(dest);
    return nodes[0];
  }
  
  /* ── Synthesised drum voices ─────────────────────────────────────────────────── */
  
  function kick(t, vel) {
    vel = vel || 1;
    var osc  = ac.createOscillator();
    var g    = ac.createGain();
    var dist = ac.createWaveShaper();
  
    var curve = new Float32Array(256);
    for (var i = 0; i < 256; i++) {
      var x = (i * 2) / 256 - 1;
      curve[i] = (Math.PI + 200) * x / (Math.PI + 200 * Math.abs(x));
    }
    dist.curve = curve;
  
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.06);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.22);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * 1.4, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
  
    chain([osc, dist, g], musicGain);
    osc.start(t);
    osc.stop(t + 0.6);
  }
  
  function snare(t, vel) {
    vel = vel || 1;
  
    var body  = ac.createOscillator();
    var bodyG = ac.createGain();
    body.type = 'triangle';
    body.frequency.setValueAtTime(200, t);
    body.frequency.exponentialRampToValueAtTime(100, t + 0.08);
    env(bodyG, t, 0.002, 0, 0.12, vel * 0.4);
  
    var bufLen = Math.floor(ac.sampleRate * 0.25);
    var buf    = ac.createBuffer(1, bufLen, ac.sampleRate);
    var data   = buf.getChannelData(0);
    for (var i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
  
    var noise  = ac.createBufferSource();
    var noiseF = ac.createBiquadFilter();
    var noiseG = ac.createGain();
    noise.buffer    = buf;
    noiseF.type     = 'bandpass';
    noiseF.frequency.value = 2800;
    noiseF.Q.value  = 0.9;
    env(noiseG, t, 0.001, 0, 0.14, vel * 0.55);
  
    chain([body, bodyG], musicGain);
    chain([noise, noiseF, noiseG], musicGain);
    body.start(t);  body.stop(t + 0.25);
    noise.start(t); noise.stop(t + 0.25);
  }
  
  function hihat(t, vel, open) {
    vel = vel || 1;
    var bufLen = Math.floor(ac.sampleRate * (open ? 0.3 : 0.06));
    var buf    = ac.createBuffer(1, bufLen, ac.sampleRate);
    var data   = buf.getChannelData(0);
    for (var i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
  
    var noise = ac.createBufferSource();
    var filt  = ac.createBiquadFilter();
    var g     = ac.createGain();
    noise.buffer       = buf;
    filt.type          = 'highpass';
    filt.frequency.value = 7000;
    env(g, t, 0.001, 0, open ? 0.25 : 0.04, vel * 0.28);
  
    chain([noise, filt, g], musicGain);
    noise.start(t);
    noise.stop(t + (open ? 0.35 : 0.08));
  }
  
  function clap(t, vel) {
    vel = vel || 1;
    [0, 0.012].forEach(function (offset) {
      var bufLen = Math.floor(ac.sampleRate * 0.15);
      var buf    = ac.createBuffer(1, bufLen, ac.sampleRate);
      var data   = buf.getChannelData(0);
      for (var i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
  
      var noise = ac.createBufferSource();
      var filt  = ac.createBiquadFilter();
      var g     = ac.createGain();
      noise.buffer       = buf;
      filt.type          = 'bandpass';
      filt.frequency.value = 1200;
      filt.Q.value       = 0.6;
      env(g, t + offset, 0.001, 0, 0.15, vel * 0.35);
  
      chain([noise, filt, g], musicGain);
      noise.start(t + offset);
      noise.stop(t + offset + 0.2);
    });
  }
  
  /* ── Bass line ───────────────────────────────────────────────────────────────── */
  var BASS_NOTES = [
    /* Pattern A — sparse, dark (early levels) */
    [36,0,0,0, 0,0,36,0, 39,0,0,0, 0,0,39,0,
     36,0,0,0, 0,36,0,0, 41,0,0,0, 0,0,41,0,
     36,0,0,0, 0,0,36,0, 39,0,0,0, 0,0,39,0,
     36,0,0,0, 0,36,0,0, 43,0,0,0, 0,0,43,0],
    /* Pattern B — mid intensity */
    [36,0,36,0, 0,0,39,0, 39,0,0,0, 0,39,0,0,
     36,0,0,36, 0,0,41,0, 41,0,41,0, 0,0,41,0,
     36,0,36,0, 0,0,39,0, 39,0,0,0, 0,39,0,0,
     36,0,0,36, 0,0,43,0, 43,0,0,43, 0,0,43,0],
    /* Pattern C — busy trap (high levels) */
    [36,0,36,36, 0,39,0,36, 39,0,39,0, 39,0,0,39,
     36,36,0,36, 0,41,36,0, 41,0,41,41, 0,41,0,41,
     36,0,36,36, 0,39,0,36, 39,0,39,0, 39,0,0,39,
     36,36,0,36, 0,43,36,0, 43,43,0,43, 0,43,43,0]
  ];
  
  function midiToHz(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }
  
  function bass808(t, midi, dur) {
    var freq  = midiToHz(midi);
    var osc   = ac.createOscillator();
    var filt  = ac.createBiquadFilter();
    var dist  = ac.createWaveShaper();
    var g     = ac.createGain();
    var ints  = intensity();
  
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq * 1.04, t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + 0.04);
  
    filt.type          = 'lowpass';
    filt.frequency.value = 280 + ints * 600;
    filt.Q.value       = 4 + ints * 8;
  
    var sc = new Float32Array(256);
    for (var i = 0; i < 256; i++) {
      var x = (i * 2) / 256 - 1;
      sc[i] = Math.tanh(x * (1.5 + ints * 2));
    }
    dist.curve = sc;
  
    var hold    = Math.max(0.01, dur - 0.06);
    var release = 0.18 + (1 - ints) * 0.3;
    env(g, t, 0.006, hold, release, 0.55 + ints * 0.3);
  
    chain([osc, filt, dist, g], musicGain);
    osc.start(t);
    osc.stop(t + dur + release + 0.05);
  }
  
  /* ── Atmospheric pad ─────────────────────────────────────────────────────────── */
  var PAD_CHORDS = [
    [57, 60, 64],  /* Am  */
    [55, 59, 62],  /* G   */
    [53, 57, 60],  /* F   */
    [50, 53, 57],  /* Dm  */
    [56, 59, 62],  /* G#m */
    [56, 59, 63]   /* G#m7 */
  ];
  
  function pad(t, chordIdx) {
    var ints   = intensity();
    var padVol = 0.12 * (1 - ints * 0.6);
    if (padVol < 0.02) return;
  
    var chord = PAD_CHORDS[Math.min(chordIdx, PAD_CHORDS.length - 1)];
    chord.forEach(function (midi, i) {
      var freq = midiToHz(midi);
      var osc1 = ac.createOscillator();
      var osc2 = ac.createOscillator();
      var filt = ac.createBiquadFilter();
      var g    = ac.createGain();
  
      osc1.type = 'sawtooth';
      osc2.type = 'sawtooth';
      osc1.frequency.value = freq;
      osc2.frequency.value = freq * 1.006;
      filt.type          = 'lowpass';
      filt.frequency.value = 900 + i * 200;
      filt.Q.value       = 1;
  
      var dur = beatDur() * 16;
      env(g, t, 0.08, dur - 0.2, 0.25, padVol * (i === 1 ? 1 : 0.65));
  
      osc1.connect(filt); osc2.connect(filt);
      chain([filt, g], musicGain);
      osc1.start(t); osc2.start(t);
      osc1.stop(t + dur + 0.3); osc2.stop(t + dur + 0.3);
    });
  }
  
  /* ── Drum patterns ───────────────────────────────────────────────────────────── */
  var DRUM_A = [
    [1,0,1,0],[0,0,0,0],[0,0,1,0],[0,0,0,0],
    [0,1,1,1],[0,0,0,0],[0,0,1,0],[0,0,0,0],
    [1,0,1,0],[0,0,0,0],[1,0,1,0],[0,0,0,0],
    [0,1,1,1],[0,0,0,0],[0,0,1,0],[0,0,0,0]
  ];
  
  var DRUM_B = [
    [1,0,1,0],[0,0,1,0],[0,0,1,0],[1,0,1,0],
    [0,1,1,1],[0,0,1,0],[1,0,1,0],[0,0,1,0],
    [1,0,1,0],[0,0,1,0],[1,0,1,0],[0,0,1,0],
    [0,1,1,1],[0,0,1,0],[1,0,1,0],[0,0,1,0]
  ];
  
  /* ── Scheduler ───────────────────────────────────────────────────────────────── */
  var LOOKAHEAD_MS = 100;
  var SCHEDULE_SEC = 0.20;
  
  function scheduleBeat(beatTime, beat) {
    var step  = beat % 16;
    var bar   = Math.floor(beat / 16);
    var ints  = intensity();
    var useB  = Math.random() < ints;
    var pat   = useB ? DRUM_B[step] : DRUM_A[step];
    var vel   = 0.65 + ints * 0.35;
  
    if (pat[0]) kick(beatTime, vel * (useB ? 1 : 0.85));
    if (pat[1]) snare(beatTime, vel * 0.75);
    if (pat[2]) {
      var openHat = (step === 6 || step === 14) && ints > 0.4;
      hihat(beatTime, vel * (ints > 0.5 ? 0.45 : 0.3), openHat);
    }
    if (pat[3] && ints > 0.2) clap(beatTime, vel * 0.6);
  
    var bassPatIdx = ints < 0.35 ? 0 : (ints < 0.7 ? 1 : 2);
    var bassNote   = BASS_NOTES[bassPatIdx][beat % BASS_NOTES[bassPatIdx].length];
    if (bassNote) bass808(beatTime, bassNote, beatDur() * 0.9);
  
    if (step === 0) {
      var chordIdx = Math.min(5, Math.floor(ints * 6));
      pad(beatTime, (chordIdx + bar) % PAD_CHORDS.length);
    }
  }
  
  function scheduleAhead() {
    if (!musicActive || !ready) return;
    var limit = now() + SCHEDULE_SEC;
    while (nextBeatTime < limit) {
      scheduleBeat(nextBeatTime, beatIndex % totalBeats);
      nextBeatTime += beatDur();
      beatIndex++;
    }
    scheduleTimer = setTimeout(scheduleAhead, LOOKAHEAD_MS);
  }
  
  /* ── Public music controls ───────────────────────────────────────────────────── */
  function start() {
    if (!ready) return;
    stop();
    /* Re-trigger <audio> playback in case it stalled (iOS sometimes pauses it) */
    if (audioEl && audioEl.paused) {
      audioEl.play().catch(function () {});
    }
    musicActive  = true;
    beatIndex    = 0;
    nextBeatTime = now() + 0.1;
    musicGain.gain.setValueAtTime(0, now());
    musicGain.gain.linearRampToValueAtTime(0.72, now() + 1.5);
    scheduleAhead();
  }
  
  function stop() {
    musicActive = false;
    clearTimeout(scheduleTimer);
    if (musicGain) {
      musicGain.gain.cancelScheduledValues(now());
      musicGain.gain.setValueAtTime(musicGain.gain.value, now());
      musicGain.gain.linearRampToValueAtTime(0, now() + 0.3);
    }
  }
  
  function pause() {
    musicActive = false;
    clearTimeout(scheduleTimer);
    if (musicGain) {
      musicGain.gain.cancelScheduledValues(now());
      musicGain.gain.setValueAtTime(musicGain.gain.value, now());
      musicGain.gain.linearRampToValueAtTime(0.06, now() + 0.2);
    }
  }
  
  function resume() {
    if (!ready) return;
    if (audioEl && audioEl.paused) {
      audioEl.play().catch(function () {});
    }
    musicActive  = true;
    nextBeatTime = now() + 0.05;
    musicGain.gain.cancelScheduledValues(now());
    musicGain.gain.setValueAtTime(musicGain.gain.value, now());
    musicGain.gain.linearRampToValueAtTime(0.72, now() + 0.4);
    scheduleAhead();
  }
  
  function setLevel(n) {
    currentLevel = n;
  }
  
  function mute() {
    if (!ready) return muted;
    muted = !muted;
    if (audioEl) audioEl.volume = muted ? 0 : 1.0;
    masterGain.gain.cancelScheduledValues(now());
    masterGain.gain.setValueAtTime(masterGain.gain.value, now());
    masterGain.gain.linearRampToValueAtTime(muted ? 0 : 0.85, now() + 0.08);
    return muted;
  }
  
  /* ── Sound effects ───────────────────────────────────────────────────────────── */
  var sfx = {
  
    rotate: function () {
      if (!ready) return;
      var t   = now();
      var osc = ac.createOscillator();
      var g   = ac.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(520, t);
      osc.frequency.linearRampToValueAtTime(640, t + 0.04);
      env(g, t, 0.001, 0, 0.06, 0.18);
      chain([osc, g], sfxGain);
      osc.start(t); osc.stop(t + 0.1);
    },
  
    drop: function () {
      if (!ready) return;
      var t   = now();
      var osc = ac.createOscillator();
      var g   = ac.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(260, t);
      osc.frequency.exponentialRampToValueAtTime(80, t + 0.07);
      env(g, t, 0.001, 0, 0.12, 0.55);
      chain([osc, g], sfxGain);
      osc.start(t); osc.stop(t + 0.18);
    },
  
    lineClear: function (n) {
      if (!ready) return;
      if (n >= 4) { sfx.tetris(); return; }
      var t         = now();
      var freqStart = 300 + n * 60;
      var freqEnd   = 600 + n * 120;
      var dur       = 0.08 + n * 0.03;
      var osc  = ac.createOscillator();
      var osc2 = ac.createOscillator();
      var g    = ac.createGain();
      osc.type  = 'sawtooth';
      osc2.type = 'square';
      osc.frequency.setValueAtTime(freqStart, t);
      osc.frequency.linearRampToValueAtTime(freqEnd, t + dur);
      osc2.frequency.setValueAtTime(freqStart * 1.5, t);
      osc2.frequency.linearRampToValueAtTime(freqEnd * 1.5, t + dur);
      env(g, t, 0.002, 0, dur + 0.08, 0.35 + n * 0.07);
      osc.connect(g); osc2.connect(g); g.connect(sfxGain);
      osc.start(t); osc2.start(t);
      osc.stop(t + dur + 0.12); osc2.stop(t + dur + 0.12);
    },
  
    tetris: function () {
      if (!ready) return;
      var t  = now();
      var bd = 0.07;
      [523, 659, 784, 1047].forEach(function (freq, i) {
        var osc = ac.createOscillator();
        var g   = ac.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        env(g, t + i * bd, 0.002, 0, 0.09, 0.45);
        chain([osc, g], sfxGain);
        osc.start(t + i * bd); osc.stop(t + i * bd + 0.12);
      });
      var impact = ac.createOscillator();
      var ig     = ac.createGain();
      impact.type = 'sawtooth';
      impact.frequency.setValueAtTime(200, t + 4 * bd);
      impact.frequency.exponentialRampToValueAtTime(60, t + 4 * bd + 0.25);
      env(ig, t + 4 * bd, 0.001, 0, 0.35, 0.7);
      chain([impact, ig], sfxGain);
      impact.start(t + 4 * bd); impact.stop(t + 4 * bd + 0.4);
    },
  
    levelUp: function () {
      if (!ready) return;
      var t  = now();
      var bd = 0.06;
      [392, 523, 659, 784, 1047].forEach(function (freq, i) {
        var osc = ac.createOscillator();
        var g   = ac.createGain();
        osc.type = 'sawtooth';
        osc.frequency.value = freq;
        env(g, t + i * bd, 0.003, 0, 0.1, 0.3 + i * 0.04);
        chain([osc, g], sfxGain);
        osc.start(t + i * bd); osc.stop(t + i * bd + 0.14);
      });
    },
  
    gameOver: function () {
      if (!ready) return;
      var t  = now();
      var bd = 0.12;
      [392, 370, 349, 330, 311, 294, 262].forEach(function (freq, i) {
        var osc = ac.createOscillator();
        var g   = ac.createGain();
        osc.type = 'sawtooth';
        osc.frequency.value = freq;
        env(g, t + i * bd, 0.004, 0, 0.2, 0.28 - i * 0.02);
        chain([osc, g], sfxGain);
        osc.start(t + i * bd); osc.stop(t + i * bd + 0.3);
      });
      var boom = ac.createOscillator();
      var bg   = ac.createGain();
      boom.type = 'sine';
      boom.frequency.setValueAtTime(80, t + 7 * bd);
      boom.frequency.exponentialRampToValueAtTime(30, t + 7 * bd + 0.6);
      env(bg, t + 7 * bd, 0.002, 0, 0.8, 0.9);
      chain([boom, bg], sfxGain);
      boom.start(t + 7 * bd); boom.stop(t + 7 * bd + 1.0);
    },
  
    pause: function () {
      if (!ready) return;
      var t = now();
      [660, 440].forEach(function (freq, i) {
        var osc = ac.createOscillator();
        var g   = ac.createGain();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        env(g, t + i * 0.08, 0.003, 0, 0.1, 0.22);
        chain([osc, g], sfxGain);
        osc.start(t + i * 0.08); osc.stop(t + i * 0.08 + 0.14);
      });
    },
  
    resume: function () {
      if (!ready) return;
      var t = now();
      [440, 660].forEach(function (freq, i) {
        var osc = ac.createOscillator();
        var g   = ac.createGain();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        env(g, t + i * 0.08, 0.003, 0, 0.1, 0.22);
        chain([osc, g], sfxGain);
        osc.start(t + i * 0.08); osc.stop(t + i * 0.08 + 0.14);
      });
    },
  
    newGame: function () {
      if (!ready) return;
      var t  = now();
      var bd = 0.055;
      [330, 392, 494, 660].forEach(function (freq, i) {
        var osc = ac.createOscillator();
        var g   = ac.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        env(g, t + i * bd, 0.002, 0, 0.08, 0.25);
        chain([osc, g], sfxGain);
        osc.start(t + i * bd); osc.stop(t + i * bd + 0.12);
      });
    }
  };
  
  /* ── Public interface ────────────────────────────────────────────────────────── */
  return {
    init:     init,
    start:    start,
    stop:     stop,
    pause:    pause,
    resume:   resume,
    setLevel: setLevel,
    mute:     mute,
    sfx:      sfx
  };
  
  }());  