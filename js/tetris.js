(function () {
'use strict';

/* ── Constants ──────────────────────────────────────────────────────────────── */
var COLS        = 10;
var ROWS        = 20;
var GHOST_ALPHA = 0.2;
var LEVEL_LINES = 10;
var STORAGE_KEY = 'tetris_lb_v2';
var SCORE_TABLE = [0, 100, 300, 500, 800];

var COLORS = ['','#2E59A7','#FFEA00','#E94B3C','#FBA922','#88B04B','#F9A7B0','#F2F2F2'];

var PIECES = {
  I:{ color:1, shapes:[[[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],[[0,0,1,0],[0,0,1,0],[0,0,1,0],[0,0,1,0]],[[0,0,0,0],[0,0,0,0],[1,1,1,1],[0,0,0,0]],[[0,1,0,0],[0,1,0,0],[0,1,0,0],[0,1,0,0]]] },
  O:{ color:2, shapes:[[[1,1],[1,1]]] },
  T:{ color:3, shapes:[[[0,1,0],[1,1,1],[0,0,0]],[[0,1,0],[0,1,1],[0,1,0]],[[0,0,0],[1,1,1],[0,1,0]],[[0,1,0],[1,1,0],[0,1,0]]] },
  S:{ color:4, shapes:[[[0,1,1],[1,1,0],[0,0,0]],[[0,1,0],[0,1,1],[0,0,1]]] },
  Z:{ color:5, shapes:[[[1,1,0],[0,1,1],[0,0,0]],[[0,0,1],[0,1,1],[0,1,0]]] },
  J:{ color:6, shapes:[[[1,0,0],[1,1,1],[0,0,0]],[[0,1,1],[0,1,0],[0,1,0]],[[0,0,0],[1,1,1],[0,0,1]],[[0,1,0],[0,1,0],[1,1,0]]] },
  L:{ color:7, shapes:[[[0,0,1],[1,1,1],[0,0,0]],[[0,1,0],[0,1,0],[0,1,1]],[[0,0,0],[1,1,1],[1,0,0]],[[1,1,0],[0,1,0],[0,1,0]]] }
};
var PIECE_KEYS = Object.keys(PIECES);

/* ── Canvas & responsive sizing ────────────────────────────────────────────── */
var canvas     = document.getElementById('gameCanvas');
var ctx        = canvas.getContext('2d');
var nextCanvas = document.getElementById('nextCanvas');
var nctx       = nextCanvas.getContext('2d');
var wrap       = document.getElementById('canvasWrap');

var BLOCK = 30; // recalculated on resize

function calcLayout() {
  var vw   = window.innerWidth;
  var vh   = window.innerHeight;

  // Available height for the canvas (leave room for header + leaderboard)
  var headerH   = 90;   // h1 + tagline
  var lbH       = 160;  // approximate leaderboard height
  var padV      = 80;   // body top+bottom padding
  var maxCanvasH = Math.floor(vh - headerH - lbH - padV);

  // Available width: on mobile the canvas takes full width minus body padding
  // On desktop/tablet, subtract side panels + gaps
  var isMobile   = vw <= 560;
  var panelW     = isMobile ? 0 : (vw <= 768 ? 100 : 120);
  var panelCount = isMobile ? 0 : 2;
  var gapCount   = isMobile ? 0 : 2;
  var gapPx      = isMobile ? 0 : (vw <= 768 ? 10 : 14);
  var bodyPadH   = isMobile ? 20 : 20;

  var maxCanvasW = Math.floor(vw - bodyPadH * 2 - panelW * panelCount - gapPx * gapCount);

  // Derive block size from whichever axis is tighter
  var blockFromW = Math.floor(maxCanvasW / COLS);
  var blockFromH = Math.floor(maxCanvasH / ROWS);
  var block      = Math.max(16, Math.min(blockFromW, blockFromH, 34));

  BLOCK = block;

  var cw = COLS * BLOCK;
  var ch = ROWS * BLOCK;

  canvas.width  = cw;
  canvas.height = ch;
  canvas.style.width  = cw + 'px';
  canvas.style.height = ch + 'px';
  wrap.style.width    = cw + 'px';
  wrap.style.height   = ch + 'px';

  // Next-piece canvas: 4×4 blocks at ~70% block size
  var nb = Math.max(14, Math.floor(BLOCK * 0.75));
  var nw = nb * 4 + 4;
  var nh = nb * 4 + 4;
  nextCanvas.width  = nw;
  nextCanvas.height = nh;
  nextCanvas.style.width  = nw + 'px';
  nextCanvas.style.height = nh + 'px';

  // Touch controls: show on mobile widths
  var mc = document.getElementById('mobileControls');
  mc.style.display = isMobile ? 'flex' : 'none';

  // Leaderboard max-width matches canvas + panels + gaps
  var lb = document.querySelector('.leaderboard');
  lb.style.maxWidth = (cw + panelW * panelCount + gapPx * gapCount) + 'px';
}

/* ── Game state ─────────────────────────────────────────────────────────────── */
var grid, activePiece, nextPiece;
var score, lines, level, dropInterval;
var running, paused;
var rafId, lastTs, accumMs;

/* ── Leaderboard ────────────────────────────────────────────────────────────── */
function lbLoad() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch(e) { return []; }
}
function lbSave(entries) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch(e) {}
}
function lbAdd(name, sc, lv) {
  var safeName = String(name || '').trim().slice(0, 14) || 'Anonymous';
  var entries  = lbLoad();
  entries.push({ name: safeName, score: sc, level: lv });
  entries.sort(function(a, b) { return b.score - a.score; });
  var top = entries.slice(0, 10);
  lbSave(top);
  lbRender(top);
}
function lbBest() {
  var e = lbLoad();
  return e.length ? e[0].score : 0;
}
function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function lbRender(entries) {
  var el = document.getElementById('lbList');
  if (!entries || !entries.length) {
    el.innerHTML = '<div class="lb-empty">No scores yet — be the first.</div>';
    return;
  }
  var rc  = ['rank-1','rank-2','rank-3'];
  var html = '';
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    html += '<div class="lb-entry">'
          + '<span class="lb-rank ' + (rc[i]||'rank-n') + '">' + (i+1) + '</span>'
          + '<span class="lb-name">'  + escHtml(e.name)  + '</span>'
          + '<span class="lb-lv">Lv.' + e.level + '</span>'
          + '<span class="lb-score">' + e.score.toLocaleString() + '</span>'
          + '</div>';
  }
  el.innerHTML = html;
}

