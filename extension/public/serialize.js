async function getSimpleHTML() {
  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'HEAD',
    'NOSCRIPT',
    'TEMPLATE',
    'SVG',
    'CANVAS',
    'AUDIO',
    'VIDEO',
    'OBJECT',
    'EMBED',
  ]);
  const VOID_TAGS = new Set(['AREA', 'BR', 'COL', 'HR', 'IMG', 'INPUT', 'WBR']);
  const UNWRAP_TAGS = new Set(['DIV', 'SPAN']);
  const BOOLEAN_ATTRS = new Set(['disabled', 'checked', 'selected']);
  const IGNORE_ROLES = new Set(['presentation', 'none', 'generic']);
  const MAX_ATTR_LENGTH = 200;

  const KEEP_ATTRS = new Set([
    'id',
    // "class",
    'role',
    'type',
    'name',
    'href',
    'src',
    'alt',
    'placeholder',
    'aria-label',
    'data-testid',
    'disabled',
    'checked',
    'selected',
    'value',
  ]);

  const serialize = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.trim();
      return text ? (node.textContent !== text ? ` ${text} ` : text) : '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    if (node.inert || node.hasAttribute?.('inert')) return '';
    if (node.hidden || node.hasAttribute?.('hidden')) return '';
    if (node.getAttribute?.('aria-hidden') === 'true') return '';

    const tag = node.tagName;
    if (SKIP_TAGS.has(tag)) return '';
    if (tag === 'IFRAME' && !node.src) return '';
    if (tag === 'IMG' && !node.alt?.trim() && !node.getAttribute('aria-label')?.trim()) return '';

    if (tag === 'SLOT') {
      const assigned = node.assignedNodes({ flatten: true });
      return (assigned.length ? assigned : [...node.childNodes]).map(serialize).join('');
    }

    if (
      node.checkVisibility &&
      !node.checkVisibility({ checkVisibilityCSS: true }) &&
      window.getComputedStyle?.(node)?.display !== 'contents'
    ) {
      return '';
    }

    const children = (node.shadowRoot ?? node).childNodes;
    const serializedChildren = [...children].map(serialize).filter(Boolean);
    const childrenContent = serializedChildren.join('');
    if (!VOID_TAGS.has(tag) && !childrenContent) return '';

    const attrs = [...node.attributes]
      .filter((attr) => {
        if (!KEEP_ATTRS.has(attr.name)) return false;
        const val = attr.value.trim();
        if (BOOLEAN_ATTRS.has(attr.name)) return true;
        if (!val || val.startsWith('data:')) return false;
        if (attr.name === 'role' && IGNORE_ROLES.has(val.toLowerCase())) return false;
        if (attr.name === 'href' && (val === '#' || val.startsWith('javascript:'))) return false;
        return true;
      })
      .map((attr) => {
        if (BOOLEAN_ATTRS.has(attr.name)) return attr.name;
        let val = attr.value.trim();
        if (val.length > MAX_ATTR_LENGTH) {
          val = `${val.slice(0, MAX_ATTR_LENGTH)}...`;
        }
        return `${attr.name}="${val.replace(/"/g, '&quot;')}"`;
      })
      .join(' ');
    const openTag = `<${tag.toLowerCase()}${attrs ? ` ${attrs}` : ''}>`;

    if (VOID_TAGS.has(tag)) return openTag;

    if (
      UNWRAP_TAGS.has(tag) &&
      !attrs &&
      serializedChildren.length === 1 &&
      (tag === 'SPAN' || serializedChildren[0].startsWith('<'))
    ) {
      return childrenContent;
    }
    return `${openTag}${childrenContent}</${tag.toLowerCase()}>`;
  };

  const restore = await window.browserAgentReadTabContentHack?.();
  const result = serialize(document.body);
  restore?.();
  return result;
}

getSimpleHTML();
