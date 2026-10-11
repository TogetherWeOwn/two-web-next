import type { Sql, TransactionSql } from "postgres";
import type { WriteBack } from "../admin/store";
import type { EventReader } from "../bot/event-read";

export type IngressEffects = {
  readEvent?: EventReader;
  writeBack?: (writeBack: NonNullable<WriteBack>) => Promise<void>;
};

export type Answer = {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
};

export type IngressConfig = {
  enabled: boolean;
  callerAgentId: string;
  stagingGuildId: string;
  productionGuildId: string;
  mutatingPerMinute: number;
  readsPerMinute: number;
  serviceMutatingPerMinute: number;
  serviceReadsPerMinute: number;
  // The outer route shield (two-web TOG-8402, config `agent-events.route_per_minute`):
  // every hit per credential per minute, counted before auth, the grant lookup
  // and the audit write. A flood guard above the inner budgets' sum, not the
  // allowance — the bot's normal burst never sees it.
  routePerMinute: number;
  lockWaitMs: number;
};

export const DEFAULT_CONFIG: IngressConfig = {
  enabled: false,
  callerAgentId: "",
  stagingGuildId: "1545644954272137297",
  productionGuildId: "326474832151838730",
  mutatingPerMinute: 10,
  readsPerMinute: 30,
  serviceMutatingPerMinute: 60,
  serviceReadsPerMinute: 300,
  routePerMinute: 60,
  lockWaitMs: 5000,
};

export const OPS = ["create", "read", "update", "publish", "cancel"] as const;
export type Op = (typeof OPS)[number];
export type Tx = TransactionSql | Sql;
export type Row = Record<string, any>;
export type Grant = {
  id: string;
  agent_id: string;
  guild_id: string;
  expires_at: Date | null;
  disabled_at: Date | null;
};
// stored: the answer is persisted for replay. Denials and failures never are, so a client that
// fixes its payload under the same key is answered, not conflicted.
export type Outcome = Answer & {
  eventKey?: string | null;
  stored?: boolean;
  writeBack?: NonNullable<WriteBack>;
};
