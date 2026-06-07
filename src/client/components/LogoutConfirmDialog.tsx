import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';

interface Props {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /**
   * Overridable so two instances (drawer Profile tab + header/mobile avatar
   * menu) never collide on the same `data-testid` in the DOM. Defaults match
   * the original `ProfileTab` dialog so its existing E2E assertions are
   * untouched.
   */
  dialogTestId?: string;
  confirmTestId?: string;
}

/**
 * Shared "Log out?" confirm dialog. The single confirm surface behind every
 * logout entry point — see `useLogout` for the action it guards.
 */
export function LogoutConfirmDialog({
  open,
  onCancel,
  onConfirm,
  dialogTestId = 'logout-confirm-dialog',
  confirmTestId = 'logout-confirm-button',
}: Props): JSX.Element {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" data-testid={dialogTestId}>
      <DialogTitle>Log out of EQX Peri?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Your session will end and you&rsquo;ll return to the main menu.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          variant="contained"
          color="error"
          onClick={onConfirm}
          data-testid={confirmTestId}
          autoFocus
        >
          Log out
        </Button>
      </DialogActions>
    </Dialog>
  );
}
