import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { captureDiagnostic } from '../debug/diagCapture';
import { getGameClient } from '../net/clientSingleton';

/**
 * Catch-all error surface for the client. Three sources feed it:
 *
 *   1. **React render / lifecycle errors** — caught by the `ErrorBoundary`
 *      class component, which wraps the entire app tree.
 *   2. **Uncaught JS exceptions** — `window.onerror`.
 *   3. **Unhandled promise rejections** — `window.onunhandledrejection`.
 *
 * All three funnel into a single module-level subscription registry so the
 * overlay component can subscribe and rerender. The overlay sits at the top
 * of the z-index stack and will appear over a black-screen failure mode,
 * showing the message + stack so the user can copy/paste it instead of
 * digging through dev-tools.
 *
 * Intentionally independent of Zustand — the overlay must keep working even
 * if the store throws during init.
 */

interface CapturedError {
  source: 'react' | 'window-error' | 'unhandled-rejection';
  message: string;
  stack: string;
  componentStack?: string;
  capturedAt: number;
}

type Listener = (errors: readonly CapturedError[]) => void;

const errors: CapturedError[] = [];
const listeners = new Set<Listener>();
const MAX = 8;

function pushError(err: CapturedError): void {
  errors.unshift(err);
  if (errors.length > MAX) errors.length = MAX;
  for (const l of listeners) l(errors);
}

function clearErrors(): void {
  errors.length = 0;
  for (const l of listeners) l(errors);
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  l(errors);
  return () => { listeners.delete(l); };
}

let installed = false;
function installWindowHandlers(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (event) => {
    const err = event.error instanceof Error ? event.error : new Error(event.message);
    pushError({
      source: 'window-error',
      message: err.message,
      stack: err.stack ?? '(no stack)',
      capturedAt: Date.now(),
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const err = reason instanceof Error ? reason : new Error(String(reason));
    pushError({
      source: 'unhandled-rejection',
      message: err.message,
      stack: err.stack ?? String(reason),
      capturedAt: Date.now(),
    });
  });
}

interface ErrorBoundaryProps {
  children: ReactNode;
}
interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    pushError({
      source: 'react',
      message: error.message,
      stack: error.stack ?? '(no stack)',
      componentStack: info.componentStack ?? undefined,
      capturedAt: Date.now(),
    });
  }

  reset = (): void => {
    clearErrors();
    this.setState({ hasError: false });
  };

  override render(): ReactNode {
    // Always render children; the overlay renders ABOVE them. That way a
    // recoverable React error (where children mount fine after a retry)
    // doesn't blank the screen — the user can dismiss the overlay and
    // keep playing if the underlying state is still consistent.
    if (this.state.hasError) {
      return (
        <>
          {/* Render the children inside a try-catch shell. If they throw
           *  again immediately, the boundary will re-fire and stay shown. */}
          <ChildrenShell>{this.props.children}</ChildrenShell>
          <ErrorOverlay onReset={this.reset} />
        </>
      );
    }
    return (
      <>
        {this.props.children}
        <ErrorOverlay />
      </>
    );
  }
}

function ChildrenShell({ children }: { children: ReactNode }): JSX.Element {
  // Best-effort re-render of children after a caught error. If they throw
  // again the boundary catches it; if they render OK, the user sees the
  // overlay over the recovered tree.
  return <>{children}</>;
}