/* ── Piece helpers ──────────────────────────────────────────────────────────── */
function makePiece() {
  var key    = PIECE_KEYS[Math.floor(Math.random() * PIECE_KEYS.length)];
  var def    = PIECES[key];
  var startX = Math.floor((COLS - def.shapes[0][0].length) / 2);
  return { color: def.color, shapes: def.shapes, rot: 0, x: startX, y: 0 };
}
function getShape(p) { return p.shapes[p.rot % p.shapes.length]; }

function collides(p, dx, dy, rotOvr) {
  dx = dx || 0; dy = dy || 0;
  var rot = (rotOvr !== undefined) ? rotOvr % p.shapes.length : p.rot % p.shapes.length;
  var s   = p.shapes[rot];
  for (var r = 0; r < s.length; r++) {
    for (var c = 0; c < s[r].length; c++) {
      if (!s[r][c]) continue;
      var gx = p.x + c + dx;
      var gy = p.y + r + dy;
      if (gx < 0 || gx >= COLS || gy >= ROWS) return true;
      if (gy >= 0 && grid[gy][gx]) return true;
    }
  }
  return false;
}
function ghostY(p) {
  var dy = 0;
  while (!collides(p, 0, dy + 1)) dy++;
  return p.y + dy;
}
function lockPiece(p) {
  var s = getShape(p);
  for (var r = 0; r < s.length; r++) {
    for (var c = 0; c < s[r].length; c++) {
      if (!s[r][c]) continue;
      var gy = p.y + r;
      if (gy < 0) { triggerGameOver(); return; }
      grid[gy][p.x + c] = p.color;
    }
  }
  sweepLines();
}
function sweepLines() {
  var cleared = 0;
  for (var r = ROWS - 1; r >= 0; r--) {
    var full = true;
    for (var c = 0; c < COLS; c++) { if (!grid[r][c]) { full = false; break; } }
    if (full) { grid.splice(r, 1); grid.unshift(new Array(COLS).fill(0)); cleared++; r++; }
  }
  if (cleared) {
    score       += (SCORE_TABLE[cleared] || 0) * level;
    lines       += cleared;
    level        = Math.floor(lines / LEVEL_LINES) + 1;
    dropInterval = Math.max(80, 1000 - (level - 1) * 85);
    refreshHUD();
  }
}
function spawnNext() {
  activePiece = nextPiece || makePiece();
  nextPiece   = makePiece();
  if (collides(activePiece, 0, 0)) triggerGameOver();
}

