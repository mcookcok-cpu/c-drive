// Format ukuran bytes jadi teks KB/MB/GB, prioritas satuan MB
function formatSize(bytes) {
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;

  if (bytes < kb) return bytes + ' B';
  if (bytes < mb) return (bytes / kb).toFixed(1) + ' KB';
  if (bytes < gb) return (bytes / mb).toFixed(1) + ' MB';
  return (bytes / gb).toFixed(2) + ' GB';
}

// Escape teks yang berasal dari server sebelum dimasukkan lewat innerHTML
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// ===================================================================================
// Upload Manager: upload chunked (potongan per potongan) yang mendukung banyak file
// sekaligus, dijalankan concurrent, serta bisa dijeda/dilanjutkan/dibatalkan per file.
//
// Kenapa chunked: file dipecah jadi potongan kecil (CHUNK_SIZE) dan dikirim satu-satu
// ke server. Server menyimpan tiap potongan yang masuk ke file ".part". Karena itu:
//   - Jeda (pause)  = klien cuma berhenti mengirim potongan berikutnya. Yang sudah
//                     terkirim tidak hilang / tidak perlu upload ulang dari nol.
//   - Lanjut (resume) = klien lanjut mengirim dari potongan berikutnya.
//   - Batal (cancel)  = server menghapus potongan yang sudah tersimpan.
//
// Catatan penting: ini berjalan selama halaman/tab ini tidak di-reload atau ditutup.
// Kalau kamu pindah ke folder lain lewat tautan biasa (yang me-reload halaman) atau
// menutup tab, browser akan menghentikan proses upload seperti upload web pada
// umumnya -- File yang sedang dibaca dari memori browser tidak bisa "disambung ulang"
// otomatis setelah reload. Selama tetap di halaman ini (scroll, buka Catatan/Editor,
// dsb tanpa reload), upload akan tetap jalan di background.
// ===================================================================================

const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB per potongan
const MAX_CONCURRENT_UPLOADS = 2;   // maksimal berapa FILE yang diupload bersamaan
const PIPELINE_DEPTH = 4;           // maksimal berapa POTONGAN dari 1 file yang dikirim
                                     // SEKALIGUS tanpa nunggu balasan potongan sebelumnya
                                     // (pipelining) -- ini yang bikin kecepatan upload
                                     // mendekati kecepatan upload biasa/non-chunked.
                                     // Server mendukung ini karena tiap potongan ditulis
                                     // langsung ke offset-nya masing2 (lihat app.py),
                                     // jadi potongan boleh sampai/selesai tidak berurutan.

const uploadQueue = []; // tiap item: {id, file, folder, name, size, received, status, _controllers}

const UPLOAD_STATUS_LABEL = {
  queued: 'Menunggu...',
  uploading: 'Mengupload...',
  paused: 'Dijeda',
  done: 'Selesai',
  error: 'Gagal',
  cancelled: 'Dibatalkan'
};

function genUploadId() {
  return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Dipanggil dari input file (tombol Upload utama & sidebar) -- masukkan file ke antrean
function queueUpload(files, folder) {
  if (!files || !files.length) return;

  for (const file of files) {
    uploadQueue.push({
      id: genUploadId(),
      file,
      folder,
      name: file.name,
      size: file.size,
      received: 0,
      status: 'queued'
    });
  }

  renderUploadManager();
  openUploadManager();
  processUploadQueue();
}

function activeUploadCount() {
  return uploadQueue.filter(u => u.status === 'uploading').length;
}

// Jalankan antrean sampai batas concurrency terpenuhi
function processUploadQueue() {
  while (activeUploadCount() < MAX_CONCURRENT_UPLOADS) {
    const next = uploadQueue.find(u => u.status === 'queued');
    if (!next) break;
    startUploadItem(next);
  }
}

async function startUploadItem(item) {
  item.status = 'uploading';
  renderUploadManager();

  try {
    const startRes = await fetch('/api/upload/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_id: item.id, name: item.name, folder: item.folder, size: item.size })
    });
    const startData = await startRes.json();
    if (!startRes.ok) throw new Error(startData.error || 'Gagal memulai upload');

    item.received = startData.received || 0;
    await uploadChunks(item);
  } catch (err) {
    if (item.status !== 'cancelled' && item.status !== 'paused') {
      item.status = 'error';
      item.errorMsg = err && err.message ? err.message : 'Upload gagal';
      renderUploadManager();
    }
  } finally {
    processUploadQueue();
  }
}

// Upload satu file dengan mengirim beberapa potongan SEKALIGUS (pipelining),
// pakai pola "worker pool": sampai PIPELINE_DEPTH worker jalan bersamaan,
// masing2 terus ambil potongan berikutnya yang belum dikirim sampai habis.
// Ini beda dari versi lama yang kirim 1 potongan, nunggu balasannya, baru
// kirim potongan berikutnya -- nunggu satu-satu itu yang bikin upload jauh
// lebih lambat dibanding upload biasa (round-trip tiap potongan numpuk).
async function uploadChunks(item) {
  let nextOffset = item.received; // byte berikutnya yang belum "diklaim" worker manapun
  let stopError = null;
  item._controllers = new Set();

  async function worker() {
    while (true) {
      if (item.status !== 'uploading' || stopError) return;
      if (nextOffset >= item.size) return;

      // Klaim potongan ini SEBELUM ada `await` apapun -- karena JS
      // single-threaded, ini aman dari worker lain yang lagi jalan bareng
      // (tidak ada celah buat dua worker ngeklaim offset yang sama).
      const offset = nextOffset;
      const end = Math.min(offset + CHUNK_SIZE, item.size);
      nextOffset = end;

      const blob = item.file.slice(offset, end);
      const buffer = await blob.arrayBuffer();

      const controller = new AbortController();
      item._controllers.add(controller);

      try {
        const res = await fetch('/api/upload/chunk/' + item.id, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Chunk-Offset': String(offset)
          },
          body: buffer,
          signal: controller.signal
        });
        item._controllers.delete(controller);

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Potongan file gagal diupload');

        // Tiap potongan ukurannya unik (tidak tumpang tindih) jadi aman dijumlah
        // langsung, walau balasannya nyampe tidak berurutan antar worker.
        item.received += (end - offset);
        renderUploadManager();
      } catch (err) {
        item._controllers.delete(controller);
        // Kalau ini gara2 kita sendiri yang batalin (pause/cancel), diamkan saja
        if (item.status === 'paused' || item.status === 'cancelled') return;
        stopError = err;
        return;
      }
    }
  }

  const remainingChunks = Math.max(1, Math.ceil((item.size - item.received) / CHUNK_SIZE));
  const workerCount = Math.min(PIPELINE_DEPTH, remainingChunks);
  await Promise.all(Array.from({ length: workerCount }, worker));

  if (item.status === 'paused' || item.status === 'cancelled') return;
  if (stopError) throw stopError;

  const finishRes = await fetch('/api/upload/finish/' + item.id, { method: 'POST' });
  const finishData = await finishRes.json();
  if (!finishRes.ok) throw new Error(finishData.error || 'Gagal menyelesaikan upload');

  item.status = 'done';
  renderUploadManager();

  // Kalau semua item di antrean sudah kelar (selesai/batal/gagal), refresh daftar
  // file di folder yang sedang dibuka -- tanpa reload halaman
  if (uploadQueue.every(u => ['done', 'cancelled', 'error'].includes(u.status))) {
    setTimeout(() => refreshCurrentList(), 700);
  }
}

function pauseUpload(id) {
  const item = uploadQueue.find(u => u.id === id);
  if (!item || item.status !== 'uploading') return;
  item.status = 'paused';
  // Beberapa potongan bisa lagi jalan bersamaan (pipelining) -- batalkan semuanya
  if (item._controllers) item._controllers.forEach(c => c.abort());
  renderUploadManager();
}

function resumeUpload(id) {
  const item = uploadQueue.find(u => u.id === id);
  if (!item || (item.status !== 'paused' && item.status !== 'error')) return;
  item.errorMsg = null;
  item.status = 'queued';
  renderUploadManager();
  processUploadQueue();
}

function cancelUpload(id) {
  const item = uploadQueue.find(u => u.id === id);
  if (!item) return;
  const wasActive = item.status === 'uploading';
  item.status = 'cancelled';
  if (item._controllers) item._controllers.forEach(c => c.abort());
  fetch('/api/upload/cancel/' + item.id, { method: 'POST' }).catch(() => {});
  renderUploadManager();
  if (wasActive) processUploadQueue();
}

