import { FastifyRequest, FastifyReply } from "fastify";
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { AppDataSource } from '@Database';
import { createResponse } from "@utils/resFormatter";
import { User, ABFilter } from "@Entities";
import { UserResponseDTO } from "@Interfaces";
import { resolveUserAccess } from "@Services/subscription.service";
import { isUserAffiliate } from "@Services/affiliate.service";

const userRepository = AppDataSource.getRepository(User);
const abFilterRepository = AppDataSource.getRepository(ABFilter);

// (Removido) lookupCPF: a verificação de CPF por API externa (KYC betao) foi
// desativada — o usuário preenche o nome manualmente no cadastro.

export const registerUser = async (req: FastifyRequest, reply: FastifyReply) => {
    const translations = req.translations;
    const { email, fullname, personal_id, phone, password, invitedBy } = req.body as {
      email?: string; fullname?: string; personal_id?: string; phone?: string; password?: string; invitedBy?: string;
    };

    // Verificação de campos obrigatórios
    if (!phone || !email || !password || !personal_id) {
        return reply.code(400).send(createResponse(0, translations.fieldsMissing, []));
    }

    try {
      await new Promise(resolve => setTimeout(resolve, 1000));

      const existingCPF = await userRepository.findOneBy({ cpf: personal_id });
      if (existingCPF) {
        return reply.code(409).send(createResponse(0, translations.existingCPF, []));
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const user = new User();
      user.email = email;
      user.fullname = fullname as string;
      user.cpf = personal_id,
      user.phone = phone,
      user.password = hashedPassword;
      user.role = 'user';
      user.referralCode = '';
      user.level = 0;
      user.invitedBy = invitedBy as string; //@TODO: Vamos trabalhar aqui depois fazer um sistema de afiliado completo....

      // Salvando a usuario no banco de dados
      const savedUser = await userRepository.save(user);

      // Verificando se a conta foi salva com sucesso
      if (!savedUser || !savedUser.id) {
        return reply.code(500).send(createResponse(0, translations.failedToSave, []));
      }

      return reply.code(201).send(createResponse(1, translations.accountCreated, {}));
    } catch (error) {
       return reply.code(500).send(createResponse(0, translations.internalServerError, { error: error }));
    }
};

export const loginUser = async (req: FastifyRequest, reply: FastifyReply) => {
    const translations = req.translations;
    const { email, password } = req.body as { email?: string; password?: string };

    await new Promise(resolve => setTimeout(resolve, 1000));

    if (!email || !password) {
      return reply.code(400).send(createResponse(0, translations.fieldsMissing, []));
    }

    try {
       let user =  await userRepository.createQueryBuilder('user')
      .addSelect('user.password') // Inclui explicitamente o campo `password`
      .where('user.email = :email', { email })
      .getOne();

      if (!user) {
        return reply.code(401).send(createResponse(0, translations.invalidCredentials, []));
      }

      if (!user.password) {
        return reply.code(401).send(createResponse(0, translations.invalidCredentials, []));
      }
      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        return reply.code(401).send(createResponse(0, translations.invalidCredentials, []));
      }

      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        throw new Error('JWT_SECRET is not defined');
      }

      const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret, {
        expiresIn: '24h',
      });

      // Reavalia o acesso no login: expira planos vencidos e sincroniza o nível.
      try {
        const access = await resolveUserAccess(user.id);
        user.level = access.level;
      } catch (e) {
        console.error('[login] resolveUserAccess falhou:', (e as Error).message);
      }

      const userResponse: UserResponseDTO = {
        id: user.id,
        fullname: user.fullname,
        cpf: user.cpf,
        phone: user.phone,
        email: user.email,
        balace: user.balance,
        role: user.role,
        level: user.level,
        referralCode: user.referralCode,
        token: token,
        profile: user.profile
      };

      // maxAge do @fastify/cookie é em SEGUNDOS (no Express, res.cookie usa milissegundos)
      const maxAgeSeconds = 24 * 60 * 60; // 1 dia

      if (process.env.NODE_ENV === 'production') {
        reply.setCookie('MToken', token, {
          path: '/',
          httpOnly: true,
          secure: true, // Garante que o cookie é enviado apenas via HTTPS em produção
          maxAge: maxAgeSeconds,
          sameSite: 'none', // Permite que o cookie seja enviado em solicitações entre sites
          domain: '.arbprime.pro' // Disponível em todos os subdomínios
        });
      } else {
        reply.setCookie('MToken', token, {
          path: '/',
          httpOnly: true,
          secure: false,
          maxAge: maxAgeSeconds,
        });
      }

      return reply.code(200).send(createResponse(1, translations.loginSuccessful, userResponse));
    } catch (err) {
      return reply.code(500).send(createResponse(0, translations.internalServerError, { error: err }));
    }
};