/* ── HUD ────────────────────────────────────────────────────────────────────── */
function refreshHUD() {
  document.getElementById('scoreDisplay').textContent = score.toLocaleString();
  document.getElementById('linesDisplay').textContent = lines;
  document.getElementById('levelDisplay').textContent = level;
  document.getElementById('bestDisplay').textContent  = Math.max(score, lbBest()).toLocaleString();
}

/* ── Drawing ────────────────────────────────────────────────────────────────── */
function drawBlock(cx, x, y, colorIdx, alpha, bsz) {
  if (!colorIdx) return;
  bsz   = bsz   || BLOCK;
  alpha = (alpha !== undefined) ? alpha : 1;
  var px = x * bsz + 1, py = y * bsz + 1, sz = bsz - 2;
  cx.save();
  cx.globalAlpha = alpha;
  cx.fillStyle   = COLORS[colorIdx];
  cx.fillRect(px, py, sz, sz);
  cx.fillStyle = 'rgba(255,255,255,0.18)';
  cx.fillRect(px, py, sz, 4);
  cx.fillRect(px, py, 4, sz);
  cx.fillStyle = 'rgba(0,0,0,0.28)';
  cx.fillRect(px, py + sz - 4, sz, 4);
  cx.restore();
}
function drawBg() {
  ctx.fillStyle = '#080808';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#111'; ctx.lineWidth = 0.5;
  for (var r = 0; r < ROWS; r++)
    for (var c = 0; c < COLS; c++)
      ctx.strokeRect(c * BLOCK, r * BLOCK, BLOCK, BLOCK);
}
function drawLocked() {
  for (var r = 0; r < ROWS; r++)
    for (var c = 0; c < COLS; c++)
      if (grid[r][c]) drawBlock(ctx, c, r, grid[r][c]);
}
function drawActive() {
  if (!activePiece) return;
  var s  = getShape(activePiece);
  var gy = ghostY(activePiece);
  var r, c;
  if (gy !== activePiece.y) {
    for (r = 0; r < s.length; r++)
      for (c = 0; c < s[r].length; c++)
        if (s[r][c]) drawBlock(ctx, activePiece.x + c, gy + r, activePiece.color, GHOST_ALPHA);
  }
  for (r = 0; r < s.length; r++)
    for (c = 0; c < s[r].length; c++)
      if (s[r][c]) drawBlock(ctx, activePiece.x + c, activePiece.y + r, activePiece.color);
}
function drawNext() {
  nctx.fillStyle = '#0d0d0d';
  nctx.fillRect(0, 0, nextCanvas.width, nextCanvas.height);
  if (!nextPiece) return;
  var s   = getShape(nextPiece);
  var bsz = Math.floor(nextCanvas.width / 4);
  var offX = Math.floor((4 - s[0].length) / 2);
  var offY = Math.floor((4 - s.length)    / 2);
  for (var r = 0; r < s.length; r++) {
    for (var c = 0; c < s[r].length; c++) {
      if (!s[r][c]) continue;
      var px = (offX + c) * bsz + 2, py = (offY + r) * bsz + 2;
      nctx.fillStyle = COLORS[nextPiece.color];
      nctx.fillRect(px, py, bsz - 4, bsz - 4);
      nctx.fillStyle = 'rgba(255,255,255,0.2)';
      nctx.fillRect(px, py, bsz - 4, 3);
    }
  }
}
function render() {
  drawBg();
  drawLocked();
  drawActive();
  drawNext();
}

/* ── Game loop ──────────────────────────────────────────────────────────────── */
function loop(ts) {
  if (!running || paused) return;
  var dt  = ts - lastTs; lastTs = ts; accumMs += dt;
  if (accumMs >= dropInterval) { accumMs = 0; doSoftDrop(); }
  render();
  rafId = requestAnimationFrame(loop);
}

/* ── Actions ────────────────────────────────────────────────────────────────── */
function doSoftDrop() {
  if (!activePiece) return;
  if (collides(activePiece, 0, 1)) { lockPiece(activePiece); spawnNext(); }
  else activePiece.y++;
}
function doHardDrop() {
  if (!activePiece) return;
  var dist = ghostY(activePiece) - activePiece.y;
  score += dist * 2; activePiece.y += dist;
  lockPiece(activePiece); spawnNext(); refreshHUD();
}
function doMoveLeft()  { if (activePiece && !collides(activePiece, -1, 0)) activePiece.x--; }
function doMoveRight() { if (activePiece && !collides(activePiece,  1, 0)) activePiece.x++; }
function doRotate() {
  if (!activePiece) return;
  var nr    = (activePiece.rot + 1) % activePiece.shapes.length;
  var kicks = [0, -1, 1, -2, 2];
  for (var i = 0; i < kicks.length; i++) {
    if (!collides(activePiece, kicks[i], 0, nr)) {
      activePiece.x += kicks[i]; activePiece.rot = nr; return;
    }
  }
}

