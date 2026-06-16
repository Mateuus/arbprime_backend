/// <reference path="../types/types.d.ts" />
import { FastifyRequest } from 'fastify';
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

// Hook onRequest do Fastify: detecta o idioma pelo cabeçalho 'Accept-Language'
// e anexa as traduções/locale à requisição (equivalente ao antigo res.locals).
export const localeHook = async (req: FastifyRequest) => {
  // Extrai o primeiro idioma da lista do cabeçalho 'Accept-Language'
  const acceptLanguageHeader = req.headers['accept-language'] || 'en';
  const primaryLanguage = acceptLanguageHeader.split(',')[0]; // Pega apenas o primeiro idioma

  // Verifica se o idioma principal é suportado, senão usa o padrão 'en'
  const selectedLanguage = supportedLanguages.includes(primaryLanguage) ? primaryLanguage : 'en';

  // Carrega as traduções e disponibiliza na requisição
  req.translations = loadTranslations(selectedLanguage);
  req.locale = selectedLanguage;
};
