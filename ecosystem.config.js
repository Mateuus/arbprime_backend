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
    {
      // Bet Worker — processo SEPARADO da API/WS (isola memória/crash + o binário Go
      // do cycletls). Roda os daemons das Instâncias de Bet. Requer INSTANCE_ENC_KEY
      // no .env do servidor (senão não decifra as credenciais das casas).
      name: "arbprime_betworker",
      script: "dist/betworker/index.js",
      node_args: "-r module-alias/register",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        REDIS_HOST: "192.168.5.210",
        REDIS_PORT: 6379,
      },
    },
  ],
};