function ErrorOverlay({ onReset }: { onReset?: () => void }): JSX.Element | null {
  const [list, setList] = useState<readonly CapturedError[]>(errors);
  const [sendStatus, setSendStatus] = useState<
    | { state: 'idle' }
    | { state: 'sending' }
    | { state: 'sent'; dir: string }
    | { state: 'failed'; error: string }
  >({ state: 'idle' });

  useEffect(() => {
    installWindowHandlers();
    return subscribe(setList);
  }, []);

  if (list.length === 0) return null;

  const sendErrors = async (): Promise<void> => {
    setSendStatus({ state: 'sending' });
    // Pack the captured errors into a structured note. The diag/capture
    // endpoint writes one capture directory containing the client's log
    // ring buffer + stats + UA + this note — so the server-side capture
    // dir has every piece needed to root-cause a black-screen failure.
    const note = JSON.stringify(
      {
        kind: 'client-error-overlay',
        capturedAt: Date.now(),
        userAgent: navigator.userAgent,
        url: window.location.href,
        errors: list.map((e) => ({
          source: e.source,
          message: e.message,
          stack: e.stack,
          componentStack: e.componentStack,
          capturedAt: e.capturedAt,
        })),
      },
      null,
      2,
    );
    const stats = getGameClient()?.stats as Record<string, unknown> | undefined;
    const result = await captureDiagnostic(stats !== undefined ? { note, stats } : { note });
    if (result.ok) {
      setSendStatus({ state: 'sent', dir: result.dir ?? result.filename ?? '(unknown)' });
    } else {
      setSendStatus({ state: 'failed', error: result.error ?? 'unknown error' });
    }
  };

  return (
    <Box
      data-testid="error-overlay"
      sx={{
        position: 'fixed',
        top: 0,
        right: 0,
        maxWidth: 'min(640px, 90vw)',
        maxHeight: '90vh',
        overflow: 'auto',
        zIndex: 2147483647, // top of everything; survives a black-screen fail
        bgcolor: 'rgba(60, 0, 0, 0.92)',
        border: '2px solid #ff4444',
        color: '#ffeeee',
        fontFamily: 'monospace',
        fontSize: 12,
        p: 2,
        m: 1,
        borderRadius: 1,
        boxShadow: '0 0 24px rgba(255,68,68,0.5)',
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1, gap: 1 }}>
        <Typography sx={{ color: '#ff8888', fontWeight: 700, letterSpacing: 1, flex: 1, minWidth: 0 }}>
          {list.length} ERROR{list.length === 1 ? '' : 'S'} CAPTURED
        </Typography>
        <Button
          size="small"
          variant="contained"
          onClick={() => { void sendErrors(); }}
          disabled={sendStatus.state === 'sending'}
          sx={{
            bgcolor: '#ff8800',
            color: '#000',
            fontWeight: 700,
            minWidth: 0,
            px: 1.25,
            '&:hover': { bgcolor: '#ffaa33' },
            '&.Mui-disabled': { bgcolor: 'rgba(255,136,0,0.4)', color: '#000' },
          }}
          data-testid="error-overlay-send"
        >
          {sendStatus.state === 'sending' ? 'Sending…' : 'Send'}
        </Button>
        <Button
          size="small"
          variant="outlined"
          onClick={() => {
            if (onReset) onReset();
            else clearErrors();
            setSendStatus({ state: 'idle' });
          }}
          sx={{ color: '#ffeeee', borderColor: '#ff8888', minWidth: 0, px: 1 }}
          data-testid="error-overlay-dismiss"
        >
          Dismiss
        </Button>
      </Box>
      {sendStatus.state === 'sent' && (
        <Box
          data-testid="error-overlay-send-result"
          sx={{
            mb: 1,
            p: 1,
            bgcolor: 'rgba(0,200,0,0.12)',
            border: '1px solid #66cc66',
            color: '#cfc',
            fontSize: 11,
            wordBreak: 'break-all',
          }}
        >
          Sent → diag/captures/{sendStatus.dir}
        </Box>
      )}
      {sendStatus.state === 'failed' && (
        <Box
          sx={{
            mb: 1,
            p: 1,
            bgcolor: 'rgba(255,255,0,0.12)',
            border: '1px solid #cc8800',
            color: '#ffcc88',
            fontSize: 11,
            wordBreak: 'break-all',
          }}
        >
          Send failed: {sendStatus.error}
        </Box>
      )}
      {list.map((e, i) => (
        <Box
          key={`${e.capturedAt}-${i}`}
          sx={{
            mb: 1.5,
            pb: 1.5,
            borderBottom: i < list.length - 1 ? '1px solid rgba(255,136,136,0.3)' : 'none',
          }}
        >
          <Typography component="div" sx={{ color: '#ffaaaa', fontSize: 11, mb: 0.5 }}>
            [{e.source}] {new Date(e.capturedAt).toLocaleTimeString()}
          </Typography>
          <Typography
            component="div"
            sx={{ color: '#fff', fontWeight: 700, fontSize: 13, mb: 0.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
          >
            {e.message}
          </Typography>
          <Box
            component="pre"
            sx={{
              m: 0,
              fontSize: 10,
              color: '#ffcccc',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 240,
              overflow: 'auto',
            }}
          >
            {e.stack}
          </Box>
          {e.componentStack && (
            <Box
              component="pre"
              sx={{
                m: 0,
                mt: 1,
                fontSize: 10,
                color: '#ddaaaa',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 160,
                overflow: 'auto',
              }}
            >
              {e.componentStack}
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}
