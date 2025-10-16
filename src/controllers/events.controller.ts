import { Request, Response } from "express";
import { getRedisClient, checkRedisConnection } from "@Core/redis";
import { createResponse } from "@utils/resFormatter";
import { EventMatch, MarketFormat, MarketOdd } from "@Interfaces/events.interface";

/**
 * Endpoint para buscar eventos com paginação e filtros
 * GET /api/events?page=1&limit=10&search=termo&sport=futebol&disabled=false
 */
export const getEvents = async (req: Request, res: Response): Promise<void> => {
    try {
        const {
            page = '1',
            limit = '10',
            search = '',
            sport = '',
            disabled = '',
            league = '',
            bookmaker = ''
        } = req.query;

        // Validação dos parâmetros
        const pageNum = parseInt(page as string);
        const limitNum = parseInt(limit as string);
        
        if (pageNum < 1 || limitNum < 1 || limitNum > 100) {
            res.status(400).json(createResponse(0, "Parâmetros de paginação inválidos. Page deve ser >= 1, limit deve ser entre 1 e 100.", []));
            return;
        }

        const redisClient = getRedisClient();
        const redisKey = 'ArbBetting:EventMatchList';
        
        // Buscar todos os eventos do Redis HASH
        const allEventsRaw = await redisClient.hgetall(redisKey);
        
        if (!allEventsRaw || Object.keys(allEventsRaw).length === 0) {
            res.status(200).json(createResponse(1, "Nenhum evento encontrado", {
                events: [],
                pagination: {
                    currentPage: pageNum,
                    totalPages: 0,
                    totalItems: 0,
                    itemsPerPage: limitNum,
                    hasNextPage: false,
                    hasPrevPage: false
                }
            }));
            return;
        }

        // Converter para array de EventMatch e aplicar filtros
        let events: EventMatch[] = Object.entries(allEventsRaw)
            .map(([id, value]) => {
                try {
                    const event = JSON.parse(value as string) as EventMatch;
                    return event;
                } catch (error) {
                    console.error(`Erro ao fazer parse do evento ${id}:`, error);
                    return null;
                }
            })
            .filter((event): event is EventMatch => event !== null);

        // Aplicar filtros
        if (search) {
            const searchTerm = (search as string).toLowerCase();
            events = events.filter(event => 
                event.home?.toLowerCase().includes(searchTerm) ||
                event.away?.toLowerCase().includes(searchTerm) ||
                event.league?.toLowerCase().includes(searchTerm)
            );
        }

        if (sport) {
            events = events.filter(event => 
                event.sport?.toLowerCase() === (sport as string).toLowerCase()
            );
        }

        if (disabled !== '') {
            const isDisabled = disabled === 'true';
            events = events.filter(event => event.disabled === isDisabled);
        }

        if (league) {
            events = events.filter(event => 
                event.league?.toLowerCase().includes((league as string).toLowerCase())
            );
        }

        if (bookmaker) {
            events = events.filter(event => 
                event.baseBookmaker?.toLowerCase().includes((bookmaker as string).toLowerCase()) ||
                event.matches?.some(match => 
                    match.bookmaker?.toLowerCase().includes((bookmaker as string).toLowerCase())
                )
            );
        }

        // Ordenar por data (mais recentes primeiro)
        events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        // Calcular paginação
        const totalItems = events.length;
        const totalPages = Math.ceil(totalItems / limitNum);
        const startIndex = (pageNum - 1) * limitNum;
        const endIndex = startIndex + limitNum;
        
        // Aplicar paginação
        const paginatedEvents = events.slice(startIndex, endIndex);

        // Resposta com paginação
        res.status(200).json(createResponse(1, "Eventos carregados com sucesso", {
            events: paginatedEvents,
            pagination: {
                currentPage: pageNum,
                totalPages,
                totalItems,
                itemsPerPage: limitNum,
                hasNextPage: pageNum < totalPages,
                hasPrevPage: pageNum > 1
            },
            filters: {
                search: search || null,
                sport: sport || null,
                disabled: disabled !== '' ? disabled === 'true' : null,
                league: league || null,
                bookmaker: bookmaker || null
            }
        }));

    } catch (error) {
        console.error('Erro ao buscar eventos:', error);
        res.status(500).json(createResponse(0, "Erro interno do servidor", { error: (error as Error).message }));
    }
};