function renderUploadManager() {
  const body = document.getElementById('uploadManagerBody');
  const countEl = document.getElementById('uploadManagerCount');
  if (!body) return;

  const activeCount = uploadQueue.filter(u => ['queued', 'uploading', 'paused'].includes(u.status)).length;
  if (countEl) countEl.textContent = activeCount > 0 ? '(' + activeCount + ')' : '';

  if (!uploadQueue.length) {
    body.innerHTML = '<div class="upload-manager-empty">Belum ada upload</div>';
    return;
  }

  body.innerHTML = uploadQueue.map(item => {
    const percent = item.size ? Math.round((item.received / item.size) * 100) : 0;
    const canPause = item.status === 'uploading';
    const canResume = item.status === 'paused' || item.status === 'error';
    const canCancel = ['queued', 'uploading', 'paused', 'error'].includes(item.status);
    const statusText = item.status === 'error' && item.errorMsg
      ? item.errorMsg
      : (UPLOAD_STATUS_LABEL[item.status] || '');

    return `
      <div class="upload-manager-item" data-status="${item.status}">
        <div class="upload-manager-item-top">
          <span class="upload-manager-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
          <span class="upload-manager-item-status">${escapeHtml(statusText)}</span>
        </div>
        <div class="upload-progress-bar">
          <div class="upload-progress-fill" style="width:${percent}%"></div>
        </div>
        <div class="upload-manager-item-bottom">
          <span>${formatSize(item.received)} / ${formatSize(item.size)} &middot; ${percent}%</span>
          <div class="upload-manager-item-actions">
            ${canPause ? `<button class="icon-btn" title="Jeda" onclick="pauseUpload('${item.id}')"><i class="bi bi-pause-fill"></i></button>` : ''}
            ${canResume ? `<button class="icon-btn" title="${item.status === 'error' ? 'Coba lagi' : 'Lanjutkan'}" onclick="resumeUpload('${item.id}')"><i class="bi ${item.status === 'error' ? 'bi-arrow-clockwise' : 'bi-play-fill'}"></i></button>` : ''}
            ${canCancel ? `<button class="icon-btn" title="Batal" onclick="cancelUpload('${item.id}')"><i class="bi bi-x-lg"></i></button>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

function openUploadManager() {
  const box = document.getElementById('uploadManager');
  if (box) {
    box.classList.add('show');
    box.classList.remove('collapsed');
    const chevron = document.getElementById('uploadManagerChevron');
    if (chevron) { chevron.classList.remove('bi-chevron-down'); chevron.classList.add('bi-chevron-up'); }
  }
}
function closeUploadManager() {
  const box = document.getElementById('uploadManager');
  if (box) box.classList.remove('show');
}
function toggleUploadManagerCollapse() {
  const box = document.getElementById('uploadManager');
  const chevron = document.getElementById('uploadManagerChevron');
  if (!box) return;
  box.classList.toggle('collapsed');
  if (chevron) {
    chevron.classList.toggle('bi-chevron-down');
    chevron.classList.toggle('bi-chevron-up');
  }
}

// Peringatkan sebelum menutup/reload tab kalau masih ada upload yang jalan/dijeda,
// supaya progress yang belum selesai tidak hilang tanpa sengaja.
window.addEventListener('beforeunload', (e) => {
  const active = uploadQueue.some(u => ['queued', 'uploading', 'paused'].includes(u.status));
  if (active) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Settings modal
function openSettings() {
  document.getElementById('settingsModal').classList.add('show');
}
function closeSettings() {
  document.getElementById('settingsModal').classList.remove('show');
}

// ===== Modal Sampah (Trash) =====
// Item yang dihapus disimpan dulu di server selama 7 hari (bisa dipulihkan)
// sebelum akhirnya dihapus permanen otomatis oleh server.
function openTrash() {
  toggleSidebar(false);
  document.getElementById('trashModal').classList.add('show');
  loadTrashList();
}

function closeTrash() {
  document.getElementById('trashModal').classList.remove('show');
}

function trashItemIcon(item) {
  if (item.is_dir) return 'bi-folder-fill';
  return 'bi-file-earmark-fill';
}

function loadTrashList() {
  const list = document.getElementById('trashList');
  list.innerHTML = '<div class="panel-loading">Memuat Sampah...</div>';

  fetch('/api/trash')
    .then(res => res.json())
    .then(data => {
      const items = data.items || [];

      if (!items.length) {
        list.innerHTML = '<div class="folder-picker-empty">Sampah kosong.</div>';
        return;
      }

      list.innerHTML = items.map(item => `
        <div class="trash-item">
          <div class="trash-item-icon"><i class="bi ${trashItemIcon(item)}"></i></div>
          <div class="trash-item-info">
            <div class="trash-item-name">${item.name}</div>
            <div class="trash-item-meta">
              ${item.is_dir ? 'Folder' : item.size_human} &middot; dihapus ${item.deleted_human}
              <br>${item.days_left > 0 ? 'Terhapus permanen dalam ' + item.days_left + ' hari' : 'Akan segera terhapus permanen'}
            </div>
          </div>
          <div class="trash-item-actions">
            <button class="icon-btn" title="Pulihkan" onclick="restoreTrashItem('${item.id}')"><i class="bi bi-arrow-counterclockwise"></i></button>
            <button class="icon-btn" title="Hapus permanen" onclick="deleteTrashItemPermanent('${item.id}')"><i class="bi bi-trash3"></i></button>
          </div>
        </div>
      `).join('');
    })
    .catch(() => {
      list.innerHTML = '<div class="folder-picker-empty">Gagal memuat Sampah.</div>';
    });
}

function restoreTrashItem(id) {
  fetch('/api/trash/restore/' + id, { method: 'POST' })
    .then(() => {
      loadTrashList();
      refreshCurrentList();
    });
}

function deleteTrashItemPermanent(id) {
  if (!confirm('Hapus item ini permanen? Tidak bisa dipulihkan lagi.')) return;
  fetch('/api/trash/delete/' + id, { method: 'POST' })
    .then(() => loadTrashList());
}

function emptyTrash() {
  if (!confirm('Kosongkan Sampah? Semua item akan dihapus permanen dan tidak bisa dipulihkan lagi.')) return;
  fetch('/api/trash/empty', { method: 'POST' })
    .then(() => loadTrashList());
}

// ===================================================================================
// Task Manager: progress untuk proses Salin / Pindah / Extract yang jalan di
// background thread di server. Beda dari Upload Manager (yang benar2 ngirim data
// potong2 dari browser), di sini prosesnya 100% terjadi di server -- browser cuma
// polling status/persentasenya tiap beberapa ratus ms lewat /api/task/status/<id>.
// Bisa di-minimize (collapse) kapan saja tanpa bikin prosesnya di server ikut berhenti.
// ===================================================================================

const taskQueue = []; // tiap item: {id, kind, label, percent, status, current_name, error, errors}
const TASK_POLL_MS = 600;

const TASK_KIND_LABEL = { copy: 'Menyalin', move: 'Memindahkan', extract: 'Mengekstrak' };
const TASK_STATUS_LABEL = {
  running: 'Diproses...',
  done: 'Selesai',
  error: 'Gagal',
  cancelled: 'Dibatalkan',
};

function registerTask(taskId, kind, label) {
  const entry = { id: taskId, kind, label, percent: 0, status: 'running', current_name: '', error: null, errors: [] };
  taskQueue.push(entry);
  renderTaskManager();
  openTaskManager();
  pollTask(entry);
}

function pollTask(entry) {
  fetch('/api/task/status/' + entry.id)
    .then(r => r.json())
    .then(data => {
      if (data.error && !data.status) {
        entry.status = 'error';
        entry.error = data.error;
        renderTaskManager();
        return;
      }
      entry.percent = data.percent;
      entry.status = data.status;
      entry.current_name = data.current_name;
      entry.error = data.error;
      entry.errors = data.errors || [];
      renderTaskManager();

      if (entry.status === 'running') {
        setTimeout(() => pollTask(entry), TASK_POLL_MS);
      } else {
        // Proses kelar (selesai/gagal/dibatalkan) -- refresh daftar file di folder
        // yang sedang dibuka biar hasilnya langsung kelihatan, tanpa reload halaman.
        setTimeout(() => refreshCurrentList(), 400);
      }
    })
    .catch(() => {
      // Koneksi sempat putus sesaat -- coba lagi, jangan langsung dianggap gagal
      setTimeout(() => pollTask(entry), TASK_POLL_MS);
    });
}

function cancelTask(id) {
  const entry = taskQueue.find(t => t.id === id);
  if (!entry || entry.status !== 'running') return;
  fetch('/api/task/cancel/' + id, { method: 'POST' }).catch(() => {});
}

function clearFinishedTasks() {
  for (let i = taskQueue.length - 1; i >= 0; i--) {
    if (taskQueue[i].status !== 'running') taskQueue.splice(i, 1);
  }
  renderTaskManager();
}

function renderTaskManager() {
  const body = document.getElementById('taskManagerBody');
  const countEl = document.getElementById('taskManagerCount');
  if (!body) return;

  const activeCount = taskQueue.filter(t => t.status === 'running').length;
  if (countEl) countEl.textContent = activeCount > 0 ? '(' + activeCount + ')' : '';

  if (!taskQueue.length) {
    body.innerHTML = '<div class="upload-manager-empty">Tidak ada proses</div>';
    return;
  }

  body.innerHTML = taskQueue.map(entry => {
    const verb = TASK_KIND_LABEL[entry.kind] || 'Memproses';
    const statusText = entry.status === 'error' && entry.error
      ? entry.error
      : (TASK_STATUS_LABEL[entry.status] || '');
    const extra = entry.errors && entry.errors.length ? ` (${entry.errors.length} item gagal)` : '';
    const detail = entry.status === 'running' && entry.current_name
      ? escapeHtml(entry.current_name)
      : (verb + ' ' + escapeHtml(entry.label));

    return `
      <div class="upload-manager-item" data-status="${entry.status}">
        <div class="upload-manager-item-top">
          <span class="upload-manager-item-name" title="${escapeHtml(entry.label)}">${verb} ${escapeHtml(entry.label)}</span>
          <span class="upload-manager-item-status">${escapeHtml(statusText)}${escapeHtml(extra)}</span>
        </div>
        <div class="upload-progress-bar">
          <div class="upload-progress-fill" style="width:${entry.percent}%"></div>
        </div>
        <div class="upload-manager-item-bottom">
          <span>${detail} &middot; ${entry.percent}%</span>
          <div class="upload-manager-item-actions">
            ${entry.status === 'running'
              ? `<button class="icon-btn" title="Batal" onclick="cancelTask('${entry.id}')"><i class="bi bi-x-lg"></i></button>`
              : `<button class="icon-btn" title="Hapus dari daftar" onclick="dismissTask('${entry.id}')"><i class="bi bi-check2"></i></button>`}
          </div>
        </div>
      </div>`;
  }).join('');
}

function dismissTask(id) {
  const idx = taskQueue.findIndex(t => t.id === id);
  if (idx !== -1) taskQueue.splice(idx, 1);
  renderTaskManager();
}

function openTaskManager() {
  const box = document.getElementById('taskManager');
  if (box) {
    box.classList.add('show');
    box.classList.remove('collapsed');
    const chevron = document.getElementById('taskManagerChevron');
    if (chevron) { chevron.classList.remove('bi-chevron-down'); chevron.classList.add('bi-chevron-up'); }
  }
}
function closeTaskManager() {
  const box = document.getElementById('taskManager');
  if (box) box.classList.remove('show');
}
function toggleTaskManagerCollapse() {
  const box = document.getElementById('taskManager');
  const chevron = document.getElementById('taskManagerChevron');
  if (!box) return;
  box.classList.toggle('collapsed');
  if (chevron) {
    chevron.classList.toggle('bi-chevron-down');
    chevron.classList.toggle('bi-chevron-up');
  }
}

// Dipanggil dari menu Extract per-file
function extractZip(path) {
  document.querySelectorAll('.dropdown.show').forEach(d => d.classList.remove('show'));

  fetch('/api/extract/start/' + encodeURI(path), { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      if (!data.ok) { alert(data.error || 'Gagal memulai ekstrak.'); return; }
      const label = path.split('/').pop();
      registerTask(data.task_id, 'extract', label);
    })
    .catch(() => alert('Gagal menghubungi server.'));

  return false;
}

// ===== Terminal SSH-style (PTY persisten di server, digambar via xterm.js) =====
// Beda dari CLI lama yang cuma "kirim satu perintah -> tunggu hasilnya": di sini kita
// buka satu sesi shell yang tetap hidup di server, layarnya digambar terus-menerus
// (streaming lewat SSE) persis kayak lagi ssh ke server dari terminal biasa -- jadi
// perintah seperti `top`, `tail -f`, atau `vim` juga jalan normal.
let sshTerm = null;
let sshFitAddon = null;
let sshTermId = null;
let sshEventSource = null;
let sshStarting = false;
let sshCtrlActive = false;
let sshAltActive = false;

// Ukuran font terminal bisa diubah (tombol zoom atau cubit dua jari) & diingat
// lewat localStorage, jadi tetap kepakai lain kali dibuka.
const SSH_FONT_MIN = 8;
const SSH_FONT_MAX = 24;
let sshFontSize = parseInt(localStorage.getItem('sshFontSize'), 10) || 11;
if (isNaN(sshFontSize)) sshFontSize = 11;
let sshPinchStartDist = null;
let sshPinchStartFontSize = null;

function openCli() {
  toggleSidebar(false);
  document.getElementById('cliModal').classList.add('show');
  ensureSshTerminal();
}

// Dipanggil dari menu titik tiga di path-bar ("Buka Terminal di sini"): matikan
// sesi shell lama (kalau ada) dan buka sesi baru yang cwd awalnya folder yang
// lagi dibuka saat ini (currentPath).
function openTerminalHere() {
  document.querySelectorAll('.dropdown.show').forEach(d => d.classList.remove('show'));

  fetch('/api/ssh/stop', { method: 'POST' }).catch(() => {}).finally(() => {
    if (sshEventSource) { sshEventSource.close(); sshEventSource = null; }
    sshTermId = null;
    if (sshTerm) { sshTerm.dispose(); sshTerm = null; sshFitAddon = null; }
    openCli();
  });
  return false;
}

function closeCli() {
  document.getElementById('cliModal').classList.remove('show');
}

function ensureSshTerminal() {
  const wrap = document.getElementById('cliTermWrap');
  if (!wrap) return;

  if (!sshTerm) {
    sshTerm = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: sshFontSize,
      fontFamily: "'Cascadia Code', Consolas, Menlo, monospace",
      theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3' },
      scrollback: 3000,
    });
    if (window.FitAddon) {
      sshFitAddon = new FitAddon.FitAddon();
      sshTerm.loadAddon(sshFitAddon);
    }
    sshTerm.open(wrap);
    initSshPinchZoom(wrap);

    sshTerm.onData((data) => {
      if (!sshTermId) return;
      let out = data;
      // Kalau tombol CTRL/ALT di keybar sedang aktif (sticky, seperti di Termux),
      // ubah karakter yang baru diketik jadi kombinasi Ctrl/Alt lalu matikan lagi togglenya.
      if ((sshCtrlActive || sshAltActive) && data.length === 1) {
        let ch = data;
        if (sshCtrlActive) {
          const code = ch.toUpperCase().charCodeAt(0);
          if (code >= 63 && code <= 95) ch = String.fromCharCode(code - 64); // A-Z, @, [, \, ], ^, _
          sshSetCtrl(false);
        }
        if (sshAltActive) {
          ch = '\x1b' + ch; // Alt+huruf = ESC diikuti huruf, sesuai konvensi terminal
          sshSetAlt(false);
        }
        out = ch;
      }
      sshSendInputRaw(out);
    });
  }

  setTimeout(() => {
    if (sshFitAddon) sshFitAddon.fit();
    if (!sshTermId && !sshStarting) startSshSession();
    updateCliKeybarPosition();
  }, 50);
}

function startSshSession() {
  sshStarting = true;
  const formData = new FormData();
  if (typeof currentPath !== 'undefined' && currentPath) formData.append('cwd', currentPath);

  fetch('/api/ssh/start', { method: 'POST', body: formData })
    .then(r => r.json())
    .then(data => {
      sshStarting = false;
      if (!data.ok) {
        sshTerm.writeln('\r\n[Gagal memulai sesi terminal: ' + (data.error || 'tidak diketahui') + ']');
        return;
      }
      sshTermId = data.term_id;
      sendSshResize();
      connectSshStream();
    })
    .catch(() => {
      sshStarting = false;
      if (sshTerm) sshTerm.writeln('\r\n[Gagal terhubung ke server (koneksi error)]');
    });
}

function connectSshStream() {
  if (sshEventSource) sshEventSource.close();

  sshEventSource = new EventSource('/api/ssh/stream?term_id=' + encodeURIComponent(sshTermId));

  sshEventSource.onmessage = (e) => {
    try {
      const binary = atob(e.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      sshTerm.write(new TextDecoder().decode(bytes));
    } catch (err) { /* abaikan potongan yang gagal di-decode */ }
  };

  sshEventSource.addEventListener('end', () => {
    if (sshTerm) sshTerm.writeln('\r\n\r\n[Sesi terminal berakhir]');
    if (sshEventSource) sshEventSource.close();
    sshEventSource = null;
    sshTermId = null;
  });

  sshEventSource.onerror = () => {
    // EventSource otomatis mencoba menyambung ulang sendiri kalau koneksinya putus sesaat
  };
}

function sendSshResize() {
  if (!sshTermId || !sshTerm) return;
  fetch('/api/ssh/resize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: sshTerm.rows, cols: sshTerm.cols }),
  }).catch(() => {});
}

window.addEventListener('resize', () => {
  const modal = document.getElementById('cliModal');
  if (sshFitAddon && modal && modal.classList.contains('show')) {
    sshFitAddon.fit();
    sendSshResize();
  }
});

// Bikin cli-keybar (ESC/CTRL/ALT/panah dll) tetap nempel di atas keyboard HP yang
// muncul, bukan ketutupan/kedorong ke bawah layar. visualViewport ngasih tinggi
// layar yang beneran kelihatan (di luar area keyboard), jadi selisihnya kita
// pakai buat naikkan posisi "bottom" keybar-nya.
function updateCliKeybarPosition() {
  const keybar = document.getElementById('cliKeybar');
  const modal = document.getElementById('cliModal');
  if (!keybar || !modal || !modal.classList.contains('show')) return;
  if (!window.visualViewport) return;
  const vv = window.visualViewport;
  const keyboardHeight = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  keybar.style.bottom = keyboardHeight + 'px';
  if (sshFitAddon) sshFitAddon.fit();
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateCliKeybarPosition);
  window.visualViewport.addEventListener('scroll', updateCliKeybarPosition);
}

// Kirim data mentah ke sesi PTY (dipakai baik oleh keyboard beneran maupun tombol keybar)
function sshSendInputRaw(data) {
  if (!sshTermId) return;
  fetch('/api/ssh/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  }).catch(() => {});
}

// Tombol keybar (ESC, TAB, panah, HOME/END/PGUP/PGDN) -- kirim escape sequence langsung
function sshSendKey(seq) {
  sshSendInputRaw(seq);
  if (sshTerm) sshTerm.focus();
}

function sshSetCtrl(on) {
  sshCtrlActive = on;
  const btn = document.getElementById('cliCtrlBtn');
  if (btn) btn.classList.toggle('active', on);
}
function sshSetAlt(on) {
  sshAltActive = on;
  const btn = document.getElementById('cliAltBtn');
  if (btn) btn.classList.toggle('active', on);
}
function sshToggleCtrl() { sshSetCtrl(!sshCtrlActive); if (sshTerm) sshTerm.focus(); }
function sshToggleAlt() { sshSetAlt(!sshAltActive); if (sshTerm) sshTerm.focus(); }

// Ubah ukuran font terminal (dipakai tombol zoom & cubit dua jari), lalu
// sesuaikan ulang jumlah baris/kolom PTY-nya (fit + kirim resize ke server).
function sshApplyFontSize(size) {
  const next = Math.min(SSH_FONT_MAX, Math.max(SSH_FONT_MIN, Math.round(size)));
  if (next === sshFontSize) return;
  sshFontSize = next;
  localStorage.setItem('sshFontSize', String(sshFontSize));
  if (sshTerm) sshTerm.options.fontSize = sshFontSize;
  if (sshFitAddon) sshFitAddon.fit();
  sendSshResize();
}

function sshZoomIn() { sshApplyFontSize(sshFontSize + 1); }
function sshZoomOut() { sshApplyFontSize(sshFontSize - 1); }

function sshTouchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

// Cubit dua jari (pinch) di area terminal buat perbesar/perkecil font, mirip
// aplikasi terminal di HP pada umumnya.
function initSshPinchZoom(wrap) {
  wrap.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      sshPinchStartDist = sshTouchDist(e.touches);
      sshPinchStartFontSize = sshFontSize;
    }
  }, { passive: true });

  wrap.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && sshPinchStartDist) {
      e.preventDefault();
      const dist = sshTouchDist(e.touches);
      const scale = dist / sshPinchStartDist;
      sshApplyFontSize(sshPinchStartFontSize * scale);
    }
  }, { passive: false });

  wrap.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) sshPinchStartDist = null;
  });
  wrap.addEventListener('touchcancel', () => { sshPinchStartDist = null; });
}

