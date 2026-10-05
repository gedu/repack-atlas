// Startup banner for human `dev` runs (G4, odd/tasks/dev-tui-dashboard.md).
// PURE and stdlib-only: no colorette/chalk (AGENTS.md rule 11 — the SGR
// codes are hand-rolled below), no fs, no process. `dev.ts` decides WHEN to
// print it (human TTY paths only) and supplies the version; this module only
// renders a string.
//
// The glyph is the user-supplied reference artwork — a braille hot-air
// balloon carrying the REPACK lettering, drawn dot-by-dot in braille and
// box-drawing — reproduced verbatim (it is an Atlas-owned asset supplied by
// the maintainer, not copied from any upstream project). Colors follow the
// sanctioned palette: the balloon body and lettering in pink 38;5;213, the
// burner/basket/rope rows at the bottom in Re.Pack green, a bold wordmark
// plus dim tagline under the art.
//
// Row budget: the artwork is 24 rows; with the wordmark and tagline the
// full banner is 26 rows. The test suite locks that budget (and the
// charset + centering contracts); a redraw must keep it honest.
//
// Charset contract (locked by tests): printable ASCII + braille
// (U+2800-U+28FF) only — Ghostty-safe. Box-drawing is allowed by the rule
// but the final drawing does not need it.

/** Narrowest terminal that still gets the art; below this the drawing would
 * wrap into noise, so the renderer falls back to the wordmark + tagline. */
export const BANNER_MIN_COLUMNS = 56;

/**
 * The NO_COLOR convention (no-color.org): color is off only when `NO_COLOR`
 * is present AND non-empty. Shared by every human-path renderer (this banner,
 * the wizard, the busy-port panel) so they cannot drift; the caller passes
 * the env, keeping this module free of `process`.
 */
export function colorAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.NO_COLOR === undefined || env.NO_COLOR === '';
}

// Built without an ESC literal for consistency with app.tsx's mouse
// sequences (the eslint no-control-regex rule is regex-only, but keeping one
// runtime-built ESC constant across the TUI code keeps the idiom uniform).
const ESC = String.fromCharCode(0x1b);

/** Hand-rolled SGR subset (rule 11: no color dependency). Each entry is one
 * complete parameter list — combine styles in a single code, never by
 * concatenating two of them (the second would lose its ESC). */
const SGR = {
  reset: '[0m',
  dim: '[2m',
  green: '[32m',
  /** bold + white — the wordmark. */
  boldWhite: '[1;37m',
  /** 256-color pink/magenta — the reference art's flower color. */
  pink: '[38;5;213m',
} as const;

function paint(codes: string, text: string): string {
  return `${ESC}${codes}${text}${ESC}${SGR.reset}`;
}

/** The reference artwork, 24 rows x 38 cols: a braille hot-air balloon
 * carrying the REPACK lettering, verbatim from the user-supplied asset. The
 * top crown and the basket/rope rows at the bottom are green; the balloon
 * body with the lettering is pink. */