/**
 * Endpoint para buscar um evento específico por ID
 * GET /api/events/:id
 */
export const getEventById = async (req: Request, res: Response): Promise<void> => {
    try {
        const { id } = req.params;
        
        if (!id) {
            res.status(400).json(createResponse(0, "ID do evento é obrigatório", []));
            return;
        }

        const redisClient = getRedisClient();
        const redisKey = 'ArbBetting:EventMatchList';
        
        const eventRaw = await redisClient.hget(redisKey, id);
        
        if (!eventRaw) {
            res.status(404).json(createResponse(0, "Evento não encontrado", []));
            return;
        }

        try {
            const event = JSON.parse(eventRaw) as EventMatch;
            res.status(200).json(createResponse(1, "Evento encontrado com sucesso", { event }));
        } catch (parseError) {
            console.error(`Erro ao fazer parse do evento ${id}:`, parseError);
            res.status(500).json(createResponse(0, "Erro ao processar dados do evento", []));
        }

    } catch (error) {
        console.error('Erro ao buscar evento por ID:', error);
        res.status(500).json(createResponse(0, "Erro interno do servidor", { error: (error as Error).message }));
    }
};

/**
 * Endpoint para obter estatísticas dos eventos
 * GET /api/events/stats
 */
export const getEventsStats = async (req: Request, res: Response): Promise<void> => {
    try {
        const redisClient = getRedisClient();
        const redisKey = 'ArbBetting:EventMatchList';
        
        const allEventsRaw = await redisClient.hgetall(redisKey);
        
        if (!allEventsRaw || Object.keys(allEventsRaw).length === 0) {
            res.status(200).json(createResponse(1, "Nenhum evento encontrado", {
                stats: {
                    totalEvents: 0,
                    disabledEvents: 0,
                    enabledEvents: 0,
                    sports: {},
                    leagues: {},
                    bookmakers: {}
                }
            }));
            return;
        }

        // Converter para array de EventMatch
        const events: EventMatch[] = Object.entries(allEventsRaw)
            .map(([id, value]) => {
                try {
                    return JSON.parse(value as string) as EventMatch;
                } catch (error) {
                    console.error(`Erro ao fazer parse do evento ${id}:`, error);
                    return null;
                }
            })
            .filter((event): event is EventMatch => event !== null);

        // Calcular estatísticas
        const stats = {
            totalEvents: events.length,
            disabledEvents: events.filter(e => e.disabled).length,
            enabledEvents: events.filter(e => !e.disabled).length,
            sports: {} as Record<string, number>,
            leagues: {} as Record<string, number>,
            bookmakers: {} as Record<string, number>
        };

        // Contar por esporte
        events.forEach(event => {
            if (event.sport) {
                stats.sports[event.sport] = (stats.sports[event.sport] || 0) + 1;
            }
        });

        // Contar por liga
        events.forEach(event => {
            if (event.league) {
                stats.leagues[event.league] = (stats.leagues[event.league] || 0) + 1;
            }
        });

        // Contar por bookmaker
        events.forEach(event => {
            if (event.baseBookmaker) {
                stats.bookmakers[event.baseBookmaker] = (stats.bookmakers[event.baseBookmaker] || 0) + 1;
            }
            
            // Contar bookmakers dos matches
            event.matches?.forEach(match => {
                if (match.bookmaker) {
                    stats.bookmakers[match.bookmaker] = (stats.bookmakers[match.bookmaker] || 0) + 1;
                }
            });
        });

        res.status(200).json(createResponse(1, "Estatísticas carregadas com sucesso", { stats }));

    } catch (error) {
        console.error('Erro ao buscar estatísticas dos eventos:', error);
        res.status(500).json(createResponse(0, "Erro interno do servidor", { error: (error as Error).message }));
    }
};