// Fullscreen: perbesar panel SSH Terminal memenuhi layar (berguna khusus di HP)
function toggleCliFullscreen() {
  const box = document.getElementById('cliBox');
  const icon = document.getElementById('cliFullscreenIcon');
  const isFull = box.classList.toggle('fullscreen');
  icon.className = isFull ? 'bi bi-fullscreen-exit' : 'bi bi-arrows-fullscreen';
  setTimeout(() => {
    if (sshFitAddon) sshFitAddon.fit();
    sendSshResize();
    updateCliKeybarPosition();
  }, 260);
}

// Urutkan A-Z / Z-A, folder tetap selalu di atas file
// Status awal disamakan dengan preferensi "Urutkan Z-A secara default" di menu Pengaturan
let sortAsc = document.getElementById('list') && document.getElementById('list').dataset.sortDesc === '1' ? false : true;
function toggleSort() {
  sortAsc = !sortAsc;

  const list = document.getElementById('list');
  const items = Array.from(list.children);

  items.sort((a, b) => {
    const aDir = a.dataset.isdir === 'True' || a.dataset.isdir === 'true';
    const bDir = b.dataset.isdir === 'True' || b.dataset.isdir === 'true';

    if (aDir !== bDir) return aDir ? -1 : 1;

    const cmp = a.dataset.name.localeCompare(b.dataset.name);
    return sortAsc ? cmp : -cmp;
  });

  items.forEach(i => list.appendChild(i));

  const icon = document.getElementById('sortIcon');
  if (icon) icon.className = sortAsc ? 'bi bi-sort-alpha-down' : 'bi bi-sort-alpha-up';
}

// Search filter
const search = document.getElementById('search');
if (search) {
  search.addEventListener('input', () => {
    const q = search.value.toLowerCase();
    document.querySelectorAll('.file-card').forEach(c => {
      c.style.display = c.dataset.name.includes(q) ? '' : 'none';
    });
  });
}

const IMAGE_EXT = ['jpg','jpeg','png','gif','webp'];
const VIDEO_EXT = ['mp4','mkv','avi','mov','webm'];

// Open image preview / video player when tapping the row (not for folders/others)
function openItem(rowInfoEl) {
  const card = rowInfoEl.closest('.file-card');

  // Saat mode seleksi aktif, tap row = toggle checkbox, bukan buka/navigasi
  if (selectMode) {
    const cb = card.querySelector('.item-checkbox');
    cb.checked = !cb.checked;
    onCheckboxChange();
    return;
  }

  const isDir = card.dataset.isdir === 'True' || card.dataset.isdir === 'true';
  const ext = card.dataset.ext;
  const path = card.dataset.path;

  if (isDir) {
    loadPage('/browse/' + path);
    return;
  }

  if (IMAGE_EXT.includes(ext)) {
    openPreview('<img src="/view/' + path + '">');
    return;
  }

  if (VIDEO_EXT.includes(ext)) {
    openPreview('<video src="/view/' + path + '" controls autoplay playsinline></video>');
    return;
  }

  // Other file types: open in new tab
  window.open('/view/' + path, '_blank');
}

function openPreview(html) {
  const modal = document.getElementById('previewModal');
  const body = document.getElementById('modalBody');
  body.innerHTML = html;
  modal.classList.add('show');
}

function closePreview() {
  const modal = document.getElementById('previewModal');
  const body = document.getElementById('modalBody');
  body.innerHTML = '';
  modal.classList.remove('show');
}

// Kebab dropdown menu
function toggleMenu(e, btn) {
  e.stopPropagation();
  const dropdown = btn.parentElement.querySelector('.dropdown');
  const wasOpen = dropdown.classList.contains('show');

  document.querySelectorAll('.dropdown.show').forEach(d => d.classList.remove('show'));
  if (wasOpen) return;

  dropdown.classList.add('show');
  positionDropdown(dropdown, btn);
}

// Menempatkan dropdown sebagai popup fixed, dipusatkan pada baris (file-card) yang
// diketuk, dan diutamakan membuka ke ATAS baris tersebut (bukan selalu nempel di
// bawah tombol titik tiga) supaya tidak kepotong/terlalu turun kalau barisnya
// dekat bagian bawah layar.
function positionDropdown(dropdown, btn) {
  const margin = 8;
  const card = btn.closest('.file-card') || btn;
  const anchor = card.getBoundingClientRect();
  const menuRect = dropdown.getBoundingClientRect();

  const menuWidth = menuRect.width || 200;
  const menuHeight = menuRect.height || 260;

  // Pusatkan secara horizontal terhadap baris yang dipilih
  let left = anchor.left + anchor.width / 2 - menuWidth / 2;
  left = Math.min(Math.max(margin, left), window.innerWidth - menuWidth - margin);

  // Utamakan buka ke atas, mengambang tepat di atas baris
  let top = anchor.top - menuHeight - margin;
  if (top < margin) {
    // Kalau ruang di atas tidak cukup, baru buka ke bawah
    top = anchor.bottom + margin;
    top = Math.min(top, window.innerHeight - menuHeight - margin);
    top = Math.max(margin, top);
  }

  dropdown.style.left = left + 'px';
  dropdown.style.top = top + 'px';
}

document.addEventListener('click', () => {
  document.querySelectorAll('.dropdown.show').forEach(d => d.classList.remove('show'));
});

function confirmDelete(path) {
  const skipConfirm = localStorage.getItem('skipDeleteConfirm') === '1';
  if (skipConfirm || confirm('Hapus item ini?')) {
    fetch('/delete/' + path, { method: 'POST' }).then(() => refreshCurrentList());
  }
  return false;
}

// ===== Opsi: konfirmasi sebelum hapus file (default: aktif) =====
function toggleConfirmDelete(checked) {
  // checkbox "Konfirmasi sebelum hapus file" checked = tetap tanya, unchecked = langsung hapus
  localStorage.setItem('skipDeleteConfirm', checked ? '0' : '1');
}

(function initConfirmDeleteSetting() {
  const toggle = document.getElementById('confirmDeleteToggle');
  if (!toggle) return;
  toggle.checked = localStorage.getItem('skipDeleteConfirm') !== '1';
})();

// ===== Opsi: bungkus baris panjang di editor kode (default: aktif) =====
function applyWordWrap(wrap) {
  const textarea = document.getElementById('scratchTextarea');
  const highlight = document.getElementById('scratchHighlight');
  if (textarea) textarea.classList.toggle('no-wrap', !wrap);
  if (highlight) highlight.classList.toggle('no-wrap', !wrap);
  // Mode wrap berubah = jumlah baris visual per baris logis ikut berubah,
  // jadi gutter harus dihitung ulang biar nomornya tetap pas.
  updateEditorGutter();
}

function toggleWordWrap(checked) {
  localStorage.setItem('editorWordWrap', checked ? '1' : '0');
  applyWordWrap(checked);
}

(function initWordWrapSetting() {
  const saved = localStorage.getItem('editorWordWrap');
  const wrap = saved === null ? true : saved === '1';
  const toggle = document.getElementById('wordWrapToggle');
  if (toggle) toggle.checked = wrap;
  applyWordWrap(wrap);
})();

// Sidebar drawer
function toggleSidebar(open) {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  sidebar.classList.toggle('show', open);
  overlay.classList.toggle('show', open);
}

// Folder saat ini, dipakai untuk upload
const mainUploadForm = document.getElementById('mainUploadForm');
let currentPath = mainUploadForm ? mainUploadForm.dataset.current : '';

// Upload dari tombol utama "Upload"
const mainUploadInput = document.getElementById('mainUploadInput');
if (mainUploadInput) {
  mainUploadInput.addEventListener('change', () => {
    queueUpload(mainUploadInput.files, currentPath);
    mainUploadInput.value = '';
  });
}

// Upload from sidebar "Upload" item
const sidebarUpload = document.getElementById('sidebarUpload');
if (sidebarUpload) {
  sidebarUpload.addEventListener('change', () => {
    if (!sidebarUpload.files.length) return;
    toggleSidebar(false);
    queueUpload(sidebarUpload.files, currentPath);
    sidebarUpload.value = '';
  });
}

// ===================================================================================
// Navigasi tanpa reload halaman (fetch + tukar isi DOM + history.pushState).
//
// Kenapa: upload (dan panel Catatan/Editor yang lagi kebuka) itu status-nya cuma
// hidup di memori JavaScript tab ini. Reload penuh = semuanya hilang. Jadi navigasi
// antar folder (buka folder, tombol "Kembali", dst) dan aksi seperti hapus/ganti
// nama/pindah/salin/buat folder sekarang dilakukan lewat fetch() lalu cuma menukar
// bagian breadcrumb + daftar file, bukan reload dokumen dari nol.
// ===================================================================================

function pathFromBrowseUrl(url) {
  const clean = url.split('?')[0].split('#')[0];
  if (clean === '/' || clean === '') return '';
  const m = clean.match(/^\/browse\/?(.*)$/);
  if (m) return decodeURIComponent(m[1] || '');
  return currentPath; // url di luar /browse -- current dianggap tidak berubah
}

