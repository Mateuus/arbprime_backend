# 📋 API de Eventos - Documentação

## Endpoints Disponíveis

### 1. **GET /api/events** - Listar Eventos com Paginação e Filtros

Busca eventos do Redis HASH `ArbBetting:EventMatchList` com paginação e filtros.

#### **Parâmetros de Query:**
- `page` (opcional): Número da página (padrão: 1)
- `limit` (opcional): Itens por página (padrão: 10, máximo: 100)
- `search` (opcional): Termo de busca (busca em home, away, league)
- `sport` (opcional): Filtrar por esporte específico
- `disabled` (opcional): Filtrar por status (true/false)
- `league` (opcional): Filtrar por liga específica
- `bookmaker` (opcional): Filtrar por bookmaker específico

#### **Exemplos de Uso:**
```bash
# Buscar primeira página com 20 itens
GET /api/events?page=1&limit=20

# Buscar eventos de futebol
GET /api/events?sport=futebol

# Buscar eventos desabilitados
GET /api/events?disabled=true

# Buscar eventos com termo "Barcelona"
GET /api/events?search=Barcelona

# Buscar eventos da Premier League
GET /api/events?league=Premier

# Buscar eventos do bookmaker "marjosports"
GET /api/events?bookmaker=marjosports

# Combinação de filtros
GET /api/events?sport=futebol&disabled=false&page=2&limit=15
```

#### **Resposta:**
```json
{
  "success": 1,
  "message": "Eventos carregados com sucesso",
  "data": {
    "events": [
      {
        "id": "68edf98a7266246e13967302",
        "disabled": false,
        "sport": "futebol",
        "league": "Liga Premier",
        "home": "Tofta Itrottarfelag B68",
        "away": "07 Vestur Sorvagur",
        "date": "2025-10-19T09:00:00.000Z",
        "link": "https://www.marjosports.com.br/home/events-area/s/SC/e/68edf98a7266246e13967302",
        "baseBookmaker": "marjosports",
        "matches": [
          {
            "bookmaker": "superbet",
            "eventId": 8309438,
            "link": "https://superbet.bet.br/evento/8309438",
            "date": "2025-10-18T02:00:00.000Z",
            "disabled": false,
            "inverted": false
          }
        ],
        "update_at": "2025-10-16T14:03:24.882Z",
        "create_at": "2025-10-16T17:02:32.156Z"
      }
    ],
    "pagination": {
      "currentPage": 1,
      "totalPages": 55,
      "totalItems": 1098,
      "itemsPerPage": 20,
      "hasNextPage": true,
      "hasPrevPage": false
    },
    "filters": {
      "search": null,
      "sport": "futebol",
      "disabled": false,
      "league": null,
      "bookmaker": null
    }
  }
}
```

---

### 2. **GET /api/events/:id** - Buscar Evento por ID

Busca um evento específico pelo seu ID.

#### **Parâmetros:**
- `id` (obrigatório): ID do evento

#### **Exemplo:**
```bash
GET /api/events/68edf98a7266246e13967302
```

#### **Resposta:**
```json
{
  "success": 1,
  "message": "Evento encontrado com sucesso",
  "data": {
    "event": {
      "id": "68edf98a7266246e13967302",
      "disabled": false,
      "sport": "futebol",
      "league": "Liga Premier",
      "home": "Tofta Itrottarfelag B68",
      "away": "07 Vestur Sorvagur",
      "date": "2025-10-19T09:00:00.000Z",
      "link": "https://www.marjosports.com.br/home/events-area/s/SC/e/68edf98a7266246e13967302",
      "baseBookmaker": "marjosports",
      "matches": [...],
      "update_at": "2025-10-16T14:03:24.882Z",
      "create_at": "2025-10-16T17:02:32.156Z"
    }
  }
}
```

---

### 3. **GET /api/events/stats** - Estatísticas dos Eventos

Retorna estatísticas gerais dos eventos armazenados.

#### **Exemplo:**
```bash
GET /api/events/stats
```

#### **Resposta:**
```json
{
  "success": 1,
  "message": "Estatísticas carregadas com sucesso",
  "data": {
    "stats": {
      "totalEvents": 1098,
      "disabledEvents": 45,
      "enabledEvents": 1053,
      "sports": {
        "futebol": 1098
      },
      "leagues": {
        "Liga Premier": 156,
        "Bundesliga": 89,
        "Serie A": 134,
        "La Liga": 98
      },
      "bookmakers": {
        "marjosports": 1098,
        "superbet": 456,
        "pinnacle": 234,
        "bet365": 189
      }
    }
  }
}
```

---

## 🔧 Funcionalidades Implementadas

### ✅ **Paginação**
- Controle de página atual
- Limite de itens por página (máximo 100)
- Informações de navegação (hasNextPage, hasPrevPage)
- Total de páginas e itens

### ✅ **Filtros Avançados**
- **Busca textual**: Procura em home, away, league
- **Filtro por esporte**: Ex: futebol, basquete, etc.
- **Filtro por status**: Eventos habilitados/desabilitados
- **Filtro por liga**: Ex: Premier League, Bundesliga
- **Filtro por bookmaker**: Ex: marjosports, superbet

### ✅ **Ordenação**
- Eventos ordenados por data (mais recentes primeiro)

### ✅ **Tratamento de Erros**
- Validação de parâmetros
- Tratamento de JSON inválido
- Mensagens de erro claras
- Logs de erro para debugging

### ✅ **Performance**
- Uso eficiente do Redis HASH
- Filtros aplicados em memória após carregamento
- Paginação aplicada apenas aos resultados filtrados

---

## 🚀 Como Usar

1. **Inicie o servidor:**
   ```bash
   cd /home/mateuus/arbprime/arbprime_backend
   npm run dev
   ```

2. **Teste os endpoints:**
   ```bash
   # Listar eventos
   curl "http://localhost:3000/api/events?page=1&limit=10"
   
   # Buscar evento específico
   curl "http://localhost:3000/api/events/68edf98a7266246e13967302"
   
   # Obter estatísticas
   curl "http://localhost:3000/api/events/stats"
   ```

3. **Integre no frontend:**
   ```javascript
   // Exemplo com fetch
   const response = await fetch('/api/events?sport=futebol&page=1&limit=20');
   const data = await response.json();
   console.log(data.data.events);
   console.log(data.data.pagination);
   ```
