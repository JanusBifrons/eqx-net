/**
 * Production node-datachannel PeerConnection factory.
 *
 * Isolated from `webrtcChannel.ts` so the manager module + its unit
 * tests don't pay the native-binding init cost — vitest pool workers
 * that import the manager (e.g. SnapshotBroadcaster routing test) get
 * a binding-free import graph.
 *
 * Plan: swift-otter (Phase 1).
 */

import ndc from 'node-datachannel';
import type {
  PeerConnectionFactory,
  WebRtcDataChannel,
  WebRtcPeerConnection,
} from './webrtcChannel.js';

export interface NodeDataChannelFactoryOptions {
  /**
   * STUN / TURN URLs. Phase 0 LAN spike showed an empty list works for
   * loopback (host-candidate-only path); production over open internet
   * benefits from at least one STUN URL for NAT traversal. Default:
   * `['stun:stun.l.google.com:19302']` — the standard freebie.
   */
  iceServers?: string[];
}

export function nodeDataChannelPeerConnectionFactory(
  opts: NodeDataChannelFactoryOptions = {},
): PeerConnectionFactory {
  return (sessionId: string): WebRtcPeerConnection => {
    const pc = new ndc.PeerConnection(sessionId, {
      iceServers: opts.iceServers ?? [],
    });

    const wrapper: WebRtcPeerConnection = {
      setRemoteDescription: (sdp, type) => pc.setRemoteDescription(sdp, type),
      addRemoteCandidate: (candidate, mid) => pc.addRemoteCandidate(candidate, mid),
      close: () => pc.close(),
      onLocalDescription: (cb) => pc.onLocalDescription((sdp, type) => cb(sdp, type as string)),
      onLocalCandidate: (cb) => pc.onLocalCandidate((cand, mid) => cb(cand, mid)),
      onDataChannel: (cb) => pc.onDataChannel((dc) => {
        const dcWrapper: WebRtcDataChannel = {
          isOpen: () => dc.isOpen(),
          bufferedAmount: () => dc.bufferedAmount(),
          sendMessageBinary: (buf) => dc.sendMessageBinary(buf),
          onOpen: (fn) => dc.onOpen(fn),
          onClosed: (fn) => dc.onClosed(fn),
          onError: (fn) =>
            dc.onError((err: unknown) =>
              fn(err instanceof Error ? err : new Error(String(err))),
            ),
          close: () => dc.close(),
        };
        cb(dcWrapper);
      }),
      onStateChange: (cb) => pc.onStateChange((state) => cb(state as string)),
    };
    return wrapper;
  };
}
