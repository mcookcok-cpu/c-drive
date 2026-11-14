import os
import shutil
import zipfile
import time
import json
import gc
import sys
import socket
import subprocess
import threading
import urllib.request
import urllib.error
import urllib.parse
import datetime
import pty
import fcntl
import termios
import struct
import select
import signal
import uuid
import base64

try:
    from dotenv import load_dotenv
    load_dotenv()  # baca file .env di folder project (kalau ada) dan taruh isinya ke os.environ
except ImportError:
    pass

try:
    import psutil
except ImportError:
    psutil = None


def human_size(num_bytes):
    """Format ukuran file jadi teks yang gampang dibaca.
    Prioritas satuan MB: file kecil (<1MB) tampil KB, file besar (>=1GB) tampil GB,
    selain itu (kisaran umum) tampil MB.
    """
    kb = 1024
    mb = kb * 1024
    gb = mb * 1024

    if num_bytes < kb:
        return f"{num_bytes} B"
    elif num_bytes < mb:
        return f"{num_bytes / kb:.1f} KB"
    elif num_bytes < gb:
        return f"{num_bytes / mb:.1f} MB"
    else:
        return f"{num_bytes / gb:.2f} GB"


def safe_filename(name):
    """Sama seperti secure_filename bawaan Werkzeug (buang path traversal, karakter
    aneh, dsb), TAPI tetap mempertahankan titik di depan nama file (dotfile),
    yang oleh secure_filename() biasa malah dibuang habis -- makanya sebelumnya
    kalau ganti nama "env.example" jadi ".env", hasilnya cuma "env" (titiknya hilang).
    """
    name = (name or "").strip()
    if name in ("", ".", ".."):
        return ""

    leading_dots = len(name) - len(name.lstrip("."))
    rest = name.lstrip(".")
    cleaned_rest = secure_filename(rest)

    if leading_dots:
        return ("." * leading_dots) + cleaned_rest
    return cleaned_rest


def unique_destination(dest_path):
    """Kalau nama sudah ada di tujuan, tambahin ' (copy)', ' (copy 2)', dst."""
    if not os.path.exists(dest_path):
        return dest_path

    base, ext = os.path.splitext(dest_path)
    n = 1
    while True:
        candidate = f"{base} (copy{'' if n == 1 else ' ' + str(n)}){ext}"
        if not os.path.exists(candidate):
            return candidate
        n += 1


def get_disk_info():
    total, used, free = shutil.disk_usage(current_root())
    gb = 1024 ** 3
    return {
        "total_gb": round(total / gb, 1),
        "used_gb": round(used / gb, 1),
        "free_gb": round(free / gb, 1),
        "percent": round((used / total) * 100, 1) if total else 0
    }


def format_duration(seconds):
    """Ubah detik jadi teks durasi singkat, mis. '2 hari 5 jam'."""
    seconds = int(seconds)
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, _ = divmod(rem, 60)

    parts = []
    if days:
        parts.append(f"{days} hari")
    if hours:
        parts.append(f"{hours} jam")
    if not days and minutes:
        parts.append(f"{minutes} menit")

    return " ".join(parts) if parts else "< 1 menit"

from functools import wraps
from flask import (
    Flask,
    render_template,
    request,
    redirect,
    url_for,
    send_from_directory,
    send_file,
    abort,
    make_response,
    jsonify,
    session,
    Response
)
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash

# ===== Konfigurasi (semua lewat environment / file .env, tidak ada rahasia di kode) =====
import hmac
import logging
import secrets as _secrets

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")


def env_bool(name, default=False):
    v = os.environ.get(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _env_path(name, default):
    return os.path.abspath(os.path.expanduser(os.environ.get(name) or default))


logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("cdrive")

APP_NAME = os.environ.get("APP_NAME", "C-Drive")
ENABLE_TERMINAL = env_bool("ENABLE_TERMINAL", True)
START_TIME = time.time()


def _load_secret_key():
    """SECRET_KEY dari env; kalau kosong dibuat acak sekali lalu disimpan (0600) di data/.secret_key
    supaya sesi login tidak putus tiap restart."""
    key = os.environ.get("SECRET_KEY", "").strip()
    if key:
        return key
    path = os.path.join(DATA_DIR, ".secret_key")
    try:
        with open(path, "r", encoding="utf-8") as f:
            key = f.read().strip()
        if key:
            return key
    except OSError:
        pass
    key = _secrets.token_hex(32)
    os.makedirs(DATA_DIR, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(key)
    return key


def _load_password_hash():
    h = os.environ.get("ADMIN_PASSWORD_HASH", "").strip()
    if h:
        return h
    plain = os.environ.get("ADMIN_PASSWORD", "")
    if plain:
        log.warning("ADMIN_PASSWORD (teks biasa) dipakai; sebaiknya pakai ADMIN_PASSWORD_HASH (scripts/set-password.py).")
        return generate_password_hash(plain)
    sys.stderr.write("FATAL: ADMIN_PASSWORD_HASH belum diatur. Jalankan: python scripts/set-password.py\n")
    raise SystemExit(1)


app = Flask(__name__)
app.secret_key = _load_secret_key()
app.config.update(
    SESSION_COOKIE_NAME="cdrive_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=env_bool("SESSION_COOKIE_SECURE", False),
    PERMANENT_SESSION_LIFETIME=datetime.timedelta(hours=env_int("SESSION_HOURS", 12)),
    JSON_AS_ASCII=False,
)
if env_bool("TRUST_PROXY", False):
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# Login (dari .env: ADMIN_USERNAME, ADMIN_PASSWORD_HASH)
AUTH_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
AUTH_PASSWORD_HASH = _load_password_hash()

# Folder yang dibagikan (dari .env: C_DRIVE_HOME / DRIVE_ROOT / DRIVE_WORK_ROOT / DRIVE_HOME_ROOT)
C_DRIVE_HOME = _env_path("C_DRIVE_HOME", "~/c-drive-files")
ROOT = _env_path("DRIVE_ROOT", os.path.join(C_DRIVE_HOME, "drive"))

# ===== Lokasi Drive (panel pilihan di ikon pindah lokasi sebelah "Drive Saya") =====
# Panel dibuat OTOMATIS dari setiap folder di DRIVE_AUTO_SCAN (default /home), kecuali yang
# ada di DRIVE_EXCLUDE (default: C-Drive, yaitu folder aplikasi ini sendiri).
# Tiga panel lama tetap memakai label & path dari .env: Drive Saya / Work / Home.
# Folder baru di /home langsung muncul tanpa restart; folder yang tidak bisa dibaca user
# aplikasi (mis. /home/ubuntu) disembunyikan supaya tidak menampilkan error.
# key = kode lokasi (dipakai di URL & session), value = (label tampil, path folder asli).
import re as _re

DRIVE_AUTO_SCAN = _env_path("DRIVE_AUTO_SCAN", "/home")
DRIVE_EXCLUDE = {x.strip().lower() for x in os.environ.get("DRIVE_EXCLUDE", "C-Drive").split(",") if x.strip()}
_APP_DIR_REAL = os.path.realpath(os.path.dirname(os.path.abspath(__file__)))
_BASE_LOCATIONS = {
    "drive": ("agentuser", ROOT),
    "work": ("Work", _env_path("DRIVE_WORK_ROOT", os.path.join(C_DRIVE_HOME, "work"))),
    "home": ("Home", _env_path("DRIVE_HOME_ROOT", os.path.join(C_DRIVE_HOME, "home"))),
}
DEFAULT_LOCATION = "drive"


def get_locations():
    """Daftar lokasi aktif: 3 panel dasar + semua folder di DRIVE_AUTO_SCAN (selain DRIVE_EXCLUDE)."""
    locs = dict(_BASE_LOCATIONS)
    used = {os.path.realpath(path) for _, path in locs.values()}
    try:
        names = sorted(os.listdir(DRIVE_AUTO_SCAN), key=str.lower)
    except OSError:
        names = []
    for name in names:
        full = os.path.join(DRIVE_AUTO_SCAN, name)
        real = os.path.realpath(full)
        if name.startswith(".") or name.lower() in DRIVE_EXCLUDE or real == _APP_DIR_REAL:
            continue
        if not os.path.isdir(full) or real in used:
            continue
        if not os.access(full, os.R_OK | os.X_OK):
            continue
        base = _re.sub(r"[^a-z0-9_-]+", "-", name.lower()).strip("-") or "folder"
        key, n = base, 2
        while key in locs:
            key = f"{base}-{n}"; n += 1
        locs[key] = (name, full)
        used.add(real)
    return locs


def current_location():
    """Kode lokasi aktif punya user sekarang (tersimpan di session)."""
    loc = session.get("location", DEFAULT_LOCATION)
    return loc if loc in get_locations() else DEFAULT_LOCATION


def current_root():
    """Path folder asli yang lagi aktif (ganti-ganti sesuai lokasi yang dipilih)."""
    locs = get_locations()
    loc = session.get("location", DEFAULT_LOCATION)
    label, path = locs[loc if loc in locs else DEFAULT_LOCATION]
    os.makedirs(path, exist_ok=True)
    return path

# URL panel kontrol server (mis. Webmin, Cockpit, cPanel, dsb). Kosongkan jika tidak dipakai.
CONTROL_PANEL_URL = ""

# Manajemen Server sekarang otomatis mendeteksi semua service SysVinit yang terpasang
# di /etc/init.d (bukan cuma daftar tetap lagi), supaya kelihatan apa saja yang jalan
# di perangkat dan bisa dimatikan langsung dari panel.
#
# MANAGED_SERVICES di bawah ini cuma dipakai untuk menentukan URUTAN TAMPIL --
# service yang namanya ada di sini ditaruh paling atas, sisanya menyusul urut A-Z.
# Service "unggulan" yang ditampilkan ringkas paling atas dengan toggle on/off
# sederhana (bukan tombol start/stop/restart penuh). Service lain di luar daftar
# ini otomatis masuk ke sub-bagian "Service lainnya" yang bisa dibuka/tutup.
# key = label yang tampil di UI, value = nama service PERSIS seperti di /etc/init.d.
# PENTING: cek nama service yang benar di perangkatmu lewat daftar "Service lainnya"
# (mis. nama service Wifi belum tentu "wicd" -- bisa "networking", "wpa_supplicant",
# dst tergantung distro). Sesuaikan nilainya kalau toggle tidak berfungsi.
FEATURED_SERVICES = {
    "Apache2": "apache2",
    "Nginx": "nginx",
    "Database": "mysql",  # ganti ke "postgresql"/"mariadb"/dll kalau database-nya bukan MySQL
    # OBS bukan service SysVinit/systemd beneran (biasanya cuma dijalankan manual
    # di terminal), jadi nama "obs-studio-remote" ini di-treat khusus lewat
    # start_obs_remote()/stop_obs_remote() di bawah, BUKAN lewat perintah `service`.
    "OBS Studio Remote": "obs-studio-remote",
}

MANAGED_SERVICES = ["apache2", "nginx", "obs-studio-remote"]

# ===== OBS Studio (headless, lewat Xvfb) =====
# Perintah yang sama seperti yang biasa kamu ketik manual di terminal:
#   xvfb-run -a obs --disable-shutdown-check
# Status & stop pakai pgrep/pkill (cari proses lewat command line-nya), bukan PID
# file -- jadi tetap kedeteksi & bisa dimatikan meskipun OBS-nya dijalankan manual
# di terminal (bukan lewat toggle ini).
OBS_START_CMD = ["xvfb-run", "-a", "obs", "--disable-shutdown-check"]
OBS_LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "obs_remote.log")
# Pola unik buat pgrep/pkill -f, biar cuma kena proses OBS yang ini, bukan proses lain.
OBS_MATCH_PATTERN = "disable-shutdown-check"


def obs_remote_status():
    try:
        r = subprocess.run(
            ["pgrep", "-f", OBS_MATCH_PATTERN],
            capture_output=True, text=True, timeout=3
        )
        return "active" if r.stdout.strip() else "inactive"
    except FileNotFoundError:
        return "unknown"
    except Exception:
        return "unknown"


def start_obs_remote():
    if obs_remote_status() == "active":
        return True, "OBS sudah jalan."

    os.makedirs(os.path.dirname(OBS_LOG_FILE), exist_ok=True)
    try:
        with open(OBS_LOG_FILE, "a") as log:
            subprocess.Popen(
                OBS_START_CMD,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        return True, "OBS Studio (headless via Xvfb) dijalankan."
    except FileNotFoundError:
        return False, "Perintah 'xvfb-run' atau 'obs' tidak ditemukan. Pastikan sudah terpasang di server ini."
    except Exception as e:
        return False, f"Gagal menjalankan OBS: {e}"


def stop_obs_remote():
    if obs_remote_status() != "active":
        return True, "OBS memang belum jalan."

    try:
        # Matikan proses OBS-nya (dan xvfb-run wrapper-nya, command line-nya sama-sama
        # mengandung pola ini)
        subprocess.run(["pkill", "-9", "-f", OBS_MATCH_PATTERN], capture_output=True, text=True, timeout=5)
        # Xvfb yang dibuka xvfb-run tidak ikut kena pola di atas, jadi dimatikan terpisah
        subprocess.run(["pkill", "-9", "-f", "Xvfb :"], capture_output=True, text=True, timeout=5)
    except FileNotFoundError:
        return False, "Perintah 'pkill' tidak ditemukan di server ini."
    except Exception as e:
        return False, f"Gagal menghentikan OBS: {e}"

    return True, "OBS dihentikan."


# Service inti yang SENGAJA disembunyikan dari panel supaya tidak tidak sengaja
# dimatikan dan bikin perangkat kehilangan akses (jaringan/SSH) atau tidak stabil.
# Tambah/kurangi sesuai kebutuhan, tapi hati-hati.
CORE_SERVICES_HIDDEN = {
    "networking", "network-manager", "NetworkManager", "ssh", "sshd", "dropbear",
    "dbus", "udev", "systemd-udevd", "cron", "rsyslog", "procps", "hostname",
    "rc.local", "hwclock.sh", "keyboard-setup",
}

# Catatan: antiX (dan turunan Debian tanpa systemd lainnya) pakai SysVinit, bukan systemd,
# jadi kontrolnya lewat perintah `service`, bukan `systemctl`. Nama service Apache di
# Debian/antiX adalah "apache2" (bukan "httpd", itu nama di RHEL/CentOS).
# PENTING: agar start/stop/restart berhasil TANPA diminta password, user yang menjalankan
# app ini butuh izin sudo NOPASSWD khusus per service. Jalankan `sudo visudo` lalu tambahkan
# baris berikut (ganti <user> dan sesuaikan daftar service yang mau dikelola dari panel):
#   <user> ALL=(root) NOPASSWD: /usr/sbin/service apache2 start, /usr/sbin/service apache2 stop, /usr/sbin/service apache2 restart, /usr/sbin/service nginx start, /usr/sbin/service nginx stop, /usr/sbin/service nginx restart
# Kalau service belum ditambahkan ke sudoers, tombol start/stop/restart-nya tetap muncul
# di panel tapi akan menampilkan pesan error yang jelas saat dicoba.

UPLOAD_FOLDER = ROOT
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER

# Catatan disimpan terpisah dari ROOT (folder yang dibagikan), supaya tidak ikut ter-browse.
# Defaultnya di ~/catatan (folder home user, di luar folder project) supaya catatan tetap
# ada meski project di-pindah/di-reinstall. Bisa dioverride lewat .env: NOTES_DIR=/path/lain
NOTES_DIR = os.environ.get("NOTES_DIR", os.path.join(os.path.expanduser("~"), "catatan"))
NOTES_FILE = os.path.join(NOTES_DIR, "notes.json")
_OLD_NOTES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "notes.json")
if not os.path.exists(NOTES_FILE) and os.path.exists(_OLD_NOTES_FILE):
    # Migrasi otomatis sekali: kalau ada catatan lama di lokasi lama (dalam folder
    # project) dan lokasi baru masih kosong, pindahkan supaya catatan tidak hilang.
    os.makedirs(NOTES_DIR, exist_ok=True)
    shutil.copy2(_OLD_NOTES_FILE, NOTES_FILE)

# Teks bebas untuk widget "Teks Editor" (scratchpad tunggal, bukan daftar catatan)
SCRATCH_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "scratch.json")

