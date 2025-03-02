import { Worker } from 'worker_threads';
import { logger, LoggerClass } from '@Core/logger';
import { ITask } from '@Interfaces';

console.log(`Processo Principal (Master) PID: ${process.pid}`);

class EventHandler {
  private tasks: Map<string, ITask> = new Map();

  addTask(task: ITask): void {
    if (this.tasks.has(task.name)) {
      logger.log(`Tarefa já existe.`, LoggerClass.LogCategory.Task, task.name, LoggerClass.LogColor.Magenta);
      return;
    }

    task.waitToFinish = task.waitToFinish ?? false;
    task.isRunning = false;

    this.tasks.set(task.name, task);
    const taskColor = task.color || LoggerClass.LogColor.Green;
    logger.log(`Tarefa adicionada para execução a cada ${task.interval / 1000} segundos.`, LoggerClass.LogCategory.Task, task.name, taskColor);
  }

  removeTask(name: string): void {
    const task = this.tasks.get(name);
    if (task && this.tasks.delete(name)) {
      const taskColor = task.color || LoggerClass.LogColor.Green;
      logger.log(`Tarefa removida.`, LoggerClass.LogCategory.Task, name, taskColor);
    } else {
      logger.log(`Tarefa não encontrada.`, LoggerClass.LogCategory.Task, name, LoggerClass.LogColor.Yellow);
    }
  }

  checkTasks(): void {
    const now = new Date().getTime();
    this.tasks.forEach(task => {
      const taskColor = task.color || LoggerClass.LogColor.Cyan;
      if (task.interval === -1 && !task.lastExecuted && !task.isRunning) {
        // Se o intervalo for -1, executa a tarefa apenas uma vez
        logger.log(`Executando tarefa única...`, LoggerClass.LogCategory.Task, task.name, taskColor);
        this.executeTask(task);
        task.lastExecuted = new Date();  // Atualiza o horário da última execução
        this.removeTask(task.name);  // Remove a tarefa da lista após execução
      } else if (task.interval !== -1 && (!task.lastExecuted || (now - task.lastExecuted.getTime()) >= task.interval) && !task.isRunning) {
        // Executa tarefas regulares
        logger.log(`Executando tarefa...`, LoggerClass.LogCategory.Task, task.name, taskColor);
        this.executeTask(task);
        task.lastExecuted = new Date();  // Atualiza o horário da última execução
      }
    });
  }

  private executeTask(task: ITask): void {
    task.isRunning = true; //Marca a tarefa como em execução
    const worker = new Worker(task.workerPath, { 
      workerData: task.options,
      execArgv: ['-r', 'ts-node/register']
    });

    const taskColor = task.color || LoggerClass.LogColor.Green;

    worker.on('message', (message) => {
      const { result, executionTime } = message;
      if (executionTime != 0) {
        logger.log(`Tarefa completada: ${result} em ${executionTime.toFixed(2)} ms`, LoggerClass.LogCategory.Task, task.name, taskColor);
      } else {
        logger.log(`Tarefa completada: ${result}`, LoggerClass.LogCategory.Task, task.name, taskColor);
      }
    });

    worker.on('error', (error) => {
      logger.error(`Erro na tarefa: ${error}`, LoggerClass.LogCategory.Task, task.name);
      task.isRunning = false; //Marca a tarefa como finalizada
      task.lastExecuted = new Date();  // Atualiza o horário da última
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        logger.error(`Worker parou com código ${code}`, LoggerClass.LogCategory.Task, task.name);
      }
      task.isRunning = false; //Marca a tarefa como finalizada
      task.lastExecuted = new Date();  // Atualiza o horário da última
    });
  }
}

export default EventHandler;