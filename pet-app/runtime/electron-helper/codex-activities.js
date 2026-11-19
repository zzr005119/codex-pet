'use strict';

const CODEX_ACTIVITY_LABELS = {
  working: '\u8fd0\u884c\u4e2d',
  success: '\u5df2\u5b8c\u6210',
  error: '\u5df2\u5931\u8d25',
  stopped: '\u5df2\u505c\u6b62',
};
const CODEX_ROW_HEIGHT = 32;
const CODEX_ROW_GAP = 4;
const CODEX_LIST_PADDING = 3;

function codexActivityPlacement(clamp, body, bubble, count) {
  if (!clamp || count === 0) return null;
  const inset = 4;
  const gap = 8;
  const aboveGap = 24; // The working animation extends above the sprite hit box.
  const bounds = {
    left: clamp.x + inset, top: clamp.y + inset,
    right: clamp.x + clamp.w - inset, bottom: clamp.y + clamp.h - inset,
  };
  const avoid = bubble ? {
    left: Math.min(body.left, bubble.left), top: Math.min(body.top, bubble.top),
    right: Math.max(body.right, bubble.right), bottom: Math.max(body.bottom, bubble.bottom),
  } : body;
  const rowCount = Math.min(count, 4);
  const listWidth = 220;
  const listHeight = rowCount * CODEX_ROW_HEIGHT + (rowCount - 1) * CODEX_ROW_GAP + CODEX_LIST_PADDING * 2;
  const centerX = (body.left + body.right) / 2;
  const centerY = (body.top + body.bottom) / 2;
  const fit = (value, min, max) => Math.max(min, Math.min(max, value));
  const slots = [
    { ...bounds, bottom: Math.min(bounds.bottom, avoid.top - gap, body.top - aboveGap), side: 'above' },
    { ...bounds, top: Math.max(bounds.top, avoid.bottom + gap), side: 'below' },
    { ...bounds, right: Math.min(bounds.right, avoid.left - gap), side: 'left' },
    { ...bounds, left: Math.max(bounds.left, avoid.right + gap), side: 'right' },
  ];
  let best = null;
  for (const slot of slots) {
    const width = Math.floor(Math.min(listWidth, slot.right - slot.left));
    const height = Math.floor(Math.min(listHeight, slot.bottom - slot.top));
    if (width < 108 || height < CODEX_ROW_HEIGHT + CODEX_LIST_PADDING * 2) continue;
    const x = slot.side === 'left' ? slot.right - width : slot.side === 'right' ? slot.left :
      fit(centerX - width / 2, slot.left, slot.right - width);
    const y = slot.side === 'above' ? slot.bottom - height : slot.side === 'below' ? slot.top :
      fit(centerY - height / 2, slot.top, slot.bottom - height);
    const rect = { x, y, width, height };
    if (width === listWidth && height === listHeight) return rect;
    if (!best || width * height > best.width * best.height) best = rect;
  }
  return best;
}

class CodexActivityList {
  constructor(open) {
    this.open = open;
    this.rows = new Map();
    this.key = '';
    this.rect = null;
    this.element = document.createElement('div');
    this.element.className = 'pet-codex-activities';
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', 'Codex \u4f1a\u8bdd\u72b6\u6001');
    this.element.hidden = true;
    this.element.style.setProperty('--row-height', CODEX_ROW_HEIGHT + 'px');
    this.element.style.setProperty('--row-gap', CODEX_ROW_GAP + 'px');
    this.element.style.setProperty('--list-padding', CODEX_LIST_PADDING + 'px');
  }

  update(activities) {
    const items = (activities || []).filter((item) => item && typeof item.threadId === 'string' && item.threadId &&
      typeof item.turnId === 'string' && item.turnId && Object.hasOwn(CODEX_ACTIVITY_LABELS, item.state));
    const key = JSON.stringify(items.map(({ threadId, turnId, state, title }) => [threadId, turnId, state, title]));
    if (key === this.key) return false;
    this.key = key;
    const rows = new Map();
    for (const item of items) {
      if (rows.has(item.threadId)) continue;
      let row = this.rows.get(item.threadId);
      if (!row) {
        const button = document.createElement('button');
        const title = document.createElement('span');
        const status = document.createElement('span');
        button.type = 'button';
        button.className = 'pet-codex-activity';
        title.className = 'pet-codex-activity-title';
        status.className = 'pet-codex-activity-status';
        status.setAttribute('aria-hidden', 'true');
        button.append(title, status);
        row = { button, title, target: null };
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          this.open(row.target);
        });
      }
      const name = typeof item.title === 'string' ? item.title.trim() : '';
      const title = name || '\u4f1a\u8bdd ' + item.threadId.slice(-6);
      const status = CODEX_ACTIVITY_LABELS[item.state];
      row.target = { threadId: item.threadId, turnId: item.turnId, state: item.state };
      row.button.dataset.state = item.state;
      row.button.title = title;
      row.button.setAttribute('aria-label', title + '\uff0c' + status);
      row.title.textContent = title;
      rows.set(item.threadId, row);
    }
    const buttons = Array.from(rows.values(), (row) => row.button);
    const oldButtons = Array.from(this.rows.values(), (row) => row.button);
    if (buttons.length !== oldButtons.length || buttons.some((button, i) => button !== oldButtons[i])) {
      const focused = document.activeElement;
      const scrollTop = this.element.scrollTop;
      this.element.replaceChildren(...buttons);
      this.element.scrollTop = scrollTop;
      if (buttons.includes(focused)) focused.focus({ preventScroll: true });
    }
    this.rows = rows;
    return true;
  }

  place(clamp, body, bubble) {
    const next = codexActivityPlacement(clamp, body, bubble, this.rows.size);
    const prev = this.rect;
    if (next === prev || (next && prev && next.x === prev.x && next.y === prev.y &&
        next.width === prev.width && next.height === prev.height)) return false;
    this.rect = next;
    this.element.hidden = !next;
    if (next) {
      this.element.style.left = next.x + 'px';
      this.element.style.top = next.y + 'px';
      this.element.style.width = next.width + 'px';
      this.element.style.height = next.height + 'px';
    }
    return true;
  }

  contains(x, y) {
    const r = this.rect;
    return !!r && x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
  }
}