# Log keamanan (percobaan login gagal & login berhasil terakhir)
SECURITY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "security.json")

# Folder sementara buat upload chunked (potongan file yang belum selesai diupload).
# Terpisah dari ROOT supaya file setengah-jadi tidak ikut ter-browse.
UPLOAD_TMP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "upload_tmp")

# ===== Sampah (Trash) =====
# Item yang dihapus lewat "Hapus" tidak langsung hilang -- dipindah dulu ke sini
# (di luar ROOT, jadi tidak ikut ter-browse), supaya bisa dipulihkan. Setelah
# TRASH_RETENTION_DAYS hari, item dihapus permanen otomatis oleh thread pembersih
# di bawah (juga dibersihkan tiap kali daftar Sampah dibuka, sebagai jaga-jaga).
TRASH_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "trash")
TRASH_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "trash.json")
TRASH_RETENTION_DAYS = 7

# Nomor versi aplikasi, ditampilkan kecil di sidebar
APP_VERSION = "2.0.0"


def load_security():
    if not os.path.exists(SECURITY_FILE):
        return {"failed_attempts": [], "last_success": None}
    try:
        with open(SECURITY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"failed_attempts": [], "last_success": None}


def save_security(data):
    os.makedirs(os.path.dirname(SECURITY_FILE), exist_ok=True)
    with open(SECURITY_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def log_failed_login(username):
    data = load_security()
    data.setdefault("failed_attempts", []).insert(0, {
        "username": username,
        "ip": request.remote_addr,
        "time": time.strftime("%d %b %Y %H:%M:%S")
    })
    data["failed_attempts"] = data["failed_attempts"][:50]
    save_security(data)


def log_success_login(username):
    data = load_security()
    data["last_success"] = {
        "username": username,
        "ip": request.remote_addr,
        "time": time.strftime("%d %b %Y %H:%M:%S")
    }
    save_security(data)


def load_notes():
    if not os.path.exists(NOTES_FILE):
        return []
    try:
        with open(NOTES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def save_notes(notes):
    os.makedirs(os.path.dirname(NOTES_FILE), exist_ok=True)
    with open(NOTES_FILE, "w", encoding="utf-8") as f:
        json.dump(notes, f, ensure_ascii=False, indent=2)


def load_trash():
    if not os.path.exists(TRASH_FILE):
        return []
    try:
        with open(TRASH_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def save_trash(trash):
    os.makedirs(os.path.dirname(TRASH_FILE), exist_ok=True)
    with open(TRASH_FILE, "w", encoding="utf-8") as f:
        json.dump(trash, f, ensure_ascii=False, indent=2)


def move_to_trash(path, rel_item):
    """Pindahkan file/folder ke Sampah (bukan dihapus langsung), supaya masih
    bisa dipulihkan sebelum akhirnya dihapus permanen otomatis setelah
    TRASH_RETENTION_DAYS hari."""
    os.makedirs(TRASH_DIR, exist_ok=True)

    trash_id = f"{int(time.time() * 1000)}-{os.urandom(4).hex()}"
    stored_path = os.path.join(TRASH_DIR, trash_id)

    name = os.path.basename(path)
    original_dir = os.path.dirname(rel_item).replace("\\", "/")
    is_dir = os.path.isdir(path)
    size_bytes = _path_size(path)

    shutil.move(path, stored_path)

    trash = load_trash()
    trash.insert(0, {
        "id": trash_id,
        "name": name,
        "original_dir": original_dir,
        "is_dir": is_dir,
        "size": size_bytes,
        "deleted_at": time.time()
    })
    save_trash(trash)


def purge_expired_trash():
    """Hapus permanen semua item Sampah yang usianya sudah lewat
    TRASH_RETENTION_DAYS hari. Dipanggil otomatis secara berkala oleh thread
    pembersih, dan juga tiap kali daftar Sampah diminta (jaga-jaga)."""
    trash = load_trash()
    cutoff = time.time() - (TRASH_RETENTION_DAYS * 86400)
    remaining = []
    changed = False

    for entry in trash:
        if entry.get("deleted_at", 0) < cutoff:
            stored_path = os.path.join(TRASH_DIR, entry["id"])
            try:
                if os.path.isdir(stored_path):
                    shutil.rmtree(stored_path)
                elif os.path.isfile(stored_path):
                    os.remove(stored_path)
            except OSError:
                pass
            changed = True
        else:
            remaining.append(entry)

    if changed:
        save_trash(remaining)

    return remaining


def _trash_cleanup_loop():
    """Thread latar belakang: cek tiap beberapa jam, hapus permanen item
    Sampah yang sudah lewat 7 hari -- jalan otomatis walau tidak ada yang
    membuka halaman Sampah."""
    while True:
        try:
            purge_expired_trash()
        except Exception:
            pass
        time.sleep(6 * 60 * 60)  # cek tiap 6 jam


threading.Thread(target=_trash_cleanup_loop, daemon=True).start()


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)
    return wrapped


@app.before_request
def csrf_origin_check():
    """Tolak request pengubah-data (POST/PUT/PATCH/DELETE) yang Origin/Referer-nya bukan situs ini."""
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        src = request.headers.get("Origin") or request.headers.get("Referer")
        if src:
            allowed = {request.host}
            allowed.update(h.strip() for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h.strip())
            if urllib.parse.urlparse(src).netloc not in allowed:
                log.warning("CSRF diblokir: %s %s dari %r", request.method, request.path, src)
                return jsonify({"ok": False, "message": "Permintaan lintas-situs ditolak."}), 403
    if not ENABLE_TERMINAL and request.path.startswith("/api/ssh/"):
        abort(404)
    return None


@app.before_request
def require_login():
    # Endpoint yang boleh diakses tanpa login
    exempt = {"login", "static", "healthz"}
    if request.endpoint in exempt:
        return None

    if not session.get("logged_in"):
        return redirect(url_for("login", next=request.path))

    return None


LOGIN_MAX_ATTEMPTS = env_int("LOGIN_MAX_ATTEMPTS", 5)
LOGIN_WINDOW_SEC = env_int("LOGIN_WINDOW_SEC", 600)
_LOGIN_FAILS = {}
_LOGIN_LOCK = threading.Lock()


def _login_locked_for(ip):
    """Sisa detik terkunci untuk IP ini (0 kalau tidak terkunci)."""
    now = time.time()
    with _LOGIN_LOCK:
        hits = [t for t in _LOGIN_FAILS.get(ip, []) if now - t < LOGIN_WINDOW_SEC]
        _LOGIN_FAILS[ip] = hits
        if len(hits) >= LOGIN_MAX_ATTEMPTS:
            return int(LOGIN_WINDOW_SEC - (now - hits[0])) + 1
    return 0


def _login_fail(ip):
    with _LOGIN_LOCK:
        _LOGIN_FAILS.setdefault(ip, []).append(time.time())


def _login_reset(ip):
    with _LOGIN_LOCK:
        _LOGIN_FAILS.pop(ip, None)


def _safe_next(nxt):
    """Hanya terima path relatif internal (cegah open redirect)."""
    if nxt and nxt.startswith("/") and not nxt.startswith("//") and "\\" not in nxt:
        return nxt
    return url_for("browse")


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None

    if request.method == "POST":
        username = request.form.get("username", "")
        password = request.form.get("password", "")

        ip = request.remote_addr or "?"
        wait = _login_locked_for(ip)
        if wait:
            minutes = max(1, wait // 60)
            error = f"Terlalu banyak percobaan gagal. Coba lagi sekitar {minutes} menit lagi."
            return render_template("login.html", error=error), 429

        user_ok = hmac.compare_digest(username.encode("utf-8"), AUTH_USERNAME.encode("utf-8"))
        pass_ok = check_password_hash(AUTH_PASSWORD_HASH, password)  # selalu dihitung (waktu konstan)
        if user_ok and pass_ok:
            session.clear()
            session.permanent = True
            session["logged_in"] = True
            session["username"] = username
            session["login_time"] = time.strftime("%d %b %Y %H:%M:%S")
            _login_reset(ip)
            log_success_login(username)
            log.info("login berhasil user=%r ip=%s", username, ip)
            return redirect(_safe_next(request.args.get("next")))

        _login_fail(ip)
        log_failed_login(username[:64])
        log.warning("login gagal user=%r ip=%s", username[:32], ip)
        error = "Username atau password salah."

    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    term_id = session.get("term_id")
    if term_id:
        _close_terminal(term_id)
    session.clear()
    return redirect(url_for("login"))


@app.route("/healthz")
def healthz():
    """Dipakai pm2/monitoring: tanpa login, tanpa data sensitif."""
    return jsonify({"status": "ok", "app": APP_NAME, "version": APP_VERSION,
                    "uptime_s": int(time.time() - START_TIME)})


@app.after_request
def security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    return resp


@app.context_processor
def inject_branding():
    return {"app_name": APP_NAME}


def safe_path_in(root, subpath):
    """Sama seperti safe_path, tapi root-nya dikasih langsung (bukan dibaca dari
    session) -- dipakai di dalam thread background (Salin/Pindah dsb) yang tidak
    punya request context lagi, jadi tidak bisa akses session."""
    root_abs = os.path.abspath(root)
    path = os.path.abspath(os.path.join(root_abs, subpath))
    if path != root_abs and not path.startswith(root_abs + os.sep):
        abort(403)
    return path


def safe_path(subpath):
    return safe_path_in(current_root(), subpath)


@app.route("/switch-location/<loc>")
def switch_location(loc):
    if loc not in get_locations():
        abort(404)
    session["location"] = loc
    return redirect(url_for("browse"))


@app.route("/")
@app.route("/browse/")
@app.route("/browse/<path:subpath>")
def browse(subpath=""):
    path = safe_path(subpath)

    if not os.path.exists(path):
        abort(404)

    hide_dotfiles = request.cookies.get("hide_dotfiles", "0") == "1"
    sort_desc = request.cookies.get("sort_desc", "0") == "1"

    items = []

    for name in os.listdir(path):
        if hide_dotfiles and name.startswith("."):
            continue

        full = os.path.join(path, name)

        ext = ""

        if os.path.isfile(full):
            ext = os.path.splitext(name)[1].lower().replace(".", "")

        size_bytes = os.path.getsize(full) if os.path.isfile(full) else 0
        modified_human = time.strftime("%d %b %Y %H:%M", time.localtime(os.path.getmtime(full)))

        items.append({
            "name": name,
            "path": os.path.join(subpath, name).replace("\\", "/"),
            "is_dir": os.path.isdir(full),
            "ext": ext,
            "size": size_bytes,
            "size_human": human_size(size_bytes),
            "modified_human": modified_human,
            "editable": os.path.isfile(full) and is_editable_file(name)
        })

    # Folder selalu tampil duluan, baru file, masing-masing urut A-Z (atau Z-A kalau diaktifkan)
    items.sort(key=lambda i: i["name"].lower(), reverse=sort_desc)
    items.sort(key=lambda i: not i["is_dir"])

    parent = os.path.dirname(subpath)

    return render_template(
        "index.html",
        items=items,
        current=subpath,
        parent=parent,
        disk=get_disk_info(),
        hide_dotfiles=hide_dotfiles,
        sort_desc=sort_desc,
        control_panel_url=CONTROL_PANEL_URL,
        app_version=APP_VERSION,
        locations=get_locations(),
        current_loc=current_location()
    )


@app.route("/view/<path:file>")
def view(file):
    file_path = safe_path(file)

    folder = os.path.dirname(file_path)
    filename = os.path.basename(file_path)

    resp = send_from_directory(folder, filename)
    if (resp.mimetype or "") in ("text/html", "image/svg+xml", "application/xhtml+xml"):
        resp.headers["Content-Security-Policy"] = "sandbox"
    return resp


@app.route("/download/<path:file>")
def download(file):
    file_path = safe_path(file)

    folder = os.path.dirname(file_path)
    filename = os.path.basename(file_path)

    return send_from_directory(
        folder,
        filename,
        as_attachment=True
    )


@app.route("/upload/<path:folder>", methods=["POST"])
@app.route("/upload/", defaults={"folder": ""}, methods=["POST"])
def upload(folder):
    path = safe_path(folder)

    if "file" not in request.files:
        return redirect(request.referrer)

    files = request.files.getlist("file")

    for f in files:
        if f.filename:
            filename = safe_filename(f.filename)
            if filename:
                f.save(os.path.join(path, filename))

    return redirect(request.referrer)


# ===== Upload chunked (mendukung banyak file sekaligus, jeda/lanjut, dan batal) =====
# Alur: klien pecah file jadi potongan (chunk) di browser, lalu kirim satu-satu ke
# /api/upload/chunk. Server nyimpen tiap potongan ke file ".part" di UPLOAD_TMP_DIR.
# Kalau di-jeda, klien cuma berhenti kirim potongan berikutnya -- yang sudah terkirim
# tidak hilang. Kalau di-lanjut, klien tanya /api/upload/start lagi dengan upload_id
# yang sama supaya tahu harus lanjut dari byte keberapa.

def _upload_id_is_safe(upload_id):
    """Cuma izinin karakter aman buat nama file (cegah path traversal lewat upload_id)."""
    return bool(upload_id) and len(upload_id) <= 100 and all(
        c.isalnum() or c in "-_" for c in upload_id
    )


def _upload_meta_path(upload_id):
    return os.path.join(UPLOAD_TMP_DIR, upload_id + ".json")


def _upload_part_path(upload_id):
    return os.path.join(UPLOAD_TMP_DIR, upload_id + ".part")


def _load_upload_meta(upload_id):
    p = _upload_meta_path(upload_id)
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _save_upload_meta(upload_id, meta):
    os.makedirs(UPLOAD_TMP_DIR, exist_ok=True)
    with open(_upload_meta_path(upload_id), "w", encoding="utf-8") as f:
        json.dump(meta, f)


# --- Dukungan upload chunk "pipelined" (beberapa potongan dikirim sekaligus,
# tidak nunggu balasan satu-satu) --------------------------------------------
# Karena beberapa potongan bisa nyampe & diproses TIDAK berurutan (klien
# ngirim beberapa request sekaligus), server tidak bisa lagi asumsi setiap
# potongan itu nempel pas di akhir file (append-only). Sebagai gantinya:
#   - file ".part" di-alokasikan penuh sejak awal (ukurannya = ukuran akhir),
#     lalu tiap potongan ditulis langsung ke offset-nya masing2 (seek+write).
#   - posisi mana saja yang sudah kebisi dicatat sebagai daftar rentang byte
#     [awal, akhir) yang digabung (merge) tiap ada potongan baru masuk.
#   - upload dianggap lengkap kalau rentang2 itu, setelah digabung, jadi
#     tepat satu rentang dari 0 sampai ukuran total.
# Lock per upload_id dipakai supaya dua potongan utk file yang sama yang
# nyampe bersamaan tidak tabrakan pas nulis/nyimpen metadata.

_upload_locks = {}
_upload_locks_guard = threading.Lock()


def _get_upload_lock(upload_id):
    with _upload_locks_guard:
        lock = _upload_locks.get(upload_id)
        if lock is None:
            lock = threading.Lock()
            _upload_locks[upload_id] = lock
        return lock


def _drop_upload_lock(upload_id):
    with _upload_locks_guard:
        _upload_locks.pop(upload_id, None)


def _merge_ranges(ranges):
    """Gabungkan rentang [awal, akhir) yang beririsan/bersambung, hasil terurut."""
    if not ranges:
        return []
    ranges = sorted((int(a), int(b)) for a, b in ranges if b > a)
    merged = [list(ranges[0])]
    for start, end in ranges[1:]:
        last = merged[-1]
        if start <= last[1]:
            last[1] = max(last[1], end)
        else:
            merged.append([start, end])
    return merged


def _ranges_total(ranges):
    return sum(b - a for a, b in ranges)


def _ranges_complete(ranges, size):
    if size == 0:
        return True
    return len(ranges) == 1 and ranges[0][0] == 0 and ranges[0][1] == size


@app.route("/api/upload/start", methods=["POST"])
def api_upload_start():
    """Mulai (atau lanjutkan) sesi upload. Klien kirim upload_id bikinan sendiri --
    kalau sesi dengan id itu sudah ada dan cocok (nama/folder/ukuran sama), server
    balikin posisi byte terakhir supaya klien lanjut dari situ, bukan dari nol."""
    data = request.get_json(silent=True) or {}
    upload_id = (data.get("upload_id") or "").strip()
    name = safe_filename(data.get("name") or "")
    folder = data.get("folder") or ""

    if not _upload_id_is_safe(upload_id):
        return jsonify({"error": "ID upload tidak valid"}), 400
    if not name:
        return jsonify({"error": "Nama file kosong"}), 400

    try:
        size = int(data.get("size"))
        if size < 0:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({"error": "Ukuran file tidak valid"}), 400

    dest_dir = safe_path(folder)
    if not os.path.isdir(dest_dir):
        return jsonify({"error": "Folder tujuan tidak ditemukan"}), 404

    existing = _load_upload_meta(upload_id)
    part_path = _upload_part_path(upload_id)

    if (existing and os.path.exists(part_path)
            and existing.get("name") == name
            and existing.get("folder") == folder
            and existing.get("size") == size
            and os.path.getsize(part_path) == size):
        ranges = _merge_ranges(existing.get("ranges") or [])
        return jsonify({
            "upload_id": upload_id,
            "received": _ranges_total(ranges),
            "ranges": ranges,
            "resumed": True,
        })

    # Sesi baru -- alokasikan file sepenuh ukuran akhir supaya tiap potongan
    # bisa ditulis langsung ke offset-nya (bukan cuma ditempel di akhir),
    # ini yang bikin beberapa potongan bisa dikirim & ditulis sekaligus.
    os.makedirs(UPLOAD_TMP_DIR, exist_ok=True)
    with open(part_path, "wb") as f:
        if size > 0:
            f.truncate(size)
    _save_upload_meta(upload_id, {"name": name, "folder": folder, "size": size, "ranges": []})

    return jsonify({"upload_id": upload_id, "received": 0, "ranges": [], "resumed": False})


@app.route("/api/upload/chunk/<upload_id>", methods=["POST"])
def api_upload_chunk(upload_id):
    """Terima satu potongan file (raw bytes) dan tulis langsung ke offset-nya.

    Klien boleh ngirim beberapa potongan sekaligus (pipelining) tanpa nunggu
    balasan potongan sebelumnya -- karena itu potongan bisa nyampe di sini
    tidak berurutan. Makanya kita tulis ke offset yang diminta (bukan cuma
    nempel di akhir file), dan kunci per upload_id supaya aman kalau ada
    beberapa potongan file yang sama diproses berbarengan (multi-thread)."""
    if not _upload_id_is_safe(upload_id):
        abort(400)

    try:
        offset = int(request.headers.get("X-Chunk-Offset", "-1"))
        if offset < 0:
            raise ValueError
    except ValueError:
        return jsonify({"error": "Header offset tidak valid"}), 400

    chunk = request.get_data()
    if not chunk:
        return jsonify({"error": "Potongan file kosong"}), 400

    lock = _get_upload_lock(upload_id)
    with lock:
        meta = _load_upload_meta(upload_id)
        part_path = _upload_part_path(upload_id)
        if not meta or not os.path.exists(part_path):
            return jsonify({"error": "Sesi upload tidak ditemukan (mungkin sudah dibatalkan)"}), 404

        size = meta.get("size", 0)
        end = offset + len(chunk)
        if end > size:
            return jsonify({"error": "Ukuran melebihi total file"}), 400

        with open(part_path, "r+b") as f:
            f.seek(offset)
            f.write(chunk)

        ranges = _merge_ranges((meta.get("ranges") or []) + [[offset, end]])
        meta["ranges"] = ranges
        _save_upload_meta(upload_id, meta)

        return jsonify({"received": _ranges_total(ranges), "complete": _ranges_complete(ranges, size)})


@app.route("/api/upload/finish/<upload_id>", methods=["POST"])
def api_upload_finish(upload_id):
    """Semua potongan sudah terkirim -- pindahkan file .part ke folder tujuan."""
    if not _upload_id_is_safe(upload_id):
        abort(400)

    lock = _get_upload_lock(upload_id)
    with lock:
        meta = _load_upload_meta(upload_id)
        part_path = _upload_part_path(upload_id)
        if not meta or not os.path.exists(part_path):
            return jsonify({"error": "Sesi upload tidak ditemukan"}), 404

        size = meta.get("size", 0)
        ranges = _merge_ranges(meta.get("ranges") or [])
        if not _ranges_complete(ranges, size):
            return jsonify({"error": "File belum lengkap", "received": _ranges_total(ranges)}), 400

        dest_dir = safe_path(meta["folder"])
        if not os.path.isdir(dest_dir):
            return jsonify({"error": "Folder tujuan tidak ditemukan"}), 404

        dest_path = unique_destination(os.path.join(dest_dir, meta["name"]))
        shutil.move(part_path, dest_path)

        try:
            os.remove(_upload_meta_path(upload_id))
        except OSError:
            pass

    _drop_upload_lock(upload_id)
    return jsonify({"ok": True, "name": os.path.basename(dest_path)})


@app.route("/api/upload/cancel/<upload_id>", methods=["POST"])
def api_upload_cancel(upload_id):
    """Batalkan sesi upload dan hapus sisa potongan yang sudah tersimpan."""
    if not _upload_id_is_safe(upload_id):
        abort(400)

    for p in (_upload_part_path(upload_id), _upload_meta_path(upload_id)):
        try:
            if os.path.exists(p):
                os.remove(p)
        except OSError:
            pass
    _drop_upload_lock(upload_id)

    return jsonify({"ok": True})


@app.route("/api/upload/status/<upload_id>")
def api_upload_status(upload_id):
    """Cek progress sesi upload -- dipakai kalau halaman di-reload biar Upload
    Manager bisa nampilin ulang posisi terakhir yang tersimpan di server."""
    if not _upload_id_is_safe(upload_id):
        abort(400)

    meta = _load_upload_meta(upload_id)
    part_path = _upload_part_path(upload_id)
    if not meta or not os.path.exists(part_path):
        return jsonify({"exists": False})

    ranges = _merge_ranges(meta.get("ranges") or [])
    return jsonify({
        "exists": True,
        "name": meta["name"],
        "folder": meta["folder"],
        "size": meta["size"],
        "received": _ranges_total(ranges),
        "ranges": ranges,
    })


@app.route("/delete/<path:item>", methods=["POST"])
def delete(item):
    path = safe_path(item)

    if not os.path.exists(path):
        abort(404)

    move_to_trash(path, item)

    return jsonify({"ok": True})


@app.route("/rename", methods=["POST"])
def rename():

    old = request.form["old"]
    new = request.form["new"]

    old_path = safe_path(old)

    cleaned_new = safe_filename(new)
    if not cleaned_new:
        return redirect(request.referrer)

    new_path = os.path.join(
        os.path.dirname(old_path),
        cleaned_new
    )

    os.rename(old_path, new_path)

    return redirect(request.referrer)


@app.route("/api/folders/")
@app.route("/api/folders/<path:subpath>")
def api_folders(subpath=""):
    """Dipakai oleh folder-picker (Pindah ke... / Salin ke...) untuk menelusuri subfolder saja."""
    path = safe_path(subpath)

    if not os.path.isdir(path):
        abort(404)

    folders = []

    for name in sorted(os.listdir(path), key=str.lower):
        full = os.path.join(path, name)
        if os.path.isdir(full):
            folders.append({
                "name": name,
                "path": os.path.join(subpath, name).replace("\\", "/")
            })

    parent = os.path.dirname(subpath)

    return jsonify({
        "current": subpath,
        "parent": parent,
        "folders": folders
    })


@app.route("/move", methods=["POST"])
def move_item():
    src = request.form["src"]
    dest_folder = request.form.get("dest_folder", "")

    src_path = safe_path(src)
    dest_dir = safe_path(dest_folder)

    if not os.path.isdir(dest_dir):
        abort(404)

    dest_path = os.path.join(dest_dir, os.path.basename(src_path))

    # Jangan pindah ke dalam dirinya sendiri / folder tujuan sama dengan folder asal
    if os.path.abspath(dest_path) == os.path.abspath(src_path):
        return redirect(request.referrer)

    dest_path = unique_destination(dest_path)

    shutil.move(src_path, dest_path)

    return redirect(request.referrer)


@app.route("/copy", methods=["POST"])
def copy_item():
    src = request.form["src"]
    dest_folder = request.form.get("dest_folder", "")

    src_path = safe_path(src)
    dest_dir = safe_path(dest_folder)

    if not os.path.isdir(dest_dir):
        abort(404)

    dest_path = unique_destination(os.path.join(dest_dir, os.path.basename(src_path)))

    if os.path.isdir(src_path):
        shutil.copytree(src_path, dest_path)
    else:
        shutil.copy2(src_path, dest_path)

    return redirect(request.referrer)


@app.route("/api/check-names", methods=["POST"])
def api_check_names():
    """Cek nama item mana saja yang sudah ada di folder tujuan (dipakai sebelum Tempel,
    supaya bisa munculkan notif "timpa atau tidak")."""
    items = request.form.getlist("items")
    dest_folder = request.form.get("dest_folder", "")

    dest_dir = safe_path(dest_folder)
    if not os.path.isdir(dest_dir):
        abort(404)

    conflicts = []
    for item in items:
        src_path = safe_path(item)
        dest_path = os.path.join(dest_dir, os.path.basename(src_path))
        if os.path.abspath(dest_path) == os.path.abspath(src_path):
            continue
        if os.path.exists(dest_path):
            conflicts.append(os.path.basename(src_path))

    return jsonify({"conflicts": conflicts})


@app.route("/batch/delete", methods=["POST"])
def batch_delete():
    """Pindahkan banyak item sekaligus ke Sampah (dipakai oleh mode seleksi)."""
    items = request.form.getlist("items")

    deleted = 0
    for item in items:
        path = safe_path(item)

        if os.path.exists(path):
            move_to_trash(path, item)
            deleted += 1

    return jsonify({"ok": True, "count": deleted})


# ===== Task progress (Salin / Pindah / Extract berjalan di background thread) =====
# Kenapa perlu ini: Salin/Pindah/Extract dulu blocking (satu request nunggu sampai
# SEMUA file kelar baru dapat balasan) jadi nggak ada cara nampilin persentase, dan
# kalau modal/tab pindah, prosesnya seperti macet padahal cuma nunggu. Sekarang
# prosesnya jalan di thread terpisah, progressnya (dalam byte) disimpan di TASKS,
# dan frontend polling ke /api/task/status/<id> tiap beberapa ratus ms buat nampilin
# progress bar + persentase, serta bisa "minimize" (collapse) panel-nya kapan saja
# tanpa proses di background ikut berhenti.
TASKS = {}
TASKS_LOCK = threading.Lock()
TASK_COPY_CHUNK = 4 * 1024 * 1024  # 4 MB per potongan baca/tulis


class _TaskCancelled(Exception):
    pass


def _new_task(kind, label):
    task_id = uuid.uuid4().hex
    task = {
        "id": task_id,
        "kind": kind,          # 'copy' | 'move' | 'extract'
        "label": label,        # nama file/folder, atau "3 item"
        "status": "running",   # running, done, error, cancelled
        "bytes_done": 0,
        "bytes_total": 0,
        "current_name": "",
        "error": None,
        "errors": [],
        "cancel": False,
        "created_at": time.time(),
        "finished_at": None,
    }
    with TASKS_LOCK:
        TASKS[task_id] = task
    return task


def _task_payload(task):
    if task["bytes_total"]:
        percent = int(task["bytes_done"] * 100 / task["bytes_total"])
    else:
        percent = 100 if task["status"] == "done" else 0
    percent = max(0, min(100, percent))
    return {
        "id": task["id"],
        "kind": task["kind"],
        "label": task["label"],
        "status": task["status"],
        "percent": percent,
        "current_name": task["current_name"],
        "error": task["error"],
        "errors": task["errors"],
    }


def _tasks_reaper_loop():
    """Buang task yang sudah kelar (done/error/cancelled) dari memori setelah 10 menit,
    biar TASKS gak numpuk terus kalau server nyala lama."""
    while True:
        time.sleep(60)
        now = time.time()
        with TASKS_LOCK:
            stale = [
                tid for tid, t in TASKS.items()
                if t["finished_at"] and (now - t["finished_at"]) > 600
            ]
            for tid in stale:
                TASKS.pop(tid, None)


threading.Thread(target=_tasks_reaper_loop, daemon=True).start()


def _path_size(path):
    """Total ukuran file (rekursif kalau folder) buat dasar hitung persentase progress."""
    if os.path.isdir(path):
        total = 0
        for root, _dirs, files in os.walk(path):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
        return total
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def _copy_file_with_progress(src, dest, task):
    if task["cancel"]:
        raise _TaskCancelled()
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    task["current_name"] = os.path.basename(src)
    with open(src, "rb") as fsrc, open(dest, "wb") as fdst:
        while True:
            if task["cancel"]:
                raise _TaskCancelled()
            buf = fsrc.read(TASK_COPY_CHUNK)
            if not buf:
                break
            fdst.write(buf)
            task["bytes_done"] += len(buf)
    try:
        shutil.copystat(src, dest)
    except OSError:
        pass


def _copy_tree_with_progress(src, dest, task):
    os.makedirs(dest, exist_ok=True)
    for root, _dirs, files in os.walk(src):
        if task["cancel"]:
            raise _TaskCancelled()
        rel = os.path.relpath(root, src)
        dest_root = dest if rel == "." else os.path.join(dest, rel)
        os.makedirs(dest_root, exist_ok=True)
        for f in files:
            _copy_file_with_progress(os.path.join(root, f), os.path.join(dest_root, f), task)


def _run_batch_task(task, action, items, dest_folder, overwrite, root):
    try:
        dest_dir = safe_path_in(root, dest_folder)

        # Hitung dulu total ukuran semua item (buat dasar persentase) sebelum mulai
        resolved = []
        total = 0
        for item in items:
            src_path = safe_path_in(root, item)
            if not os.path.exists(src_path):
                task["errors"].append({"item": item, "error": "Sumber tidak ditemukan"})
                continue
            size = _path_size(src_path)
            resolved.append((item, src_path, size))
            total += size
        task["bytes_total"] = total

        for item, src_path, size in resolved:
            if task["cancel"]:
                task["status"] = "cancelled"
                task["finished_at"] = time.time()
                return
            try:
                dest_path = os.path.join(dest_dir, os.path.basename(src_path))

                if os.path.abspath(dest_path) == os.path.abspath(src_path):
                    task["bytes_done"] += size
                    continue

                if os.path.exists(dest_path):
                    if overwrite:
                        # Yang ditimpa dipindah ke Sampah dulu (bukan dihapus permanen),
                        # biar aman kalau proses salin/pindah gagal di tengah jalan.
                        rel_dest = os.path.join(dest_folder, os.path.basename(dest_path)).replace("\\", "/")
                        move_to_trash(dest_path, rel_dest)
                    else:
                        dest_path = unique_destination(dest_path)

                if action == "copy":
                    if os.path.isdir(src_path):
                        _copy_tree_with_progress(src_path, dest_path, task)
                    else:
                        _copy_file_with_progress(src_path, dest_path, task)
                else:  # move
                    task["current_name"] = os.path.basename(src_path)
                    try:
                        # Rename di filesystem yang sama itu instan, gak perlu baca/tulis ulang isinya
                        os.rename(src_path, dest_path)
                        task["bytes_done"] += size
                    except OSError:
                        # Beda filesystem -- fallback: salin manual (dengan progress) baru hapus sumbernya
                        if os.path.isdir(src_path):
                            _copy_tree_with_progress(src_path, dest_path, task)
                            shutil.rmtree(src_path)
                        else:
                            _copy_file_with_progress(src_path, dest_path, task)
                            os.remove(src_path)
            except _TaskCancelled:
                task["status"] = "cancelled"
                task["finished_at"] = time.time()
                return
            except Exception as e:
                task["errors"].append({"item": item, "error": str(e)})

        task["status"] = "done"
        task["finished_at"] = time.time()
    except Exception as e:
        task["status"] = "error"
        task["error"] = str(e)
        task["finished_at"] = time.time()


@app.route("/api/batch/start", methods=["POST"])
def api_batch_start():
    """Mulai proses Salin/Pindah di background thread, balikin task_id buat dipoll progressnya."""
    action = request.form.get("action")
    if action not in ("copy", "move"):
        return jsonify({"error": "Aksi tidak dikenal"}), 400

    items = request.form.getlist("items")
    dest_folder = request.form.get("dest_folder", "")
    overwrite = request.form.get("overwrite") == "1"

    if not items:
        return jsonify({"error": "Tidak ada item dipilih"}), 400

    dest_dir = safe_path(dest_folder)
    if not os.path.isdir(dest_dir):
        return jsonify({"error": "Folder tujuan tidak ditemukan"}), 404

    root = current_root()
    label = items[0].split("/")[-1] if len(items) == 1 else f"{len(items)} item"
    task = _new_task("copy" if action == "copy" else "move", label)

    threading.Thread(
        target=_run_batch_task,
        args=(task, action, items, dest_folder, overwrite, root),
        daemon=True,
    ).start()

    return jsonify({"ok": True, "task_id": task["id"]})


def _run_extract_task(task, zip_path, target):
    try:
        with zipfile.ZipFile(zip_path, "r") as z:
            infos = z.infolist()
            task["bytes_total"] = sum(i.file_size for i in infos)

            for info in infos:
                if task["cancel"]:
                    task["status"] = "cancelled"
                    task["finished_at"] = time.time()
                    return

                dest_path = os.path.join(target, info.filename)

                if info.is_dir():
                    os.makedirs(dest_path, exist_ok=True)
                    continue

                os.makedirs(os.path.dirname(dest_path) or ".", exist_ok=True)
                task["current_name"] = os.path.basename(info.filename) or info.filename

                with z.open(info) as fsrc, open(dest_path, "wb") as fdst:
                    while True:
                        if task["cancel"]:
                            task["status"] = "cancelled"
                            task["finished_at"] = time.time()
                            return
                        buf = fsrc.read(TASK_COPY_CHUNK)
                        if not buf:
                            break
                        fdst.write(buf)
                        task["bytes_done"] += len(buf)

        task["status"] = "done"
        task["finished_at"] = time.time()
    except Exception as e:
        task["status"] = "error"
        task["error"] = str(e)
        task["finished_at"] = time.time()


@app.route("/api/extract/start/<path:file>", methods=["POST"])
def api_extract_start(file):
    """Mulai proses extract ZIP di background thread, balikin task_id buat dipoll progressnya."""
    zip_path = safe_path(file)

    if not zip_path.endswith(".zip") or not os.path.isfile(zip_path):
        return jsonify({"error": "Bukan file ZIP yang valid"}), 400

    target = zip_path[:-4]
    label = os.path.basename(zip_path)
    task = _new_task("extract", label)

    threading.Thread(
        target=_run_extract_task,
        args=(task, zip_path, target),
        daemon=True,
    ).start()

    return jsonify({"ok": True, "task_id": task["id"]})


@app.route("/api/task/status/<task_id>")
def api_task_status(task_id):
    with TASKS_LOCK:
        task = TASKS.get(task_id)
    if not task:
        return jsonify({"error": "Task tidak ditemukan (mungkin server baru di-restart)"}), 404
    return jsonify(_task_payload(task))


@app.route("/api/task/cancel/<task_id>", methods=["POST"])
def api_task_cancel(task_id):
    with TASKS_LOCK:
        task = TASKS.get(task_id)
    if task and task["status"] == "running":
        task["cancel"] = True
    return jsonify({"ok": True})


# ===== API Sampah (Trash) =====
@app.route("/api/trash")
def api_trash_list():
    """Daftar item di Sampah, dipakai oleh panel Sampah di sidebar."""
    trash = purge_expired_trash()
    trash.sort(key=lambda e: e.get("deleted_at", 0), reverse=True)

    now = time.time()
    items = []
    for e in trash:
        deleted_at = e.get("deleted_at", now)
        age_days = (now - deleted_at) / 86400
        days_left = max(0, TRASH_RETENTION_DAYS - int(age_days))
        items.append({
            "id": e["id"],
            "name": e["name"],
            "is_dir": e.get("is_dir", False),
            "size_human": human_size(e.get("size", 0)),
            "deleted_human": time.strftime("%d %b %Y %H:%M", time.localtime(deleted_at)),
            "days_left": days_left
        })

    return jsonify({"items": items, "retention_days": TRASH_RETENTION_DAYS})


@app.route("/api/trash/restore/<trash_id>", methods=["POST"])
def api_trash_restore(trash_id):
    """Kembalikan item dari Sampah ke lokasi asalnya (folder asal dibuat lagi
    kalau sudah tidak ada, dan nama ditambah ' (copy)' kalau sudah ada yang
    bentrok)."""
    trash = load_trash()
    entry = next((e for e in trash if e["id"] == trash_id), None)
    if not entry:
        return jsonify({"error": "Item Sampah tidak ditemukan"}), 404

    stored_path = os.path.join(TRASH_DIR, trash_id)
    if not os.path.exists(stored_path):
        save_trash([e for e in trash if e["id"] != trash_id])
        return jsonify({"error": "Item sudah tidak ada"}), 404

    dest_dir = safe_path(entry.get("original_dir", ""))
    os.makedirs(dest_dir, exist_ok=True)
    dest_path = unique_destination(os.path.join(dest_dir, entry["name"]))

    shutil.move(stored_path, dest_path)

    save_trash([e for e in trash if e["id"] != trash_id])
    return jsonify({"ok": True})


@app.route("/api/trash/delete/<trash_id>", methods=["POST"])
def api_trash_delete(trash_id):
    """Hapus permanen satu item dari Sampah (tidak bisa dipulihkan lagi)."""
    trash = load_trash()
    entry = next((e for e in trash if e["id"] == trash_id), None)
    if not entry:
        return jsonify({"error": "Item Sampah tidak ditemukan"}), 404

    stored_path = os.path.join(TRASH_DIR, trash_id)
    if os.path.isdir(stored_path):
        shutil.rmtree(stored_path)
    elif os.path.isfile(stored_path):
        os.remove(stored_path)

    save_trash([e for e in trash if e["id"] != trash_id])
    return jsonify({"ok": True})


@app.route("/api/trash/empty", methods=["POST"])
def api_trash_empty():
    """Kosongkan Sampah -- hapus permanen semua item sekaligus."""
    trash = load_trash()
    for entry in trash:
        stored_path = os.path.join(TRASH_DIR, entry["id"])
        try:
            if os.path.isdir(stored_path):
                shutil.rmtree(stored_path)
            elif os.path.isfile(stored_path):
                os.remove(stored_path)
        except OSError:
            pass

    save_trash([])
    return jsonify({"ok": True, "count": len(trash)})


@app.route("/zip/<path:folder>")
def zip_folder(folder):

    folder_path = safe_path(folder)

    zip_path = unique_destination(folder_path + ".zip")

    with zipfile.ZipFile(
        zip_path,
        "w",
        zipfile.ZIP_DEFLATED
    ) as z:

        for root, dirs, files in os.walk(folder_path):

            for file in files:

                full = os.path.join(root, file)

                arc = os.path.relpath(
                    full,
                    folder_path
                )

                z.write(full, arc)

    return redirect(request.referrer)


@app.route("/settings/hidden", methods=["POST"])
def toggle_hidden():
    hide = request.form.get("hide_dotfiles") == "1"

    resp = redirect(request.referrer or url_for("browse"))
    resp.set_cookie(
        "hide_dotfiles",
        "1" if hide else "0",
        max_age=60 * 60 * 24 * 365
    )
    return resp


@app.route("/settings/sort", methods=["POST"])
def toggle_sort_default():
    desc = request.form.get("sort_desc") == "1"

    resp = redirect(request.referrer or url_for("browse"))
    resp.set_cookie(
        "sort_desc",
        "1" if desc else "0",
        max_age=60 * 60 * 24 * 365
    )
    return resp


@app.route("/mkdir", methods=["POST"])
def mkdir():

    folder = request.form["folder"]

    current = request.form["current"]

    path = safe_path(
        os.path.join(current, folder)
    )

    os.makedirs(path, exist_ok=True)

    return redirect(request.referrer)


def get_top_processes(limit=4):
    """Proses dengan pemakaian RAM tertinggi (persentase RAM sistem)."""
    procs = []
    for p in psutil.process_iter(["pid", "name", "memory_percent"]):
        try:
            info = p.info
            procs.append(info)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    procs.sort(key=lambda x: x.get("memory_percent") or 0, reverse=True)

    return [
        {
            "pid": p["pid"],
            "name": p.get("name") or "?",
            "ram_percent": round(p.get("memory_percent") or 0, 1)
        }
        for p in procs[:limit]
    ]


def get_swap_info():
    """Status swap RAM (termasuk swap yang jalan di atas zram, kalau ada)."""
    try:
        sm = psutil.swap_memory()
    except Exception:
        return None

    if sm.total == 0:
        return {
            "percent": 0,
            "used_gb": 0,
            "total_gb": 0,
            "active": False
        }

    return {
        "percent": sm.percent,
        "used_gb": round(sm.used / (1024 ** 3), 2),
        "total_gb": round(sm.total / (1024 ** 3), 2),
        "active": True
    }


def get_zram_info():
    """Deteksi perangkat zram lewat /sys/block/zram*. Best-effort, None kalau tidak ada zram."""
    try:
        base = "/sys/block"
        if not os.path.isdir(base):
            return None

        devices = []
        for name in sorted(os.listdir(base)):
            if not name.startswith("zram"):
                continue

            dev_path = os.path.join(base, name)

            def read_val(fname):
                try:
                    with open(os.path.join(dev_path, fname)) as f:
                        return f.read().strip()
                except Exception:
                    return None

            disksize = int(read_val("disksize") or 0)
            if disksize == 0:
                continue  # zram device ada tapi belum diaktifkan

            orig_size = compr_size = mem_used = 0
            mm_stat = read_val("mm_stat")
            if mm_stat:
                parts = mm_stat.split()
                if len(parts) >= 3:
                    orig_size, compr_size, mem_used = (
                        int(parts[0]), int(parts[1]), int(parts[2])
                    )
            else:
                orig_size = int(read_val("orig_data_size") or 0)
                compr_size = int(read_val("compr_data_size") or 0)
                mem_used = int(read_val("mem_used_total") or 0)

            devices.append({
                "name": name,
                "disksize_mb": round(disksize / (1024 * 1024), 1),
                "used_mb": round(mem_used / (1024 * 1024), 1),
                "orig_mb": round(orig_size / (1024 * 1024), 1),
                "ratio": round(orig_size / compr_size, 2) if compr_size else None
            })

        return devices if devices else None
    except Exception:
        return None


def get_battery_info():
    """Status baterai (kalau perangkat punya baterai, mis. laptop/UPS yang terbaca psutil).
    Balikin None kalau tidak ada baterai terdeteksi (server desktop/VPS biasa)."""
    if not hasattr(psutil, "sensors_battery"):
        return None
    try:
        batt = psutil.sensors_battery()
    except Exception:
        return None
    if batt is None:
        return None

    time_left = None
    secsleft = getattr(batt, "secsleft", None)
    if secsleft is not None and secsleft not in (
        psutil.POWER_TIME_UNLIMITED, psutil.POWER_TIME_UNKNOWN
    ):
        time_left = format_duration(secsleft)

    return {
        "percent": round(batt.percent, 1),
        "plugged": bool(batt.power_plugged),
        "time_left": time_left
    }


@app.route("/api/system")
def api_system():
    """Dipakai oleh panel 'Monitor Sistem' di sidebar (RAM & CPU real-time)."""
    if psutil is None:
        return jsonify({
            "available": False,
            "message": "Modul psutil belum terpasang. Jalankan: pip install psutil"
        })

    vm = psutil.virtual_memory()
    cpu = psutil.cpu_percent(interval=0.15)
    proc = psutil.Process(os.getpid())
    proc_rss_mb = round(proc.memory_info().rss / (1024 * 1024), 1)
    uptime = format_duration(time.time() - psutil.boot_time())

    return jsonify({
        "available": True,
        "cpu_percent": cpu,
        "ram": {
            "percent": vm.percent,
            "used_gb": round(vm.used / (1024 ** 3), 2),
            "total_gb": round(vm.total / (1024 ** 3), 2),
            "available_gb": round(vm.available / (1024 ** 3), 2),
        },
        "battery": get_battery_info(),
        "swap": get_swap_info(),
        "zram": get_zram_info(),
        "process_rss_mb": proc_rss_mb,
        "uptime": uptime,
        "top_processes": get_top_processes()
    })


@app.route("/api/system/boost", methods=["POST"])
def api_system_boost():
    """Bersihkan memori proses server (garbage collection) dan laporkan hasilnya.
    Catatan jujur: ini membersihkan objek Python yang sudah tidak terpakai di proses
    server ini saja -- bukan 'membebaskan RAM sistem' secara ajaib seperti aplikasi
    'RAM booster' di iklan, yang klaimnya memang tidak berdasar secara teknis.
    """
    if psutil is None:
        return jsonify({
            "available": False,
            "message": "Modul psutil belum terpasang. Jalankan: pip install psutil"
        })

    proc = psutil.Process(os.getpid())
    before = proc.memory_info().rss

    collected = gc.collect()

    after = proc.memory_info().rss
    freed_mb = round(max(before - after, 0) / (1024 * 1024), 2)

    vm = psutil.virtual_memory()

    return jsonify({
        "available": True,
        "objects_collected": collected,
        "freed_mb": freed_mb,
        "process_rss_mb": round(after / (1024 * 1024), 1),
        "ram_percent": vm.percent
    })


# ===== Jaringan =====
_public_ip_cache = {"ip": None, "ts": 0}


def get_local_ips():
    ips = []
    try:
        stats = psutil.net_if_stats()
        for iface, addrs in psutil.net_if_addrs().items():
            if_up = stats[iface].isup if iface in stats else False
            for addr in addrs:
                if addr.family == socket.AF_INET and not addr.address.startswith("127."):
                    ips.append({"iface": iface, "ip": addr.address, "up": if_up})
    except Exception:
        pass
    return ips


def get_public_ip():
    """IP publik, di-cache 5 menit supaya tidak nge-hit layanan luar tiap refresh."""
    now = time.time()
    if _public_ip_cache["ip"] and now - _public_ip_cache["ts"] < 300:
        return _public_ip_cache["ip"]
    try:
        with urllib.request.urlopen("https://api.ipify.org", timeout=3) as r:
            ip = r.read().decode("utf-8").strip()
            _public_ip_cache["ip"] = ip
            _public_ip_cache["ts"] = now
            return ip
    except Exception:
        return None


@app.route("/api/network")
def api_network():
    if psutil is None:
        return jsonify({"available": False, "message": "Modul psutil belum terpasang."})

    io = psutil.net_io_counters()
    mb = 1024 ** 2

    return jsonify({
        "available": True,
        "local_ips": get_local_ips(),
        "public_ip": get_public_ip(),
        "sent_mb": round(io.bytes_sent / mb, 1),
        "recv_mb": round(io.bytes_recv / mb, 1)
    })


# ===== Manajemen Server =====
def service_status(name):
    """Cek status service lewat skrip init.d (`service <name> status`), sesuai
    konvensi LSB: exit code 0 = jalan, 3 = berhenti. Ini tidak butuh sudo."""
    if name == "obs-studio-remote":
        return obs_remote_status()

    try:
        r = subprocess.run(
            ["service", name, "status"],
            capture_output=True, text=True, timeout=3
        )
        if r.returncode == 0:
            return "active"
        elif r.returncode == 3:
            return "inactive"
        return "unknown"
    except FileNotFoundError:
        return "unknown"
    except Exception:
        return "unknown"


def discover_services():
    """Cari semua service SysVinit yang terpasang di /etc/init.d, supaya panel
    Manajemen Server otomatis kelihatan apa saja yang ada -- tidak perlu didaftar
    manual satu-satu di MANAGED_SERVICES lagi. Service inti/berisiko (jaringan,
    SSH, dst -- lihat CORE_SERVICES_HIDDEN) sengaja dikecualikan demi keamanan.
    MANAGED_SERVICES dipakai untuk menentukan urutan tampil, bukan pembatas lagi."""
    init_dir = "/etc/init.d"
    skip_files = {
        "README", "skeleton", "rc", "rcS", "single", "functions",
        ".depend.boot", ".depend.start", ".depend.stop"
    }

    try:
        candidates = sorted(os.listdir(init_dir))
    except (FileNotFoundError, PermissionError):
        candidates = list(MANAGED_SERVICES)

    names = []
    for name in candidates:
        if name in skip_files or name.startswith(".") or name in CORE_SERVICES_HIDDEN:
            continue
        full = os.path.join(init_dir, name)
        if not os.path.isfile(full) or not os.access(full, os.X_OK):
            continue
        names.append(name)

    # Service yang namanya ada di MANAGED_SERVICES ditaruh paling atas (urutan sesuai
    # daftar itu), sisanya menyusul urut A-Z.
    ordered = [n for n in MANAGED_SERVICES if n in names]
    ordered += [n for n in names if n not in MANAGED_SERVICES]
    return ordered


@app.route("/api/services")
def api_services():
    featured_names = set(FEATURED_SERVICES.values())

    featured = [
        {"name": svc_name, "label": label, "status": service_status(svc_name)}
        for label, svc_name in FEATURED_SERVICES.items()
    ]

    other_names = [n for n in discover_services() if n not in featured_names]
    others = [{"name": n, "label": n, "status": service_status(n)} for n in other_names]
    others.sort(key=lambda s: (0 if s["status"] == "active" else 1, s["name"]))

    return jsonify({"featured": featured, "others": others})


@app.route("/api/pm2")
def api_pm2():
    """Daftar proses pm2 + port yang didengarkan (untuk halaman PM2 di sidebar)."""
    try:
        from pm2_info import get_pm2_overview
        return jsonify(get_pm2_overview())
    except Exception as exc:
        return jsonify({"ok": False, "message": "Gagal membaca pm2: " + str(exc)[:160]}), 500


# Binary/aplikasi command-line yang relevan buat fitur-fitur di aplikasi ini,
# beserta penjelasan singkat kenapa dibutuhkan -- ditampilkan di Panel Kontrol
# > Manajemen Server > Aplikasi & Dependensi.
SYSTEM_BINARIES = [
    {"bin": "python3", "label": "Python 3", "note": "runtime aplikasi ini", "version_flag": "--version"},
    {"bin": "pip3", "label": "pip", "note": "install dependency Python (requirements.txt)", "version_flag": "--version"},
    {"bin": "bash", "label": "Bash", "note": "dipakai fitur Terminal di sidebar", "version_flag": "--version"},
    {"bin": "git", "label": "Git", "note": "opsional -- kelola source code/project", "version_flag": "--version"},
    {"bin": "node", "label": "Node.js", "note": "opsional -- jalanin project JavaScript", "version_flag": "--version"},
    {"bin": "npm", "label": "npm", "note": "opsional -- install dependency JavaScript", "version_flag": "--version"},
    {"bin": "ffmpeg", "label": "FFmpeg", "note": "opsional -- olah audio/video", "version_flag": "-version"},
]


def _bin_version(path, flag):
    try:
        r = subprocess.run([path, flag], capture_output=True, text=True, timeout=3)
        out = (r.stdout or r.stderr or "").strip().splitlines()
        return out[0][:80] if out else ""
    except Exception:
        return ""


def check_system_binaries():
    result = []
    for item in SYSTEM_BINARIES:
        path = shutil.which(item["bin"])
        result.append({
            "name": item["bin"],
            "label": item["label"],
            "note": item["note"],
            "installed": bool(path),
            "path": path or "",
            "version": _bin_version(path, item["version_flag"]) if path else "",
        })
    return result


def check_python_packages():
    """Baca requirements.txt lalu cocokkan tiap paket dengan versi yang benar-benar
    terpasang (importlib.metadata), biar kelihatan mana yang belum diinstall."""
    result = []
    req_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "requirements.txt")
    try:
        with open(req_path, "r", encoding="utf-8") as f:
            lines = [ln.strip() for ln in f if ln.strip() and not ln.strip().startswith("#")]
    except Exception:
        lines = []

    try:
        from importlib import metadata as importlib_metadata
    except ImportError:
        import importlib_metadata  # type: ignore

    for line in lines:
        if "==" in line:
            pkg, wanted = line.split("==", 1)
        else:
            pkg, wanted = line, ""
        pkg = pkg.strip()
        wanted = wanted.strip()
        try:
            installed_version = importlib_metadata.version(pkg)
            installed = True
        except Exception:
            installed_version = ""
            installed = False
        result.append({
            "name": pkg,
            "wanted": wanted,
            "installed": installed,
            "version": installed_version,
        })
    return result


@app.route("/api/system/dependencies")
def api_system_dependencies():
    return jsonify({
        "python_version": sys.version.split()[0],
        "packages": check_python_packages(),
        "binaries": check_system_binaries(),
    })


def allowed_service_names():
    """Nama service yang boleh di-start/stop/restart dari panel: gabungan service
    unggulan (FEATURED_SERVICES) dan hasil deteksi otomatis (discover_services)."""
    return set(FEATURED_SERVICES.values()) | set(discover_services())


@app.route("/api/services/<name>/<action>", methods=["POST"])
def api_service_action(name, action):
    if name not in allowed_service_names():
        return jsonify({"ok": False, "message": "Service tidak ditemukan atau tidak diizinkan dikelola dari panel ini."}), 403
    if action not in ("start", "stop", "restart"):
        return jsonify({"ok": False, "message": "Aksi tidak dikenal"}), 400

    if name == "obs-studio-remote":
        if action == "start":
            ok, msg = start_obs_remote()
        elif action == "stop":
            ok, msg = stop_obs_remote()
        else:  # restart
            stop_obs_remote()
            time.sleep(1)
            ok, msg = start_obs_remote()

        if not ok:
            return jsonify({"ok": False, "message": msg}), 500
        return jsonify({"ok": True, "status": service_status(name), "message": msg})

    try:
        r = subprocess.run(
            ["sudo", "-n", "service", name, action],
            capture_output=True, text=True, timeout=10
        )
        if r.returncode != 0:
            msg = r.stderr.strip() or r.stdout.strip() or "Gagal menjalankan perintah."
            if "password" in msg.lower() or "sudo" in msg.lower():
                msg += " Pastikan sudo NOPASSWD untuk service ini sudah diatur (lihat komentar MANAGED_SERVICES di app.py)."
            return jsonify({"ok": False, "message": msg}), 500
    except FileNotFoundError:
        return jsonify({"ok": False, "message": "Perintah 'service' atau 'sudo' tidak ditemukan di server ini."}), 500
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "message": "Waktu tunggu perintah habis."}), 500

    return jsonify({"ok": True, "status": service_status(name)})


