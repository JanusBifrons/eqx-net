/**
 * EqxTable paging (pure): which slice of `count` rows page `page` shows.
 * The page is clamped into range, so a list that shrank under a later page
 * shows its last page rather than nothing.
 */
export interface EqxTablePageWindow {
  /** The page shown, 0-based, clamped to [0, pages − 1]. */
  page: number;
  /** Page count, at least 1 (an empty list is one empty page). */
  pages: number;
  /** Row slice [start, end). */
  start: number;
  end: number;
}

export function tablePageWindow(count: number, page: number, size: number): EqxTablePageWindow {
  const per = size >= 1 ? Math.floor(size) : 1;
  const n = count > 0 ? Math.floor(count) : 0;
  const pages = Math.max(1, Math.ceil(n / per));
  const p = Math.min(pages - 1, Math.max(0, Math.floor(page) || 0));
  const start = p * per;
  return { page: p, pages, start, end: Math.min(n, start + per) };
}

/** A pager slot: a page (0-based) or a gap mark (pages left out). */
export type EqxTablePageSlot = number | 'gap-start' | 'gap-end';

/** Most slots the pager shows (fits a ~330 px phone panel between the arrows). */
export const TABLE_PAGER_SLOTS = 7;

/**
 * The numbered buttons between the pager's arrows. Every page when they fit
 * in 7 slots; otherwise the first, the last, the current page and its
 * neighbours, with a gap mark for each run left out (1 … 4 5 6 … 12). Near an
 * end the window fills toward it (1 2 3 4 5 … 12), so there are always 7 slots
 * and the pager never changes width as you page.
 */
export function tablePageList(page: number, pages: number): EqxTablePageSlot[] {
  const n = pages >= 1 ? Math.floor(pages) : 1;
  const p = Math.min(n - 1, Math.max(0, Math.floor(page) || 0));
  if (n <= TABLE_PAGER_SLOTS) return Array.from({ length: n }, (_, i) => i);
  const last = n - 1;
  // First + gap + 3 middle + gap + last = 7; at an end the middle grows to 5.
  if (p <= 3) return [0, 1, 2, 3, 4, 'gap-end', last];
  if (p >= last - 3) return [0, 'gap-start', last - 4, last - 3, last - 2, last - 1, last];
  return [0, 'gap-start', p - 1, p, p + 1, 'gap-end', last];
}
