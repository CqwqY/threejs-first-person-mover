// pm2 进程配置：在远程以 fp-relay 名称常驻 node index.js（监听 8080）
module.exports = {
  apps: [
    {
      name: 'fp-relay',
      script: './index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      min_uptime: '10s',
      time: true,
    },
  ],
};