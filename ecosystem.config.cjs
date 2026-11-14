// pm2 start ecosystem.config.cjs   |   pm2 reload c-drive --update-env
const path = require("path");

module.exports = {
  apps: [
    {
      name: "c-drive",
      cwd: __dirname,
      script: path.join(__dirname, "venv", "bin", "gunicorn"),
      args: "-c gunicorn.conf.py app:app",
      interpreter: "none",
      exec_mode: "fork",
      instances: 1, // state di memori -> jangan di-cluster

      autorestart: true,
      min_uptime: "20s",
      max_restarts: 10,
      exp_backoff_restart_delay: 200,
      max_memory_restart: "600M",
      kill_timeout: 15000, // beri waktu gunicorn menutup koneksi dengan rapi

      time: true,
      merge_logs: true,
      env: {
        PYTHONUNBUFFERED: "1",
      },
    },
  ],
};