export const logoutAccount = async (req: FastifyRequest, reply: FastifyReply) => {
  const translations = req.translations;
  try {
    // Implementar a lógica de logout @DEPOIS.
    // Limpar o cookie de autenticação com configurações consistentes
      if (process.env.NODE_ENV === 'production') {
        reply.clearCookie('MToken', {
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'none',
          domain: '.arbprime.pro'
        });
      } else {
        reply.clearCookie('MToken', {
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'lax'
        });
      }

    return reply.code(200).send(createResponse(1, translations.logoutSuccessful, {}));
  } catch (err) {
    return reply.code(500).send(createResponse(0, translations.internalServerError, { error: err }));
  }
};

export const getUserInfo = async (req: FastifyRequest, reply: FastifyReply) => {
    const translations = req.translations;
    const email = req.userData?.email;

    // Verificação de campos obrigatórios
    if (!email) {
      return reply.code(400).send(createResponse(0, translations.fieldsMissing, []));
    }

    try {
      const user = await userRepository.findOneBy({ email: email as string });

      if (user) {
        // Verifica expiração da assinatura a cada request de info e sincroniza o nível.
        try {
          const access = await resolveUserAccess(user.id);
          user.level = access.level;
        } catch (e) {
          console.error('[getUserInfo] resolveUserAccess falhou:', (e as Error).message);
        }
        const { password, ...userWithoutPassword } = user;
        const isAffiliate = await isUserAffiliate(user.id).catch(() => false);
        return reply.code(200).send(createResponse(1, translations.accountRecoveredSuccessfully, { user: { ...userWithoutPassword, isAffiliate } }));
      } else {
        return reply.code(409).send(createResponse(0, translations.accountDoesNotExist, []));
      }
    } catch (error) {
      return reply.code(500).send(createResponse(0, translations.internalServerError, { error }));
    }
};

export const getUserAuth = async (req: FastifyRequest, reply: FastifyReply) => {
  const translations = req.translations;
  try {
    return reply.code(200).send(createResponse(1, translations.accountAuthenticated, req.userData?.token));
  } catch (error) {
    return reply.code(500).send(createResponse(0, translations.internalServerError, { error }));
  }
};

export const changePassword = async (req: FastifyRequest, reply: FastifyReply) => {
  const translations = req.translations;
  const email = req.userData?.email;
  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };

  if (!currentPassword || !newPassword) {
    return reply.code(400).send(createResponse(0, translations.fieldsMissing, []));
  }

  try {
    await new Promise(resolve => setTimeout(resolve, 1500));

    let user =  await userRepository.createQueryBuilder('user')
    .addSelect('user.password') // Inclui explicitamente o campo `password`
    .where('user.email = :email', { email })
    .getOne();

    if (!user || !user.password) {
      return reply.code(401).send(createResponse(0, translations.invalidEmailOrPassword, []));
    }

    const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isPasswordValid) {
      return reply.code(401).send(createResponse(0, translations.incorrectCurrentPassword, []));
    }

    // 🔐 Hash da nova senha
    const newHashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = newHashedPassword;

    // 💾 Salva nova senha
    await userRepository.save(user);

    return reply.code(200).send(createResponse(1, translations.passwordChangedSuccessfully, {}));
  } catch (err) {
    return reply.code(500).send(createResponse(0, translations.internalServerError, { error: err }));
  }
};

export const getUserFilters = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;

  try {
    const filters = await abFilterRepository.find({ where: { userId } });
    return reply.send(createResponse(1, 'Filtros carregados com sucesso.', filters));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao buscar filtros.', { error }));
  }
};

export const getFilterById = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  const userId = req.userData?.userId;

  try {
    const filter = await abFilterRepository.findOneBy({ id, userId });

    if (!filter) {
      return reply.code(404).send(createResponse(0, 'Filtro não encontrado.', []));
    }

    return reply.send(createResponse(1, 'Filtro carregado.', filter));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao buscar filtro.', { error }));
  }
};

export const createFilter = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  const data = req.body as Partial<ABFilter>;

  try {
    const newFilter = abFilterRepository.create({ ...data, userId });
    await abFilterRepository.save(newFilter);

    return reply.code(201).send(createResponse(1, 'Filtro criado com sucesso.', newFilter));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao criar filtro.', { error }));
  }
};

export const updateFilter = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  const userId = req.userData?.userId;
  const data = req.body as Partial<ABFilter>;

  try {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const filter = await abFilterRepository.findOneBy({ id, userId });
    if (!filter) {
      return reply.code(404).send(createResponse(0, 'Filtro não encontrado.', []));
    }

    abFilterRepository.merge(filter, data);
    await abFilterRepository.save(filter);

    return reply.send(createResponse(1, 'Filtro atualizado com sucesso.', filter));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao atualizar filtro.', { error }));
  }
};

export const deleteFilter = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  const userId = req.userData?.userId;

  try {
    const filter = await abFilterRepository.findOneBy({ id, userId });
    if (!filter) {
      return reply.code(404).send(createResponse(0, 'Filtro não encontrado.', []));
    }

    await abFilterRepository.remove(filter);
    return reply.send(createResponse(1, 'Filtro excluído com sucesso.', []));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao excluir filtro.', { error }));
  }
};
