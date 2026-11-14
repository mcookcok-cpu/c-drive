"""Info proses pm2 + port yang didengarkan, untuk halaman PM2 di menu hamburger C-Drive.

Hanya membaca: `pm2 jlist`, `ss -ltnp`, `ps` dan `tailscale ip -4`. Tidak ada aksi start/stop.
"""
import json
import os
import re
import subprocess
import time

_TS_CACHE = {"ip": "", "t": 0.0}
_SKIP_PORTS = {22, 53, 631}  # SSH, DNS, CUPS: bukan aplikasi web
_ALL_IFACES = {"0.0.0.0", "*", "[::]", "::"}


def _run(cmd, timeout=8):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout or ""
    except Exception:
        return ""


def tailscale_ip():
    env = os.environ.get("TAILSCALE_IP", "").strip()
    if env:
        return env
    now = time.time()
    if _TS_CACHE["ip"] and now - _TS_CACHE["t"] < 300:
        return _TS_CACHE["ip"]
    out = _run(["tailscale", "ip", "-4"], timeout=3).strip().splitlines()
    ip = out[0].strip() if out else ""
    _TS_CACHE.update(ip=ip, t=now)
    return ip


def _pm2_list():
    out = _run(["pm2", "jlist"], timeout=10)
    start = out.find("[")
    if start < 0:
        return []
    try:
        return json.loads(out[start:])
    except ValueError:
        return []


def _ppid_map():
    mapping = {}
    for line in _run(["ps", "-eo", "pid=,ppid="], timeout=5).splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            mapping[int(parts[0])] = int(parts[1])
    return mapping


def _listeners():
    """[(port, bind, [pid, ...]), ...] dari `ss -ltnp` (satu entri per alamat)."""
    result = []
    for line in _run(["ss", "-H", "-ltnp"], timeout=5).splitlines():
        cols = line.split()
        if len(cols) < 4:
            continue
        local = cols[3]
        if ":" not in local:
            continue
        bind, _, port = local.rpartition(":")
        if not port.isdigit():
            continue
        bind = bind.split("%", 1)[0]  # buang suffix interface, mis. %tailscale0
        pids = [int(p) for p in re.findall(r"pid=(\d+)", line)]
        result.append((int(port), bind, pids))
    return result


def _is_loopback(bind):
    return bind.startswith("127.") or bind in ("[::1]", "::1", "localhost")


def get_pm2_overview():
    ts_ip = tailscale_ip()
    procs = _pm2_list()
    ppid = _ppid_map()
    pm2_pid_to_name = {}
    for p in procs:
        pid = p.get("pid") or 0
        if pid:
            pm2_pid_to_name[int(pid)] = p.get("name", "")

    def owner_of(pid):
        seen = 0
        while pid and seen < 60:
            if pid in pm2_pid_to_name:
                return pm2_pid_to_name[pid]
            pid = ppid.get(pid, 0)
            seen += 1
        return None

    ports_by_name = {}   # nama -> {port: reachable}
    other = {}           # port -> reachable
    for port, bind, pids in _listeners():
        reachable = not _is_loopback(bind)
        owner = None
        for pid in pids:
            owner = owner_of(pid)
            if owner:
                break
        if owner:
            d = ports_by_name.setdefault(owner, {})
            d[port] = d.get(port, False) or reachable
        elif port not in _SKIP_PORTS and port < 32768 and (bind in _ALL_IFACES or (ts_ip and bind == ts_ip)):
            other[port] = True

    now_ms = time.time() * 1000
    items = []
    for p in procs:
        env = p.get("pm2_env", {}) or {}
        monit = p.get("monit", {}) or {}
        status = env.get("status", "unknown")
        up = env.get("pm_uptime") or 0
        uptime_s = int((now_ms - up) / 1000) if status == "online" and up else 0
        name = p.get("name", "")
        ports = [{"port": port, "reachable": ok} for port, ok in sorted(ports_by_name.get(name, {}).items())]
        items.append({
            "name": name,
            "id": p.get("pm_id"),
            "status": status,
            "pid": p.get("pid") or 0,
            "cpu": monit.get("cpu", 0),
            "mem": monit.get("memory", 0),
            "restarts": env.get("restart_time", 0),
            "uptime_s": uptime_s,
            "ports": ports,
        })
    items.sort(key=lambda i: (0 if i["status"] == "online" else 1, i["name"]))

    return {
        "ok": True,
        "tailscale_ip": ts_ip,
        "processes": items,
        "other_ports": [{"port": p, "reachable": True} for p in sorted(other)],
    }
