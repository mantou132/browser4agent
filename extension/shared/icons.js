import { extendIcons, genIcon } from 'duoyun-ui/lib/icons';

/** Extend duoyun-ui's global icon store with app-specific icons; the
 * returned store still carries every built-in icon. */
export const icons = extendIcons({
  send: genIcon('M5 11h10.17l-4.59-4.59L12 5l7 7-7 7-1.41-1.41L15.17 13H5v-2z'),
  stop: genIcon('M7 7h10v10H7z'),
  file: genIcon(
    'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
  ),
  edit: genIcon(
    'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  ),
  // Material "playlist_add", used when a send will be staged into the queue
  queueAdd: genIcon('M14 10H2v2h12v-2zm0-4H2v2h12V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4z'),
  // Material "smart_toy", the common agent/AI-assistant mark
  robot: genIcon(
    'M20,9V7c0-1.1-0.9-2-2-2h-3c0-1.66-1.34-3-3-3S9,3.34,9,5H6C4.9,5,4,5.9,4,7v2c-1.66,0-3,1.34-3,3c0,1.66,1.34,3,3,3v4 c0,1.1,0.9,2,2,2h12c1.1,0,2-0.9,2-2v-4c1.66,0,3-1.34,3-3C23,10.34,21.66,9,20,9z M7.5,11.5C7.5,10.67,8.17,10,9,10 s1.5,0.67,1.5,1.5S9.83,13,9,13S7.5,12.33,7.5,11.5z M16,17H8v-2h8V17z M15,13c-0.83,0-1.5-0.67-1.5-1.5S14.17,10,15,10 s1.5,0.67,1.5,1.5S15.83,13,15,13z',
  ),
});
