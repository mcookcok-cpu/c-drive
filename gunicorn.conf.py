"""Konfigurasi gunicorn untuk C-Drive (dijalankan lewat pm2)."""
import os

bind = f"{os.environ.get('HOST', '0.0.0.0')}:{os.environ.get('PORT', '8000')}"

# WAJIB 1 worker: sesi terminal, tugas salin/pindah dan upload chunk disimpan di memori proses.
workers = 1
worker_class = "gthread"
threads = int(os.environ.get("THREADS", "32"))  # satu thread per koneksi SSE/terminal aktif

timeout = 120
graceful_timeout = 30
keepalive = 5

accesslog = "-" if os.environ.get("ACCESS_LOG", "false").lower() in ("1", "true", "yes") else None
errorlog = "-"
loglevel = os.environ.get("LOG_LEVEL", "info").lower()