def _under_gunicorn():
    try:
        with open(f"/proc/{os.getppid()}/cmdline", "rb") as f:
            return b"gunicorn" in f.read()
    except OSError:
        return False


@app.route("/api/server/restart-app", methods=["POST"])
def api_restart_app():
    """Restart proses aplikasi Flask ini sendiri (re-exec proses Python saat ini).
    Catatan: kalau app ini dijalankan lewat systemd, cara paling rapi adalah
    menambahkan nama service app ini sendiri ke MANAGED_SERVICES lalu pakai
    tombol restart service biasa. Endpoint ini adalah cara umum yang tetap
    berfungsi walau app dijalankan manual (python app.py)."""
    def do_restart():
        time.sleep(1)
        if _under_gunicorn():
            # Master gunicorn keluar -> pm2 menyalakan ulang seluruh aplikasi dengan bersih.
            os.kill(os.getppid(), signal.SIGTERM)
        else:
            os.execv(sys.executable, [sys.executable] + sys.argv)

    threading.Thread(target=do_restart, daemon=True).start()
    return jsonify({"ok": True, "message": "Aplikasi akan restart dalam beberapa detik..."})


# ===== Keamanan =====
@app.route("/api/security")
def api_security():
    data = load_security()
    return jsonify({
        "failed_attempts": data.get("failed_attempts", [])[:10],
        "last_success": data.get("last_success"),
        "current_session": {
            "username": session.get("username"),
            "login_time": session.get("login_time"),
            "ip": request.remote_addr
        }
    })


