import { icons } from 'duoyun-ui/lib/icons';
import { theme } from 'duoyun-ui/lib/theme';
import { t } from '../../shared/i18n.js';

const EMPTY_TOOL = () => ({
  name: '',
  pattern: '',
  description: '',
  execute: '',
  properties: [],
});

const style = css`
  :scope {
    display: grid;
    grid-template-columns: 16rem minmax(0, 1fr);
    gap: 1rem;
    height: 60vh;
    padding: 0.25rem;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    overflow: hidden;
    border: 1px solid ${theme.borderColor};
    border-radius: 0.875rem;
    background:
      radial-gradient(circle at 85% 0%, color-mix(in srgb, ${theme.primaryColor} 14%, transparent), transparent 11rem),
      color-mix(in srgb, ${theme.lightBackgroundColor} 72%, white);
    padding: 0.875rem;
  }
  .list-header {
    padding: 0.25rem 0.25rem 0.5rem;
  }
  .list-title {
    margin: 0;
    color: ${theme.highlightColor};
    font-size: 1rem;
    font-weight: 700;
    line-height: 1.4;
  }
  .list-desc {
    margin: 0.25rem 0 0;
    color: ${theme.describeColor};
    font-size: 0.75rem;
    line-height: 1.5;
  }
  .list-body {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    gap: 0.5rem;
    overflow: auto;
    padding-inline: 0.875rem;
    margin-inline: -0.875rem;
  }
  .list-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem;
    border-radius: 0.75rem;
    cursor: pointer;
    border: 1px solid ${theme.borderColor};
    background: color-mix(in srgb, white 86%, transparent);
    box-shadow: 0 0.25rem 0.875rem rgba(15, 23, 42, 0.04);
    transition:
      border-color 0.2s,
      box-shadow 0.2s,
      transform 0.2s,
      background 0.2s;
  }
  .list-item:hover {
    border-color: ${theme.primaryColor};
    background: white;
    box-shadow: 0 0.625rem 1.5rem rgba(99, 102, 241, 0.12);
    transform: translateY(-1px);
  }
  .list-item.selected {
    background: color-mix(in srgb, ${theme.primaryColor} 9%, white);
    border-color: ${theme.primaryColor};
    box-shadow: 0 0.625rem 1.5rem rgba(99, 102, 241, 0.14);
  }
  .list-item-index {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 2rem;
    height: 2rem;
    border-radius: 0.625rem;
    color: ${theme.primaryColor};
    background: color-mix(in srgb, ${theme.primaryColor} 10%, white);
    font-size: 0.8125rem;
    font-weight: 700;
  }
  .list-item-main {
    min-width: 0;
    flex: 1;
  }
  .list-item-name {
    display: block;
    font-size: 0.875rem;
    font-weight: 600;
    color: ${theme.highlightColor};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .list-item-desc {
    display: block;
    margin-top: 0.125rem;
    color: ${theme.describeColor};
    font-size: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .editor {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    border: 1px solid ${theme.borderColor};
    border-radius: 0.875rem;
    background: color-mix(in srgb, white 92%, transparent);
    box-shadow: 0 1rem 2.25rem rgba(15, 23, 42, 0.06);
  }
  .editor-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    border-bottom: 1px solid ${theme.borderColor};
    background: linear-gradient(135deg, white, color-mix(in srgb, ${theme.primaryColor} 6%, white));
    padding: 1rem 1.125rem;
  }
  .editor-title {
    margin: 0;
    color: ${theme.highlightColor};
    font-size: 1.125rem;
    font-weight: 700;
    line-height: 1.4;
  }
  .editor-desc {
    margin: 0.25rem 0 0;
    color: ${theme.describeColor};
    font-size: 0.75rem;
    line-height: 1.5;
  }
  .editor-meta {
    flex-shrink: 0;
    border-radius: 999px;
    background: color-mix(in srgb, ${theme.primaryColor} 10%, white);
    color: ${theme.primaryColor};
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.25rem 0.625rem;
  }
  .form-wrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 1rem 1.125rem 1.125rem;
  }
  .add-button {
    flex-shrink: 0;
  }
  @media (max-width: 760px) {
    :scope {
      grid-template-columns: 1fr;
    }
    .list {
      max-height: 18rem;
    }
  }
`;

@customElement('market-tool-editor')
@adoptedStyle(style)
class MarketToolEditorElement extends GemElement {
  @property initialTools;

