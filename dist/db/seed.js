import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { pool } from "./pool.js";
import { calculateRating } from "../services/rating.js";
/**
 * Deterministic fixture data for local development and tests: enough rows
 * across every domain table that pages built on top of them (rankings,
 * player profiles, events, hall of fame, changelog, store, home stats)
 * render non-empty without hand-crafted per-feature fixtures.
 *
 * Idempotent: truncates every domain table (CASCADE handles FK order) before
 * inserting, so `seed()` is safe to call repeatedly against the same
 * database — in tests re-run against a persistent local Postgres, and in
 * dev when re-seeding after schema changes.
 */
export async function seed() {
    await pool.query(`
    TRUNCATE TABLE
      players, clans, rankings, player_stats, events, hall_of_fame,
      changelog_entries, home_stats, store_items, orders, order_items,
      link_codes, staff_accounts
    RESTART IDENTITY CASCADE
  `);
    const playerFixtures = [
        { username: "sombra_zk", display: "Sombra" },
        { username: "fantasma_rj", display: "Fantasma" },
        { username: "reaper_br", display: "Reaper BR" },
        { username: "vulcao_sp", display: "Vulcão" },
        { username: "predador_01", display: "Predador" },
        { username: "aranha_negra", display: "Aranha Negra" },
        { username: "lobo_solitario", display: "Lobo Solitário" },
        { username: "cobra_real", display: "Cobra Real" },
        { username: "trovao_zk", display: "Trovão" },
        { username: "nemesis_br", display: "Nêmesis" },
    ];
    const players = playerFixtures.map((p, i) => ({
        id: randomUUID(),
        discordId: `disc-${1000 + i}`,
        discordUsername: p.username,
        fivemLicense: `license:zk${1000 + i}`,
        displayName: p.display,
    }));
    for (const p of players) {
        await pool.query(`INSERT INTO players (id, discord_id, discord_username, fivem_license, display_name)
       VALUES ($1, $2, $3, $4, $5)`, [p.id, p.discordId, p.discordUsername, p.fivemLicense, p.displayName]);
    }
    const clanFixtures = [
        { tag: "RVL", name: "Rival" },
        { tag: "ANX", name: "Anexo" },
        { tag: "ZKS", name: "ZK Soldiers" },
        { tag: "ECL", name: "Eclipse" },
    ];
    const clans = clanFixtures.map((c) => ({ id: randomUUID(), ...c }));
    for (const c of clans) {
        await pool.query(`INSERT INTO clans (id, tag, name) VALUES ($1, $2, $3)`, [
            c.id,
            c.tag,
            c.name,
        ]);
    }
    // Give each seeded clan at least one member player (players.clan_id, added
    // in migration 002). Players 0 and 1 match the clans the `rankings` fixture
    // below already credits at positions 1 and 2 (clans[pos - 1] for pos <= 2),
    // so a player's clan tag is consistent between /api/players and
    // /api/ranking wherever both happen to reference the same player.
    const clanMemberships = [
        { playerIndex: 0, clanIndex: 0 }, // Sombra -> RVL
        { playerIndex: 1, clanIndex: 1 }, // Fantasma -> ANX
        { playerIndex: 2, clanIndex: 2 }, // Reaper BR -> ZKS
        { playerIndex: 3, clanIndex: 3 }, // Vulcão -> ECL
    ];
    for (const { playerIndex, clanIndex } of clanMemberships) {
        await pool.query(`UPDATE players SET clan_id = $1 WHERE id = $2`, [
            clans[clanIndex].id,
            players[playerIndex].id,
        ]);
    }
    // player_stats: every player gets global/duo/squad rows with genuinely
    // distinct stats per mode (not copies), driven by index + a per-mode
    // offset so the three rows never collide.
    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        const modeStats = [
            {
                mode: "global",
                matches: 120 + i * 7,
                avgPosition: Math.max(1, 15 - i * 0.5),
                avgKills: 4.5 + i * 0.2,
                kd: 1.2 + i * 0.07,
                wins: 40 + i * 3,
                ranked: true,
            },
            {
                mode: "duo",
                matches: 80 + i * 5,
                avgPosition: Math.max(1, 12 - i * 0.4),
                avgKills: 3.8 + i * 0.15,
                kd: 1.0 + i * 0.05,
                wins: 25 + i * 2,
                ranked: true,
            },
            {
                mode: "squad",
                matches: 60 + i * 4,
                avgPosition: Math.max(1, 10 - i * 0.3),
                avgKills: 3.0 + i * 0.18,
                kd: 0.9 + i * 0.06,
                wins: 18 + i * 2,
                ranked: i % 2 === 0,
            },
        ];
        for (const s of modeStats) {
            const rating = calculateRating({
                wins: s.wins,
                kd: s.kd,
                avgPosition: s.avgPosition,
                avgKills: s.avgKills,
                ranked: s.ranked,
            });
            await pool.query(`INSERT INTO player_stats
           (player_id, mode, matches, avg_position, avg_kills, kd, wins, ranked, rating)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [p.id, s.mode, s.matches, s.avgPosition, s.avgKills, s.kd, s.wins, s.ranked, rating]);
        }
    }
    // rankings: cover all 4 modes (diario/semanal/mensal/mvp) for a single stage,
    // ranking the first 5 players by index with distinct positions.
    const STAGE = "temporada-1";
    const rankingModes = [
        "diario",
        "semanal",
        "mensal",
        "mvp",
    ];
    const prizesByPosition = {
        1: "R$ 1.000 + Caixa Lendária",
        2: "R$ 500 + Caixa Épica",
        3: "R$ 250",
    };
    for (const mode of rankingModes) {
        for (let pos = 1; pos <= 5; pos++) {
            const p = players[(pos - 1) % players.length];
            const eliminations = 50 - pos * 4;
            const wins = 20 - pos * 2;
            const rating = calculateRating({
                wins,
                kd: 1.5 - pos * 0.1,
                avgPosition: pos * 2,
                avgKills: 6 - pos * 0.5,
                ranked: true,
            });
            const clanId = pos <= 2 ? clans[pos - 1].id : null;
            await pool.query(`INSERT INTO rankings
           (player_id, mode, stage, position, eliminations, wins, rating, clan_id, prizes_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
                p.id,
                mode,
                STAGE,
                pos,
                eliminations,
                wins,
                rating,
                clanId,
                prizesByPosition[pos] ?? null,
            ]);
        }
    }
    const events = [
        {
            title: "Torneio Solo da Virada",
            description: "Disputa individual com premiação em diamantes e cash.",
            category: "torneio",
            startsAt: "2026-12-05T20:00:00Z",
            prizeText: "R$ 2.000 em prêmios",
            featured: true,
        },
        {
            title: "Guerra de Clãs ZKPVP",
            description: "Confronto entre os clãs mais fortes do servidor.",
            category: "comunidade",
            startsAt: "2026-11-15T19:00:00Z",
            prizeText: "Troféu + Caixa Lendária",
            featured: false,
        },
        {
            title: "Evento Especial de Aniversário",
            description: "Comemoração de aniversário do servidor com modos especiais.",
            category: "especial",
            startsAt: "2026-11-30T18:00:00Z",
            prizeText: "Diamantes em dobro",
            featured: false,
        },
    ];
    for (const e of events) {
        await pool.query(`INSERT INTO events (title, description, category, starts_at, prize_text, featured)
       VALUES ($1, $2, $3, $4, $5, $6)`, [e.title, e.description, e.category, e.startsAt, e.prizeText, e.featured]);
    }
    const hallOfFame = [
        {
            eventName: "Torneio de Verão 2026",
            championName: "Sombra",
            championTag: "ZKS",
            prizeText: "R$ 1.500",
            wonAt: "2026-02-20",
        },
        {
            eventName: "Copa Squad ZKPVP",
            championName: "Reaper BR",
            championTag: "RVL",
            prizeText: "R$ 3.000 dividido entre o squad",
            wonAt: "2026-05-10",
        },
        {
            eventName: "Duelo dos Campeões",
            championName: "Cobra Real",
            championTag: "ECL",
            prizeText: "Caixa Lendária + Cash",
            wonAt: "2026-08-01",
        },
    ];
    for (const h of hallOfFame) {
        await pool.query(`INSERT INTO hall_of_fame (event_name, champion_name, champion_tag, prize_text, won_at)
       VALUES ($1, $2, $3, $4, $5)`, [h.eventName, h.championName, h.championTag, h.prizeText, h.wonAt]);
    }
    const changelogEntries = [
        {
            version: "1.0.0",
            title: "Lançamento oficial do ZKPVP",
            publishedAt: "2026-01-10",
            categories: ["novidades"],
            body: "Lançamento do servidor com sistema de ranking, loja de diamantes e eventos sazonais.",
        },
        {
            version: "1.1.0",
            title: "Balanceamento de armas e correções",
            publishedAt: "2026-04-18",
            categories: ["melhorias", "correcoes"],
            body: "Ajuste no dano de armas automáticas e correção de bug na contagem de eliminações.",
        },
        {
            version: "1.2.0",
            title: "Melhorias de segurança e anti-cheat",
            publishedAt: "2026-08-22",
            categories: ["importantes", "correcoes"],
            body: "Reforço no sistema anti-cheat e correção de falha que permitia duplicar diamantes.",
        },
    ];
    for (const c of changelogEntries) {
        await pool.query(`INSERT INTO changelog_entries (version, title, published_at, categories, body)
       VALUES ($1, $2, $3, $4, $5)`, [c.version, c.title, c.publishedAt, c.categories, c.body]);
    }
    const homeStats = {
        contas_criadas: "15420",
        premiacao_total: "R$ 128.500",
        campeonatos: "47",
        clas: "312",
        banidos: "89",
    };
    for (const [key, value] of Object.entries(homeStats)) {
        await pool.query(`INSERT INTO home_stats (key, value) VALUES ($1, $2)`, [key, value]);
    }
    const storeItems = [
        {
            name: "Caixa Lendária",
            description: "Caixa com chance de itens lendários exclusivos.",
            priceCents: 1990,
            category: "caixas",
        },
        {
            name: "Caixa Épica",
            description: "Caixa com itens épicos e raros.",
            priceCents: 1290,
            category: "caixas",
        },
        {
            name: "Skin Operador Sombrio",
            description: "Skin exclusiva de personagem para o modo PvP.",
            priceCents: 2490,
            category: "skins",
        },
        {
            name: "VIP Bronze (30 dias)",
            description: "Benefícios básicos de VIP por 30 dias.",
            priceCents: 1590,
            category: "vip",
        },
        {
            name: "VIP Diamante (30 dias)",
            description: "Benefícios completos de VIP por 30 dias.",
            priceCents: 3990,
            category: "vip",
        },
        {
            name: "Pacote de Armas Tático",
            description: "Conjunto de armas táticas para combate PvP.",
            priceCents: 1490,
            category: "armas",
        },
        {
            name: "Veículo Blindado Urbano",
            description: "Veículo blindado exclusivo para sobrevivência.",
            priceCents: 4990,
            category: "veiculos",
        },
        {
            name: "Emote Vitória Épica",
            description: "Emote exclusivo para celebrar vitórias.",
            priceCents: 490,
            category: "emotes",
        },
    ];
    for (const s of storeItems) {
        await pool.query(`INSERT INTO store_items (name, description, price_diamonds, price_cents, category)
       VALUES ($1, $2, 0, $3, $4)`, [s.name, s.description, s.priceCents, s.category]);
    }
}
const isDirectRun = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
    seed()
        .then(() => {
        console.log("Seed concluído com sucesso.");
        return pool.end();
    })
        .catch((err) => {
        console.error("Falha ao executar seed:", err);
        return pool.end().finally(() => process.exit(1));
    });
}