# ===== CLI (terminal web sederhana) =====
# ===== Terminal SSH-style (PTY persisten, jalan terus seperti sesi SSH sungguhan) =====
# Beda sama CLI lama (yang cuma subprocess.run sekali jalan lalu selesai): di sini
# server benar-benar membuka satu proses bash lewat pseudo-terminal (pty) yang tetap
# HIDUP selama sesinya belum ditutup. Karena itu:
#   - "cd" beneran mengubah direktori kerja shell-nya sendiri (bukan ditangani manual).
#   - Program yang butuh tampilan hidup terus seperti `top`, `tail -f`, atau `vim`
#     bisa dipakai, karena outputnya di-stream terus-menerus ke browser (SSE), bukan
#     nunggu satu perintah selesai baru kelihatan hasilnya.
#   - Layar terminalnya digambar beneran (termasuk warna/kursor) oleh xterm.js di sisi
#     browser, mirip yang kamu lihat kalau ssh ke server ini dari terminal biasa.
#
# Catatan: ini BUKAN protokol SSH yang sesungguhnya (tidak connect ke host lain lewat
# port 22) -- ini terminal lokal ke shell server ini sendiri, ditampilkan lewat web,
# dengan nuansa & perilaku seperti sesi SSH. Tiap sesi terminal disimpan di memori
# server (TERMINAL_SESSIONS), diikat ke sesi login (cookie) masing-masing user.
TERMINAL_SESSIONS = {}
TERMINAL_LOCK = threading.Lock()


