// Headless Colyseus joiner used to drive the server tick so we can read
// per-phase tick_budget telemetry from /dev/events without a real client.
import { Client } from 'colyseus.js';

const url = process.env.URL || 'ws://localhost:2570';
const room = process.env.ROOM || 'sector';
const holdMs = Number(process.env.HOLD_MS || 12000);

const client = new Client(url);
console.log(`joining ${room} on ${url}…`);
const joinedRoom = await client.joinOrCreate(room, { droneCount: 30 });
console.log('joined room:', joinedRoom.roomId, 'sessionId:', joinedRoom.sessionId);

joinedRoom.onMessage('welcome', (m) => console.log('welcome:', m.serverTick, m.playerId));

await new Promise((r) => setTimeout(r, holdMs));
console.log(`held for ${holdMs}ms, leaving`);
await joinedRoom.leave();
process.exit(0);