// Ambil halaman lain (folder lain / current folder lagi) lewat fetch, lalu tukar
// cuma bagian breadcrumb (.path-bar) dan daftar file (#list), tanpa reload dokumen.
async function loadPage(url, { pushHistory = true } = {}) {
  let html;
  try {
    const res = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!res.ok) { window.location.href = url; return; }
    html = await res.text();
  } catch (err) {
    window.location.href = url; // fallback: kalau fetch gagal, navigasi biasa saja
    return;
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const newPathBar = doc.querySelector('.path-bar');
  const newList = doc.querySelector('#list');
  const curPathBar = document.querySelector('.path-bar');
  const curList = document.getElementById('list');

  if (newPathBar && curPathBar) curPathBar.innerHTML = newPathBar.innerHTML;
  if (newList && curList) {
    curList.innerHTML = newList.innerHTML;
    curList.dataset.sortDesc = newList.dataset.sortDesc || '0';
  }

  currentPath = pathFromBrowseUrl(url);
  if (mainUploadForm) mainUploadForm.dataset.current = currentPath;
  const mkdirCurrentInput = document.querySelector('#mkdirBox input[name="current"]');
  if (mkdirCurrentInput) mkdirCurrentInput.value = currentPath;

  // Daftar file berubah total -- keluar dari mode seleksi biar tidak nyangkut
  if (typeof selectMode !== 'undefined' && selectMode) exitSelectMode();

  // Bersihkan filter pencarian supaya file di folder baru tidak ikut ke-hide
  const searchBox = document.getElementById('search');
  if (searchBox) searchBox.value = '';

  // Sinkronkan ulang status urutan A-Z/Z-A dengan data folder yang baru dimuat
  if (curList) {
    sortAsc = curList.dataset.sortDesc === '1' ? false : true;
    const icon = document.getElementById('sortIcon');
    if (icon) icon.className = 'bi ' + (sortAsc ? 'bi-sort-alpha-down' : 'bi-sort-alpha-up');
  }

  if (pushHistory) history.pushState({ ajaxNav: true }, '', url);
  window.scrollTo(0, 0);
}

// Muat ulang cuma daftar file di folder yang sedang dibuka (dipakai setelah
// hapus/ganti nama/pindah/salin/buat folder), tanpa reload & tanpa nambah histori.
function refreshCurrentList() {
  return loadPage(window.location.pathname + window.location.search, { pushHistory: false });
}

// Cegat klik ke tautan navigasi folder (buka folder di dropdown, tombol "Kembali",
// dan "Terbaru" di sidebar) supaya lewat loadPage(), bukan navigasi penuh browser.
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href^="/browse/"], a[href="/"]');
  if (!link || link.target === '_blank') return;
  e.preventDefault();
  toggleSidebar(false);
  loadPage(link.getAttribute('href'));
});

// Tombol back/forward browser
window.addEventListener('popstate', () => {
  loadPage(window.location.pathname + window.location.search, { pushHistory: false });
});

// Form "Urutkan Z-A secara default" di Setelan -- awalnya native submit (reload penuh)
const sortForm = document.getElementById('sortForm');
if (sortForm) {
  sortForm.addEventListener('submit', (e) => {
    e.preventDefault();
    fetch('/settings/sort', { method: 'POST', body: new FormData(sortForm) })
      .then(() => refreshCurrentList());
  });
}
// Form "Buat folder baru" -- awalnya native <form> (reload penuh), sekarang lewat
// fetch supaya tidak ikut membatalkan upload yang lagi jalan
const mkdirBox = document.getElementById('mkdirBox');
if (mkdirBox) {
  mkdirBox.addEventListener('submit', (e) => {
    e.preventDefault();
    const formData = new FormData(mkdirBox);
    fetch('/mkdir', { method: 'POST', body: formData })
      .then(() => {
        mkdirBox.classList.remove('show');
        mkdirBox.reset();
        refreshCurrentList();
      });
  });
}

// Rename via dropdown "Ganti nama"
function renamePrompt(path, oldName) {
  const newName = prompt('Ganti nama menjadi:', oldName);
  if (newName && newName !== oldName) {
    const formData = new FormData();
    formData.append('old', path);
    formData.append('new', newName);
    fetch('/rename', { method: 'POST', body: formData })
      .then(() => refreshCurrentList());
  }
  return false;
}

// Mode tempel untuk "Pindah" / "Salin": pilih item -> disimpan di clipboard ->
// pindah/masuk ke folder tujuan -> tekan "Tempel di sini".
const clipboard = { items: [], action: null };

function cutOrCopyItem(path, name, action) {
  clipboard.items = [path];
  clipboard.action = action;
  updateClipboardBar();
  return false;
}

function cutOrCopySelection(action) {
  const items = getSelectedPaths();
  if (!items.length) return;

  clipboard.items = items;
  clipboard.action = action;
  exitSelectMode();
  updateClipboardBar();
}

function updateClipboardBar() {
  const bar = document.getElementById('clipboardBar');
  if (!bar) return;
  const info = document.getElementById('clipboardInfo');

  if (!clipboard.items.length) {
    bar.classList.remove('show');
    return;
  }

  const verb = clipboard.action === 'move' ? 'Memindahkan' : 'Menyalin';
  info.textContent = verb + ' ' + clipboard.items.length + ' item \u2014 buka folder tujuan lalu Tempel';
  bar.classList.add('show');
}

function cancelClipboard() {
  clipboard.items = [];
  clipboard.action = null;
  updateClipboardBar();
}

function pasteHere() {
  if (!clipboard.items.length) return;
  const items = clipboard.items;
  const action = clipboard.action;
  const destFolder = currentPath;

  const checkData = new FormData();
  items.forEach(p => checkData.append('items', p));
  checkData.append('dest_folder', destFolder);

  fetch('/api/check-names', { method: 'POST', body: checkData })
    .then(r => r.json())
    .then(data => {
      const proceed = (overwrite) => {
        const formData = new FormData();
        formData.append('action', action);
        items.forEach(p => formData.append('items', p));
        formData.append('dest_folder', destFolder);
        formData.append('overwrite', overwrite ? '1' : '0');

        fetch('/api/batch/start', { method: 'POST', body: formData })
          .then(r => r.json())
          .then(data => {
            if (!data.ok) { alert(data.error || 'Gagal memulai proses.'); return; }
            const label = items.length === 1 ? items[0].split('/').pop() : (items.length + ' item');
            registerTask(data.task_id, action, label);
          })
          .catch(() => alert('Gagal menghubungi server.'));

        cancelClipboard();
      };

      if (data.conflicts && data.conflicts.length) {
        askOverwrite(data.conflicts).then(choice => {
          if (choice === 'cancel') return; // batal total, clipboard tetap tersimpan biar bisa dicoba lagi
          proceed(choice === 'overwrite');
        });
      } else {
        proceed(false);
      }
    });
}

// Modal 3 pilihan saat nama bentrok: Batal / Simpan salinan / Timpa
let overwriteResolver = null;

function askOverwrite(names) {
  return new Promise(resolve => {
    overwriteResolver = resolve;
    document.getElementById('overwriteMessage').textContent =
      names.join(', ') + ' sudah ada di folder ini. Timpa file itu, atau simpan sebagai salinan baru?';
    document.getElementById('overwriteModal').classList.add('show');
  });
}

function resolveOverwrite(choice) {
  document.getElementById('overwriteModal').classList.remove('show');
  if (overwriteResolver) {
    const resolve = overwriteResolver;
    overwriteResolver = null;
    resolve(choice);
  }
}

// ===== Mode seleksi (checkbox multi-pilih untuk Pindah / Salin / Hapus) =====
let selectMode = false;
let longPressTimer = null;

function toggleSelectMode() {
  if (selectMode) {
    exitSelectMode();
  } else {
    enterSelectMode();
  }
}

function enterSelectMode() {
  selectMode = true;
  document.getElementById('list').classList.add('select-mode');
  document.getElementById('selectionBar').classList.add('show');
  const selectBtn = document.getElementById('selectBtn');
  if (selectBtn) selectBtn.classList.add('active');
  document.body.classList.add('select-mode-active');
  updateSelectionCount();
}

function exitSelectMode() {
  selectMode = false;
  document.getElementById('list').classList.remove('select-mode');
  document.getElementById('selectionBar').classList.remove('show');
  const selectBtn = document.getElementById('selectBtn');
  if (selectBtn) selectBtn.classList.remove('active');
  document.body.classList.remove('select-mode-active');
  document.querySelectorAll('.item-checkbox:checked').forEach(cb => cb.checked = false);
  const selectAllCb = document.getElementById('selectAllCb');
  if (selectAllCb) selectAllCb.checked = false;
}

function onCheckboxChange() {
  updateSelectionCount();
}

function updateSelectionCount() {
  const n = getSelectedPaths().length;
  document.getElementById('selectionCount').textContent = n + ' dipilih';
}

function getSelectedPaths() {
  return Array.from(document.querySelectorAll('.item-checkbox:checked'))
    .map(cb => cb.closest('.file-card').dataset.path);
}

function toggleSelectAll(cb) {
  document.querySelectorAll('.file-card').forEach(card => {
    if (card.style.display === 'none') return; // hormati filter pencarian
    card.querySelector('.item-checkbox').checked = cb.checked;
  });
  updateSelectionCount();
}

function batchDelete() {
  const items = getSelectedPaths();
  if (!items.length) return;

  if (!confirm('Hapus ' + items.length + ' item terpilih?')) return;

  const formData = new FormData();
  items.forEach(p => formData.append('items', p));

  fetch('/batch/delete', { method: 'POST', body: formData })
    .then(() => {
      exitSelectMode();
      refreshCurrentList();
    });
}

// ===== Panel Kontrol (sidebar): accordion =====
function togglePanel(id) {
  const body = document.getElementById(id);
  const chev = document.getElementById('chev-' + id);
  const isOpen = body.classList.toggle('open');
  chev.style.transform = isOpen ? 'rotate(180deg)' : 'rotate(0deg)';

  if (isOpen) {
    if (id === 'panelCrypto' && !cryptoLoaded) loadCrypto();
    if (id === 'panelWeather' && !weatherLoaded) loadWeather();
    if (id === 'panelServer' && !servicesLoaded) loadServices();
    if (id === 'panelNetwork' && !networkLoaded) loadNetwork();
    if (id === 'panelSecurity' && !securityLoaded) loadSecurity();
    if (id === 'panelDeps' && !depsLoaded) loadDeps();
  }
}

// ===== Monitor Sistem (RAM/CPU) + Boost =====
function gaugeClass(percent) {
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warn';
  return '';
}

function refreshSystemStats() {
  fetch('/api/system')
    .then(r => r.json())
    .then(data => {
      if (!data.available) {
        document.getElementById('ramSub').textContent = data.message || 'Monitor tidak tersedia';
        return;
      }

      const ramFill = document.getElementById('ramFill');
      const ramPercent = data.ram.percent;
      ramFill.style.width = ramPercent + '%';
      ramFill.className = 'mini-gauge-fill ' + gaugeClass(ramPercent);
      document.getElementById('ramPercentText').textContent = ramPercent + '%';
      document.getElementById('ramSub').textContent =
        data.ram.used_gb + ' GB / ' + data.ram.total_gb + ' GB terpakai · proses ini: ' + data.process_rss_mb + ' MB';

      const cpuFill = document.getElementById('cpuFill');
      cpuFill.style.width = data.cpu_percent + '%';
      document.getElementById('cpuPercentText').textContent = data.cpu_percent + '%';

      const swapGauge = document.getElementById('swapGauge');
      if (data.swap && data.swap.active) {
        swapGauge.style.display = '';
        const swapPercent = data.swap.percent;
        const swapFill = document.getElementById('swapFill');
        swapFill.style.width = swapPercent + '%';
        swapFill.className = 'mini-gauge-fill swap ' + gaugeClass(swapPercent);
        document.getElementById('swapPercentText').textContent = swapPercent + '%';
        document.getElementById('swapSub').textContent =
          data.swap.used_gb + ' GB / ' + data.swap.total_gb + ' GB terpakai';
      } else {
        swapGauge.style.display = 'none';
      }

      const zramRow = document.getElementById('zramRow');
      if (data.zram && data.zram.length) {
        zramRow.style.display = '';
        const summary = data.zram.map(z => {
          let s = z.name + ': ' + z.used_mb + ' MB';
          if (z.ratio) s += ' (rasio ' + z.ratio + 'x)';
          return s;
        }).join(' · ');
        document.getElementById('zramText').textContent = summary;
      } else {
        zramRow.style.display = 'none';
      }

      const batteryGauge = document.getElementById('batteryGauge');
      if (data.battery) {
        batteryGauge.style.display = '';
        const pct = data.battery.percent;
        const batteryFill = document.getElementById('batteryFill');
        batteryFill.style.width = pct + '%';
        batteryFill.className = 'mini-gauge-fill battery ' + (data.battery.plugged ? '' : gaugeClass(100 - pct));
        document.getElementById('batteryPercentText').textContent = pct + '%';

        const icon = document.getElementById('batteryIcon');
        icon.className = data.battery.plugged
          ? 'bi bi-lightning-charge-fill'
          : (pct >= 90 ? 'bi bi-battery-full' : pct >= 40 ? 'bi bi-battery-half' : 'bi bi-battery');

        let sub = data.battery.plugged ? 'Mengisi daya' : 'Menggunakan baterai';
        if (data.battery.time_left) sub += ' · sisa ' + data.battery.time_left;
        document.getElementById('batterySub').textContent = sub;
      } else {
        batteryGauge.style.display = 'none';
      }

      const uptimeEl = document.getElementById('sysUptime');
      if (uptimeEl) uptimeEl.textContent = data.uptime || '\u2014';

      const procList = document.getElementById('sysProcList');
      if (procList && data.top_processes) {
        procList.innerHTML = '';
        const label = document.createElement('div');
        label.className = 'sys-proc-label';
        label.textContent = 'Proses RAM tertinggi';
        procList.appendChild(label);

        data.top_processes.forEach(p => {
          const row = document.createElement('div');
          row.className = 'sys-proc-row';
          row.innerHTML =
            '<span class="sys-proc-name">' + escapeHtml(p.name) + '</span>' +
            '<span class="sys-proc-ram">' + p.ram_percent + '%</span>';
          procList.appendChild(row);
        });
      }
    })
    .catch(() => {
      document.getElementById('ramSub').textContent = 'Gagal memuat data sistem';
    });
}

