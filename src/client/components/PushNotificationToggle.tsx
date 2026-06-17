import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Typography from '@mui/material/Typography';
import { loadToken } from '../auth/tokenStorage.js';
import {
  detectPushEnvironment,
  shouldOfferPushToggle,
  getPushSubscribed,
  subscribeToPush,
  unsubscribeFromPush,
  type SubscribeReason,
} from '../push/pushClient.js';

function reasonText(reason: SubscribeReason): string {
  switch (reason) {
    case 'denied':
      return 'Notifications were blocked in your browser settings.';
    case 'no-sw':
      return 'Install the app to enable alerts.';
    case 'server-disabled':
      return 'Notifications are not configured on the server yet.';
    case 'server-rejected':
      return 'Could not register for alerts. Try again.';
    default:
      return '';
  }
}

/**
 * "Alert me when my base is under attack" — the Web Push opt-in. Shared by the
 * desktop SettingsModal and the mobile drawer Settings tab. On iOS-not-installed
 * it shows the Add-to-Home-Screen hint (push only works in an installed PWA);
 * on unsupported browsers it renders nothing.
 */
export function PushNotificationToggle(): JSX.Element | null {
  const [env] = useState(detectPushEnvironment);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getPushSubscribed().then((s) => {
      if (alive) setSubscribed(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!env.supported) return null;

  // iOS Safari (not installed): push can't work in a tab — guide to install.
  if (env.isIos && !env.isStandalone) {
    return (
      <Box data-testid="push-ios-install-hint">
        <Typography variant="body2">Base-attack alerts</Typography>
        <Typography variant="caption" color="text.secondary">
          On iPhone/iPad, tap Share → “Add to Home Screen”, then open the app from your home
          screen to enable notifications.
        </Typography>
      </Box>
    );
  }

  if (!shouldOfferPushToggle(env)) return null;

  const onChange = async (next: boolean): Promise<void> => {
    setBusy(true);
    setStatus(null);
    const token = loadToken();
    if (!token) {
      setStatus('Log in to enable alerts.');
      setBusy(false);
      return;
    }
    try {
      if (next) {
        const r = await subscribeToPush(token);
        if (r.ok) setSubscribed(true);
        else setStatus(reasonText(r.reason));
      } else {
        await unsubscribeFromPush(token);
        setSubscribed(false);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <FormControlLabel
        control={
          <Switch
            checked={subscribed}
            disabled={busy}
            onChange={(e) => void onChange(e.target.checked)}
            inputProps={
              {
                'aria-label': 'Alert me when my base is under attack',
                'data-testid': 'push-toggle',
              } as React.InputHTMLAttributes<HTMLInputElement>
            }
          />
        }
        label={
          <Box>
            <Typography variant="body2">Base-attack alerts</Typography>
            <Typography variant="caption" color="text.secondary">
              Get a notification when your base is attacked while you&rsquo;re away.
            </Typography>
          </Box>
        }
      />
      {status && (
        <Typography variant="caption" color="text.secondary" data-testid="push-toggle-status" sx={{ display: 'block' }}>
          {status}
        </Typography>
      )}
    </Box>
  );
}
