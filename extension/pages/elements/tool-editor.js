import { icons } from 'duoyun-ui/lib/icons';
import { theme } from 'duoyun-ui/lib/theme';

const EMPTY_TOOL = () => ({
  name: '',
  pattern: '',
  description: '',
  execute: '',
  properties: [],
});

const style = css`
  :scope {
    display: flex;
    gap: 1rem;
    min-height: 18rem;
    width: 38rem;
  }
  .list {
    width: 33%;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .list-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .list-item:hover {
    background: ${theme.hoverBackgroundColor};
  }
  .list-item.selected {
    background: color-mix(in srgb, ${theme.primaryColor} 10%, transparent);
    border-color: ${theme.primaryColor};
  }
  .list-item-name {
    font-size: 0.875rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .editor {
    width: 66%;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .param-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .param-label {
    font-size: 0.875rem;
    color: ${theme.describeColor};
  }
  .param-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
  }
  .param-item:hover {
    background: ${theme.hoverBackgroundColor};
  }
  .param-item-name {
    flex: 1;
  }
`;

@customElement('market-tool-editor')
@adoptedStyle(style)
class MarketToolEditorElement extends GemElement {
  #state = createState({
    tools: [EMPTY_TOOL()],
    selectedIndex: 0,
  });

  #formRef = createRef();

  #addTool = () => {
    const tools = [...this.#state.tools, EMPTY_TOOL()];
    this.#state({ tools, selectedIndex: tools.length - 1 });
  };

  #removeTool = (index) => {
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
    { label: '工具名称', type: 'text', field: 'name', required: true, autofocus: true },
    { label: 'URL 匹配模式', type: 'text', field: 'pattern', required: true, placeholder: 'https://example.com/*' },
    { label: '描述', type: 'textarea', field: 'description', rows: 2 },
    {
      label: `参数`,
      type: 'slot',
      field: `properties`,
      list: true,
      // TODO: param: name, type(string, number, boolean), required, description
      slot: html`<market-tool-editor-param></market-tool-editor-param>`,
    },
    {
      label: '执行代码',
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

  @template()
  #content = () => {
    const { tools, selectedIndex } = this.#state;

    return html`
      <div class="list">
        ${tools.map(
          (t, i) => html`
            <div
              class="list-item ${i === selectedIndex ? 'selected' : ''}"
              @click=${() => this.#selectTool(i)}
            >
              <span class="list-item-name">${t.name || '(未命名)'}</span>
              <dy-button square color="cancel" .icon=${icons.delete} @click=${() => this.#removeTool(i)}></dy-button>
            </div>
          `,
        )}
        <dy-button type="reverse" .icon=${icons.add} @click=${this.#addTool}>添加工具</dy-button>
      </div>
      <div class="editor">
        <dy-pat-form
          v-if=${!!tools[selectedIndex]}
          ${this.#formRef}
          @change=${this.#onChange}
          .formItems=${this.#formItems}
          .data=${tools[selectedIndex]}
        ></dy-pat-form>
      </div>
    `;
  };

  getTools() {
    return this.#state.tools.map((e) => ({
      ...e,
      properties: undefined,
      inputSchema: {
        type: 'object',
        // TODO: e.properties => inputSchema
        properties: {},
        required: e.properties.filter((e) => e.required).map((e) => e.name),
      },
    }));
  }
}
