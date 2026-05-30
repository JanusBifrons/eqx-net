import { z } from 'zod';

/**
 * Wire schemas for the swift-otter WebRTC plan's signaling path. The
 * client speaks WebSocket for these three messages and the server
 * replies via the same Colyseus `client.send`. Once the DataChannel
 * is open, snapshots flow over DC; the WS stays open for signaling
 * + non-snapshot game messages.
 *
 * SDP is up to ~2 KB of plain text; we cap at 64 KB to defend against
 * a malicious / mangled offer. ICE candidates are short ASCII strings;
 * 1 KB is generous.
 *
 * Plan: swift-otter (Phase 1 — server-side parse; Phase 2 — client-side emit).
 */

export const SDP_MAX_LEN = 64 * 1024;
export const ICE_CANDIDATE_MAX_LEN = 1024;
export const ICE_MID_MAX_LEN = 16;

export const WebRtcOfferMessageSchema = z
  .object({
    type: z.literal('webrtc_offer'),
    sdp: z.string().min(1).max(SDP_MAX_LEN),
  })
  .strict();

export const WebRtcAnswerMessageSchema = z
  .object({
    type: z.literal('webrtc_answer'),
    sdp: z.string().min(1).max(SDP_MAX_LEN),
  })
  .strict();

export const WebRtcIceMessageSchema = z
  .object({
    type: z.literal('webrtc_ice'),
    candidate: z.string().min(1).max(ICE_CANDIDATE_MAX_LEN),
    mid: z.string().max(ICE_MID_MAX_LEN),
  })
  .strict();

/**
 * Client sends this when it has given up on the DataChannel handshake (5 s
 * connect deadline elapsed without `dc-open`, ICE failed, etc.) and is
 * declaring fallback to WebSocket. Server cleans up its entry + replies
 * with `webrtc_fallback_ack` so the client knows the server has stopped
 * trying to route through DC. Hostile review #9.
 */
export const WebRtcFallbackMessageSchema = z
  .object({
    type: z.literal('webrtc_fallback'),
    reason: z.string().max(64).optional(),
  })
  .strict();

export const WebRtcFallbackAckMessageSchema = z
  .object({
    type: z.literal('webrtc_fallback_ack'),
  })
  .strict();

export type WebRtcOfferMessage = z.infer<typeof WebRtcOfferMessageSchema>;
export type WebRtcAnswerMessage = z.infer<typeof WebRtcAnswerMessageSchema>;
export type WebRtcIceMessage = z.infer<typeof WebRtcIceMessageSchema>;
export type WebRtcFallbackMessage = z.infer<typeof WebRtcFallbackMessageSchema>;
export type WebRtcFallbackAckMessage = z.infer<typeof WebRtcFallbackAckMessageSchema>;