function boostMemory() {
  const btn = document.getElementById('boostBtn');
  const resultEl = document.getElementById('boostResult');

  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Membersihkan...';

  fetch('/api/system/boost', { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      if (!data.available) {
        resultEl.textContent = data.message || 'Boost tidak tersedia';
      } else {
        resultEl.textContent =
          'Selesai: ' + data.objects_collected + ' objek dibersihkan, ~' + data.freed_mb + ' MB terlepas dari proses ini.';
      }
      refreshSystemStats();
    })
    .catch(() => { resultEl.textContent = 'Boost gagal, coba lagi.'; })
    .finally(() => {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    });
}

// Muat monitor sistem begitu halaman dibuka, lalu refresh berkala
if (document.getElementById('ramFill')) {
  refreshSystemStats();
  setInterval(refreshSystemStats, 8000);
}

// ===== Manajemen Server (restart app + kelola service systemd) =====
function restartApp() {
  if (!confirm('Restart aplikasi ini sekarang? Koneksi akan terputus sebentar.')) return;

  const resultEl = document.getElementById('restartAppResult');
  resultEl.textContent = 'Mengirim perintah restart...';

  fetch('/api/server/restart-app', { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      resultEl.textContent = data.message || 'Restart dikirim.';
      setTimeout(() => { window.location.reload(); }, 4000);
    })
    .catch(() => { resultEl.textContent = 'Gagal mengirim perintah restart.'; });
}

let servicesLoaded = false;

function loadServices() {
  fetch('/api/services')
    .then(r => r.json())
    .then(data => {
      servicesLoaded = true;
      renderFeaturedServices(data.featured || []);
      renderOtherServices(data.others || []);
    })
    .catch(() => {
      document.getElementById('featuredServicesList').innerHTML = '<div class="panel-loading">Gagal memuat service</div>';
      document.getElementById('servicesList').innerHTML = '';
    });
}

// Service unggulan: baris ringkas dengan satu toggle on/off (bukan 3 tombol)
function renderFeaturedServices(services) {
  const wrap = document.getElementById('featuredServicesList');
  wrap.innerHTML = '';

  services.forEach(s => {
    const active = s.status === 'active';
    const row = document.createElement('div');
    row.className = 'featured-service-item';
    row.innerHTML =
      '<span class="featured-service-name">' + escapeHtml(s.label) + '</span>' +
      '<label class="featured-service-switch">' +
        '<input type="checkbox" ' + (active ? 'checked' : '') + ' onchange="featuredServiceToggle(\'' + s.name + '\', this)">' +
      '</label>';
    wrap.appendChild(row);
  });
}

function featuredServiceToggle(name, checkbox) {
  const wantOn = checkbox.checked;
  checkbox.disabled = true;

  fetch('/api/services/' + name + '/' + (wantOn ? 'start' : 'stop'), { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      if (!data.ok) {
        alert(data.message || 'Gagal mengubah status service');
        checkbox.checked = !wantOn; // gagal, balikin posisi toggle
      }
    })
    .catch(() => {
      alert('Gagal menghubungi server');
      checkbox.checked = !wantOn;
    })
    .finally(() => { checkbox.disabled = false; });
}

// Service lainnya: daftar lengkap dengan tombol start/stop/restart, di dalam sub-panel yang bisa dibuka/tutup
function renderOtherServices(services) {
  const list = document.getElementById('servicesList');
  list.innerHTML = '';

  const countEl = document.getElementById('otherServicesCount');
  if (countEl) countEl.textContent = services.length ? '(' + services.length + ')' : '';

  if (!services.length) {
    list.innerHTML = '<div class="note-empty">Tidak ada service lain terdeteksi di /etc/init.d perangkat ini</div>';
    return;
  }

  services.forEach(s => {
    const row = document.createElement('div');
    row.className = 'service-item';
    row.innerHTML =
      '<div class="service-info">' +
        '<span class="service-name">' + escapeHtml(s.label) + '</span>' +
        '<span class="service-status ' + serviceStatusClass(s.status) + '">' + escapeHtml(s.status) + '</span>' +
      '</div>' +
      '<div class="service-actions">' +
        '<button class="note-action" title="Start" onclick="serviceAction(\'' + s.name + '\', \'start\', this)"><i class="bi bi-play-fill"></i></button>' +
        '<button class="note-action" title="Stop" onclick="serviceAction(\'' + s.name + '\', \'stop\', this)"><i class="bi bi-stop-fill"></i></button>' +
        '<button class="note-action" title="Restart" onclick="serviceAction(\'' + s.name + '\', \'restart\', this)"><i class="bi bi-arrow-clockwise"></i></button>' +
      '</div>';
    list.appendChild(row);
  });
}

function serviceStatusClass(status) {
  if (status === 'active') return 'up';
  if (status === 'failed') return 'down';
  return '';
}

function serviceAction(name, action, btn) {
  const group = btn.closest('.service-item');
  group.style.opacity = '.6';

  fetch('/api/services/' + name + '/' + action, { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      if (!data.ok) alert(data.message || 'Gagal menjalankan aksi service');
      loadServices();
    })
    .catch(() => { alert('Gagal menghubungi server'); })
    .finally(() => { group.style.opacity = '1'; });
}

// ===== Aplikasi & Dependensi =====
let depsLoaded = false;

function loadDeps() {
  const box = document.getElementById('depsBox');

  fetch('/api/system/dependencies')
    .then(r => r.json())
    .then(data => {
      depsLoaded = true;

      const pkgRows = (data.packages || []).map(p => {
        const statusCls = p.installed ? 'up' : 'down';
        const statusText = p.installed ? (p.version || 'terpasang') : 'belum terpasang';
        return (
          '<div class="deps-row">' +
            '<span class="deps-row-name">' + escapeHtml(p.name) + (p.wanted ? ' <span class="deps-row-wanted">(butuh ' + escapeHtml(p.wanted) + ')</span>' : '') + '</span>' +
            '<span class="deps-row-status ' + statusCls + '">' + escapeHtml(statusText) + '</span>' +
          '</div>'
        );
      }).join('');

      const binRows = (data.binaries || []).map(b => {
        const statusCls = b.installed ? 'up' : 'down';
        const statusText = b.installed ? (b.version || 'terpasang') : 'tidak ada';
        return (
          '<div class="deps-row">' +
            '<span class="deps-row-name">' + escapeHtml(b.label) + '<span class="deps-row-note">' + escapeHtml(b.note) + '</span></span>' +
            '<span class="deps-row-status ' + statusCls + '">' + escapeHtml(statusText) + '</span>' +
          '</div>'
        );
      }).join('');

      box.innerHTML =
        '<div class="deps-section-label">Python ' + escapeHtml(data.python_version || '') + ' -- package (requirements.txt)</div>' +
        (pkgRows || '<div class="note-empty">requirements.txt kosong/tidak ditemukan</div>') +
        '<div class="deps-section-label">Aplikasi sistem</div>' +
        binRows +
        '<button class="boost-btn" onclick="depsLoaded=false;loadDeps();"><i class="bi bi-arrow-clockwise"></i> Cek Ulang</button>';
    })
    .catch(() => {
      box.innerHTML = '<div class="panel-loading">Gagal memuat dependensi</div>';
    });
}

// ===== Jaringan =====
let networkLoaded = false;

function loadNetwork() {
  const box = document.getElementById('networkBox');

  fetch('/api/network')
    .then(r => r.json())
    .then(data => {
      networkLoaded = true;

      if (!data.available) {
        box.innerHTML = '<div class="panel-loading">' + escapeHtml(data.message || 'Info jaringan tidak tersedia') + '</div>';
        return;
      }

      let html = '';
      html += '<div class="net-row"><span>IP Publik</span><span>' + escapeHtml(data.public_ip || 'Tidak diketahui') + '</span></div>';

      (data.local_ips || []).forEach(ipInfo => {
        html += '<div class="net-row">' +
          '<span>' + escapeHtml(ipInfo.iface) + ' <span class="net-dot ' + (ipInfo.up ? 'up' : 'down') + '"></span></span>' +
          '<span>' + escapeHtml(ipInfo.ip) + '</span>' +
        '</div>';
      });

      html += '<div class="net-row"><span>Terkirim</span><span>' + data.sent_mb + ' MB</span></div>';
      html += '<div class="net-row"><span>Diterima</span><span>' + data.recv_mb + ' MB</span></div>';

      box.innerHTML = html;
    })
    .catch(() => {
      box.innerHTML = '<div class="panel-loading">Gagal memuat info jaringan</div>';
    });
}

// ===== Keamanan =====
let securityLoaded = false;

function loadSecurity() {
  const box = document.getElementById('securityBox');

  fetch('/api/security')
    .then(r => r.json())
    .then(data => {
      securityLoaded = true;

      let html = '<div class="sec-block-label">Sesi saat ini</div>';
      html += '<div class="net-row"><span>User</span><span>' + escapeHtml(data.current_session.username || '\u2014') + '</span></div>';
      html += '<div class="net-row"><span>Login sejak</span><span>' + escapeHtml(data.current_session.login_time || '\u2014') + '</span></div>';
      html += '<div class="net-row"><span>IP</span><span>' + escapeHtml(data.current_session.ip || '\u2014') + '</span></div>';

      if (data.last_success) {
        html += '<div class="sec-block-label">Login berhasil terakhir</div>';
        html += '<div class="net-row"><span>' + escapeHtml(data.last_success.time) + '</span><span>' + escapeHtml(data.last_success.ip) + '</span></div>';
      }

      html += '<div class="sec-block-label">Percobaan login gagal</div>';
      if (!data.failed_attempts || !data.failed_attempts.length) {
        html += '<div class="note-empty">Tidak ada percobaan gagal</div>';
      } else {
        data.failed_attempts.forEach(a => {
          html += '<div class="sec-fail-row">' +
            '<span class="sec-fail-user">' + escapeHtml(a.username || '(kosong)') + '</span>' +
            '<span class="sec-fail-meta">' + escapeHtml(a.ip) + ' &middot; ' + escapeHtml(a.time) + '</span>' +
          '</div>';
        });
      }

      document.getElementById('securityBox').innerHTML = html;
    })
    .catch(() => {
      box.innerHTML = '<div class="panel-loading">Gagal memuat data keamanan</div>';
    });
}

// ===== Berita Crypto (CoinGecko, publik & gratis) =====
let cryptoLoaded = false;
// Urutan tampil: BTC, ETH, DOGE dulu, baru sisanya
const CRYPTO_IDS = { bitcoin: 'BTC', ethereum: 'ETH', dogecoin: 'DOGE', velvet: 'VELVET', 'magma-finance': 'MAGMA' };

function loadCrypto() {
  const list = document.getElementById('cryptoList');
  const ids = Object.keys(CRYPTO_IDS).join(',');

  // coins/markets: satu request dapat harga, persentase 24 jam, ikon, DAN data
  // sparkline 7 hari sekaligus -- lebih hemat & lebih cepat dibanding request terpisah.
  fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=idr&ids=' + ids + '&sparkline=true&price_change_percentage=24h')
    .then(r => r.json())
    .then(data => {
      cryptoLoaded = true;
      list.innerHTML = '';

      if (!Array.isArray(data) || !data.length) {
        list.innerHTML = '<div class="panel-loading">Data tidak tersedia</div>';
        return;
      }

      // API tidak selalu balikin sesuai urutan yang diminta -> urutkan ulang sesuai CRYPTO_IDS
      const order = Object.keys(CRYPTO_IDS);
      data.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

      data.forEach(coin => {
        const change = coin.price_change_percentage_24h || 0;
        const up = change >= 0;
        const priceText = coin.current_price < 1000
          ? coin.current_price.toLocaleString('id-ID', { maximumFractionDigits: 4 })
          : Math.round(coin.current_price).toLocaleString('id-ID');

        const sparkPrices = (coin.sparkline_in_7d && coin.sparkline_in_7d.price) || [];
        const chartHtml = sparkPrices.length > 1 ? renderSparkline(sparkPrices, up) : '';

        const item = document.createElement('div');
        item.className = 'crypto-item';
        item.innerHTML =
          '<img class="crypto-icon" src="' + coin.image + '" alt="" loading="lazy">' +
          '<span class="crypto-symbol">' + (CRYPTO_IDS[coin.id] || coin.symbol.toUpperCase()) + '</span>' +
          '<div class="crypto-chart">' + chartHtml + '</div>' +
          '<div class="crypto-right">' +
            '<span class="crypto-price">Rp' + priceText + '</span>' +
            '<span class="crypto-change ' + (up ? 'up' : 'down') + '">' +
              (up ? '\u25B2' : '\u25BC') + ' ' + Math.abs(change).toFixed(2) + '%' +
            '</span>' +
          '</div>';
        list.appendChild(item);
      });
    })
    .catch(() => {
      list.innerHTML = '<div class="panel-loading">Gagal memuat harga crypto</div>';
    });
}

