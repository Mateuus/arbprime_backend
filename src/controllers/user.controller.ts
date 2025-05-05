import { Request, Response } from "express";
import bcrypt from 'bcryptjs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { AppDataSource } from '@Database';
import { createResponse } from "@utils/resFormatter";
import { User } from "@Entities";
import { UserResponseDTO } from "@Interfaces";

const userRepository = AppDataSource.getRepository(User);

export const lookupCPF = async (req: Request, res: Response) => {
  const translations = res.locals.translations;
  const {personal_id}  = req.body;

  try {
    const response = await axios.post('https://kyc.betao.bet.br/v1/client/personal-id/lookup', {
      personal_id,
    });
    res.status(200).json(createResponse(0, 'Dados', response.data));
  } catch (error) {
    res.status(500).json(createResponse(0, translations.internalServerError, {error: error}));
  }
};

export const registerUser = async (req: Request, res: Response) => {
    const translations = res.locals.translations;
    
    const {email, fullname, personal_id, phone, password, invitedBy}  = req.body;
    console.log(email);
    console.log(translations);
    
    // Verificação de campos obrigatórios
    if (!phone || !email || !password || !personal_id) {
        res.status(400).json(createResponse(0, translations.fieldsMissing, []));
        return;
    }

    try {
      await new Promise(resolve => setTimeout(resolve, 5000));

      const existingCPF = await userRepository.findOneBy({ cpf: personal_id });
      if (existingCPF) {
        res.status(409).json(createResponse(0, translations.existingCPF, []));
        return;
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const user = new User();
      user.email = email;
      user.fullname = fullname;
      user.cpf = personal_id,
      user.phone = phone,
      user.password = hashedPassword;
      user.role = 'user';
      user.referralCode = '';
      user.level = 0;
      user.invitedBy = invitedBy; //@TODO: Vamos trabalhar aqui depois fazer um sistema de afiliado completo....
  
      // Salvando a usuario no banco de dados
      const savedUser = await userRepository.save(user);
  
      // Verificando se a conta foi salva com sucesso
      if (!savedUser || !savedUser.id) {
        res.status(500).json(createResponse(0, translations.failedToSave, []));
        return;
      }
  
      res.status(201).json(createResponse(1, translations.accountCreated, {}));
    } catch (error) {
       res.status(500).json(createResponse(0, translations.internalServerError, {error: error}));
    }
};

export const loginUser = async (req: Request, res: Response) => {
    const translations = res.locals.translations;
    const { email, password } = req.body;

    await new Promise(resolve => setTimeout(resolve, 5000));

    if (!email || !password) {
      res.status(400).json(createResponse(0, translations.fieldsMissing, []));
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
        expiresIn: '24h',
      });

      const userResponse: UserResponseDTO = {
        id: user.id,
        fullname: user.fullname,
        personal_id: user.cpf,
        phone: user.phone,
        email: user.email,
        balace: user.balance,
        role: user.role,
        level: user.level,
        referralCode: user.referralCode,
        token: token,
        profile: user.profile
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

      res.status(200).json(createResponse(1, translations.loginSuccessful,  userResponse ));
    } catch (err) {
      res.status(500).json(createResponse(0, translations.internalServerError, { error: err }));
    }
};

export const logoutAccount = async (req: Request, res: Response) => {
  const translations = res.locals.translations;
  try {
    // Implementar a lógica de logout @DEPOIS.
    // Limpar o cookie de autenticação com configurações consistentes
      if(process.env.NODE_ENV === 'production'){
        res.clearCookie('MToken', { 
          path: '/', 
          httpOnly: true, 
          secure: true,
          sameSite: 'none',
          domain: '.arbprime.pro'
        });
      } else {
        res.clearCookie('MToken', { 
          path: '/', 
          httpOnly: true, 
          secure: false,
          sameSite: 'lax'
        });
      }

    res.status(200).json(createResponse(1, translations.logoutSuccessful,  {} ));
  } catch (err) {
    res.status(500).json(createResponse(0, translations.internalServerError, { error: err }));
  }
};

export const getUserInfo = async (req: Request, res: Response) => {
    const translations = res.locals.translations;
    const email = req.userData?.email;
  
    // Verificação de campos obrigatórios
    if (!email) {
      res.status(400).json(createResponse(0, translations.fieldsMissing, []));
      return;
    }
  
    try {
      const user = await userRepository.findOneBy({ email: email as string });
  
      if (user) {
        const { password, ...userWithoutPassword } = user;
        res.status(200).json(createResponse(1, translations.accountRecoveredSuccessfully, { user: userWithoutPassword }));
      } else { 
        res.status(409).json(createResponse(0, translations.accountDoesNotExist, []));
      }
    } catch (error) {
      res.status(500).json(createResponse(0, translations.internalServerError, { error }));
    }
};

export const getUserAuth = async (req: Request, res: Response) => {
  const translations = res.locals.translations;
  try {
    res.status(200).json(createResponse(1, translations.accountAuthenticated, req.userData?.token ));
  } catch (error) {
    res.status(500).json(createResponse(0, translations.internalServerError, { error }));
  }
};

export const changePassword = async (req: Request, res: Response) => {
  const translations = res.locals.translations;
  const email = req.userData?.email;
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    res.status(400).json(createResponse(0, translations.fieldsMissing, []));
    return;
  }

  try {
    await new Promise(resolve => setTimeout(resolve, 1500));

    let user =  await userRepository.createQueryBuilder('user')
    .addSelect('user.password') // Inclui explicitamente o campo `password`
    .where('user.email = :email', { email })
    .getOne();

    if (!user || !user.password) {
      res.status(401).json(createResponse(0, translations.invalidEmailOrPassword, []));
      return;
    }

    const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isPasswordValid) {
      res.status(401).json(createResponse(0, translations.incorrectCurrentPassword, []));
      return;
    }

    // 🔐 Hash da nova senha
    const newHashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = newHashedPassword;

    // 💾 Salva nova senha
    await userRepository.save(user);

    res.status(200).json(createResponse(1, translations.passwordChangedSuccessfully, {}));
  } catch (err) {
    res.status(500).json(createResponse(0, translations.internalServerError, { error: err }));
  }
};