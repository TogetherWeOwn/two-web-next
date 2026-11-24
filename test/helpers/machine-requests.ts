export const agentCaller = "agent-under-test";
export const agentCredential = "cred-route-kill-001";
export const agentCreate = {
  op: "create",
  idempotency_key: "route-ok-001",
  fields: {
    title: "Agent proof event",
    game: "Helldivers 2",
    description: "One uniquely labelled route proof.",
    starts_at: "2026-10-01 20:00",
    ends_at: "2026-10-01 22:00",
    timezone: "Europe/London",
    location: "Voice: General",
    capacity: 4,
  },
};

export function mcpToolCall(name: string, args: Record<string, unknown>, id: number | string) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

export const mcpListEventsArgs = { per_page: 20, page: 1 };