// Grafik mini (sparkline) dari data 7 hari terakhir yang sudah ikut di response coins/markets
function renderSparkline(prices, up) {
  const w = 60, h = 24, pad = 1;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = (max - min) || 1;

  const points = prices.map((p, i) => {
    const x = pad + (i / (prices.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (p - min) / range) * (h - pad * 2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');

  const color = up ? '#34a853' : '#ea4335';

  return '<svg viewBox="0 0 ' + w + ' ' + h + '" class="sparkline" preserveAspectRatio="none">' +
    '<polyline points="' + points + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>' +
  '</svg>';
}

// ===== Catatan (floating widget, tersimpan di server) =====
let notesLoaded = false;
let notesCache = [];
let currentPopupNoteId = null;

function toggleNotesFloating() {
  const panel = document.getElementById('notesFloating');
  const opening = !panel.classList.contains('show');

  panel.classList.toggle('show');
  document.getElementById('notesTopBtn').classList.toggle('active', opening);

  if (opening) {
    closeNoteTextPopup();
    if (!notesLoaded) loadNotes();
  }
}

// Geser panel mengambang (Catatan / Teks Editor) lewat headernya (mouse & sentuh)
function makeFloatingDraggable(panelId, headerId) {
  const panel = document.getElementById(panelId);
  const header = document.getElementById(headerId);
  if (!panel || !header) return;

  let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

  const onDown = (clientX, clientY) => {
    dragging = true;
    const rect = panel.getBoundingClientRect();
    startX = clientX;
    startY = clientY;
    startLeft = rect.left;
    startTop = rect.top;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = startLeft + 'px';
    panel.style.top = startTop + 'px';
  };

  const onMove = (clientX, clientY) => {
    if (!dragging) return;
    const dx = clientX - startX;
    const dy = clientY - startY;
    const maxLeft = window.innerWidth - panel.offsetWidth - 4;
    const maxTop = window.innerHeight - panel.offsetHeight - 4;
    panel.style.left = Math.min(Math.max(4, startLeft + dx), Math.max(4, maxLeft)) + 'px';
    panel.style.top = Math.min(Math.max(4, startTop + dy), Math.max(4, maxTop)) + 'px';
  };

  const onUp = () => { dragging = false; };

  header.addEventListener('mousedown', e => { onDown(e.clientX, e.clientY); e.preventDefault(); });
  window.addEventListener('mousemove', e => onMove(e.clientX, e.clientY));
  window.addEventListener('mouseup', onUp);

  header.addEventListener('touchstart', e => {
    const t = e.touches[0];
    onDown(t.clientX, t.clientY);
  }, { passive: true });
  window.addEventListener('touchmove', e => {
    if (!dragging) return;
    const t = e.touches[0];
    onMove(t.clientX, t.clientY);
  }, { passive: true });
  window.addEventListener('touchend', onUp);
}
makeFloatingDraggable('notesFloating', 'notesFloatingHeader');
makeFloatingDraggable('scratchFloating', 'scratchFloatingHeader');

function loadNotes() {
  const list = document.getElementById('notesList');

  fetch('/api/notes')
    .then(r => r.json())
    .then(notes => {
      notesLoaded = true;
      notesCache = notes;
      renderNotes(notes);
    })
    .catch(() => {
      list.innerHTML = '<div class="panel-loading">Gagal memuat catatan</div>';
    });
}

function renderNotes(notes) {
  const list = document.getElementById('notesList');
  list.innerHTML = '';

  if (!notes.length) {
    list.innerHTML = '<div class="note-empty">Belum ada catatan</div>';
    return;
  }

  notes.forEach(n => {
    const item = document.createElement('div');
    item.className = 'note-item';
    item.dataset.id = n.id;
    item.innerHTML =
      '<button class="note-title-btn" onclick="openNoteTextPopup(' + n.id + ')">' +
        '<span class="note-title-text"></span>' +
        '<div class="note-date">' + n.created + (n.edited ? ' &middot; diedit' : '') + '</div>' +
      '</button>' +
      '<button class="note-action note-delete" title="Hapus" onclick="deleteNote(' + n.id + ')"><i class="bi bi-trash"></i></button>';
    item.querySelector('.note-title-text').textContent = n.title || '(Tanpa judul)';
    list.appendChild(item);
  });
}

// ===== Popup mengambang: tampil saat judul catatan diklik =====
function openNoteTextPopup(id) {
  const note = notesCache.find(n => n.id === id);
  if (!note) return;

  currentPopupNoteId = id;
  renderPopupView(note);

  document.getElementById('noteTextPopupOverlay').classList.add('show');
  document.getElementById('noteTextPopup').classList.add('show');
}

function renderPopupView(note) {
  // Pastikan judul & isi kembali ke elemen tampilan biasa (bukan input/textarea edit)
  const titleEl = document.getElementById('noteTextPopupTitle');
  if (titleEl.tagName !== 'SPAN') {
    titleEl.outerHTML = '<span id="noteTextPopupTitle"></span>';
  }
  document.getElementById('noteTextPopupTitle').textContent = note.title || '(Tanpa judul)';

  const bodyEl = document.getElementById('noteTextPopupBody');
  if (bodyEl.tagName !== 'DIV') {
    bodyEl.outerHTML = '<div id="noteTextPopupBody" class="note-text-popup-body"></div>';
  } else {
    bodyEl.classList.remove('editing');
  }
  document.getElementById('noteTextPopupBody').textContent = note.text;

  document.getElementById('noteTextPopupDate').textContent =
    note.created + (note.edited ? ' \u00b7 diedit ' + note.edited : '');

  const actions = document.querySelector('.note-text-popup-actions');
  actions.innerHTML =
    '<button class="note-action" title="Salin" onclick="copyPopupNote()"><i class="bi bi-copy"></i> Salin</button>' +
    '<button class="note-action" title="Edit" onclick="startEditPopupNote()"><i class="bi bi-pencil"></i> Edit</button>' +
    '<button class="note-action note-delete" title="Hapus" onclick="deletePopupNote()"><i class="bi bi-trash"></i> Hapus</button>';
}

function closeNoteTextPopup() {
  document.getElementById('noteTextPopupOverlay').classList.remove('show');
  document.getElementById('noteTextPopup').classList.remove('show');
  currentPopupNoteId = null;
}

function copyPopupNote() {
  const note = notesCache.find(n => n.id === currentPopupNoteId);
  if (!note) return;
  const text = note.text;

  const done = () => {
    const btn = document.querySelector('.note-text-popup-actions .note-action');
    const original = btn.innerHTML;
    btn.innerHTML = '<i class="bi bi-check2"></i> Tersalin';
    setTimeout(() => { btn.innerHTML = original; }, 1200);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, cb) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
  if (cb) cb();
}

function startEditPopupNote() {
  const note = notesCache.find(n => n.id === currentPopupNoteId);
  if (!note) return;

  document.getElementById('noteTextPopupTitle').outerHTML =
    '<input type="text" id="noteTextPopupTitle" class="note-edit-input popup-edit-title" value="' +
    (note.title || '').replace(/"/g, '&quot;') + '">';

  // Textarea sungguhan supaya Enter selalu bikin baris baru (bukan contenteditable)
  document.getElementById('noteTextPopupBody').outerHTML =
    '<textarea id="noteTextPopupBody" class="note-text-popup-body editing"></textarea>';
  const bodyEl = document.getElementById('noteTextPopupBody');
  bodyEl.value = note.text;
  bodyEl.focus();

  const actions = document.querySelector('.note-text-popup-actions');
  actions.innerHTML =
    '<button class="note-action" title="Simpan" onclick="saveEditPopupNote()"><i class="bi bi-check2"></i> Simpan</button>' +
    '<button class="note-action" title="Batal" onclick="renderPopupView(notesCache.find(n => n.id === currentPopupNoteId))"><i class="bi bi-x-lg"></i> Batal</button>';
}

function saveEditPopupNote() {
  const title = document.getElementById('noteTextPopupTitle').value.trim();
  const text = document.getElementById('noteTextPopupBody').value.trim();
  if (!text) return;

  fetch('/api/notes/' + currentPopupNoteId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, text })
  })
    .then(r => r.json())
    .then(updated => {
      const idx = notesCache.findIndex(n => n.id === currentPopupNoteId);
      if (idx !== -1) notesCache[idx] = updated;
      renderNotes(notesCache);
      renderPopupView(updated);
    });
}

function deletePopupNote() {
  if (!currentPopupNoteId) return;
  if (!confirm('Hapus catatan ini?')) return;

  fetch('/api/notes/' + currentPopupNoteId, { method: 'DELETE' })
    .then(() => {
      closeNoteTextPopup();
      loadNotes();
    });
}

function addNote(e) {
  e.preventDefault();
  const titleInput = document.getElementById('noteTitleInput');
  const input = document.getElementById('noteInput');
  const title = titleInput.value.trim();
  const text = input.value.trim();
  if (!text) return false;

  fetch('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, text })
  })
    .then(r => r.json())
    .then(() => {
      titleInput.value = '';
      input.value = '';
      loadNotes();
    });

  return false;
}

function deleteNote(id) {
  fetch('/api/notes/' + id, { method: 'DELETE' })
    .then(() => loadNotes());
}

// ===== Teks Editor =====
// Sebelumnya di sini ada lapisan warna kode terpisah (textarea transparan +
// <pre> berwarna di belakangnya). Itu penyebab bug "kursor kelihatan di satu
// tempat tapi yang kehapus teks lain": <pre> dan textarea bisa mem-bungkus
// baris beda (scrollbar/lebar beda dikit saja sudah cukup), jadi posisi
// kursor yang KELIHATAN (di layer <pre>) tidak selalu sama dengan posisi
// kursor SEBENARNYA (di textarea). Sekarang teksnya cuma satu lapisan --
// textarea biasa yang terlihat langsung -- jadi yang dilihat = yang diedit,
// tidak mungkin desync lagi.

let editorFilesLoaded = false;
let currentEditorFile = ''; // path file yang lagi dibuka di editor
let currentEditorLanguage = 'none'; // bahasa buat syntax highlighting, ditebak dari ekstensi file

function toggleScratchFloating() {
  document.getElementById('scratchFloating').classList.toggle('show');
}

// Dipanggil dari menu "Edit" di daftar file (row-menu) -> buka panel Teks Editor
// dan langsung muat file yang diklik.
function openInTextEditor(path) {
  document.getElementById('scratchFloating').classList.add('show');
  if (!editorFilesLoaded) loadEditorFiles();
  openEditorFile(path);
  return false;
}

// Daftar file yang bisa dibuka & diedit langsung dari server (untuk dropdown pemilih file)
function loadEditorFiles() {
  const select = document.getElementById('editorFileSelect');

  fetch('/api/editor/files')
    .then(r => r.json())
    .then(data => {
      editorFilesLoaded = true;
      const files = data.files || [];
      const current = select.value;

      select.innerHTML = '';
      files.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f;
        opt.textContent = f;
        select.appendChild(opt);
      });

      if (files.includes(current)) select.value = current;
      else if (files.includes(currentEditorFile)) select.value = currentEditorFile;
    })
    .catch(() => {});
}

function onEditorFileSelect(path) {
  if (!path) return;
  openEditorFile(path);
}

function openEditorFile(path) {
  const statusEl = document.getElementById('scratchStatus');
  statusEl.textContent = 'Membuka ' + path + '...';

  fetch('/api/editor/file?path=' + encodeURIComponent(path))
    .then(r => r.json())
    .then(data => {
      if (data.error) { statusEl.textContent = data.error; return; }

      currentEditorFile = data.path;
      currentEditorLanguage = getEditorLanguage(data.path);
      document.getElementById('scratchTextarea').value = data.content || '';
      document.getElementById('editorFileSelect').value = data.path;
      document.getElementById('editorDeleteBtn').style.display = '';
      statusEl.textContent = 'Membuka: ' + data.path;
      updateEditorGutter();
      updateEditorHighlight();
      closeEditorSearch();
    })
    .catch(() => { statusEl.textContent = 'Gagal membuka file'; });
}

