(async ({ paths = [location.pathname + location.search], widths = [375, 768, 1280], range = [320, 1600], height = 900, resize, statics = true, sweep = true } = {}) => {
  const IGNORED = '[hidden], [aria-hidden="true"], dialog:not([open]), template';
  const PLACEHOLDER = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\$\{[^}]*\}/g;
  const CONTROLS = 'input:not([type="hidden"], [type="submit"], [type="button"], [type="reset"], [type="image"]), select, textarea';
  const FREEZE = '*, *::before, *::after { animation: none !important; transition: none !important; } html { scrollbar-width: none; }';

  const ignored = el => !!el.closest(IGNORED) || (el.checkVisibility ? !el.checkVisibility() : false);

  const describe = el => {
    const part = e => e.id ? `#${e.id}` : e.tagName.toLowerCase() + [...e.classList].map(c => `.${c}`).join('');
    const chain = [];
    for (let e = el; e && e.nodeType === 1 && chain.length < 3; e = e.parentElement) {
      chain.unshift(part(e));
      if (e.id) break;
    }
    return chain.join(' > ');
  };

  const freeze = doc => {
    const style = doc.createElement('style');
    style.textContent = FREEZE;
    doc.head.append(style);
    return doc.fonts?.ready;
  };

  const openHere = async width => {
    await resize(width);
    await freeze(document);
    return { doc: document, size: resize, close() {} };
  };

  const openInFrame = async (path, width) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;height:${height}px;border:0;opacity:0;pointer-events:none`;
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
    frame.src = path;
    document.body.append(frame);
    await loaded;
    const doc = frame.contentDocument;
    if (!doc) {
      frame.remove();
      throw new Error(`${path} refuses framing (X-Frame-Options or CSP frame-ancestors) or is on another origin; the check loads each page in an iframe`);
    }
    await freeze(doc);
    return { doc, size: async w => { frame.style.width = `${w}px`; }, close: () => frame.remove() };
  };

  const open = (path, width) => (resize ? openHere(width) : openInFrame(path, width));

  const overflow = doc => {
    const root = doc.documentElement;
    if (root.scrollWidth <= root.clientWidth) return null;
    const edge = root.clientWidth + 0.5;
    const culprits = [...doc.body.querySelectorAll('*')]
      .filter(el => !ignored(el) && el.getBoundingClientRect().right > edge && !(el.parentElement.getBoundingClientRect().right > edge))
      .slice(0, 5)
      .map(describe);
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, elements: culprits };
  };

  const labelled = el => el.labels?.length > 0
    || !!el.getAttribute('aria-label')?.trim()
    || (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).some(id => id && el.ownerDocument.getElementById(id)?.textContent.trim());

  const staticFindings = doc => {
    const found = [];
    const seen = new Map();
    for (const el of doc.querySelectorAll('[id]')) {
      if (ignored(el)) continue;
      seen.set(el.id, [...(seen.get(el.id) ?? []), el]);
    }
    for (const [id, els] of seen) if (els.length > 1) found.push({ check: 'duplicate-id', id, count: els.length });
    for (const el of doc.querySelectorAll(CONTROLS)) if (!ignored(el) && !labelled(el)) found.push({ check: 'unlabeled-input', element: describe(el) });
    for (const el of doc.querySelectorAll('a[href="#"]')) if (!ignored(el)) found.push({ check: 'href-hash', element: describe(el), text: el.textContent.trim() });
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest('script, style, noscript') || ignored(parent)) continue;
      for (const match of node.textContent.matchAll(PLACEHOLDER)) found.push({ check: 'template-placeholder', element: describe(parent), text: match[0] });
    }
    return found;
  };

  const layouts = doc => [...doc.body.querySelectorAll('*')].filter(el => {
    if (ignored(el)) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return /grid/.test(style.display) || (/flex/.test(style.display) && style.flexWrap !== 'nowrap' && !/column/.test(style.flexDirection));
  });

  const columns = el => {
    const win = el.ownerDocument.defaultView;
    const style = win.getComputedStyle(el);
    if (/grid/.test(style.display)) {
      const tracks = style.gridTemplateColumns.split(/\s+/).map(parseFloat).filter(px => px > 0);
      return { count: tracks.length, narrowest: Math.min(...tracks) };
    }
    const items = [...el.children].filter(c => !ignored(c));
    if (!items.length) return { count: 0, narrowest: 0 };
    const top = items[0].getBoundingClientRect().top;
    const line = items.filter(c => Math.abs(c.getBoundingClientRect().top - top) < 1);
    return { count: line.length, narrowest: Math.min(...line.map(c => c.getBoundingClientRect().width)) };
  };

  const chWidth = el => {
    const probe = el.ownerDocument.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;inline-size:10ch';
    el.append(probe);
    const width = probe.getBoundingClientRect().width / 10;
    probe.remove();
    return width;
  };

  const breakpoints = async path => {
    const view = await open(path, range[0]);
    const els = layouts(view.doc);
    const at = async width => {
      await view.size(width);
      return els.map(columns);
    };
    const switches = [];
    let before = await at(range[0]);
    for (let width = range[0] + 16; width <= range[1] + 15; width += 16) {
      const end = Math.min(width, range[1]);
      const after = await at(end);
      if (after.some((c, i) => c.count !== before[i].count)) {
        let previous = await at(end - 16 < range[0] ? range[0] : end - 16);
        for (let w = Math.max(range[0], end - 15); w <= end; w++) {
          const now = await at(w);
          now.forEach((c, i) => {
            if (c.count !== previous[i].count) switches.push({ element: describe(els[i]), width: w, from: previous[i].count, to: c.count, narrowestColumnCh: Math.round(c.narrowest / chWidth(els[i])) });
          });
          previous = now;
        }
      }
      before = after;
      if (end === range[1]) break;
    }
    view.close();
    const merged = new Map();
    for (const s of switches) {
      const key = JSON.stringify(s);
      merged.set(key, { path, ...s, count: (merged.get(key)?.count ?? 0) + 1 });
    }
    return [...merged.values()];
  };

  const findings = [];
  const report = [];
  for (const path of paths) {
    for (const [n, width] of widths.entries()) {
      const view = await open(path, width);
      const over = overflow(view.doc);
      if (over) findings.push({ check: 'overflow', path, width, ...over });
      if (n === 0 && statics) findings.push(...staticFindings(view.doc).map(f => ({ path, ...f })));
      view.close();
    }
    if (sweep) report.push(...await breakpoints(path));
  }
  return { findings, breakpoints: report };
})
