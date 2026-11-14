# C-Drive

Pengelola file berbasis web (Flask) dengan manajemen server: jelajah/unggah/unduh file, sampah (trash),
penyalinan latar belakang, editor teks, catatan, monitoring sistem, kontrol service, dan terminal web.
Dijalankan produksi dengan **gunicorn di bawah pm2**.

## Struktur

```
app.py                  aplikasi Flask
gunicorn.conf.py        konfigurasi server (1 worker, gthread)
ecosystem.config.cjs    definisi proses pm2
requirements.txt        dependensi Python
.env.example            contoh konfigurasi (salin ke .env)
scripts/deploy.sh       deploy / update satu perintah (idempotent)
scripts/set-password.py atur password admin (disimpan sebagai hash)
templates/  static/     antarmuka
data/                   state runtime (security.json, trash, upload sementara)
```

## Deploy

```bash
cd ~/c-drive
cp .env.example .env && chmod 600 .env
venv/bin/python scripts/set-password.py     # atau tambahkan --random
./scripts/deploy.sh                         # venv + dependensi + pm2 + health check
```

Update setelah mengubah kode: jalankan lagi `./scripts/deploy.sh`.

## Konfigurasi (.env)

| Variabel | Fungsi | Default |
|---|---|---|
| `HOST`, `PORT` | alamat dengar | `0.0.0.0`, `8000` |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` | login | `admin`, wajib diisi |
| `SECRET_KEY` | kunci sesi | acak otomatis (`data/.secret_key`) |
| `C_DRIVE_HOME` / `DRIVE_ROOT` / `DRIVE_WORK_ROOT` / `DRIVE_HOME_ROOT` | folder yang dibagikan | `~/c-drive-files/{drive,work,home}` |
| `ENABLE_TERMINAL` | terminal web | `true` |
| `SESSION_HOURS`, `SESSION_COOKIE_SECURE`, `TRUST_PROXY` | sesi & proxy | `12`, `false`, `false` |
| `LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_SEC` | batas percobaan login per IP | `5`, `600` |
| `ALLOWED_HOSTS` | host tambahan untuk cek Origin | kosong |

## Operasional

```bash
pm2 status c-drive
pm2 logs c-drive --lines 100
pm2 restart c-drive
curl http://127.0.0.1:8000/healthz        # {"status":"ok",...}
pm2 install pm2-logrotate                  # disarankan: putar log otomatis
```

Tombol "Restart aplikasi" di panel membuat gunicorn keluar dengan bersih; pm2 menyalakannya kembali.

## Keamanan

- Tidak ada password atau kunci di kode; password disimpan sebagai hash scrypt di `.env` (izin 600).
- Batas percobaan login per IP, pembanding waktu-konstan, cookie `HttpOnly` + `SameSite=Lax`.
- Perlindungan CSRF (cek Origin/Referer), `next` login hanya path internal, hapus file wajib `POST`.
- Perbaikan pengecekan path (folder berawalan sama tidak bisa ditembus); HTML/SVG yang dibuka lewat `/view` disandbox.
- Mode debug Werkzeug dimatikan (di versi lama `debug=True` pada `0.0.0.0` membuka eksekusi kode jarak jauh).
- **Terminal web = shell dengan hak user aplikasi.** Jangan buka port ke internet publik; akses lewat VPN/Tailscale
  atau reverse proxy HTTPS, dan matikan dengan `ENABLE_TERMINAL=false` jika tidak perlu.

## Catatan

- Wajib **1 worker** gunicorn: sesi terminal, tugas latar belakang, dan upload chunk disimpan di memori proses.
- Kontrol service memakai `sudo -n service <nama> <aksi>`; atur sudoers NOPASSWD per service bila ingin dipakai.
