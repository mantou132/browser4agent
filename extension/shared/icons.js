import { extendIcons, genIcon } from 'duoyun-ui/lib/icons';

/** Extend duoyun-ui's global icon store with app-specific icons; the
 * returned store still carries every built-in icon. */
export const icons = extendIcons({
  send: genIcon('M5 11h10.17l-4.59-4.59L12 5l7 7-7 7-1.41-1.41L15.17 13H5v-2z'),
  stop: genIcon('M7 7h10v10H7z'),
  file: genIcon(
    'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
  ),
});