function deleteEditorFile() {
  if (!currentEditorFile) return;
  if (!confirm('Hapus file "' + currentEditorFile + '"? Tindakan ini tidak bisa dibatalkan.')) return;

  fetch('/api/editor/file?path=' + encodeURIComponent(currentEditorFile), { method: 'DELETE' })
    .then(r => r.json())
    .then(data => {
      if (data.error) { alert(data.error); return; }
      currentEditorFile = '';
      currentEditorLanguage = 'none';
      document.getElementById('scratchTextarea').value = '';
      document.getElementById('editorDeleteBtn').style.display = 'none';
      document.getElementById('editorFileSelect').value = '';
      document.getElementById('scratchStatus').textContent = 'File dihapus';
      updateEditorGutter();
      updateEditorHighlight();
      loadEditorFiles();
    })
    .catch(() => alert('Gagal menghapus file'));
}

function saveScratch() {
  if (!currentEditorFile) return;

  const text = document.getElementById('scratchTextarea').value;
  const statusEl = document.getElementById('scratchStatus');
  statusEl.textContent = 'Menyimpan...';

  fetch('/api/editor/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: currentEditorFile, content: text })
  })
    .then(r => r.json())
    .then(data => {
      if (data.error) { statusEl.textContent = data.error; return; }
      statusEl.textContent = 'Tersimpan: ' + data.path + ' (' + data.saved + ')';
    })
    .catch(() => { statusEl.textContent = 'Gagal menyimpan'; });
}

// Simpan isi editor sebagai file baru / nama lain (juga dipakai untuk bikin file baru)
function saveAsEditorFile() {
  const suggested = currentEditorFile || '';
  const path = (prompt('Simpan sebagai (path relatif, mis. folder/nama.txt):', suggested) || '').trim();
  if (!path) return;

  const text = document.getElementById('scratchTextarea').value;
  const statusEl = document.getElementById('scratchStatus');
  statusEl.textContent = 'Menyimpan sebagai ' + path + '...';

  fetch('/api/editor/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path, content: text })
  })
    .then(r => r.json())
    .then(data => {
      if (data.error) { statusEl.textContent = data.error; return; }
      currentEditorFile = data.path;
      currentEditorLanguage = getEditorLanguage(data.path);
      document.getElementById('editorDeleteBtn').style.display = '';
      statusEl.textContent = 'Tersimpan sebagai: ' + data.path + ' (' + data.saved + ')';
      updateEditorHighlight();
      loadEditorFiles();
    })
    .catch(() => { statusEl.textContent = 'Gagal menyimpan'; });
}

