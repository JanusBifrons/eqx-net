/** Styles shared by the Factions and Ship look drawer tabs. */
export const TITLE_SX = { fontSize: 13, fontWeight: 700, color: '#dffff0', mb: 0.75 } as const;
export const SECTION_SX = { fontSize: 10, color: '#9aa0b4', textTransform: 'uppercase', letterSpacing: 0.6, mt: 1, mb: 0.5 } as const;
export const DETAIL_SX = { fontSize: 10, color: '#9aa0b4' } as const;
export const POLICY_LABEL_SX = { flex: 1, fontSize: 10, color: '#c8cde0' } as const;

export function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}
