import { getRedisClient } from "@Core/redis";

const TEAM_ALIAS_HASH = "ArbPrime:Configs:TeamAliases";

class TeamAliasManager {
  private aliasCache: Map<string, string[]> = new Map();

  /**
   * Carrega os aliases do Redis em memória
   */
  public async loadAliasCache(): Promise<void> {
    const redisClient = getRedisClient();
    const all = await redisClient.hgetall(TEAM_ALIAS_HASH);
    for (const [field, value] of Object.entries(all)) {
      try {
        const aliases = JSON.parse(value as string);
        if (Array.isArray(aliases)) {
          this.aliasCache.set(field, aliases);
        }
      } catch {
        this.aliasCache.set(field, []);
      }
    }
  }

  private normalizeName(name: string): string {
    return name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private buildFieldKey(name: string): string {
    const norm = this.normalizeName(name);
    const prefix = name.match(/\bsub[-\s]?(19|20|21|23|17|15)\b/i);
    const result = prefix ? `${norm} sub-${prefix[1]}` : norm;
    return result.toUpperCase();
  }

  /**
   * Verifica se o nome está presente entre os aliases da base
   */
  public isAliasMatch(baseName: string, compareName: string): boolean {
    const field = this.buildFieldKey(baseName);
    const aliases = this.aliasCache.get(field);
    if (!aliases) return false;

    const compareNorm = this.normalizeName(compareName);
    return aliases.some(alias => this.normalizeName(alias) === compareNorm);
  }

  /**
   * Cria o Field inicial no Redis se ele ainda não existir
   */
  public async ensureFieldExists(baseName: string): Promise<void> {
    const field = this.buildFieldKey(baseName);
    if (!this.aliasCache.has(field)) {
      const list = [baseName];
      this.aliasCache.set(field, list);
      const redisClient = getRedisClient();
      await redisClient.hset(TEAM_ALIAS_HASH, field, JSON.stringify(list));
    }
  }
}

export default new TeamAliasManager();