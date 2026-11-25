/**
 * Moved: the game's window frame is now the catalogue's EqxWindow
 * (src/ui/EqxWindow). This path re-exports it (as GameWindow), its parts and
 * the open notifier, so every existing caller keeps working unchanged.
 */
export { EqxWindow as GameWindow, type EqxWindowProps as GameWindowProps } from '../../ui/EqxWindow/EqxWindow.js';
export * from '../../ui/EqxWindow/windowParts.js';
export { onGameWindowOpen, notifyGameWindowOpen } from '../../ui/EqxWindow/windowOpen.js';
