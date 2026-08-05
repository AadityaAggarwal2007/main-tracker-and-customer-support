module.exports = {
  apps: [
    {
      name: 'tracker',
      script: 'node_modules/.bin/next',
      args: 'start',
      cwd: '/var/www/tracker',
      instances: 2,           // 2 of 4 vCPUs for Next.js; 2 left for PostgreSQL
      exec_mode: 'cluster',   // load balance requests across instances
      max_memory_restart: '2G',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      // Auto-restart on crash
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '5s',
      // Logging
      out_file: '/var/log/tracker-out.log',
      error_file: '/var/log/tracker-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