def _set_winsize(fd, rows, cols):
    try:
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except Exception:
        pass


def _terminal_alive(entry):
    try:
        pid, status = os.waitpid(entry["pid"], os.WNOHANG)
        if pid == 0:
            return True
        return False
    except ChildProcessError:
        return False
    except Exception:
        try:
            os.kill(entry["pid"], 0)
            return True
        except Exception:
            return False


def _spawn_terminal(cwd):
    pid, fd = pty.fork()
    if pid == 0:
        # Proses anak: ganti direktori kerja & jalankan shell interaktif.
        try:
            os.chdir(cwd if os.path.isdir(cwd) else ROOT)
        except Exception:
            pass
        os.environ["TERM"] = "xterm-256color"
        os.environ["PS1"] = r"\u@\h:\w\$ "
        try:
            os.execvp("bash", ["bash"])
        except FileNotFoundError:
            os.execvp("sh", ["sh"])
    _set_winsize(fd, 24, 80)
    return pid, fd


def _close_terminal(term_id):
    with TERMINAL_LOCK:
        entry = TERMINAL_SESSIONS.pop(term_id, None)
    if not entry:
        return
    try:
        os.kill(entry["pid"], signal.SIGHUP)
    except Exception:
        pass
    # Beri jeda sekejap supaya bash sempat mati oleh SIGHUP sebelum dipaksa
    # SIGKILL, dan supaya waitpid di bawah tidak keburu dipanggil saat anak
    # belum mati (race) -- itulah sumber zombie yang menumpuk sebelumnya.
    time.sleep(0.05)
    try:
        os.kill(entry["pid"], signal.SIGKILL)
    except Exception:
        pass
    # wait BLOKING (bukan WNOHANG): sesudah SIGKILL anak pasti segera mati,
    # jadi reap dijamin terjadi. Dulu pakai WNOHANG -> kalau anak belum mati
    # di momen itu, sesi tetap dihapus dari daftar dan zombie tidak pernah
    # di-reap oleh siapa pun (inilah penyebab 11 zombie yang menumpuk).
    try:
        os.waitpid(entry["pid"], 0)
    except Exception:
        pass
    try:
        os.close(entry["fd"])
    except Exception:
        pass