  #state = createState({
    tools: [EMPTY_TOOL()],
    selectedIndex: 0,
  });

  #formRef = createRef();

  #addTool = () => {
    const tools = [...this.#state.tools, EMPTY_TOOL()];
    this.#state({ tools, selectedIndex: tools.length - 1 });
  };

  #removeTool = (index, evt) => {
    evt?.stopPropagation();
    const tools = this.#state.tools.filter((_, i) => i !== index);
    if (!tools.length) {
      this.#state({ tools: [EMPTY_TOOL()], selectedIndex: 0 });
    } else {
      const selectedIndex = Math.min(this.#state.selectedIndex, tools.length - 1);
      this.#state({ tools, selectedIndex });
    }
  };

  #selectTool = (index) => {
    this.#state({ selectedIndex: index });
  };

  #formItems = [
    { label: t('toolName'), type: 'text', field: 'name', required: true, autofocus: true },
    { label: t('urlPattern'), type: 'text', field: 'pattern', required: true, placeholder: 'https://example.com/*' },
    { label: t('description'), type: 'textarea', field: 'description', rows: 2 },
    {
      label: t('parameters'),
      type: 'slot',
      field: `properties`,
      list: true,
      slot: html`<market-tool-editor-param></market-tool-editor-param>`,
    },
    {
      label: t('executeCode'),
      type: 'textarea',
      field: 'execute',
      required: true,
      rows: 6,
      placeholder: 'async ({ param1 } = {}) => { return { result } }',
    },
  ];

  #onChange = (evt) => {
    const { tools, selectedIndex } = this.#state;
    this.#state({ tools: tools.map((e, i) => (i === selectedIndex ? evt.detail : e)) });
  };

  mounted = () => {
    if (this.initialTools?.length) {
      this.#state({
        tools: this.initialTools.map((t) => {
          const required = new Set(t.inputSchema?.required || []);
          const props = t.inputSchema?.properties || {};
          return {
            name: t.name || '',
            pattern: t.pattern || '',
            description: t.description || '',
            execute: t.execute || '',
            properties: Object.entries(props).map(([name, s]) => ({
              name,
              type: s?.type || 'string',
              description: s?.description || '',
              required: required.has(name),
            })),
          };
        }),
      });
    }
  };

  render = () => {
    const { tools, selectedIndex } = this.#state;
    const selectedTool = tools[selectedIndex];

    return html`
      <div class="list">
        <div class="list-header">
          <h3 class="list-title">${t('toolsList')}</h3>
          <p class="list-desc">${t('toolListDesc', tools.length)}</p>
        </div>
        <div class="list-body">
          ${tools.map(
            (tool, i) => html`
              <div
                class="list-item ${i === selectedIndex ? 'selected' : ''}"
                @click=${() => this.#selectTool(i)}
              >
                <span class="list-item-index">${i + 1}</span>
                <span class="list-item-main">
                  <span class="list-item-name">${tool.name || t('unnamedTool')}</span>
                  <span class="list-item-desc">${tool.pattern || t('pendingUrlPattern')}</span>
                </span>
                <dy-button square color="cancel" .icon=${icons.delete} @click=${(evt) => this.#removeTool(i, evt)}></dy-button>
              </div>
            `,
          )}
        </div>
        <dy-button class="add-button" type="reverse" .icon=${icons.add} @click=${this.#addTool}>${t('addTool')}</dy-button>
      </div>
      <div class="editor">
        <div class="editor-header">
          <div>
            <h3 class="editor-title">${selectedTool?.name || t('configureNewTool')}</h3>
            <p class="editor-desc">${selectedTool?.description || t('newToolDesc')}</p>
          </div>
          <span class="editor-meta">${t('paramCount', selectedTool?.properties?.length || 0)}</span>
        </div>
        <div class="form-wrap">
          <dy-pat-form
            v-if=${!!selectedTool}
            ${this.#formRef}
            @change=${this.#onChange}
            .formItems=${this.#formItems}
            .data=${selectedTool}
          ></dy-pat-form>
        </div>
      </div>
    `;
  };

  getTools() {
    return this.#state.tools.map((e) => {
      const properties = {};
      const required = [];
      for (const p of e.properties) {
        if (!p?.name) continue;
        properties[p.name] = {
          type: p.type || 'string',
          ...(p.description ? { description: p.description } : {}),
        };
        if (p.required) required.push(p.name);
      }
      const { properties: _omit, ...rest } = e;
      return {
        ...rest,
        inputSchema: { type: 'object', properties, required },
      };
    });
  }
}
