/**
 * Player rating inputs. All values are aggregates over a player's match history.
 */
export interface RatingStats {
  /** Total match wins. */
  readonly wins: number;
  /** Kill/death ratio. */
  readonly kd: number;
  /** Average placement; 1 is best. Values at or above 100 contribute nothing. */
  readonly avgPosition: number;
  /** Average kills per match. */
  readonly avgKills: number;
  /** Whether the stats come from ranked matches. */
  readonly ranked: boolean;
}

const WIN_WEIGHT = 30;
const KD_WEIGHT = 25;
const POSITION_WEIGHT = 0.25;
const POSITION_CEILING = 100;
const KILLS_WEIGHT = 20;
const RANKED_MULTIPLIER = 1.05;

/**
 * Computes a player rating from aggregate stats.
 *
 * Pure function: no I/O, no side effects. Position is inverted so that
 * lower placements score higher and is clamped at zero, so it can never
 * reduce the rating.
 */
export function calculateRating(stats: RatingStats): number {
  const positionScore = Math.max(0, POSITION_CEILING - stats.avgPosition) * POSITION_WEIGHT;
  const base =
    stats.wins * WIN_WEIGHT +
    stats.kd * KD_WEIGHT +
    positionScore +
    stats.avgKills * KILLS_WEIGHT;

  return stats.ranked ? base * RANKED_MULTIPLIER : base;
}