// Nomor baris di kiri, ala vim/nano.
//
// PENTING: kalau word-wrap aktif, satu baris kode yang panjang bisa kebungkus
// jadi beberapa baris visual di textarea -- kalau gutter cuma nulis angka
// 1,2,3,... berurutan satu per satu tanpa mikirin itu, nomornya lama-lama
// geser jauh dari baris aslinya (persis bug yang dilaporkan). Makanya di sini
// dihitung dulu kira-kira berapa baris visual yang dipakai tiap baris logis
// (berdasarkan lebar kolom yang muat, karena fontnya monospace jadi gampang
// dihitung per karakter), baru nomornya ditulis di baris visual PERTAMA saja,
// sisanya (baris sambungan akibat wrap) dikosongkan -- sama seperti gutter di
// editor kode pada umumnya (VS Code, dst).
function _editorCharWidth(textarea) {
  const style = getComputedStyle(textarea);
  const canvas = _editorCharWidth._canvas || (_editorCharWidth._canvas = document.createElement('canvas'));
  const ctx = canvas.getContext('2d');
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize}/${style.lineHeight} ${style.fontFamily}`;
  const w = ctx.measureText('0').width;
  return w > 0 ? w : 7.8;
}

function updateEditorGutter() {
  const textarea = document.getElementById('scratchTextarea');
  const gutter = document.getElementById('scratchGutter');
  if (!textarea || !gutter) return;

  const lines = textarea.value.split('\n');
  const wrapAktif = !textarea.classList.contains('no-wrap');

  let out = '';

  if (!wrapAktif) {
    // Mode "no-wrap": textarea scroll horizontal, tiap baris logis = persis 1 baris visual.
    for (let i = 1; i <= lines.length; i++) out += i + '\n';
  } else {
    const style = getComputedStyle(textarea);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    const innerWidth = Math.max(1, textarea.clientWidth - paddingLeft - paddingRight);
    const charWidth = _editorCharWidth(textarea);
    const charsPerRow = Math.max(1, Math.floor(innerWidth / charWidth));

    lines.forEach((line, idx) => {
      const visualRows = Math.max(1, Math.ceil(line.length / charsPerRow));
      out += (idx + 1) + '\n';
      for (let r = 1; r < visualRows; r++) out += '\n';
    });
  }

  gutter.textContent = out;
}

// ===== Syntax highlighting (pakai Prism.js, di-load via CDN) =====
// Caranya: teks asli di textarea dibikin transparan (lihat CSS .code-editor-textarea),
// terus di baliknya ada lapisan <pre><code> (#scratchHighlight) yang isinya disalin
// ulang & diwarnai Prism tiap ada perubahan. Lapisan itu murni tampilan doang
// (pointer-events:none), jadi tidak ikut campur dengan kursor/undo-redo bawaan
// textarea -- yang diedit user tetap textarea aslinya.
const EDITOR_LANG_MAP = {
  py: 'python', pyw: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
  css: 'css', scss: 'scss', less: 'less',
  json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  md: 'markdown', markdown: 'markdown',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  java: 'java', kt: 'kotlin', go: 'go', rs: 'rust',
  php: 'php', rb: 'ruby', lua: 'lua', dart: 'dart',
  ini: 'ini', conf: 'ini', env: 'ini',
  dockerfile: 'docker',
};

function getEditorLanguage(filename) {
  if (!filename) return 'none';
  const base = filename.split('/').pop().toLowerCase();
  if (base === 'dockerfile') return 'docker';
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return EDITOR_LANG_MAP[ext] || 'none';
}

// Nulis ulang isi lapisan highlight persis sama dengan textarea, lalu minta
// Prism mewarnainya (kalau bahasanya dikenali). Ditambah 1 baris kosong di
// akhir supaya tinggi <pre> tidak "kepotong" pas baris terakhir kosong.
function updateEditorHighlight() {
  const textarea = document.getElementById('scratchTextarea');
  const codeEl = document.getElementById('scratchHighlightCode');
  if (!textarea || !codeEl) return;

  const lang = currentEditorLanguage || 'none';
  codeEl.className = 'language-' + lang;
  codeEl.textContent = textarea.value + '\n';

  if (lang !== 'none' && window.Prism && Prism.languages && Prism.languages[lang]) {
    Prism.highlightElement(codeEl);
  } else if (lang !== 'none' && window.Prism && window.Prism.plugins && window.Prism.plugins.autoloader) {
    // Grammar bahasanya belum ke-load -- panggil highlightElement tetap, nanti
    // plugin autoloader otomatis ambil file grammar-nya lalu highlight ulang
    // begitu selesai. Sementara itu teksnya tampil polos dulu (tidak masalah).
    Prism.highlightElement(codeEl);
  }

  syncEditorHighlightScroll();
}

function syncEditorHighlightScroll() {
  const textarea = document.getElementById('scratchTextarea');
  const highlight = document.getElementById('scratchHighlight');
  if (!textarea || !highlight) return;
  highlight.scrollTop = textarea.scrollTop;
  highlight.scrollLeft = textarea.scrollLeft;
}

// Undo / Redo pakai riwayat undo bawaan browser di textarea
function editorUndo() {
  const textarea = document.getElementById('scratchTextarea');
  textarea.focus();
  document.execCommand('undo');
  updateEditorGutter();
  updateEditorHighlight();
}

function editorRedo() {
  const textarea = document.getElementById('scratchTextarea');
  textarea.focus();
  document.execCommand('redo');
  updateEditorGutter();
  updateEditorHighlight();
}

// Fullscreen: perbesar panel editor memenuhi layar
function toggleEditorFullscreen() {
  const panel = document.getElementById('scratchFloating');
  const icon = document.getElementById('editorFullscreenIcon');
  const isFull = panel.classList.toggle('fullscreen');
  icon.className = isFull ? 'bi bi-fullscreen-exit' : 'bi bi-arrows-fullscreen';
  // Lebar textarea berubah pas masuk/keluar fullscreen -> gutter perlu
  // dihitung ulang (baris visual per baris logis ikut berubah kalau wrap aktif).
  setTimeout(updateEditorGutter, 260);
}

// ===== Cari kode di dalam file yang lagi dibuka =====
// Pencarian baru dijalankan saat user menekan Enter (bukan tiap ketikan),
// supaya tidak lag/loncat-loncat saat mengetik kata kunci panjang.
let editorSearchMatches = [];
let editorSearchIndex = -1;
let editorSearchQuery = null; // kata kunci terakhir yang benar-benar sudah dicari

function toggleEditorSearch() {
  const bar = document.getElementById('editorSearchBar');
  const opening = bar.style.display === 'none' || !bar.style.display;

  if (opening) {
    bar.style.display = 'flex';
    document.getElementById('editorSearchInput').focus();
  } else {
    closeEditorSearch();
  }
}

function closeEditorSearch() {
  const bar = document.getElementById('editorSearchBar');
  bar.style.display = 'none';
  document.getElementById('editorSearchInput').value = '';
  editorSearchMatches = [];
  editorSearchIndex = -1;
  editorSearchQuery = null;
  updateEditorSearchCount();
}

function runEditorSearch() {
  const query = document.getElementById('editorSearchInput').value;
  const textarea = document.getElementById('scratchTextarea');
  editorSearchMatches = [];
  editorSearchIndex = -1;
  editorSearchQuery = query;

  if (query) {
    const text = textarea.value.toLowerCase();
    const q = query.toLowerCase();
    let idx = text.indexOf(q);
    while (idx !== -1) {
      editorSearchMatches.push(idx);
      idx = text.indexOf(q, idx + q.length);
    }
  }

  updateEditorSearchCount();
  if (editorSearchMatches.length) editorSearchGoTo(0);
}

function editorSearchGoTo(i) {
  if (!editorSearchMatches.length) return;
  editorSearchIndex = (i + editorSearchMatches.length) % editorSearchMatches.length;

  const textarea = document.getElementById('scratchTextarea');
  const query = document.getElementById('editorSearchInput').value;
  const start = editorSearchMatches[editorSearchIndex];

  textarea.focus();
  textarea.setSelectionRange(start, start + query.length);
  updateEditorSearchCount();
}

// Dipanggil saat Enter ditekan atau tombol panah diklik.
// Kalau kata kuncinya berubah sejak pencarian terakhir, cari ulang dulu (mulai dari hasil pertama).
// Kalau kata kuncinya sama, cukup lompat ke hasil berikut/sebelumnya.
function editorSearchStep(reverse) {
  const query = document.getElementById('editorSearchInput').value;
  if (query !== editorSearchQuery) {
    runEditorSearch();
    return;
  }
  if (!editorSearchMatches.length) { runEditorSearch(); return; }
  editorSearchGoTo(editorSearchIndex + (reverse ? -1 : 1));
}

function editorSearchNext() {
  editorSearchStep(false);
}

function editorSearchPrev() {
  editorSearchStep(true);
}

function updateEditorSearchCount() {
  const el = document.getElementById('editorSearchCount');
  const query = document.getElementById('editorSearchInput').value;
  if (!el) return;
  el.textContent = editorSearchMatches.length
    ? (editorSearchIndex + 1) + '/' + editorSearchMatches.length
    : (query ? '0/0' : '');
}

// Ganti satu kemunculan yang sedang aktif/tersorot, lalu lompat ke kemunculan berikutnya.
// Pakai execCommand('insertText') (bukan textarea.value=...) supaya tetap tercatat
// di riwayat undo/redo bawaan browser, sama seperti trik indentasi Tab di bawah.
function editorReplaceOne() {
  const textarea = document.getElementById('scratchTextarea');
  const query = document.getElementById('editorSearchInput').value;
  const replacement = document.getElementById('editorReplaceInput').value;
  if (!query) return;

  if (query !== editorSearchQuery || !editorSearchMatches.length) {
    runEditorSearch();
    if (!editorSearchMatches.length) return;
  }

  const start = textarea.selectionStart, end = textarea.selectionEnd;
  const selected = textarea.value.substring(start, end);

  // Kalau belum ada kemunculan yang benar-benar tersorot (mis. abis buka file
  // baru), pilih yang pertama dulu -- baru tekan "Ganti" lagi buat eksekusi.
  if (selected.toLowerCase() !== query.toLowerCase()) {
    editorSearchGoTo(editorSearchIndex >= 0 ? editorSearchIndex : 0);
    return;
  }

  textarea.focus();
  document.execCommand('insertText', false, replacement);
  updateEditorGutter();
  updateEditorHighlight();
  runEditorSearch();
  if (editorSearchMatches.length) editorSearchGoTo(editorSearchIndex);
  document.getElementById('scratchStatus').textContent = 'Diganti 1 kemunculan';
}

// Ganti semua kemunculan sekaligus.
function editorReplaceAll() {
  const textarea = document.getElementById('scratchTextarea');
  const query = document.getElementById('editorSearchInput').value;
  const replacement = document.getElementById('editorReplaceInput').value;
  if (!query) return;

  const before = textarea.value;
  const lower = before.toLowerCase();
  const q = query.toLowerCase();

  let count = 0, i = 0, result = '';
  let idx = lower.indexOf(q);
  while (idx !== -1) {
    result += before.substring(i, idx) + replacement;
    i = idx + query.length;
    count++;
    idx = lower.indexOf(q, i);
  }
  result += before.substring(i);

  if (!count) return;

  textarea.focus();
  textarea.select();
  document.execCommand('insertText', false, result);
  updateEditorGutter();
  updateEditorHighlight();
  closeEditorSearch();
  document.getElementById('scratchStatus').textContent = 'Mengganti ' + count + ' kemunculan "' + query + '"';
}

(function initCodeEditor() {
  const textarea = document.getElementById('scratchTextarea');
  const gutter = document.getElementById('scratchGutter');
  if (!textarea || !gutter) return;

  textarea.addEventListener('input', () => {
    updateEditorGutter();
    updateEditorHighlight();
  });
  textarea.addEventListener('scroll', () => {
    gutter.scrollTop = textarea.scrollTop;
    syncEditorHighlightScroll();
  });

  // Tab buat indentasi kode, bukan pindah fokus (kebiasaan vim/nano/editor kode)
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      if (document.execCommand('insertText', false, '  ')) {
        // insertText via execCommand tetap tercatat di riwayat undo/redo bawaan browser
      } else {
        // Fallback kalau execCommand tidak didukung
        const start = textarea.selectionStart, end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      }
      updateEditorGutter();
      updateEditorHighlight();
    }
  });

  // Lebar textarea berubah kalau layar diputar / panel di-resize -- itu ikut
  // mengubah berapa banyak baris visual yang kepakai tiap baris logis pas
  // word-wrap aktif, jadi gutter perlu dihitung ulang.
  window.addEventListener('resize', () => {
    const panel = document.getElementById('scratchFloating');
    if (panel && panel.classList.contains('show')) updateEditorGutter();
  });

  updateEditorGutter();
  updateEditorHighlight();
})();

function copyScratch() {
  const text = document.getElementById('scratchTextarea').value;
  const statusEl = document.getElementById('scratchStatus');
  const original = statusEl.textContent;

  const done = () => {
    statusEl.textContent = 'Disalin!';
    setTimeout(() => { statusEl.textContent = original; }, 1200);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}


// ===== Cuaca (Open-Meteo, publik & gratis, tanpa API key) =====
let weatherLoaded = false;

const WEATHER_CODES = {
  0: ['bi-sun-fill', 'Cerah'],
  1: ['bi-brightness-high', 'Cerah berawan'],
  2: ['bi-cloud-sun-fill', 'Berawan sebagian'],
  3: ['bi-clouds-fill', 'Mendung'],
  45: ['bi-cloud-haze-fill', 'Berkabut'],
  48: ['bi-cloud-haze-fill', 'Berkabut'],
  51: ['bi-cloud-drizzle-fill', 'Gerimis ringan'],
  53: ['bi-cloud-drizzle-fill', 'Gerimis'],
  55: ['bi-cloud-drizzle-fill', 'Gerimis lebat'],
  61: ['bi-cloud-rain-fill', 'Hujan ringan'],
  63: ['bi-cloud-rain-fill', 'Hujan'],
  65: ['bi-cloud-rain-heavy-fill', 'Hujan lebat'],
  80: ['bi-cloud-rain-fill', 'Hujan singkat'],
  95: ['bi-cloud-lightning-fill', 'Badai petir'],
};

function weatherInfo(code) {
  return WEATHER_CODES[code] || ['bi-cloud-fill', 'Tidak diketahui'];
}

function loadWeather() {
  const box = document.getElementById('weatherBox');

  if (!navigator.geolocation) {
    fetchWeather(-6.2, 106.8, 'Jakarta (default)');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => fetchWeather(pos.coords.latitude, pos.coords.longitude, 'Lokasi Anda'),
    () => fetchWeather(-6.2, 106.8, 'Jakarta (default)'),
    { timeout: 6000 }
  );
}

function fetchWeather(lat, lon, placeLabel) {
  const box = document.getElementById('weatherBox');

  fetch('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&current_weather=true')
    .then(r => r.json())
    .then(data => {
      weatherLoaded = true;
      const cw = data.current_weather;
      if (!cw) throw new Error('no data');

      const [icon, desc] = weatherInfo(cw.weathercode);

      box.innerHTML =
        '<i class="bi ' + icon + ' weather-icon"></i>' +
        '<div>' +
          '<div class="weather-temp">' + Math.round(cw.temperature) + '&deg;C</div>' +
          '<div class="weather-desc">' + desc + ' · angin ' + Math.round(cw.windspeed) + ' km/j</div>' +
          '<div class="weather-place">' + placeLabel + '</div>' +
        '</div>';
    })
    .catch(() => {
      box.innerHTML = '<div class="panel-loading">Gagal memuat cuaca</div>';
    });
}

// Tekan lama (long-press) pada item untuk langsung masuk mode seleksi.
// Dipasang lewat event delegation di kontainer #list (bukan satu-satu ke tiap
// .file-card) karena daftar file di situ diganti ulang (innerHTML) tiap kali
// pindah folder / refresh / upload-selesai / hapus / dll -- kalau listener-nya
// dipasang langsung ke card, card yang baru muncul setelah pergantian itu
// tidak akan pernah punya listener-nya lagi (makanya long-press berhenti
// jalan begitu daftar pertama kali di-render ulang).
(function () {
  const list = document.getElementById('list');
  if (!list) return;

  let pressTimer = null;

  function startPress(card) {
    pressTimer = setTimeout(() => {
      if (!selectMode) enterSelectMode();
      const cb = card.querySelector('.item-checkbox');
      if (cb) cb.checked = true;
      updateSelectionCount();
    }, 500);
  }
  function cancelPress() {
    clearTimeout(pressTimer);
  }

  list.addEventListener('touchstart', (e) => {
    const card = e.target.closest('.file-card');
    if (card) startPress(card);
  });
  list.addEventListener('touchend', cancelPress);
  list.addEventListener('touchmove', cancelPress);
  list.addEventListener('mousedown', (e) => {
    const card = e.target.closest('.file-card');
    if (card) startPress(card);
  });
  list.addEventListener('mouseup', cancelPress);
  list.addEventListener('mouseleave', cancelPress);
})();

// ===== Pull-to-refresh: tarik layar ke bawah saat sudah mentok scroll paling atas =====
// supaya daftar file bisa dimuat ulang tanpa harus reload manual, mirip aplikasi mobile
// pada umumnya. Cuma aktif kalau halaman memang sedang di posisi paling atas dan tidak
// ada modal/panel mengambang yang sedang terbuka (biar tidak mengganggu scroll di
// dalamnya, mis. Sampah, Catatan, Teks Editor, Terminal, dsb).
(function initPullToRefresh() {
  const THRESHOLD = 70;   // px tarikan minimal sebelum dianggap "siap refresh"
  const MAX_PULL = 110;   // px batas visual biar indikatornya tidak ditarik kelewatan

  let startY = 0;
  let pulling = false;
  let refreshing = false;
  let indicator = null;

  function anyOverlayOpen() {
    return document.querySelector('.modal.show, .settings-modal.show, .notes-floating.show') !== null;
  }

  function ensureIndicator() {
    if (indicator) return indicator;
    indicator = document.createElement('div');
    indicator.id = 'pullRefreshIndicator';
    indicator.className = 'pull-refresh-indicator';
    indicator.innerHTML = '<i class="bi bi-arrow-clockwise"></i>';
    document.body.appendChild(indicator);
    return indicator;
  }

  function resetIndicator() {
    if (!indicator) return;
    indicator.classList.remove('show', 'ready', 'loading');
    indicator.style.transform = '';
  }

  document.addEventListener('touchstart', (e) => {
    if (refreshing || anyOverlayOpen()) { pulling = false; return; }
    if (window.scrollY > 0) { pulling = false; return; }
    if (e.touches.length !== 1) { pulling = false; return; }
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!pulling || refreshing) return;
    if (window.scrollY > 0) { pulling = false; resetIndicator(); return; }

    const deltaY = e.touches[0].clientY - startY;
    if (deltaY <= 0) { resetIndicator(); return; }

    const el = ensureIndicator();
    const pull = Math.min(deltaY * 0.55, MAX_PULL);
    el.style.transform = 'translateY(' + pull + 'px) translateX(-50%)';
    el.classList.add('show');
    el.classList.toggle('ready', deltaY > THRESHOLD);
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!pulling || refreshing) { pulling = false; return; }
    pulling = false;

    const wasReady = indicator && indicator.classList.contains('ready');
    if (!wasReady) { resetIndicator(); return; }

    refreshing = true;
    indicator.classList.add('loading');
    indicator.style.transform = 'translateY(' + (THRESHOLD * 0.55) + 'px) translateX(-50%)';

    refreshCurrentList().finally(() => {
      refreshing = false;
      resetIndicator();
    });
  });
})();

// ===================================================================================
// Halaman PM2: daftar proses pm2 + tombol buka lewat IP Tailscale (http://IP:port).
// Data dari /api/pm2 (hanya baca). Menyegarkan sendiri tiap 5 detik selama terbuka.
// ===================================================================================
let pm2Timer = null;

function openPm2() {
  toggleSidebar(false);
  document.getElementById('pm2Modal').classList.add('show');
  loadPm2();
  clearInterval(pm2Timer);
  pm2Timer = setInterval(loadPm2, 5000);
}

function closePm2() {
  document.getElementById('pm2Modal').classList.remove('show');
  clearInterval(pm2Timer);
  pm2Timer = null;
}

function pm2Duration(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return d + ' hari ' + h + ' jam';
  if (h) return h + ' jam ' + m + ' menit';
  if (m) return m + ' menit';
  return '< 1 menit';
}

function pm2Mem(bytes) {
  const mb = (bytes || 0) / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
}

function pm2PortButtons(ports, host) {
  return ports.map(p => {
    if (!p.reachable) {
      return `<span class="pm2-link disabled" title="Hanya mendengarkan di localhost, tidak bisa dibuka dari luar"><i class="bi bi-slash-circle"></i> :${p.port} lokal</span>`;
    }
    const url = 'http://' + host + ':' + p.port;
    return `<a class="pm2-link" href="${url}" target="_blank" rel="noopener" title="Buka ${url}"><i class="bi bi-box-arrow-up-right"></i> ${escapeHtml(host)}:${p.port}</a>`;
  }).join('');
}

function loadPm2() {
  const list = document.getElementById('pm2List');
  const summary = document.getElementById('pm2Summary');

  fetch('/api/pm2')
    .then(res => res.json())
    .then(data => {
      if (!data.ok) throw new Error(data.message || 'gagal');
      const host = data.tailscale_ip || location.hostname;
      const procs = data.processes || [];
      const online = procs.filter(p => p.status === 'online').length;
      summary.textContent = procs.length + ' proses \u00b7 ' + online + ' online' + (data.tailscale_ip ? ' \u00b7 Tailscale ' + data.tailscale_ip : '');

      let html = procs.map(p => {
        const ok = p.status === 'online';
        const meta = ok
          ? 'CPU ' + p.cpu + '% \u00b7 RAM ' + pm2Mem(p.mem) + ' \u00b7 restart ' + p.restarts + ' \u00b7 ' + pm2Duration(p.uptime_s)
          : p.status + ' \u00b7 restart ' + p.restarts;
        const links = p.ports.length
          ? pm2PortButtons(p.ports, host)
          : '<span class="pm2-noport">Tidak ada port web</span>';
        return `
          <div class="pm2-item">
            <div class="pm2-item-top">
              <span class="pm2-dot ${ok ? 'online' : 'off'}"></span>
              <span class="pm2-name">${escapeHtml(p.name)}</span>
              <span class="pm2-status ${ok ? 'online' : 'off'}">${escapeHtml(p.status)}</span>
            </div>
            <div class="pm2-meta">${meta}</div>
            <div class="pm2-links">${links}</div>
          </div>`;
      }).join('');

      const other = data.other_ports || [];
      if (other.length) {
        html += `
          <div class="pm2-item">
            <div class="pm2-item-top"><span class="pm2-name">Port lain</span></div>
            <div class="pm2-meta">Terbuka tapi tidak terdeteksi milik proses pm2 tertentu</div>
            <div class="pm2-links">${pm2PortButtons(other, host)}</div>
          </div>`;
      }

      list.innerHTML = html || '<div class="folder-picker-empty">Tidak ada proses pm2.</div>';
    })
    .catch(() => {
      list.innerHTML = '<div class="folder-picker-empty">Gagal memuat PM2. Coba segarkan atau login ulang.</div>';
      summary.textContent = 'Gagal memuat';
    });
}