const ART: readonly { text: string; color: keyof typeof SGR }[] = [
  { text: '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣀⣤⣤⣤⣤⣤⣤⣤⣀⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀', color: 'green' },
  { text: '⠀⠀⠀⠀⠀⠀⠀⠀⢀⣠⡴⠾⠿⢭⣥⣄⣀⠀⠀⠀⠀⠀⣜⠋⠛⠳⢦⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀', color: 'pink' },
  { text: '⠀⠀⠀⠀⠀⠀⣠⡴⣟⠋⠀⠀⠀⠀⠀⠈⠉⠛⠷⣤⡀⢰⠂⠀⠀⠀⠀⠈⢝⣷⣤⠀⠀⠀⠀⠀⠀⠀', color: 'pink' },
  { text: '⠀⠀⠀⠀⣠⡾⠋⢀⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⣶⣠⡤⣀⠀⠀⠀⠀⠀⢹⡷⣄⠀⠀⠀⠀⠀', color: 'pink' },
  { text: '⠀⠀⠀⣴⢯⡇⠀⣀⣀⠦⠒⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢷⡄⠉⠚⠴⡄⡀⠀⠘⡇⠙⢷⡀⠀⠀⠀', color: 'pink' },
  { text: '⠀⢀⣾⠃⢘⢗⠞⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠛⠀⠀⠀⠈⠪⡢⡀⠀⢀⡈⢿⣄⠀⠀', color: 'pink' },
  { text: '⠀⣼⢃⡴⠋⠩⣆⠀⠀⠀⡿⠛⠛⠛⠛⠶⢶⣄⠀⣾⠛⢷⣄⠀⠀⣾⠛⢿⡆⠈⠪⣄⠉⠑⢻⡏⢷⡀', color: 'pink' },
  { text: '⢶⣟⠋⠀⠀⠀⠐⠵⠀⠀⡇⠀⣿⠛⠛⢶⡀⢹⡆⣿⠀⣄⠙⣷⡀⣿⠀⢸⡇⠀⠀⠹⣆⠀⢺⣅⢸⡧', color: 'pink' },
  { text: '⣾⢛⡀⠀⠀⠀⠀⠀⠀⠀⡇⠀⠿⠶⠶⠟⢁⣼⠇⣿⠀⣿⣧⡈⠻⣿⠀⢸⡇⠀⠀⠀⢋⡀⢠⡏⠀⣿', color: 'pink' },
  { text: '⣿⡜⣥⠀⠀⠀⠀⠀⠀⠀⡇⠀⣶⠶⣦⠈⢿⡅⠀⣿⠀⣿⠈⢻⣄⠙⠂⢸⡇⠀⠀⠀⠘⢃⡿⢡⠀⣿', color: 'pink' },
  { text: '⣿⠁⠰⣂⠀⠀⢀⠦⠀⠀⣧⣤⣿⠀⠘⣷⣬⣿⡆⣿⣤⣿⠀⠀⠙⢷⣤⣼⡇⠀⠀⠀⢀⣾⡱⢘⢰⡏', color: 'pink' },
  { text: '⢹⡇⠀⠐⡧⣀⠾⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣤⣤⣤⣤⣄⠀⢀⡴⠟⡍⠰⢘⡾⠂', color: 'pink' },
  { text: '⠋⣷⠀⠀⠈⣯⣅⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣼⠏⠀⠈⠀⠀⢹⣷⣿⠁⠀⠀⢀⣾⠁⠀', color: 'pink' },
  { text: '⠀⠸⣧⠀⡸⠇⠈⢊⢆⢄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣾⣁⡶⠛⠋⠛⢷⣄⢹⣿⠀⠀⣰⠟⢹⠈⠀', color: 'pink' },
  { text: '⠀⠀⢙⣧⡻⠀⠀⠈⠀⠈⠸⡇⠶⠀⠀⠀⠀⠀⢀⣀⣀⣈⣿⡧⣤⠀⣤⠂⣿⠛⠑⢠⡿⡏⠰⠈⠀⠀', color: 'pink' },
  { text: '⠀⠀⠀⠈⢷⣄⠀⠀⠀⢠⡳⠀⠀⠀⠀⠀⢀⣴⠟⠉⠉⣽⠛⣧⡶⠶⣤⣴⣿⠀⠘⣾⡅⠀⠀⠀⠀⠀', color: 'pink' },
  { text: '⠀⠀⠀⠀⠀⣿⠳⣴⣎⠊⠆⠀⠀⠀⠀⣀⣼⢃⠀⠁⠀⠹⣦⢸⠈⠀⡌⠁⣽⢀⢀⡿⠁⠀⠀⠀⠀⠀', color: 'pink' },
  { text: '⠀⠀⠀⠀⠀⡙⢦⣌⡙⠻⢦⣄⠀⣠⡿⠋⠘⠘⢠⡀⠀⠀⢙⢷⣤⣠⡶⡞⢡⢰⣾⠃⠃⠀⠀⠀⠀⠀', color: 'pink' },
  { text: '⠀⠀⠀⠀⠀⠀⠀⢈⠻⣆⡇⠉⢳⠏⠇⠃⠀⢀⣼⡇⡄⠄⠀⠀⠀⣠⡧⡄⢛⣼⠃⠀⠀⠀⠀⠀⠀⠀', color: 'pink' },
  { text: '⠀⠀⠀⠀⠀⠀⠀⠸⠀⠹⣆⡀⠰⠈⠂⣠⡴⢿⣉⠻⣧⣙⣁⣠⣴⠿⠤⣷⢛⠁⠀⠀⠀⠀⠀⠀⠀⠀', color: 'green' },
  { text: '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡝⠷⢦⣴⠾⠫⣶⢺⣜⠷⠴⠛⠙⢩⡄⠻⣾⠇⠘⠀⠀⠀⠀⠀⠀⠀⠀⠀', color: 'green' },
  { text: '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⠀⠃⢃⡿⢤⠉⠥⣇⣣⣌⣼⢃⣼⠏⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀', color: 'green' },
  { text: '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢼⣧⣈⠀⠀⠈⠋⢹⣟⣴⠏⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀', color: 'green' },
  { text: '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⠉⠛⠛⠛⠛⠛⠉⠀⠂⠂⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀', color: 'green' },
];

