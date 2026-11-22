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
