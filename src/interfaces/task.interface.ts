import { LogColor } from '@Enums'; // Importe LogColor diretamente

export interface ITask {
    name: string;
    lastExecuted: Date | null;
    interval: number;
    workerPath: string;
    options?: any;
    color?: LogColor; // Usando LogColor diretamente
    waitToFinish?: boolean; // Indica se deve aguardar a finalização antes de executar novamente
    isRunning?: boolean; // Indica se a tarefa está atualmente em execução
}