def _terminal_reaper_loop():
    """Thread latar belakang: buang sesi terminal yang proses shell-nya sudah mati
    (mis. diketik 'exit') supaya tidak menumpuk di memori."""
    while True:
        try:
            with TERMINAL_LOCK:
                dead = [tid for tid, e in TERMINAL_SESSIONS.items() if not _terminal_alive(e)]
            for tid in dead:
                _close_terminal(tid)
            # Jaring pengaman: sapu SEMUA zombie anak proses server ini tiap
            # siklus (sesi yang lolos race close, atau Popen seperti OBS yang
            # sudah mati tanpa pernah di-wait). Aman untuk subprocess.run di
            # thread lain: kalau ada thread lain lebih dulu menunggu anak yang
            # sama, Python menangani ECHILD dengan rapi (diuji di Python 3.13).
            while True:
                try:
                    if os.waitpid(-1, os.WNOHANG)[0] == 0:
                        break
                except Exception:
                    break
        except Exception:
            pass
        time.sleep(30)


threading.Thread(target=_terminal_reaper_loop, daemon=True).start()


@app.route("/api/ssh/start", methods=["POST"])
def api_ssh_start():
    term_id = session.get("term_id")
    with TERMINAL_LOCK:
        entry = TERMINAL_SESSIONS.get(term_id) if term_id else None
        if entry and _terminal_alive(entry):
            return jsonify({"ok": True, "term_id": term_id, "resumed": True})

    if term_id:
        _close_terminal(term_id)

    rel_cwd = request.form.get("cwd", "")
    cwd = safe_path(rel_cwd) if rel_cwd else current_root()
    if not os.path.isdir(cwd):
        cwd = current_root()

    try:
        pid, fd = _spawn_terminal(cwd)
    except Exception as e:
        return jsonify({"ok": False, "error": f"Gagal membuka terminal: {e}"}), 500

    new_id = uuid.uuid4().hex
    with TERMINAL_LOCK:
        TERMINAL_SESSIONS[new_id] = {"pid": pid, "fd": fd}
    session["term_id"] = new_id

    return jsonify({"ok": True, "term_id": new_id, "resumed": False})


