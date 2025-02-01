import kleur from 'kleur';
import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';
import { LogColor, LogCategory } from '@Enums';

export class LoggerClass {
  public static LogColor = LogColor;
  public static LogCategory = LogCategory;

  private logger;

  constructor(logFilePath: string = 'application.log') {
    const logDirectory = path.resolve(__dirname, './../../logs');
    const fullLogPath = path.join(logDirectory, logFilePath);

    // Verifica se a pasta 'logs' existe, se não, cria a pasta
    if (!fs.existsSync(logDirectory)) {
      fs.mkdirSync(logDirectory, { recursive: true });
    }

    this.logger = createLogger({
      format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(({ timestamp, message }) => {
          return `${timestamp} ${message}`;
        })
      ),
      transports: [
        new transports.Console({
          format: format.combine(
            format.printf(({ timestamp, message }) => {
              return `${timestamp} ${message}`;
            })
          )
        }),
        new DailyRotateFile({
          filename: `${fullLogPath}-%DATE%.log`,
          datePattern: 'YYYY-MM-DD',
          maxSize: '20m',
          maxFiles: '15d',
          zippedArchive: true,
          format: format.combine(
            format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            format.printf(({ timestamp, message }) => {
              // Remove cores para os logs que vão para o arquivo
              return `${timestamp} ${(message as string).replace(/\u001b\[.*?m/g, '')}`;
            })
          )
        })
      ],
    });
    }

    private formatTaskName(taskName: string, color: LogColor): string {
    const colorFunction = kleur[color] || kleur.white;
    return colorFunction(taskName);
    }

    private formatMessage(category: LogCategory, taskName: string, message: string, color: LogColor): string {
    const coloredTaskName = this.formatTaskName(taskName, color);
    const colorFunction = kleur[color] || kleur.white;
    return `${colorFunction(`[${category}]`)} ${coloredTaskName}: ${message}`;
    }

    log(message: string, category: LogCategory, taskName: string, color: LogColor = LogColor.White): void {
    const formattedMessage = this.formatMessage(category, taskName, message, color);
    this.logger.info(formattedMessage);
    }

    info(message: string, category: LogCategory, taskName: string, color: LogColor = LogColor.Blue): void {
    const formattedMessage = this.formatMessage(category, taskName, message, color);
    this.logger.info(formattedMessage);
    }

    warn(message: string, category: LogCategory, taskName: string, color: LogColor = LogColor.Yellow): void {
    const formattedMessage = this.formatMessage(category, taskName, message, color);
    this.logger.warn(formattedMessage);
    }

    error(message: string, category: LogCategory, taskName: string, color: LogColor = LogColor.Red): void {
    const formattedMessage = this.formatMessage(category, taskName, message, color);
    this.logger.error(formattedMessage);
    }
}

export const logger = new LoggerClass();