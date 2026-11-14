#!/usr/bin/env python3
"""Atur password admin: simpan HASH (bukan teks biasa) ke .env.

Pemakaian:
  venv/bin/python scripts/set-password.py            # tanya password (tersembunyi)
  venv/bin/python scripts/set-password.py --random   # buat password acak dan tampilkan sekali
"""
import getpass
import os
import re
import secrets
import shutil
import stat
import sys

from werkzeug.security import generate_password_hash

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = os.path.join(ROOT, ".env")
EXAMPLE = os.path.join(ROOT, ".env.example")


def main():
    shown = None
    if "--random" in sys.argv:
        shown = secrets.token_urlsafe(16)
        pw = shown
    else:
        pw = getpass.getpass("Password baru (min. 10 karakter): ")
        if len(pw) < 10:
            sys.exit("Password terlalu pendek (minimal 10 karakter).")
        if getpass.getpass("Ulangi password: ") != pw:
            sys.exit("Password tidak sama.")

    hashed = generate_password_hash(pw)
    if not os.path.exists(ENV):
        shutil.copy(EXAMPLE, ENV)
    text = open(ENV, encoding="utf-8").read()
    line = f"ADMIN_PASSWORD_HASH='{hashed}'"
    if re.search(r"^ADMIN_PASSWORD_HASH=.*$", text, flags=re.M):
        text = re.sub(r"^ADMIN_PASSWORD_HASH=.*$", lambda _m: line, text, flags=re.M)
    else:
        text += "\n" + line + "\n"
    with open(ENV, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(ENV, stat.S_IRUSR | stat.S_IWUSR)
    print("Hash password disimpan di .env (izin 600).")
    if shown:
        print(f"Password baru (catat sekarang, tidak ditampilkan lagi): {shown}")


if __name__ == "__main__":
    main()
