// MARK: heartbeat types
//
// Spec: docs/specs/2026-04-16-heartbeat-spec.md

export type HeartbeatHandlerKind = "agent-run";

export interface HeartbeatAnnounce {
  channels: string[];
  urgency?: "low" | "normal" | "high";
}

export interface HeartbeatTaskDef {
  id: string;
  schedule: string;
  handler: HeartbeatHandlerKind;
  prompt?: string;
  announce?: HeartbeatAnnounce;
  tags?: string[];
  enabled?: boolean;
}

export interface HeartbeatTaskState {
  lastFiredAt?: string;
  lastStatus?: "ok" | "error";
  lastReturnId?: string;
  lastError?: string;
}

export interface HeartbeatState {
  tasks: Record<string, HeartbeatTaskState>;
}

export interface HeartbeatTaskStatus {
  def: HeartbeatTaskDef;
  state: HeartbeatTaskState;
  nextFireAt?: string;
}
