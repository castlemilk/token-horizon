// Deterministic public team card. The Worker resolves the team and its public
// aggregates, reads optional logo bytes from its own R2 bucket, then rasterizes
// this SVG with the same bundled fonts and resvg instance as profile cards.
import { validatedRasterDataUri } from './og-avatar.js';

export const TEAM_OG_VERSION = 'team-horizon-1';

const C = { ink: '#121714', dark: '#101813', forest: '#235E43', mint: '#B6F2CF', paper: '#F3F4EF', muted: '#56635A', line: '#CDD3CC', white: '#FFFFFF' };
const STYLES = {
  openai: ['OpenAI', '#235E43'], anthropic: ['Anthropic', '#D97757'], google: ['Google', '#4285F4'],
  deepseek: ['DeepSeek', '#4D6BFE'], meta: ['Meta', '#0866FF'], xai: ['xAI', '#343E37'],
  opencode: ['OpenCode', '#7665B5'], openrouter: ['OpenRouter', '#78877C'], mistral: ['Mistral', '#B98027'],
  kimi: ['Kimi', '#B45685'], zhipu: ['Zhipu', '#288895'], minimax: ['MiniMax', '#B98027'],
  alibaba: ['Alibaba', '#CE6427'], local: ['Local', '#478966'], other: ['Other', '#89978B']
};

