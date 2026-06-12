async function getSimpleHTML() {
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE', 'IMG', 'SVG']);
  const VOID_TAGS = new Set([
    'AREA',
    'BASE',
    'BR',
    'COL',
    'EMBED',
    'HR',
    'IMG',
    'INPUT',
    'LINK',
    'META',
    'PARAM',
    'SOURCE',
    'TRACK',
    'WBR',
  ]);
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
    'aria-hidden',
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

    const tag = node.tagName;
    if (SKIP_TAGS.has(tag)) return '';
    if (tag === 'IFRAME' && !node.src) return '';

    if (tag === 'SLOT') {
      const assigned = node.assignedNodes({ flatten: true });
      return (assigned.length ? assigned : [...node.childNodes]).map(serialize).join('');
    }

    const children = (node.shadowRoot ?? node).childNodes;
    const childrenContent = [...children].map(serialize).join('');
    if (!VOID_TAGS.has(tag) && !childrenContent) return '';

    const attrs = [...node.attributes]
      .filter((attr) => KEEP_ATTRS.has(attr.name) && !attr.value.startsWith('data:'))
      .map((attr) => `${attr.name}="${attr.value}"`)
      .join(' ');
    const openTag = `<${tag.toLowerCase()}${attrs ? ` ${attrs}` : ''}>`;

    if (VOID_TAGS.has(tag)) return openTag;

    if (children.length === 1 && !attrs.length) return childrenContent;
    return `${openTag}${childrenContent}</${tag.toLowerCase()}>`;
  };

  const restore = await window.browserAgentReadTabContentHack?.();
  const result = serialize(document.body);
  restore?.();
  return result;
}

getSimpleHTML();
