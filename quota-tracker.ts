export interface QuotaConfig {
  botToken: string;
  chatId: string;
  pollIntervalMs?: number;
}

export interface QuotaState {
  provider: "anthropic" | "openai";
  fiveHourRemaining: number | null;
  fiveHourReset: Date | null;
  sevenDayRemaining: number | null;
  sevenDayReset: Date | null;
  lastUpdated: Date;
}

export function formatQuotaStatus(states: QuotaState[]): string {
  if (states.length === 0) return "No quota data collected yet.";

  return states
    .map((state) => {
      const provider = state.provider === "openai" ? "openai-codex" : state.provider;
      const parts: string[] = [];

      if (state.sevenDayRemaining !== null) {
        const resetStr = state.sevenDayReset ? formatResetTime(state.sevenDayReset) : "unknown";
        parts.push(`7d: ${state.sevenDayRemaining}% left (${resetStr})`);
      }

      if (state.fiveHourRemaining !== null) {
        const resetStr = state.fiveHourReset ? formatResetTime(state.fiveHourReset) : "unknown";
        parts.push(`5h: ${state.fiveHourRemaining}% left (${resetStr})`);
      }

      return `${provider}: ${parts.join(", ")}`;
    })
    .join("\n");
}

export function formatResetTime(reset: Date): string {
  const now = new Date();
  const diff = reset.getTime() - now.getTime();

  if (diff <= 0) return "now";

  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

