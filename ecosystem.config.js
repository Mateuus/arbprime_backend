module.exports = {
  apps: [
    {
      name: "arbprime_backend",
      script: "dist/index.js", // Ponto de entrada correto
      node_args: "-r module-alias/register", // Suporte para module-alias
      exec_mode: "fork", // Executar como um processo único
      instances: 1, // Apenas uma instância do backend
      autorestart: true, // Reinicia automaticamente em caso de falha
      watch: false, // Não assistir mudanças nos arquivos
      max_memory_restart: "2G", // Reinicia se ultrapassar 2GB de RAM
      env: {
        NODE_ENV: "production", // Garante que sempre rode em produção
        PORT_API: 3000,
        REDIS_HOST: "192.168.5.210",
        REDIS_PORT: 6379,
      },
    },
  ],
};
