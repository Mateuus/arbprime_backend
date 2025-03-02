import { Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';

const supportedLanguages = ['en', 'pt-BR'];

const loadTranslations = (language: string) => {
  const localePath = path.join(__dirname, `../locales/${language}.json`);
  if (fs.existsSync(localePath)) {
    return JSON.parse(fs.readFileSync(localePath, 'utf-8'));
  }
  return {};
};

export const localeMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Extrai o primeiro idioma da lista do cabeçalho 'Accept-Language'
  const acceptLanguageHeader = req.headers['accept-language'] || 'en';
  const primaryLanguage = acceptLanguageHeader.split(',')[0]; // Pega apenas o primeiro idioma

  // Verifica se o idioma principal é suportado, senão usa o padrão 'en'
  const selectedLanguage = supportedLanguages.includes(primaryLanguage) ? primaryLanguage : 'en';

  // Carrega as traduções para o idioma selecionado
  const translations = loadTranslations(selectedLanguage);
 
  // Adiciona as traduções ao objeto de resposta
  res.locals.translations = translations;
  res.locals.locale = selectedLanguage;
  next();
};