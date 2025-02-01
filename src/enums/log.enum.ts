/**
 * Enumeração que representa as cores disponíveis para personalização de logs.
 * 
 * - `Green`: Exibe o texto em verde. Usado tipicamente para indicar sucesso ou ações concluídas.
 * - `Yellow`: Exibe o texto em amarelo. Usado para alertas ou avisos.
 * - `Red`: Exibe o texto em vermelho. Usado para indicar erros ou falhas críticas.
 * - `Blue`: Exibe o texto em azul. Usado para mensagens informativas.
 * - `Magenta`: Exibe o texto em magenta. Usado para destaque ou categorias específicas.
 * - `Cyan`: Exibe o texto em ciano. Usado para informações secundárias ou detalhes.
 * - `White`: Exibe o texto em branco. Usado como cor padrão para logs genéricos.
 */
export enum LogColor {
    Green = 'green',
    Yellow = 'yellow',
    Red = 'red',
    Blue = 'blue',
    Magenta = 'magenta',
    Cyan = 'cyan',
    White = 'white'
}

/**
 * Enumeração que representa as categorias de log.
 * 
 * - `Task`: Relacionado a operações ou eventos de tarefas.
 * - `Server`: Relacionado a eventos ou status do servidor.
 * - `Database`: Relacionado a operações ou conexões de banco de dados.
 * - `Auth`: Relacionado a eventos de autenticação ou autorização.
 * - `Network`: Relacionado a operações de rede ou conectividade.
 */
export enum LogCategory {
    Task = 'Task',
    Server = 'Server',
    Database = 'Database',
    Auth = 'Auth',
    Network = 'Network'
  }