@app.route("/api/ssh/input", methods=["POST"])
def api_ssh_input():
    term_id = session.get("term_id")
    entry = TERMINAL_SESSIONS.get(term_id)
    if not entry:
        return jsonify({"error": "Sesi terminal belum dimulai atau sudah berakhir."}), 400

    data = request.get_json(silent=True) or {}
    text = data.get("data", "")
    try:
        os.write(entry["fd"], text.encode("utf-8", errors="ignore"))
    except OSError as e:
        return jsonify({"error": str(e)}), 500

    return jsonify({"ok": True})


@app.route("/api/ssh/resize", methods=["POST"])
def api_ssh_resize():
    term_id = session.get("term_id")
    entry = TERMINAL_SESSIONS.get(term_id)
    if not entry:
        return jsonify({"ok": False}), 400

    data = request.get_json(silent=True) or {}
    try:
        rows = max(1, int(data.get("rows", 24)))
        cols = max(1, int(data.get("cols", 80)))
    except (TypeError, ValueError):
        return jsonify({"ok": False}), 400

    _set_winsize(entry["fd"], rows, cols)
    return jsonify({"ok": True})


@app.route("/api/ssh/stream")
def api_ssh_stream():
    term_id = request.args.get("term_id") or session.get("term_id")
    entry = TERMINAL_SESSIONS.get(term_id)
    if not entry:
        return jsonify({"error": "Sesi terminal tidak ditemukan."}), 404

    fd = entry["fd"]

    def generate():
        while True:
            if term_id not in TERMINAL_SESSIONS:
                yield "event: end\ndata: sesi-berakhir\n\n"
                break
            try:
                ready, _, _ = select.select([fd], [], [], 15.0)
            except Exception:
                yield "event: end\ndata: sesi-berakhir\n\n"
                break

            if not ready:
                # Keepalive supaya koneksi SSE tidak dianggap putus saat idle
                yield ": keepalive\n\n"
                continue

            try:
                chunk = os.read(fd, 4096)
            except OSError:
                yield "event: end\ndata: proses-berakhir\n\n"
                break

            if not chunk:
                yield "event: end\ndata: proses-berakhir\n\n"
                break

            yield "data: " + base64.b64encode(chunk).decode("ascii") + "\n\n"

    return Response(generate(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


@app.route("/api/ssh/stop", methods=["POST"])
def api_ssh_stop():
    term_id = session.pop("term_id", None)
    if term_id:
        _close_terminal(term_id)
    return jsonify({"ok": True})


@app.route("/api/notes", methods=["GET"])
def api_notes_list():
    return jsonify(load_notes())


@app.route("/api/notes", methods=["POST"])
def api_notes_add():
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    text = (data.get("text") or "").strip()

    if not text:
        return jsonify({"error": "Catatan kosong"}), 400

    notes = load_notes()
    note = {
        "id": int(time.time() * 1000),
        "title": title or "(Tanpa judul)",
        "text": text,
        "created": time.strftime("%d %b %Y %H:%M")
    }
    notes.insert(0, note)
    save_notes(notes)

    return jsonify(note)


@app.route("/api/notes/<int:note_id>", methods=["DELETE"])
def api_notes_delete(note_id):
    notes = load_notes()
    notes = [n for n in notes if n["id"] != note_id]
    save_notes(notes)

    return jsonify({"ok": True})


@app.route("/api/notes/<int:note_id>", methods=["PUT"])
def api_notes_edit(note_id):
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    text = (data.get("text") or "").strip()

    if not text:
        return jsonify({"error": "Catatan kosong"}), 400

    notes = load_notes()
    found = None
    for n in notes:
        if n["id"] == note_id:
            n["title"] = title or "(Tanpa judul)"
            n["text"] = text
            n["edited"] = time.strftime("%d %b %Y %H:%M")
            found = n
            break

    if not found:
        return jsonify({"error": "Catatan tidak ditemukan"}), 404

    save_notes(notes)
    return jsonify(found)


# ===== Teks Editor (scratchpad tunggal, mengambang) =====
def load_scratch():
    if not os.path.exists(SCRATCH_FILE):
        return {"text": "", "updated": None}
    try:
        with open(SCRATCH_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"text": "", "updated": None}


@app.route("/api/scratch", methods=["GET"])
def api_scratch_get():
    return jsonify(load_scratch())


@app.route("/api/scratch", methods=["POST"])
def api_scratch_save():
    data = request.get_json(silent=True) or {}
    text = data.get("text", "")

    payload = {"text": text, "updated": time.strftime("%d %b %Y %H:%M:%S")}
    os.makedirs(os.path.dirname(SCRATCH_FILE), exist_ok=True)
    with open(SCRATCH_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    return jsonify(payload)


# ===== Teks Editor: mode file (buka/edit/simpan file sungguhan di ROOT) =====
# Ekstensi yang dianggap file teks/kode dan boleh muncul di daftar "Buka file"
EDITOR_EXTENSIONS = {
    "txt", "md", "markdown", "json", "yml", "yaml", "ini", "conf", "cfg", "env",
    "py", "js", "jsx", "ts", "tsx", "html", "htm", "css", "scss", "sh", "bash",
    "php", "java", "c", "cpp", "h", "hpp", "go", "rs", "rb", "sql", "xml", "log",
    "toml"
}
# Folder yang dilewati saat menyusuri ROOT (biar tidak lambat / tidak relevan)
EDITOR_SKIP_DIRS = {".git", "node_modules", "venv", ".venv", "__pycache__", ".cache"}
EDITOR_MAX_FILES = 300
EDITOR_MAX_SIZE = 2 * 1024 * 1024  # 2 MB, biar tetap ringan dibuka di browser


def is_editable_file(name):
    if "." not in name:
        return False
    ext = name.rsplit(".", 1)[-1].lower()
    return ext in EDITOR_EXTENSIONS


@app.route("/api/editor/files")
def api_editor_files():
    """Daftar file teks/kode di bawah ROOT, buat dropdown 'Buka file' di Teks Editor."""
    results = []
    root = current_root()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EDITOR_SKIP_DIRS and not d.startswith(".")]
        for fname in sorted(filenames):
            if is_editable_file(fname):
                full = os.path.join(dirpath, fname)
                rel = os.path.relpath(full, root).replace(os.sep, "/")
                results.append(rel)
                if len(results) >= EDITOR_MAX_FILES:
                    break
        if len(results) >= EDITOR_MAX_FILES:
            break
    results.sort()
    return jsonify({"files": results})


@app.route("/api/editor/file", methods=["GET"])
def api_editor_file_get():
    rel = request.args.get("path", "")
    if not rel:
        return jsonify({"error": "Path kosong"}), 400

    path = safe_path(rel)
    if not os.path.isfile(path):
        return jsonify({"error": "File tidak ditemukan"}), 404
    if os.path.getsize(path) > EDITOR_MAX_SIZE:
        return jsonify({"error": "File terlalu besar untuk dibuka di editor (maks 2 MB)"}), 400

    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
    except UnicodeDecodeError:
        return jsonify({"error": "File ini bukan file teks (biner)"}), 400

    return jsonify({"path": rel, "content": content})


@app.route("/api/editor/file", methods=["POST"])
def api_editor_file_save():
    data = request.get_json(silent=True) or {}
    rel = (data.get("path") or "").strip()
    content = data.get("content", "")

    if not rel:
        return jsonify({"error": "Path kosong"}), 400

    path = safe_path(rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)

    return jsonify({"ok": True, "path": rel, "saved": time.strftime("%d %b %Y %H:%M:%S")})


@app.route("/api/editor/file", methods=["DELETE"])
def api_editor_file_delete():
    rel = request.args.get("path", "")
    if not rel:
        return jsonify({"error": "Path kosong"}), 400

    path = safe_path(rel)
    if not os.path.isfile(path):
        return jsonify({"error": "File tidak ditemukan"}), 404

    os.remove(path)
    return jsonify({"ok": True})


@app.route("/api/editor/newfile", methods=["POST"])
def api_editor_newfile():
    data = request.get_json(silent=True) or {}
    rel = (data.get("path") or "").strip().lstrip("/")

    if not rel:
        return jsonify({"error": "Nama file kosong"}), 400

    path = safe_path(rel)
    if os.path.exists(path):
        return jsonify({"error": "File dengan nama itu sudah ada"}), 400

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write("")

    return jsonify({"ok": True, "path": rel})


if __name__ == "__main__":
    # Mode pengembangan saja. Produksi: gunicorn lewat pm2 (lihat README.md & ecosystem.config.cjs).
    log.warning("Menjalankan server dev Werkzeug. Untuk produksi gunakan gunicorn/pm2.")
    app.run(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=env_int("PORT", 8000),
        debug=env_bool("FLASK_DEBUG", False),
        threaded=True  # wajib biar beberapa potongan upload (pipelining) bisa diproses barengan
    )
