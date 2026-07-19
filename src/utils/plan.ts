import { Plan } from "@Entities";

/**
 * Calcula o preço final de um plano aplicando a promoção sobre o preço cheio.
 * - percent: abate `promotionValue`% do preço
 * - fixed:   abate R$ `promotionValue` do preço
 * Nunca retorna negativo. Arredonda em 2 casas.
 */
export const computeFinalPrice = (plan: Pick<Plan, 'price' | 'promotionType' | 'promotionValue'>): number => {
  const price = Number(plan.price) || 0;
  const value = Number(plan.promotionValue) || 0;

  let final = price;
  if (plan.promotionType === 'percent') {
    final = price - (price * value) / 100;
  } else if (plan.promotionType === 'fixed') {
    final = price - value;
  }

  if (!Number.isFinite(final) || final < 0) final = 0;
  return Math.round(final * 100) / 100;
};

/** Desconto absoluto (R$) que a promoção representa. */
export const computeDiscount = (plan: Pick<Plan, 'price' | 'promotionType' | 'promotionValue'>): number => {
  const price = Number(plan.price) || 0;
  return Math.round((price - computeFinalPrice(plan)) * 100) / 100;
};

/** Serializa um plano para a API com campos calculados (finalPrice/discount/hasPromotion). */
export const serializePlan = (plan: Plan) => {
  const finalPrice = computeFinalPrice(plan);
  const price = Number(plan.price) || 0;
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    price,
    promotionType: plan.promotionType,
    promotionValue: Number(plan.promotionValue) || 0,
    finalPrice,
    discount: Math.round((price - finalPrice) * 100) / 100,
    hasPromotion: plan.promotionType !== 'none' && finalPrice < price,
    durationInDays: plan.durationInDays,
    level: plan.level,
    isTrial: plan.isTrial,
    isActive: plan.isActive,
    sortOrder: plan.sortOrder,
    discordRoleId: plan.discordRoleId ?? null,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
};
