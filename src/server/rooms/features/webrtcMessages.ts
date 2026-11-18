/**
 * Phase 1 swift-otter — WebRTC signalling: `webrtc_offer`, `webrtc_ice`,
 * `webrtc_fallback`, routed to the room's `WebRtcChannelManager`
 * (`src/server/transport/webrtcChannel.ts`, null when WebRTC is off).
 *
 * Client is the offerer; server is the answerer. Drop silently on schema
 * failure per the validation contract (the malformed tracker samples its
 * warn, so a malicious client can't flood the log). The manager handles
 * out-of-order ICE (counts iceDroppedBeforeOffer if a candidate arrives
 * before the offer). Moved verbatim out of `SectorRoom.onCreate`.
 */
import { serverLogEvent } from '../../debug/ServerEventLog.js';
import type { WebRtcChannelManager } from '../../transport/webrtcChannel.js';
import { parsedMessage, type ParsedMessageHost, type RoomFeature } from './parsedMessage.js';
import {
  WebRtcFallbackMessageSchema,
  WebRtcIceMessageSchema,
  WebRtcOfferMessageSchema,
} from '../../../shared-types/messages/webrtcSignalingMessages.js';

/** What the signalling handlers need from the room; getters read the live field. */
export interface WebRtcMessageHost extends ParsedMessageHost {
  webrtcChannelManager(): Pick<WebRtcChannelManager, 'handleOffer' | 'handleIce' | 'cleanup'> | null;
}

export function registerWebRtcMessages(h: WebRtcMessageHost): RoomFeature {
  parsedMessage(h, 'webrtc_offer', WebRtcOfferMessageSchema, (msg, client) => {
    h.webrtcChannelManager()?.handleOffer(client.sessionId, msg.sdp);
  });
  parsedMessage(h, 'webrtc_ice', WebRtcIceMessageSchema, (msg, client) => {
    h.webrtcChannelManager()?.handleIce(
      client.sessionId,
      msg.candidate,
      msg.mid,
    );
  });
  // Hostile #9 — client declares fallback explicitly. We clean up the
  // PC immediately (no waiting for ICE-deadline expiry) and ACK so the
  // client knows it can stop sending signaling.
  parsedMessage(h, 'webrtc_fallback', WebRtcFallbackMessageSchema, (msg, client) => {
    serverLogEvent('webrtc_client_fallback', {
      sessionId: client.sessionId,
      reason: msg.reason ?? 'unspecified',
    });
    h.webrtcChannelManager()?.cleanup(client.sessionId);
    client.send('webrtc_fallback_ack', { type: 'webrtc_fallback_ack' });
  });
  return {};
}
