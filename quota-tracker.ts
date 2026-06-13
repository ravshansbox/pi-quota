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

export function parseAnthropicHeaders(headers: Record<string, string>): Partial<QuotaState> | null {
  const remaining = headers["anthropic-ratelimit-requests-remaining"];
  const reset = headers["anthropic-ratelimit-requests-reset"];
  const tokensRemaining = headers["anthropic-ratelimit-tokens-remaining"];
  const tokensReset = headers["anthropic-ratelimit-tokens-reset"];

  if (!remaining && !tokensRemaining) return null;

  const parsedRemaining = remaining ? parseInt(remaining, 10) : null;
  const parsedTokens = tokensRemaining ? parseInt(tokensRemaining, 10) : null;

  const requestsReset = reset ? new Date(reset) : null;
  const tokenReset = tokensReset ? new Date(tokensReset) : null;

  return {
    provider: "anthropic",
    requestsRemaining: parsedRemaining !== null && !isNaN(parsedRemaining) ? parsedRemaining : null,
    requestsReset: requestsReset && !isNaN(requestsReset.getTime()) ? requestsReset : null,
    tokensRemaining: parsedTokens !== null && !isNaN(parsedTokens) ? parsedTokens : null,
    tokensReset: tokenReset && !isNaN(tokenReset.getTime()) ? tokenReset : null,
    lastUpdated: new Date(),
  };
}

export function parseOpenAIHeaders(headers: Record<string, string>): Partial<QuotaState> | null {
  const remaining = headers["x-ratelimit-remaining-requests"];
  const reset = headers["x-ratelimit-reset-requests"];
  const tokensRemaining = headers["x-ratelimit-remaining-tokens"];
  const tokensReset = headers["x-ratelimit-reset-tokens"];

  if (!remaining && !tokensRemaining) return null;

  const parsedRemaining = remaining ? parseInt(remaining, 10) : null;
  const parsedTokens = tokensRemaining ? parseInt(tokensRemaining, 10) : null;

  const requestsReset = reset ? new Date(reset) : null;
  const tokenReset = tokensReset ? new Date(tokensReset) : null;

  return {
    provider: "openai",
    requestsRemaining: parsedRemaining !== null && !isNaN(parsedRemaining) ? parsedRemaining : null,
    requestsReset: requestsReset && !isNaN(requestsReset.getTime()) ? requestsReset : null,
    tokensRemaining: parsedTokens !== null && !isNaN(parsedTokens) ? parsedTokens : null,
    tokensReset: tokenReset && !isNaN(tokenReset.getTime()) ? tokenReset : null,
    lastUpdated: new Date(),
  };
}

export function formatQuotaStatus(states: QuotaState[]): string {
  if (states.length === 0) return "No quota data collected yet.";

  const lines: string[] = ["📊 Quota Status", ""];

  for (const state of states) {
    const provider = state.provider.charAt(0).toUpperCase() + state.provider.slice(1);
    lines.push(`${provider}:`);

    if (state.fiveHourRemaining !== null) {
      const resetStr = state.fiveHourReset ? formatResetTime(state.fiveHourReset) : "unknown";
      lines.push(`• 5 Hour: ${state.fiveHourRemaining}% remaining (resets ${resetStr})`);
    }

    if (state.sevenDayRemaining !== null) {
      const resetStr = state.sevenDayReset ? formatResetTime(state.sevenDayReset) : "unknown";
      lines.push(`• 7 Day: ${state.sevenDayRemaining}% remaining (resets ${resetStr})`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

function formatResetTime(reset: Date): string {
  const now = new Date();
  const diff = reset.getTime() - now.getTime();

  if (diff <= 0) return "now";

  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);

  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}K`;
  return tokens.toString();
}