/**
 * Endpoint para buscar detalhes completos de um evento com mercados e odds
 * GET /api/events/:id/details
 */
export const getEventDetails = async (req: Request, res: Response): Promise<void> => {
    try {
        const { id } = req.params;
        
        if (!id) {
            res.status(400).json(createResponse(0, "ID do evento é obrigatório", []));
            return;
        }

        const redisClient = getRedisClient();
        const eventKey = 'ArbBetting:EventMatchList';
        
        // Buscar o evento principal
        const eventRaw = await redisClient.hget(eventKey, id);
        
        if (!eventRaw) {
            res.status(404).json(createResponse(0, "Evento não encontrado", []));
            return;
        }

        let event: EventMatch;
        try {
            event = JSON.parse(eventRaw) as EventMatch;
        } catch (parseError) {
            console.error(`Erro ao fazer parse do evento ${id}:`, parseError);
            res.status(500).json(createResponse(0, "Erro ao processar dados do evento", []));
            return;
        }

        // Coletar todos os bookmakers (base + matches)
        const allBookmakers = [
            { bookmaker: event.baseBookmaker, isBase: true },
            ...(event.matches?.map(match => ({ bookmaker: match.bookmaker, isBase: false })) || [])
        ];

        console.log(`[DEBUG] Evento ID: ${id}`);
        console.log(`[DEBUG] Esporte: ${event.sport}`);
        console.log(`[DEBUG] Bookmakers encontrados:`, allBookmakers.map(b => b.bookmaker));

        // Buscar mercados para cada bookmaker
        const marketsData: Record<string, MarketFormat[]> = {};
        
        for (const { bookmaker } of allBookmakers) {
            try {
                let eventId = id; // ID padrão (para baseBookmaker)
                
                // Se não for o baseBookmaker, buscar o eventId específico nos matches
                if (bookmaker !== event.baseBookmaker) {
                    const match = event.matches.find(m => m.bookmaker === bookmaker);
                    if (match && match.eventId) {
                        eventId = match.eventId.toString();
                        console.log(`[DEBUG] Usando eventId específico para ${bookmaker}: ${eventId}`);
                    } else {
                        console.log(`[DEBUG] EventId não encontrado para ${bookmaker}, usando ID padrão: ${eventId}`);
                    }
                } else {
                    console.log(`[DEBUG] Usando ID padrão para baseBookmaker ${bookmaker}: ${eventId}`);
                }
                
                const marketKey = `ArbBetting:Markets:${event.sport.charAt(0).toUpperCase() + event.sport.slice(1)}:${bookmaker}:${eventId}`;
                console.log(`[DEBUG] Buscando mercado com chave: ${marketKey}`);
                
                const marketRaw = await redisClient.hgetall(marketKey);
                console.log(`[DEBUG] Resultado para ${bookmaker}:`, marketRaw ? Object.keys(marketRaw).length : 'null');
                
                if (marketRaw && Object.keys(marketRaw).length > 0) {
                    const markets: MarketFormat[] = Object.entries(marketRaw).map(([marketId, marketValue]) => {
                        try {
                            const market = JSON.parse(marketValue as string) as MarketFormat;
                            console.log(`[DEBUG] Mercado parseado: ${marketId} - ${market.name}`);
                            return market;
                        } catch (error) {
                            console.error(`Erro ao fazer parse do mercado ${marketId} para ${bookmaker}:`, error);
                            return null;
                        }
                    }).filter((market): market is MarketFormat => market !== null);
                    
                    if (markets.length > 0) {
                        marketsData[bookmaker] = markets;
                        console.log(`[DEBUG] ${markets.length} mercados carregados para ${bookmaker}`);
                    }
                } else {
                    console.log(`[DEBUG] Nenhum mercado encontrado para ${bookmaker}`);
                }
            } catch (error) {
                console.error(`Erro ao buscar mercados para ${bookmaker}:`, error);
            }
        }

        console.log(`[DEBUG] Total de bookmakers com mercados:`, Object.keys(marketsData).length);

        // Processar e organizar odds por mercado
        const processedMarkets: Array<{
            marketId: string;
            marketName: string;
            marketNameEn: string;
            odds: Array<{
                bookmaker: string;
                price: number | string;
                name: string;
                team?: string;
                handicap?: number | string;
                size?: number;
                inverted?: boolean;
            }>;
        }> = [];

        // Agrupar odds por mercado
        const marketGroups: Record<string, Array<{
            bookmaker: string;
            price: number | string;
            name: string;
            team?: string;
            handicap?: number | string;
            size?: number;
            inverted?: boolean;
        }>> = {};

        Object.entries(marketsData).forEach(([bookmaker, markets]) => {
            markets.forEach(market => {
                const marketKey = market.id; // Usar apenas o ID, sem subId
                
                if (!marketGroups[marketKey]) {
                    marketGroups[marketKey] = [];
                }

                market.odds.forEach(odd => {
                    marketGroups[marketKey].push({
                        bookmaker,
                        price: odd.price,
                        name: odd.name,
                        team: odd.team,
                        handicap: odd.handicap,
                        size: odd.size,
                        inverted: odd.inverted
                    });
                });
            });
        });


        // Converter para formato final e ordenar odds por preço (maior para menor)
        Object.entries(marketGroups).forEach(([marketKey, odds]) => {
            // Encontrar informações do mercado
            let marketInfo = null;
            for (const markets of Object.values(marketsData)) {
                const market = markets.find(m => m.id === marketKey);
                if (market) {
                    marketInfo = market;
                    break;
                }
            }

            if (marketInfo) {
                // Ordenar odds por preço (maior para menor)
                const sortedOdds = odds.sort((a, b) => {
                    const priceA = typeof a.price === 'string' ? parseFloat(a.price) : a.price;
                    const priceB = typeof b.price === 'string' ? parseFloat(b.price) : b.price;
                    return priceB - priceA;
                });

                processedMarkets.push({
                    marketId: marketKey,
                    marketName: marketInfo.name,
                    marketNameEn: marketInfo.nameEn,
                    odds: sortedOdds
                });
            }
        });


        // Criar objeto com links das casas de apostas
        const bookmakerLinks: Record<string, string> = {};
        
        // Adicionar link da casa base
        bookmakerLinks[event.baseBookmaker] = event.link;
        
        // Adicionar links das outras casas de apostas
        event.matches.forEach(match => {
            if (match.link && match.bookmaker !== event.baseBookmaker) {
                bookmakerLinks[match.bookmaker] = match.link;
            }
        });

        // Resposta com detalhes completos
        res.status(200).json(createResponse(1, "Detalhes do evento carregados com sucesso", {
            event: {
                id: event.id,
                sport: event.sport,
                league: event.league,
                home: event.home,
                away: event.away,
                date: event.date,
                link: event.link,
                baseBookmaker: event.baseBookmaker,
                disabled: event.disabled,
                update_at: event.update_at,
                create_at: event.create_at
            },
            bookmakers: allBookmakers.map(b => b.bookmaker),
            bookmakerLinks: bookmakerLinks,
            markets: processedMarkets,
            marketsCount: processedMarkets.length,
            bookmakersWithMarkets: Object.keys(marketsData)
        }));

    } catch (error) {
        console.error('Erro ao buscar detalhes do evento:', error);
        res.status(500).json(createResponse(0, "Erro interno do servidor", { error: (error as Error).message }));
    }
};

