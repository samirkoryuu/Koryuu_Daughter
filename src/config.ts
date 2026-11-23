import "dotenv/config";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  clientId: required("DISCORD_CLIENT_ID"),
  guildId: process.env.DISCORD_GUILD_ID?.trim() || undefined,
  workerApiUrl: required("WORKER_API_URL").replace(/\/+$/, ""),
  gatewaySharedSecret: required("GATEWAY_SHARED_SECRET"),
  lilithId: required("LILITH_USER_ID"),
  asterionId: required("ASTERION_USER_ID")
};
