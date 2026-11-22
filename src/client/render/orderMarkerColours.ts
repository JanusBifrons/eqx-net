/**
 * The move-order marker colour: the green `FleetOverlay` draws at a move order
 * (the ring that flashes where you tap / right-click, and the order line to
 * the destination dot). The left strip's Move button wears the same green so
 * the button and the mark it makes read as one thing. No Pixi, no React: the
 * worker renderer and the React strip both import it.
 */
export const MOVE_ORDER_COLOUR_HEX = '#7dff9a';
export const MOVE_ORDER_COLOUR: number = parseInt(MOVE_ORDER_COLOUR_HEX.slice(1), 16);