/** Rendered art width (every row padded to it, so centering is stable). */
const ART_WIDTH = Math.max(...ART.map((row) => row.text.length));

const TITLE = 'repack-atlas';
const TAGLINE = 'module federation, made visible';

export interface StartupBannerOptions {
  /** Version to show; an empty/absent version drops the `v<x>` suffix. */
  version?: string;
  /** Terminal columns; below BANNER_MIN_COLUMNS only the text lines print,
   * and nothing at all when even those would wrap. */
  columns: number;
  /** False renders with zero escape bytes (plain streams, captured output). */
  color: boolean;
}

function pad(line: string, width: number): string {
  return line + ' '.repeat(Math.max(0, width - line.length));
}

function centerOf(content: number, width: number): number {
  return Math.max(0, Math.floor((width - content) / 2));
}

/**
 * The banner, newline-joined, sized to `columns`: the full art when it fits
 * (`columns >= BANNER_MIN_COLUMNS`), only the text lines on a narrower
 * terminal, and `''` when even those would wrap. Centered against `columns`:
 * art rows first, then the bold wordmark (`repack-atlas v<version>` — the
 * plain name when no version is available) and the dim tagline. The banner is
 * printed once, so a later resize is the terminal's to reflow. `color: false`
 * yields the same layout with zero escape bytes; suppression for machine
 * paths is `dev.ts`'s job, not a mode of this function.
 */
export function renderStartupBanner(options: StartupBannerOptions): string {
  const { version, color } = options;
  const title =
    version === undefined || version === '' ? TITLE : `${TITLE} v${version}`;
  const withArt = options.columns >= BANNER_MIN_COLUMNS;
  const textWidth = Math.max(title.length, TAGLINE.length);
  if (!withArt && !(options.columns >= textWidth)) return '';
  const widest = withArt ? Math.max(ART_WIDTH, textWidth) : textWidth;
  const indent = ' '.repeat(Math.max(0, Math.floor((options.columns - widest) / 2)));
  // The art block is centered within the text block when the tagline is the
  // widest line (its trailing design spaces are part of the drawing).
  const artIndent = ' '.repeat(centerOf(ART_WIDTH, widest));
  const lines: string[] = [];
  for (const row of withArt ? ART : []) {
    const text = artIndent + pad(row.text, widest);
    lines.push(color ? paint(SGR[row.color], text) : text);
  }
  const titleText = pad(title, widest);
  lines.push(color ? paint(SGR.boldWhite, titleText) : titleText);
  const taglineText = pad(TAGLINE, widest);
  lines.push(color ? paint(SGR.dim, taglineText) : taglineText);
  return lines.map((line) => `${indent}${line}`).join('\n');
}