// These are the official marks already shipped in docs/assets/brands. All SVG
// markup is trusted build-time artwork; public provider strings never become
// SVG paths, colors, URLs or attributes. OpenAI's source has a large canvas,
// so its viewBox is cropped to the actual mark for a centered, equal-size fit.
const MARKS = {
  "openai": {
    "viewBox": "177 177 361 361",
    "content": "<path d=\"M508.749 317.399C516.777 287.314 508.991 253.884 485.389 230.282C461.788 206.681 428.36 198.895 398.273 206.923C376.231 184.928 343.39 174.956 311.148 183.596C278.906 192.234 255.45 217.292 247.36 247.361C217.291 255.451 192.233 278.91 183.595 311.149C174.957 343.391 184.927 376.232 206.924 398.274C198.896 428.359 206.683 461.789 230.284 485.391C253.885 508.992 287.313 516.779 317.401 508.75C339.442 530.745 372.286 540.717 404.525 532.079C436.767 523.441 460.223 498.384 468.313 468.315C498.383 460.224 523.44 436.766 532.078 404.526C540.716 372.285 530.747 339.443 508.749 317.402V317.399ZM470.899 244.776C486.892 260.77 493.488 282.601 490.687 303.412L415.577 260.046C412.411 258.218 408.509 258.218 405.345 260.046L317.401 310.82V277.526C317.401 275.191 318.652 273.005 320.676 271.837L387.644 233.174C414.178 218.353 448.346 222.223 470.901 244.776H470.899ZM357.837 311.144L398.275 334.491V381.185L357.837 404.532L317.398 381.185V334.491L357.837 311.144ZM264.776 269.693C265.207 239.305 285.644 211.649 316.453 203.393C338.3 197.54 360.505 202.744 377.127 215.573L302.014 258.937C298.848 260.764 296.898 264.144 296.898 267.798V369.346L268.065 352.699C266.043 351.531 264.776 349.353 264.776 347.017V269.691V269.693ZM203.391 316.454C209.244 294.608 224.854 277.978 244.276 269.999V356.73C244.276 360.384 246.226 363.763 249.392 365.591L337.337 416.365L308.503 433.013C306.481 434.181 303.961 434.188 301.939 433.02L234.971 394.357C208.868 378.789 195.138 347.261 203.391 316.454ZM244.775 470.9C228.781 454.906 222.186 433.075 224.986 412.264L300.096 455.63C303.263 457.457 307.164 457.457 310.328 455.63L398.273 404.856V438.149C398.273 440.485 397.022 442.671 394.997 443.839L328.029 482.502C301.495 497.322 267.327 493.452 244.772 470.9H244.775ZM450.897 445.982C450.466 476.371 430.029 504.027 399.22 512.283C377.373 518.136 355.168 512.932 338.547 500.102L413.659 456.738C416.826 454.911 418.775 451.532 418.775 447.877V346.329L447.609 362.977C449.631 364.145 450.897 366.323 450.897 368.659V445.985V445.982ZM512.282 399.221C506.429 421.068 490.819 437.697 471.397 445.676V358.946C471.397 355.292 469.448 351.912 466.281 350.085L378.336 299.311L407.17 282.663C409.192 281.495 411.712 281.487 413.734 282.655L480.702 321.318C506.805 336.887 520.536 368.415 512.282 399.221Z\" fill=\"#FFFFFF\"/>"
  },
  "anthropic": {
    "viewBox": "0 0 24 24",
    "content": "<path d=\"M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z\"/>"
  },
  "google": {
    "viewBox": "0 0 24 24",
    "content": "<path d=\"M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z\" fill=\"#4285F4\"/><path d=\"M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z\" fill=\"#34A853\"/><path d=\"M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z\" fill=\"#FBBC05\"/><path d=\"M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z\" fill=\"#EA4335\"/><path d=\"M1 1h22v22H1z\" fill=\"none\"/>"
  },
  "deepseek": {
    "viewBox": "0 0 24 24",
    "content": "<path d=\"M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45\"/>"
  },
  "meta": {
    "viewBox": "0 0 24 24",
    "content": "<path d=\"M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z\"/>"
  },
  "openrouter": {
    "viewBox": "0 0 1024 730",
    "content": "<path d=\"M795.893 0C915.776 0 1012.95 97.9963 1012.95 218.88C1012.95 339.764 915.776 437.76 795.893 437.76L1011.2 654.869C1038.55 682.447 1019.18 729.6 980.504 729.6H361.77C161.97 729.6 0 566.273 0 364.8C0 163.327 161.97 0 361.77 0L795.893 0ZM361.77 145.92C241.89 145.92 144.708 243.916 144.708 364.8C144.708 485.684 241.89 583.68 361.77 583.68C481.649 583.68 578.831 485.684 578.831 364.8C578.831 243.916 481.649 145.92 361.77 145.92Z\" fill=\"#FFFFFF\"/>"
  },
  "mistral": {
    "viewBox": "0 0 24 24",
    "content": "<path d=\"M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z\"/>"
  },
  "opencode": {
    "viewBox": "0 0 24 24",
    "content": "<path d=\"M22 24H2V0h20zM17 4.8H7v14.4h10z\"/>"
  },
  "xai": {
    "viewBox": "0 0 834 318",
    "content": "<path d=\"M832.419 0.291178C736.486 8.11276 359.416 54.86 97.9592 317.699H0.935547L11.7763 306.895C66.4906 254.036 308.595 30.0129 832.419 0V0.291178Z\" fill=\"#FFFFFF\"/>\n<path d=\"M504.045 317.699H428L278.168 208.633C291.976 199.95 305.871 191.68 319.81 183.804L504.045 317.699Z\" fill=\"#FFFFFF\"/>\n<path d=\"M382.512 317.7H306.501L283.443 300.929H154.706C163.769 292.881 172.944 285.068 182.216 277.484H251.175L215.49 251.526C228.245 242.035 241.141 232.944 254.141 224.235L382.512 317.7Z\" fill=\"#FFFFFF\"/>\n<path d=\"M105.851 116.591L164.466 159.188C149.878 167.778 136.224 176.28 123.48 184.598L29.9057 116.554L105.851 116.591Z\" fill=\"#FFFFFF\"/>"
  },
  "alibaba": {
    "viewBox": "0 0 59.8 37.28",
    "content": "<rect x=\"19.94\" y=\"16.3\" width=\"19.92\" height=\"4.49\"></rect><path d=\"M49.84,0H36.66l3.18,4.5,9.61,3a4.15,4.15,0,0,1,2.9,4V25.84h0a4.17,4.17,0,0,1-2.9,4l-9.61,2.94-3.18,4.5H49.84a9.94,9.94,0,0,0,9.95-10V10A10,10,0,0,0,49.84,0Z\"></path><path d=\"M10,0H23.14L20,4.5l-9.61,3a4.16,4.16,0,0,0-2.91,4V25.84h0a4.18,4.18,0,0,0,2.91,4L20,32.78l3.18,4.5H10a10,10,0,0,1-10-10V10A10,10,0,0,1,10,0Z\"></path>"
  },
  "minimax": {
    "viewBox": "0 0 24 24",
    "content": "<path d=\"M11.43 3.92a.86.86 0 1 0-1.718 0v14.236a1.999 1.999 0 0 1-3.997 0V9.022a.86.86 0 1 0-1.718 0v3.87a1.999 1.999 0 0 1-3.997 0V11.49a.57.57 0 0 1 1.139 0v1.404a.86.86 0 0 0 1.719 0V9.022a1.999 1.999 0 0 1 3.997 0v9.134a.86.86 0 0 0 1.719 0V3.92a1.998 1.998 0 1 1 3.996 0v11.788a.57.57 0 1 1-1.139 0zm10.572 3.105a2 2 0 0 0-1.999 1.997v7.63a.86.86 0 0 1-1.718 0V3.923a1.999 1.999 0 0 0-3.997 0v16.16a.86.86 0 0 1-1.719 0V18.08a.57.57 0 1 0-1.138 0v2a1.998 1.998 0 0 0 3.996 0V3.92a.86.86 0 0 1 1.719 0v12.73a1.999 1.999 0 0 0 3.996 0V9.023a.86.86 0 1 1 1.72 0v6.686a.57.57 0 0 0 1.138 0V9.022a2 2 0 0 0-1.998-1.997\"/>"
  },
  "zhipu": {
    "viewBox": "0 0 160 160",
    "content": "<g clip-path=\"url(#clip0_3_10)\">\n<path d=\"M137.381 0H22.619C10.1269 0 0 10.1269 0 22.619V137.381C0 149.873 10.1269 160 22.619 160H137.381C149.873 160 160 149.873 160 137.381V22.619C160 10.1269 149.873 0 137.381 0Z\" fill=\"black\"/>\n<path d=\"M82.771 33.208L75.0661 44.157C74.4609 45.0175 73.6581 45.7202 72.7251 46.2063C71.7922 46.6924 70.7562 46.9476 69.7043 46.9506H27.7104V33.1629L82.771 33.208Z\" fill=\"#FFFFFF\"/>\n<path d=\"M135.083 33.2075L68.9835 126.837H24.917L91.0167 33.2075H135.083Z\" fill=\"#FFFFFF\"/>\n<path d=\"M77.2741 126.837L85.024 115.843C85.6315 114.988 86.4359 114.292 87.3692 113.814C88.3024 113.336 89.3371 113.089 90.3859 113.095H132.335V126.612L77.2741 126.837Z\" fill=\"#FFFFFF\"/>\n</g>\n<defs>\n<clipPath id=\"clip0_3_10\">\n<rect width=\"160\" height=\"160\" fill=\"#FFFFFF\"/>\n</clipPath>\n</defs>"
  }
};

