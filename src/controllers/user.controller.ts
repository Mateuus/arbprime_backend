import { Request, Response } from "express";
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { AppDataSource } from '@Database';
import { createResponse } from "@utils/resFormatter";
import { User } from "@Entities";
import { UserResponseDTO } from "@Interfaces";

const userRepository = AppDataSource.getRepository(User);

export const registerUser = async (req: Request, res: Response) => {
    const translations = res.locals.translations;
    const {username, email, password}  = req.body;
    
    // Verificação de campos obrigatórios
    if (!username || !email || !password) {
        res.status(400).json(createResponse(0, 'translations.fieldsMissing', []));
        return;
    }

    try {
      const existingEmail = await userRepository.findOneBy({ email });
      if (existingEmail) {
        res.status(409).json(createResponse(0, 'translations.existingEmail', []));
        return;
      }
  
      const hashedPassword = await bcrypt.hash(password, 10);
      const user = new User();
      user.email = email;
      user.username = username;
      user.password = hashedPassword;
      user.role = 'user';
  
      // Salvando a usuario no banco de dados
      const savedUser = await userRepository.save(user);
  
      // Verificando se a conta foi salva com sucesso
      if (!savedUser || !savedUser.id) {
        res.status(500).json(createResponse(0, 'translations.failedToSave', []));
        return;
      }
  
        res.status(201).json(createResponse(1, 'translations.userCreated', {}));
    } catch (error) {
       res.status(500).json(createResponse(0, 'translations.internalServerError', {error: error}));
    }
};

export const loginUser = async (req: Request, res: Response) => {
    const translations = res.locals.translations;
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json(createResponse(0, 'translations.fieldsMissing', []));
      return;
    }
  
    try {
       let user =  await userRepository.createQueryBuilder('user')
      .addSelect('user.password') // Inclui explicitamente o campo `password`
      .where('user.email = :email', { email })
      .getOne();
      
      if (!user) {
        res.status(401).json(createResponse(0, translations.invalidCredentials, []));
        return;
      }
  
      if (!user.password) {
        res.status(401).json(createResponse(0, translations.invalidCredentials, []));
        return;
      }
      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        res.status(401).json(createResponse(0, translations.invalidCredentials, []));
        return;
      }
  
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        throw new Error('JWT_SECRET is not defined');
      }
  
      const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret, {
        expiresIn: '1h',
      });

      const userResponse: UserResponseDTO = {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        token: token
      };

      // Define a expiração em milissegundos (1 dia) para uso no cookie e na resposta
      const expiration = 24 * 60 * 60 * 1000; // 1 dia em milissegundos

      if(process.env.NODE_ENV === 'production'){
        res.cookie('MToken', token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production', // Garante que o cookie é enviado apenas via HTTPS em produção
          maxAge: expiration,
          sameSite: 'none', // Permite que o cookie seja enviado em solicitações entre sites
          domain: '.arbprime.pro' // Configura o cookie para estar disponível em todos os subdomínios
        });
      } else {
        res.cookie('MToken', token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production', // Garante que o cookie é enviado apenas via HTTPS em produção
          maxAge: expiration,
        });
      }

      res.status(200).json(createResponse(1, 'translations.loginSuccessful',  userResponse ));
    } catch (err) {
      res.status(500).json(createResponse(0, 'translations.internalServerError', { error: err }));
    }
};

export const logoutAccount = async (req: Request, res: Response) => {
  const translations = res.locals.translations;
  try {
    // Implementar a lógica de logout @DEPOIS.
    // Limpar o cookie de autenticação com configurações consistentes
      res.clearCookie('MToken', { 
        path: '/', 
        httpOnly: true, 
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'none',
        domain: '.arbprime.pro'
      });

    res.status(200).json(createResponse(1, 'translations.logoutSuccessful',  {} ));
  } catch (err) {
    res.status(500).json(createResponse(0, 'translations.internalServerError', { error: err }));
  }
};

export const getUserInfo = async (req: Request, res: Response) => {
    const translations = res.locals.translations;
    const email = req.userData?.email;
  
    // Verificação de campos obrigatórios
    if (!email) {
      res.status(400).json(createResponse(0, 'translations.fieldsMissing', []));
      return;
    }
  
    try {
      const user = await userRepository.findOneBy({ email: email as string });
  
      if (user) {
        const { password, ...userWithoutPassword } = user;
        res.status(200).json(createResponse(1, 'usuário recuperado com sucesso', { user: userWithoutPassword }));
      } else { 
        res.status(409).json(createResponse(0, 'O usuário não existe', []));
      }
    } catch (error) {
      res.status(500).json(createResponse(0, 'Erro interno do servidor', { error }));
    }
};

export const getUserAuth = async (req: Request, res: Response) => {
  const translations = res.locals.translations;
  try {
    res.status(200).json(createResponse(1, 'usuário está autenticado', req.userData?.token ));
  } catch (error) {
    res.status(500).json(createResponse(0, 'Erro interno do servidor', { error }));
  }
};