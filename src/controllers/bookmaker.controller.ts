import { FastifyRequest, FastifyReply } from "fastify";
import { AppDataSource } from "@Database";
import { Bookmaker } from "@Entities";
import { createResponse } from "@utils/resFormatter";

const bookmakerRepository = AppDataSource.getRepository(Bookmaker);

// Próxima ordem disponível (maior atual + 1) — usado no cadastro automático.
async function nextSortOrder(): Promise<number> {
  const row = await bookmakerRepository
    .createQueryBuilder("b")
    .select("MAX(b.sortOrder)", "max")
    .getRawOne<{ max: number | null }>();
  return (row?.max != null ? Number(row.max) : -1) + 1;
}

// Normaliza o slug: minúsculo, sem acentos/espaços, mas mantém '_' e '-'
// (o identificador do arbbetting pode ter underscore, ex.: 'betsbola_vip').
function normalizeSlug(raw: string): string {
  return (raw || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")        // remove acentos
    .replace(/\s+/g, "_")           // espaços viram underscore
    .replace(/[^a-z0-9_-]+/g, ""); // mantém letras, dígitos, '_' e '-'
}

// GET /bookmaker — lista todas as casas (ordenadas por sortOrder, depois nome)
export const listBookmakers = async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const bookmakers = await bookmakerRepository.find({ order: { sortOrder: "ASC", name: "ASC" } });
    return reply.send(createResponse(1, "Casas carregadas com sucesso.", bookmakers));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao listar casas.", { error: (error as Error).message }));
  }
};

// POST /bookmaker — cadastra uma casa
export const addBookmaker = async (req: FastifyRequest, reply: FastifyReply) => {
  const body = (req.body || {}) as {
    slug?: string; name?: string; logoUrl?: string; color?: string; url?: string;
    cloneOf?: string | null; isActive?: boolean; sortOrder?: number;
  };

  const slug = normalizeSlug(body.slug || "");
  if (!slug || !body.name) {
    return reply.code(400).send(createResponse(0, "Campos 'slug' e 'name' são obrigatórios.", []));
  }

  try {
    const existing = await bookmakerRepository.findOneBy({ slug });
    if (existing) {
      return reply.code(409).send(createResponse(0, `Já existe uma casa com o slug '${slug}'.`, []));
    }

    const bookmaker = bookmakerRepository.create({
      slug,
      name: body.name,
      logoUrl: body.logoUrl || null,
      color: body.color || null,
      url: body.url || null,
      cloneOf: body.cloneOf || null,
      isActive: body.isActive ?? true,
      // Ordem automática: vai para o fim da lista (maior + 1).
      sortOrder: await nextSortOrder()
    });
    await bookmakerRepository.save(bookmaker);
    return reply.code(201).send(createResponse(1, "Casa cadastrada com sucesso.", bookmaker));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao cadastrar casa.", { error: (error as Error).message }));
  }
};

// PUT /bookmaker/:id — edita campos da casa
export const updateBookmaker = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  const body = (req.body || {}) as Record<string, unknown>;

  try {
    const bookmaker = await bookmakerRepository.findOneBy({ id });
    if (!bookmaker) {
      return reply.code(404).send(createResponse(0, "Casa não encontrada.", []));
    }

    if (typeof body.slug === "string") {
      const slug = normalizeSlug(body.slug);
      if (slug && slug !== bookmaker.slug) {
        const dup = await bookmakerRepository.findOneBy({ slug });
        if (dup) return reply.code(409).send(createResponse(0, `Já existe uma casa com o slug '${slug}'.`, []));
        bookmaker.slug = slug;
      }
    }

    // Troca de ordem: se a nova ordem já pertence a outra casa, elas trocam de posição.
    if ("sortOrder" in body) {
      const newOrder = Number(body.sortOrder);
      if (Number.isFinite(newOrder) && newOrder !== bookmaker.sortOrder) {
        const oldOrder = bookmaker.sortOrder;
        const other = await bookmakerRepository.findOneBy({ sortOrder: newOrder });
        if (other && other.id !== bookmaker.id) {
          other.sortOrder = oldOrder;
          await bookmakerRepository.save(other);
        }
        bookmaker.sortOrder = newOrder;
      }
    }

    const allowed = ["name", "logoUrl", "color", "url", "cloneOf", "isActive"];
    for (const key of allowed) {
      if (key in body) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (bookmaker as any)[key] = (body as any)[key];
      }
    }

    await bookmakerRepository.save(bookmaker);
    return reply.send(createResponse(1, "Casa atualizada com sucesso.", bookmaker));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao atualizar casa.", { error: (error as Error).message }));
  }
};

// PATCH /bookmaker/:id/toggle { isActive? } — ativa/desativa
export const toggleBookmaker = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  const body = (req.body || {}) as { isActive?: boolean };

  try {
    const bookmaker = await bookmakerRepository.findOneBy({ id });
    if (!bookmaker) {
      return reply.code(404).send(createResponse(0, "Casa não encontrada.", []));
    }

    bookmaker.isActive = typeof body.isActive === "boolean" ? body.isActive : !bookmaker.isActive;
    await bookmakerRepository.save(bookmaker);
    return reply.send(createResponse(1, `Casa ${bookmaker.isActive ? "ativada" : "desativada"}.`, bookmaker));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao alterar status da casa.", { error: (error as Error).message }));
  }
};

// DELETE /bookmaker/:id — remove a casa
export const deleteBookmaker = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };

  try {
    const bookmaker = await bookmakerRepository.findOneBy({ id });
    if (!bookmaker) {
      return reply.code(404).send(createResponse(0, "Casa não encontrada.", []));
    }

    await bookmakerRepository.remove(bookmaker);
    return reply.send(createResponse(1, "Casa removida com sucesso.", []));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao remover casa.", { error: (error as Error).message }));
  }
};