const clean = value => String(value ?? '').replace(/[\u0000-\u001F\u007F-\u009F]/g, '').slice(0, 192);
const escape = value => clean(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const number = value => Number.isFinite(Number(value)) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number(value))) : 0;
const short = (value, limit) => { const chars = Array.from(clean(value)); return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : chars.join(''); };
const compact = value => {
  const n = number(value);
  for (const [size, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (n >= size) return (n / size).toFixed(n / size >= 100 ? 0 : n / size >= 10 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0$/, '') + suffix;
  }
  return Math.round(n).toLocaleString('en-US');
};
const hasNumber = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;

export function buildTeamOgModel(team = {}, stats = {}) {
  const providers = stats.providers && typeof stats.providers === 'object' && !Array.isArray(stats.providers) ? stats.providers : {};
  const rows = Object.entries(providers).slice(0, 64).filter(([, tokens]) => hasNumber(tokens) && Number(tokens) > 0)
    .map(([key, tokens]) => ({ provider: clean(key).toLowerCase(), tokens: number(tokens) }))
    .sort((a, b) => b.tokens - a.tokens || a.provider.localeCompare(b.provider));
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  const visible = rows.slice(0, 4);
  if (rows.length > 4) visible.push({ provider: 'other', tokens: rows.slice(4).reduce((sum, row) => sum + row.tokens, 0) });
  return {
    id: /^[a-f0-9]{32}$/.test(team.id || '') ? team.id : '',
    name: clean(team.name).trim() || 'Your team',
    members: Math.floor(number(team.memberCount)),
    memberCountAvailable: hasNumber(team.memberCount),
    tokens: number(stats.tokens),
    tokensAvailable: hasNumber(stats.tokens),
    publishedProfiles: Math.floor(number(stats.publishedProfiles)),
    profilesAvailable: hasNumber(stats.publishedProfiles),
    providerCount: rows.length,
    providerTotal: total,
    mix: visible.map(row => ({ ...row, label: STYLES[row.provider]?.[0] || short(row.provider, 16), color: STYLES[row.provider]?.[1] || STYLES.other[1], share: total ? row.tokens / total : 0 }))
  };
}

function text(x, y, value, size = 16, fill = C.ink, weight = 400, attributes = '') {
  return `<text x="${x}" y="${y}" font-family="Token Horizon Sans" font-size="${size}" font-weight="${weight}" fill="${fill}" ${attributes}>${escape(value)}</text>`;
}
function mono(x, y, value, size = 12, fill = C.muted, attributes = '') {
  return `<text x="${x}" y="${y}" font-family="JetBrains Mono" font-size="${size}" fill="${fill}" ${attributes}>${escape(value)}</text>`;
}
function horizon(x, y, size, color) {
  const r = size / 2;
  return `<g transform="translate(${x} ${y})"><circle cx="${r}" cy="${r}" r="${r - 1}" fill="none" stroke="${color}" stroke-width="1.6"/><path d="M2 ${r}H${size - 2}" stroke="${color}" stroke-width="1.6"/><path d="M5 ${r + 3}Q${r} ${size + 2} ${size - 5} ${r + 3}" fill="${color}"/></g>`;
}

// Compact display names stay large. Longer and wide-script names fit up to
// three lines without crossing into the separate live-membership panel.
function charWidth(char, size) {
  if (/\s/.test(char)) return size * .28;
  if (/[ilI.,'!:;|]/.test(char)) return size * .3;
  if (/[mwMW@%]/.test(char)) return size * .88;
  if (char.codePointAt(0) > 0x2e7f) return size;
  return size * .6;
}
function nameLines(value) {
  const width = 650;
  for (const size of [52, 46, 40, 34, 30]) {
    const lines = [];
    let line = '', used = 0;
    for (const char of Array.from(value)) {
      const advance = charWidth(char, size);
      if (used + advance > width && line) {
        const space = line.lastIndexOf(' ');
        if (space > line.length / 2) {
          lines.push(line.slice(0, space).trim());
          line = line.slice(space + 1);
          used = Array.from(line).reduce((sum, previous) => sum + charWidth(previous, size), 0);
        } else { lines.push(line.trim()); line = ''; used = 0; }
      }
      line += char; used += advance;
    }
    if (line.trim()) lines.push(line.trim());
    if (lines.length <= 3) return { size, lines };
    if (size === 30) return { size, lines: [...lines.slice(0, 2), short(lines[2], 20)] };
  }
}

function embeddedLogo(source) {
  if (typeof source !== 'string' || source.length > 533360) return '';
  const match = source.match(/^data:(image\/(?:png|jpeg));base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/);
  if (!match?.[2]) return '';
  try {
    const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
    return validatedRasterDataUri(bytes, match[1], { allowGif: false });
  } catch { return ''; }
}

function providerMark(row, x, y) {
  const mark = MARKS[row.provider];
  const fallback = text(x + 18, y + 25, short(row.label, 2).toUpperCase(), 13, C.white, 600, 'text-anchor="middle"');
  return `<g data-provider-mark="${escape(row.provider)}"><rect x="${x}" y="${y}" width="36" height="36" rx="9" fill="${C.ink}"/>${mark ? `<svg x="${x + 8}" y="${y + 8}" width="20" height="20" viewBox="${mark.viewBox}" preserveAspectRatio="xMidYMid meet" fill="#FFFFFF">${mark.content}</svg>` : fallback}</g>`;
}

/** Only public team identity and usage aggregates appear in the social card. */
export function renderTeamOgSvg(team = {}, stats = {}, { logoDataUri = '' } = {}) {
  const vm = buildTeamOgModel(team, stats);
  const logo = embeddedLogo(logoDataUri);
  const layout = nameLines(vm.name);
  const nameStart = layout.lines.length === 1 ? 172 : layout.lines.length === 2 ? 151 : 138;
  const name = layout.lines.map((line, index) => text(166, nameStart + index * (layout.size + 5), line, layout.size, C.white, 600, 'data-team-name="true"')).join('');
  const letters = (vm.name.match(/[\p{L}\p{N}]+/gu) || []).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase();
  const initials = /^[A-Z0-9À-ž]{1,2}$/.test(letters) ? letters : 'TH';
  const identity = `<rect x="48" y="111" width="96" height="96" rx="20" fill="${logo ? C.white : C.mint}"/>${logo ? `<image data-team-logo="custom" x="58" y="121" width="76" height="76" preserveAspectRatio="xMidYMid meet" href="${logo}"><title>Custom team logo</title></image>` : text(96, 174, initials, 36, C.forest, 600, 'text-anchor="middle" data-team-logo="monogram"')}`;
  const memberValue = vm.memberCountAvailable ? compact(vm.members) : '—';
  const members = `<g data-team-members="${vm.memberCountAvailable ? vm.members : 'unavailable'}"><rect x="878" y="92" width="274" height="152" rx="20" fill="#17241B" stroke="#354A3B"/>${text(1015, 171, memberValue, memberValue.length > 5 ? 58 : 76, C.mint, 600, 'text-anchor="middle"')}${mono(1015, 204, vm.members === 1 ? 'MEMBER' : 'MEMBERS', 14, '#D0DED2', 'text-anchor="middle"')}${mono(1015, 225, 'JOINED THE HORIZON', 10, '#99AE9E', 'text-anchor="middle"')}</g>`;
  const tokenValue = vm.tokensAvailable ? compact(vm.tokens) : '—';
  const profileValue = vm.profilesAvailable ? compact(vm.publishedProfiles) : '—';
  const usageNote = vm.profilesAvailable && vm.publishedProfiles === 0 ? 'Your team’s story starts with its first public profile.' : 'Measured usage from your team’s public profiles.';
  const statsPanel = `<rect x="24" y="278" width="1152" height="268" rx="24" fill="${C.paper}"/>${mono(48, 318, 'TEAM TOKENS / ALL TIME')}${text(48, 398, tokenValue, 80, C.ink, 600, 'data-team-tokens="true"')}${mono(520, 318, 'PUBLIC PROFILES')}${text(520, 392, profileValue, 62, C.ink, 600, 'data-team-profiles="true"')}${mono(842, 318, 'PROVIDERS')}${text(842, 392, compact(vm.providerCount), 62, C.ink, 600, 'data-team-provider-count="true"')}<path d="M486 307V404M808 307V404" stroke="${C.line}"/>`;
  let bar = '', legend = '';
  if (vm.mix.length) {
    let offset = 0;
    bar = `<defs><clipPath id="team-provider-bar"><rect x="48" y="432" width="1104" height="12" rx="6"/></clipPath></defs><g clip-path="url(#team-provider-bar)">${vm.mix.map((row, index) => {
      const width = index === vm.mix.length - 1 ? 1104 - offset : row.share * 1104;
      const rect = `<rect data-provider-share="${escape(row.provider)}" x="${(48 + offset).toFixed(3)}" y="432" width="${width.toFixed(3)}" height="12" fill="${row.color}"><title>${escape(row.label)} · ${escape(compact(row.tokens))} tokens</title></rect>`;
      offset += width;
      return rect;
    }).join('')}</g>`;
    const spacing = 1104 / vm.mix.length;
    legend = vm.mix.map((row, index) => {
      const x = Math.round(48 + index * spacing);
      return providerMark(row, x, 471) + text(x + 47, 487, row.label, 15, C.ink, 600) + mono(x + 47, 508, `${Math.round(row.share * 100)}% OF ATTRIBUTED TOKENS`, vm.mix.length > 4 ? 8 : 9);
    }).join('');
  } else {
    bar = `<path d="M48 432H1152" stroke="${C.line}"/>`;
    legend = horizon(48, 468, 34, C.forest) + text(98, 489, vm.tokensAvailable && vm.tokens > 0 ? 'Provider breakdown not published' : 'Ready for your first shared milestone.', 21, C.ink, 600) + text(98, 515, usageNote, 14, C.muted);
  }
  const href = vm.id ? `token-horizon.dev/t/${vm.id.slice(0, 8)}…` : 'token-horizon.dev';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="team-og-title"><title id="team-og-title">${escape(vm.name)} · ${escape(vm.memberCountAvailable ? `${vm.members} joined ${vm.members === 1 ? 'member' : 'members'}` : 'Team profile')} · Token Horizon</title><rect width="1200" height="630" fill="${C.dark}"/><path d="M36 264H1164" stroke="#2E4134"/>${horizon(48, 38, 30, C.mint)}${text(90, 62, 'Token Horizon', 23, C.white, 600)}${mono(1152, 61, 'BUILD TOGETHER. GO FURTHER.', 11, '#A3B5A8', 'text-anchor="end"')}${identity}${name}${members}${statsPanel}${bar}${legend}${text(48, 593, 'Your crew. One shared horizon.', 21, C.white, 600)}${mono(1152, 591, href, 12, '#A3B5A8', 'text-anchor="end"')}</svg>`;
}
