import { Entity, PrimaryGeneratedColumn, Column, Index, OneToMany } from 'typeorm';
import { PrimeTvRadioStation } from './PrimeTvRadioStation';

/**
 * Jogo do **PrimeRádio**: transmissão de ÁUDIO (narração) cadastrada à mão pelo
 * admin — aqui NÓS somos o fornecedor, não o weddbets.
 *
 * Diferente do resto do PrimeTV (cache do fornecedor em memória + overrides no
 * Redis com TTL), isto é **conteúdo autoral** e precisa persistir de verdade →
 * MySQL, no mesmo espírito de `EventExclusion` (dado curado por admin). O
 * `RadioSource` (services/primetv/radio.provider) lê esta tabela e devolve
 * `PrimeTvEvent` com `kind:'radio'`, entrando na MESMA lista do PrimeTV.
 *
 * ⚠️ `startTime`/`endTime` seguem a convenção do projeto: **wallclock de Brasília
 * (GMT-3)**. O front renderiza verbatim (timeZone:'UTC'), então gravar o horário
 * "como digitado" — não converter pra UTC real, senão sai 3h errado.
 *
 * Fim do jogo: `endTime` (sugerido início+100min no formulário) OU `endedAt`
 * (admin encerrou na mão). Qualquer um dos dois tira da lista pública.
 */
@Entity('primetv_radio_events')
@Index('idx_radio_window', ['startTime', 'endTime'])
@Index('idx_radio_active', ['isActive'])
export class PrimeTvRadioEvent {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    // --- times (jogo A x B). Sem eles, usa `title` (evento avulso). ---
    @Column({ type: 'varchar', length: 120, nullable: true })
    homeName!: string | null;

    @Column({ type: 'varchar', length: 120, nullable: true })
    awayName!: string | null;

    // id do time no SofaScore — o escudo sai de /api/v1/team/{id}/image
    @Column({ type: 'varchar', length: 32, nullable: true })
    homeSofaId!: string | null;

    @Column({ type: 'varchar', length: 32, nullable: true })
    awaySofaId!: string | null;

    // Usado quando não é "A x B" (ex.: "Mesa redonda", corrida, etc.).
    @Column({ type: 'varchar', length: 200, nullable: true })
    title!: string | null;

    @Column({ type: 'varchar', length: 160, nullable: true })
    competition!: string | null;

    @Column({ type: 'varchar', length: 80, nullable: true })
    country!: string | null;

    // ISO-2 (BR, AR...) — vira a bandeirinha na lista.
    @Column({ type: 'varchar', length: 8, nullable: true })
    countryCode!: string | null;

    @Column({ type: 'varchar', length: 40, default: 'futebol' })
    sport!: string;

    // --- janela (wallclock Brasília, ver aviso no topo) ---
    // Guardado como STRING ISO verbatim (ex.: "2026-06-30T22:00:00.000Z" = 22:00 BRT),
    // NÃO como timestamp: coluna de data faria o MySQL/TypeORM converterem fuso e o
    // horário sairia 3h errado. Como texto faz round-trip exato, e ISO-8601 ordena
    // lexicograficamente na ordem cronológica (ORDER BY e range no SQL seguem valendo).
    @Column({ type: 'varchar', length: 30 })
    startTime!: string;

    @Column({ type: 'varchar', length: 30 })
    endTime!: string;

    // --- emissoras ---
    // Um jogo tem N rádios narrando; quem escolhe é o ouvinte (ver PrimeTvRadioStation).
    @OneToMany(() => PrimeTvRadioStation, (station) => station.event, { cascade: false })
    stations!: PrimeTvRadioStation[];

    // ⚠️ LEGADO — versão de uma emissora só, de antes da tabela de stations.
    // Nada novo grava aqui; o serviço sintetiza uma emissora a partir destes
    // campos quando o evento antigo não tem nenhuma linha em stations.
    @Column({ type: 'text', nullable: true })
    streamUrl!: string | null;

    @Column({ type: 'varchar', length: 120, nullable: true })
    station!: string | null;

    // Imagem de fundo da página do jogo (estádio, arte do confronto...).
    // Sem ela a página cai num gradiente com os escudos.
    @Column({ type: 'text', nullable: true })
    coverUrl!: string | null;

    // --- controle ---
    // Encerrado na mão pelo admin (some da lista pública imediatamente).
    @Column({ type: 'timestamp', nullable: true })
    endedAt!: Date | null;

    @Column({ type: 'boolean', default: true })
    isActive!: boolean;

    @Column({ type: 'varchar', length: 64, nullable: true })
    createdBy!: string | null; // userId do admin

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
    updatedAt!: Date;
}