/* ── Lifecycle ──────────────────────────────────────────────────────────────── */
function startGame() {
  grid = [];
  for (var r = 0; r < ROWS; r++) grid.push(new Array(COLS).fill(0));
  score = 0; lines = 0; level = 1; dropInterval = 1000; accumMs = 0;
  running = true; paused = false;
  activePiece = makePiece(); nextPiece = makePiece();
  hideEl('overlayStart'); hideEl('overlayGameOver'); hideEl('overlayPause');
  refreshHUD();
  cancelAnimationFrame(rafId);
  lastTs = performance.now();
  rafId  = requestAnimationFrame(loop);
}
function togglePause() {
  if (!running) return;
  paused = !paused;
  if (paused) {
    showEl('overlayPause');
  } else {
    hideEl('overlayPause');
    lastTs = performance.now(); accumMs = 0;
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
  }
}
function triggerGameOver() {
  running = false; cancelAnimationFrame(rafId); render();
  var best = lbBest();
  document.getElementById('finalScore').textContent   = score.toLocaleString();
  document.getElementById('newHighMsg').style.display = score > best ? 'block' : 'none';
  document.getElementById('playerName').value = '';
  showEl('btnSave'); showEl('btnSkip'); hideEl('btnAgain');
  showEl('overlayGameOver');
  setTimeout(function() { var el = document.getElementById('playerName'); if (el) el.focus(); }, 150);
}
function showEl(id) { var el = document.getElementById(id); if (el) el.style.display = 'flex'; }
function hideEl(id) { var el = document.getElementById(id); if (el) el.style.display = 'none'; }

/* ── Keyboard ───────────────────────────────────────────────────────────────── */
document.addEventListener('keydown', function(e) {
  if (e.key === 'p' || e.key === 'P') { togglePause(); return; }
  if (!running || paused) return;
  switch (e.key) {
    case 'ArrowLeft':  e.preventDefault(); doMoveLeft();  break;
    case 'ArrowRight': e.preventDefault(); doMoveRight(); break;
    case 'ArrowDown':  e.preventDefault(); doSoftDrop(); score++; accumMs = 0; refreshHUD(); break;
    case 'ArrowUp':    e.preventDefault(); doRotate();    break;
    case ' ':          e.preventDefault(); doHardDrop();  break;
  }
  render();
});

/* ── Touch / click controls ─────────────────────────────────────────────────── */
function bindAction(id, fn) {
  var el = document.getElementById(id);
  if (!el) return;
  function go(e) {
    e.preventDefault();
    if (!running || paused) return;
    fn(); render();
  }
  el.addEventListener('touchstart', go, { passive: false });
  el.addEventListener('click', go);
}
bindAction('mLeft',   doMoveLeft);
bindAction('mRight',  doMoveRight);
bindAction('mRotate', doRotate);
bindAction('mDrop',   doHardDrop);
bindAction('mDown', function() { doSoftDrop(); score++; accumMs = 0; refreshHUD(); });

/* ── Button wiring ──────────────────────────────────────────────────────────── */
document.getElementById('btnStart').addEventListener('click', startGame);
document.getElementById('btnResume').addEventListener('click', togglePause);
document.getElementById('btnSave').addEventListener('click', function() {
  lbAdd(document.getElementById('playerName').value, score, level);
  hideEl('btnSave'); hideEl('btnSkip'); showEl('btnAgain');
});
document.getElementById('btnSkip').addEventListener('click', function() {
  hideEl('btnSave'); hideEl('btnSkip'); showEl('btnAgain');
});
document.getElementById('btnAgain').addEventListener('click', startGame);
document.getElementById('playerName').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') document.getElementById('btnSave').click();
});

/* ── Resize handling ────────────────────────────────────────────────────────── */
var resizeTimer;
window.addEventListener('resize', function() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function() {
    var wasRunning = running;
    var wasPaused  = paused;
    if (wasRunning && !wasPaused) { paused = true; cancelAnimationFrame(rafId); }
    calcLayout();
    render();
    if (wasRunning && !wasPaused) {
      paused  = false;
      lastTs  = performance.now();
      accumMs = 0;
      rafId   = requestAnimationFrame(loop);
    }
  }, 120);
});

/* ── Init ───────────────────────────────────────────────────────────────────── */
calcLayout();
lbRender(lbLoad());
document.getElementById('bestDisplay').textContent = lbBest().toLocaleString();
// Draw blank grid before first game
drawBg();

}());
