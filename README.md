# **ArbCrypto Backend** 🚀  

📈 **ArbCrypto Backend** é um sistema de arbitragem de criptomoedas que monitora as cotações de **mercados futuros e spot** em tempo real, armazenando os dados no **Redis** para otimizar a velocidade de cálculos e processamento.  

O backend é responsável por **coletar, armazenar e processar as cotações** das exchanges para encontrar oportunidades de arbitragem.

---

## **📀 Tecnologias Utilizadas**
✅ **Node.js** → Runtime para executar o backend.  
✅ **TypeScript** → Código estruturado e tipado.  
✅ **Redis** → Armazena as cotações para acesso rápido.  
✅ **Express.js** → API para comunicação com outros serviços.  
✅ **CCXT** → Biblioteca para conectar com as exchanges.  
✅ **PM2** → Gerenciamento de processos para rodar workers.  
✅ **MySQL (com TypeORM)** → Banco de dados para persistência.  
✅ **Telegraf (Bot Telegram)** → Envio de alertas de arbitragem.  
✅ **Docker (Futuro)** → Para rodar em containers de forma escalável.  

---

## **🔧 Como Funciona?**
🔹 O **`arbcrypto_backend`** conecta-se às exchanges de criptomoedas para coletar **cotações de mercado spot e futuro**.  
🔹 As cotações são **armazenadas no Redis** para **rápido acesso** e processamento.  
🔹 O sistema então **calcula diferenças de preço** entre diferentes mercados e gera **oportunidades de arbitragem**.  
🔹 Caso uma **arbitragem seja identificada**, o sistema pode **enviar alertas** (Telegram) ou executar **operações automáticas** (futuro).  

---

## **🔄 Instalação e Configuração**

### **1⃣ Clonar o Repositório**
```bash
git clone https://github.com/Mateuus/arbcrypto_backend.git
cd arbcrypto_backend
```

### **2⃣ Instalar as Dependências**
```bash
npm install
```

### **3⃣ Criar o Arquivo `.env`**
Crie um arquivo `.env` na raiz do projeto para armazenar as credenciais e configurações:
```bash
touch .env
```

📌 **Exemplo de `.env`**
```
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

EXCHANGE_API_KEY=SEU_API_KEY
EXCHANGE_SECRET=SEU_SECRET_KEY
```

### **4⃣ Iniciar o Redis**
O Redis precisa estar rodando para armazenar as cotações:
```bash
redis-server &
```

### **5⃣ Compilar o TypeScript**
Antes de rodar, é necessário compilar o código:
```bash
npm run build
```

### **6⃣ Iniciar o Servidor**
```bash
npm run start
```

Se quiser rodar no modo **desenvolvimento**, com atualização automática:
```bash
npm run dev
```

---

## **🔄 Como Rodar os Workers?**
Os **workers** são responsáveis por processar as cotações e monitorar as oportunidades de arbitragem.

### **✅ Iniciar Workers no Modo Desenvolvimento**
```bash
npm run dev:workers
```

### **✅ Iniciar Workers com PM2**
```bash
npm run pm2:start
```

### **✅ Listar Workers Ativos**
```bash
pm2 list
```

### **✅ Visualizar Logs dos Workers**
```bash
npm run pm2:logs
```

---

## **📀 Estrutura do Projeto**
```
arbcrypto_backend/
│
├── src/
│   ├── core/
│   ├── controllers/
│   ├── middlewares/
│   ├── locales/
│   ├── routes/
│   ├── gateways/
│   ├── interfaces/
│   ├── services/
│   ├── workers/
│   ├── index.ts
├── package.json
├── tsconfig.json
├── .gitignore
└── dist/
```

---

## **🔢 API Endpoints**
| Método | Rota           | Descrição                  |
|--------|---------------|----------------------------|
| GET    | `/`           | Status da API              |
| GET    | `/prices`     | Retorna as cotações do Redis |
| GET    | `/arbitrage`  | Retorna oportunidades de arbitragem |

---

## **🔄 Contribuição**
Contribuições são bem-vindas! Se quiser ajudar, faça um **fork** do repositório e envie um **pull request**.

1. Faça um **fork** do projeto  
2. Crie uma **branch** (`git checkout -b feature-nova-funcionalidade`)  
3. Faça o **commit** das mudanças (`git commit -m 'Adiciona nova funcionalidade'`)  
4. Envie para o repositório remoto (`git push origin feature-nova-funcionalidade`)  
5. Abra um **pull request** no GitHub  

---

## **📝 Licença**
Este projeto está sob a licença **MIT**.

---