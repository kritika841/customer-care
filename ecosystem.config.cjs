module.exports = {
  apps: [
    {
      name: "satmi-support",
      script: "npm",
      args: "start -- -p 5010 -H 127.0.0.1",
      cwd: "/home/deployer/apps/satmi-support",
      env: {
        NODE_ENV: "production",
        PORT: 5010,
      },
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "500M",
      out_file: "/home/deployer/logs/satmi-support-out.log",
      error_file: "/home/deployer/logs/satmi-support-error.log",
      time: true,
    },
  ],
};
