#!/usr/bin/env node
// Dev helper: send a test "base under attack" push to every subscription of a
// user, without staging a real siege. Requires the same VAPID keys the server
// uses (EQX_VAPID_PUBLIC_KEY + EQX_VAPID_PRIVATE_KEY) in the environment.
//
//   node scripts/send-test-push.mjs <userId> [dbPath]
//
// See docs/architecture/web-push.md.
import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import webpush from 'web-push';

const userId = process.argv[2];
const dbPath = process.argv[3] ?? process.env.DB_PATH ?? './eqx.db';

if (!userId) {
  console.error('usage: node scripts/send-test-push.mjs <userId> [dbPath]');
  process.exit(1);
}

const pub = process.env.EQX_VAPID_PUBLIC_KEY;
const priv = process.env.EQX_VAPID_PRIVATE_KEY;
const subject = process.env.EQX_VAPID_SUBJECT ?? 'mailto:admin@eqx-peri.local';
if (!pub || !priv) {
  console.error('EQX_VAPID_PUBLIC_KEY + EQX_VAPID_PRIVATE_KEY must be set (npx web-push generate-vapid-keys).');
  process.exit(1);
}
webpush.setVapidDetails(subject, pub, priv);

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db
  .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
  .all(userId);

if (rows.length === 0) {
  console.error(`No push subscriptions for user ${userId} in ${dbPath}.`);
  process.exit(2);
}

const payload = JSON.stringify({
  type: 'structure_attacked',
  title: 'Base under attack',
  body: 'Test alert — your capital is under attack in sol-prime.',
  tag: 'base-attack:test',
});

let ok = 0;
for (const r of rows) {
  try {
    await webpush.sendNotification(
      { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
      payload,
    );
    ok++;
    console.log('sent →', String(r.endpoint).slice(0, 60) + '…');
  } catch (err) {
    console.error('FAILED', err?.statusCode ?? '', String(r.endpoint).slice(0, 60) + '…');
  }
}
console.log(`Done: ${ok}/${rows.length} sent.`);
db.close();
