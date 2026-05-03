import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import Alert from '@mui/material/Alert';
import { useAuthStore } from '../auth/authStore.js';
import { apiLogin, apiRegister } from '../auth/authApi.js';

interface Props {
  onSuccess: () => void;
  onSkip?: () => void;
}

export function LoginPage({ onSuccess, onSkip }: Props) {
  const { setAuth } = useAuthStore();
  const [tab, setTab] = useState(0);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (tab === 0) {
        const { token, user } = await apiLogin(email, password);
        setAuth(token, user);
        onSuccess();
      } else {
        const { token, user } = await apiRegister(
          email, password, confirmPassword,
          displayName.trim() || undefined,
        );
        setAuth(token, user);
        onSuccess();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pt: '48px',
        background: '#05070f',
      }}
    >
      <Card sx={{ width: '100%', maxWidth: 400, mx: 2 }}>
        <CardContent sx={{ p: 3 }}>
          <Tabs value={tab} onChange={(_, v) => { setTab(v as number); setError(null); }} sx={{ mb: 3 }}>
            <Tab label="Sign In" />
            <Tab label="Create Account" />
          </Tabs>

          <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}

            <TextField
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              fullWidth
              size="small"
              autoComplete="email"
            />
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              fullWidth
              size="small"
              inputProps={{ minLength: tab === 1 ? 8 : undefined }}
              autoComplete={tab === 0 ? 'current-password' : 'new-password'}
            />

            {tab === 1 && (
              <>
                <TextField
                  label="Confirm password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  fullWidth
                  size="small"
                  autoComplete="new-password"
                />
                <TextField
                  label="Display name (optional)"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  fullWidth
                  size="small"
                  inputProps={{ maxLength: 32 }}
                />
              </>
            )}

            <Button
              type="submit"
              variant="contained"
              disabled={loading}
              fullWidth
              sx={{ mt: 1 }}
            >
              {loading ? 'Please wait…' : tab === 0 ? 'Sign In' : 'Create Account'}
            </Button>

            <Divider sx={{ my: 1 }}>
              <Typography variant="caption" color="text.secondary">or</Typography>
            </Divider>

            <Button
              variant="outlined"
              fullWidth
              onClick={() => { window.location.href = '/auth/google'; }}
            >
              Continue with Google
            </Button>

            {onSkip && (
              <Button size="small" color="inherit" sx={{ opacity: 0.45, mt: 1 }} onClick={onSkip}>
                Continue as guest
              </Button>
            )}
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
