/**
 * Thin wrapper around Discord's OAuth2 "Authorization Code Grant" flow.
 *
 * DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / DISCORD_REDIRECT_URI are
 * intentionally blank until a Discord Developer Portal app exists — every
 * function here reads them from process.env on each call (never cached at
 * module load) and `isDiscordConfigured` lets the route layer degrade
 * cleanly (503) instead of throwing when they're unset.
 */

export interface DiscordIdentity {
  discordId: string;
  username: string;
  avatar: string | null;
}

export function discordAvatarUrl(discordId: string, avatar: string | null): string {
  if (!avatar) {
    const defaultIndex = Number((BigInt(discordId) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
  }
  const extension = avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.${extension}?size=256`;
}

interface DiscordConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function getConfig(): DiscordConfig | null {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const redirectUri = process.env.DISCORD_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }

  return { clientId, clientSecret, redirectUri };
}

/** True only when all three Discord env vars are set and non-empty. */
export function isDiscordConfigured(): boolean {
  return getConfig() !== null;
}

/**
 * Builds the Discord "authorize" URL to redirect the browser to.
 * `state` is an opaque, caller-generated CSRF token (the route layer
 * generates it, stores it in a short-lived cookie, and verifies it against
 * Discord's callback `state` query param before trusting the callback).
 * Throws if config is missing — callers must check `isDiscordConfigured()`
 * first (the /auth/discord/login route does, and 503s instead of calling
 * this).
 */
export function buildAuthorizeUrl(state: string): string {
  const config = getConfig();
  if (!config) {
    throw new Error("Discord OAuth is not configured");
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "identify",
    state,
  });

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

interface DiscordTokenResponse {
  access_token: string;
}

interface DiscordUserResponse {
  id: string;
  username: string;
  avatar?: string | null;
}

/**
 * Exchanges an OAuth `code` for a Discord access token, then calls
 * `/users/@me` to resolve the player's Discord id and username.
 *
 * `fetchImpl` defaults to the global `fetch` but is overridable — tests
 * pass a fake so no real network call ever happens in the suite, matching
 * the pattern used by services/fivemStatus.ts's `pollOnce`.
 */
export async function exchangeCode(
  code: string,
  fetchImpl: typeof fetch = fetch
): Promise<DiscordIdentity> {
  const config = getConfig();
  if (!config) {
    throw new Error("Discord OAuth is not configured");
  }

  const tokenRes = await fetchImpl("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`discord token exchange failed with HTTP ${tokenRes.status}`);
  }

  const tokenBody = (await tokenRes.json()) as DiscordTokenResponse;

  const userRes = await fetchImpl("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${tokenBody.access_token}` },
  });

  if (!userRes.ok) {
    throw new Error(`discord /users/@me failed with HTTP ${userRes.status}`);
  }

  const userBody = (await userRes.json()) as DiscordUserResponse;

  return { discordId: userBody.id, username: userBody.username, avatar: userBody.avatar ?? null };
}
