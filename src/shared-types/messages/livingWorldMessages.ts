/**
 * Server → client (broadcast): a Living World bot is now proactively
 * hostile to `targetPlayerId`. Server → client twin of the
 * `damage`→`markHostile` mirror — the client feeds `botEntityId`
 * (stripped of its `swarm-` prefix) + `targetPlayerId` into its own
 * `AiController.markHostile`, so the predicted drone AI and the
 * authoritative one stay lockstep without a swarm-wire bump (the
 * existing, proven hostility channel). Re-sent each director control
 * tick so the 30 s hostility decay never trips while a player is present;
 * a dropped packet self-heals on the next pass. Interface-only (no zod) —
 * server→client events are not in the inbound `ClientMessageSchema`.
 */
export interface BotAggroEvent {
  type: 'bot_aggro';
  /** Dense wire id of the bot drone, `swarm-<entityId>` (same form as
   *  `DamageEvent.targetId` for swarm targets). */
  botEntityId: string;
  targetPlayerId: string;
  /** Server tick at declaration — only used for the AI fire/forget
   *  cooldown reference, exactly like the damage-mirror path. */
  tick: number;
}
