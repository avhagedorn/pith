// Terminal escape sequences by name. No other file spells out a raw escape code.
const sgr = (...codes: number[]) => `\x1b[${codes.join(';')}m`;

export const RESET = sgr(0);
export const BOLD = sgr(1);
export const DIM = sgr(2);
export const ITALIC = sgr(3);
export const UNDERLINE = sgr(4);
export const STRIKE = sgr(9);
export const BOLD_ITALIC = sgr(1, 3);

// Each END_ code closes one style and leaves the others on. 22 closes both bold and dim.
export const END_WEIGHT = sgr(22);
export const END_ITALIC = sgr(23);
export const END_BOLD_ITALIC = sgr(22, 23);
export const END_UNDERLINE = sgr(24);
export const END_STRIKE = sgr(29);
export const END_COLOR = sgr(39);

export const RED = sgr(31);
export const GREEN = sgr(32);
export const CYAN = sgr(36);
export const BOLD_YELLOW = sgr(1, 33);
export const BOLD_CYAN = sgr(1, 36);

export const CLEAR_LINE = '\r\x1b[K';
export const CURSOR_UP = '\x1b[1A';
export const HIDE_CURSOR = '\x1b[?25l';
export const SHOW_CURSOR = '\x1b[?25h';
