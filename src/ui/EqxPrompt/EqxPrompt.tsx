/**
 * EqxPrompt: the top-centre answer-me prompt and short toast (plan A6). A
 * small card: a message, optional answer buttons (EqxButton), a tone colour.
 * - `actions` are the answers (Pay / Decline / Cancel); a tap calls `onPick`.
 *   `inline` puts them beside the message (a one-line chip) instead of under it.
 * - `onTap` makes the whole card a button (a toast that opens its panel);
 *   ignored when `actions` are given (no button inside a button).
 * - `timeoutMs` + `onTimeout`: called once after that long without an answer.
 *   The timer starts when the prompt mounts; give the prompt a new React `key`
 *   to restart it (a new offer).
 * - A prompt with no actions and no `onTap` is a readout: it takes no taps.
 * - `dim` fades it (an all-clear readout). `dataAttrs` adds `data-*`
 *   attributes for tests; they win over the card's own `data-tone`.
 * - Does not position itself: it lives in the `top-center-prompt` Slot.
 * `EqxPromptStack` stacks several prompts (a column, centred).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Box } from '@mui/material';
import { HUD } from '../../client/hud/tokens.js';
import { EqxButton, type EqxTone } from '../EqxButton/EqxButton.js';

/** info = cyan, warn = amber, danger = red, good = green, gold = credits gold, plain = ink. */
export type EqxPromptTone = 'info' | 'warn' | 'danger' | 'good' | 'gold' | 'plain';

/** Tone -> token colour (edge and text). */
export const PROMPT_TONE_COLOR: Readonly<Record<EqxPromptTone, string>> = {
  info: HUD.color.auto,
  warn: HUD.color.manual,
  danger: HUD.color.danger,
  good: HUD.color.hullOk,
  gold: HUD.color.credits,
  plain: HUD.color.ink,
};

export interface EqxPromptAction {
  /** The button text ("Pay"). Also its accessible name. */
  label: string;
  onPick: () => void;
  /** Default `secondary`. */
  tone?: EqxTone;
  'data-testid'?: string;
}

export interface EqxPromptProps {
  message: ReactNode;
  /** Default `plain`. */
  tone?: EqxPromptTone;
  actions?: readonly EqxPromptAction[];
  /** Buttons beside the message (a chip) instead of under it. */
  inline?: boolean;
  /** The whole card is a button (ignored with `actions`). */
  onTap?: () => void;
  /** Called once after this long unanswered (needs `onTimeout`). */
  timeoutMs?: number;
  onTimeout?: () => void;
  /** Faded (an all-clear readout). */
  dim?: boolean;
  /** Extra `data-*` attributes (keys without the `data-` prefix). */
  dataAttrs?: Readonly<Record<string, string | number>>;
  'data-testid'?: string;
}

const P = HUD.prompt;

const CARD_SX = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: `${P.gap}px`,
  m: 0,
  px: `${P.padX}px`,
  py: `${P.padY}px`,
  maxWidth: P.maxW,
  bgcolor: P.bg,
  border: '1px solid',
  borderRadius: `${P.radius}px`,
  fontFamily: HUD.font.label,
  fontSize: P.font,
  fontWeight: 600,
  lineHeight: 1.3,
  textAlign: 'center',
} as const;
const INLINE_SX = { flexDirection: 'row' } as const;
const TAP_SX = { cursor: 'pointer', pointerEvents: 'auto', '&:focus-visible': { outline: `1px solid ${HUD.color.auto}`, outlineOffset: 1 } } as const;
const ANSWER_SX = { pointerEvents: 'auto' } as const;
const READOUT_SX = { pointerEvents: 'none' } as const;
const DIM_SX = { opacity: P.dimOpacity } as const;
const ACTIONS_SX = { display: 'flex', gap: `${P.gap}px`, justifyContent: 'center', flexWrap: 'wrap' } as const;
const STACK_SX = { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: `${P.stackGap}px` } as const;

/** `{ a: 1 }` -> `{ 'data-a': 1 }`. */
export function promptDataProps(attrs: EqxPromptProps['dataAttrs']): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (attrs === undefined) return out;
  for (const k of Object.keys(attrs)) out[`data-${k}`] = attrs[k]!;
  return out;
}

export function EqxPrompt({
  message, tone = 'plain', actions, inline = false, onTap, timeoutMs, onTimeout, dim = false, dataAttrs, 'data-testid': testId,
}: EqxPromptProps) {
  const timeoutRef = useRef(onTimeout);
  timeoutRef.current = onTimeout;
  useEffect(() => {
    if (timeoutMs === undefined) return undefined;
    const t = setTimeout(() => timeoutRef.current?.(), timeoutMs);
    return () => clearTimeout(t);
  }, [timeoutMs]);

  const color = PROMPT_TONE_COLOR[tone];
  const hasActions = actions !== undefined && actions.length > 0;
  const tappable = !hasActions && onTap !== undefined;
  const sx = [
    CARD_SX,
    { color, borderColor: color },
    inline && INLINE_SX,
    tappable ? TAP_SX : hasActions ? ANSWER_SX : READOUT_SX,
    dim && DIM_SX,
  ];
  const data = { 'data-testid': testId, 'data-tone': tone, ...promptDataProps(dataAttrs) };
  const body = (
    <>
      <Box component="span">{message}</Box>
      {hasActions && (
        <Box component="span" sx={ACTIONS_SX}>
          {actions.map((a) => (
            <EqxButton key={a.label} tone={a.tone} onClick={a.onPick} data-testid={a['data-testid']}>{a.label}</EqxButton>
          ))}
        </Box>
      )}
    </>
  );
  if (tappable) {
    return <Box component="button" type="button" sx={sx} onClick={onTap} {...data}>{body}</Box>;
  }
  return <Box role={hasActions ? undefined : 'status'} sx={sx} {...data}>{body}</Box>;
}

export interface EqxPromptStackProps {
  children?: ReactNode;
  dataAttrs?: Readonly<Record<string, string | number>>;
  'data-testid'?: string;
}

/** A centred column of prompts (always renders its box, even empty). */
export function EqxPromptStack({ children, dataAttrs, 'data-testid': testId }: EqxPromptStackProps) {
  return <Box sx={STACK_SX} data-testid={testId} {...promptDataProps(dataAttrs)}>{children}</Box>;
}
