import { icons } from 'duoyun-ui/lib/icons';

const EMPTY_TOOL = () => ({
  name: '',
  pattern: '',
  description: '',
  execute: '',
  inputSchema: { type: 'object', properties: {}, required: [] },
});

const PARAM_TYPES = ['string', 'number', 'boolean'];

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
    background: var(--s-color-neutral-5);
  }
  .list-item.selected {
    background: color-mix(in srgb, var(--s-color-primary) 10%, transparent);
    border-color: var(--s-color-primary);
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
    color: var(--s-color-describe);
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
    background: var(--s-color-neutral-5);
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

  getTools() {
    return this.#state.tools;
  }

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

  #toFormData = (tool) => {
    const paramEntries = Object.entries(tool.inputSchema.properties);
    const data = { name: tool.name, pattern: tool.pattern, description: tool.description, execute: tool.execute };
    paramEntries.forEach(([key, prop], i) => {
      data[`param_${i}_name`] = key;
      data[`param_${i}_type`] = prop.type;
      data[`param_${i}_desc`] = prop.description || '';
    });
    return data;
  };

  #fromFormData = (data, paramCount) => {
    const properties = {};
    const required = [];
    for (let i = 0; i < paramCount; i++) {
      const pName = data[`param_${i}_name`];
      if (pName) {
        properties[pName] = {
          type: data[`param_${i}_type`] || 'string',
          description: data[`param_${i}_desc`] || '',
        };
      }
    }
    return {
      name: data.name,
      pattern: data.pattern,
      description: data.description,
      execute: data.execute,
      inputSchema: { type: 'object', properties, required },
    };
  };

  #getParamCount = () =>
    Object.keys(this.#state.tools[this.#state.selectedIndex]?.inputSchema?.properties || {}).length;

  get #currentFormData() {
    const tool = this.#state.tools[this.#state.selectedIndex];
    return tool ? this.#toFormData(tool) : undefined;
  }

  get #currentFormItems() {
    const tool = this.#state.tools[this.#state.selectedIndex];
    if (!tool) return [];
    const paramEntries = Object.entries(tool.inputSchema.properties);
    return [
      { label: '工具名称', type: 'text', field: 'name', required: true, autofocus: true },
      { label: 'URL 匹配模式', type: 'text', field: 'pattern', required: true, placeholder: 'https://example.com/*' },
      { label: '描述', type: 'textarea', field: 'description', rows: 2 },
      ...paramEntries.map(([key, prop], i) => [
        { label: `参数 ${i + 1} 名称`, type: 'text', field: `param_${i}_name` },
        {
          label: `参数 ${i + 1} 类型`,
          type: 'select',
          field: `param_${i}_type`,
          options: PARAM_TYPES.map((t) => ({ label: t, value: t })),
        },
        { label: `参数 ${i + 1} 描述`, type: 'text', field: `param_${i}_desc` },
      ]),
      {
        label: '执行代码',
        type: 'textarea',
        field: 'execute',
        required: true,
        rows: 6,
        placeholder: 'async ({ param1 } = {}) => { return { result } }',
      },
    ].flat();
  }

  #addParam = () => {
    const { tools, selectedIndex } = this.#state;
    const tool = tools[selectedIndex];
    const paramCount = Object.keys(tool.inputSchema.properties).length;
    const newKey = `param${paramCount + 1}`;
    const updated = {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: { ...tool.inputSchema.properties, [newKey]: { type: 'string', description: '' } },
      },
    };
    const newTools = [...tools];
    newTools[selectedIndex] = updated;
    this.#state({ tools: newTools });
  };

  #removeParam = (paramKey) => {
    const { tools, selectedIndex } = this.#state;
    const tool = tools[selectedIndex];
    const { [paramKey]: _, ...rest } = tool.inputSchema.properties;
    const updated = {
      ...tool,
      inputSchema: { ...tool.inputSchema, properties: rest },
    };
    const newTools = [...tools];
    newTools[selectedIndex] = updated;
    this.#state({ tools: newTools });
  };

  @effect((i) => [i.#formRef.element?.state?.data])
  #syncForm = () => {
    const form = this.#formRef.element;
    if (!form?.state?.data) return;
    const data = form.state.data;
    const index = this.#state.selectedIndex;
    const paramCount = this.#getParamCount();
    const newTool = this.#fromFormData(data, paramCount);
    const tools = [...this.#state.tools];
    tools[index] = newTool;
    this.#state({ tools });
  };

  @template()
  #content = () => {
    const { tools, selectedIndex } = this.#state;
    const tool = tools[selectedIndex];
    const paramKeys = tool ? Object.keys(tool.inputSchema.properties) : [];

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
          v-if=${this.#currentFormData}
          ${this.#formRef}
          .formItems=${this.#currentFormItems}
          .data=${this.#currentFormData}
        ></dy-pat-form>
        <div class="param-header">
          <span class="param-label">参数</span>
          <dy-button type="reverse" .icon=${icons.add} @click=${this.#addParam}>添加</dy-button>
        </div>
        ${paramKeys.map(
          (key) => html`
            <div class="param-item">
              <span class="param-item-name">${key}</span>
              <dy-button square color="cancel" .icon=${icons.delete} @click=${() => this.#removeParam(key)}></dy-button>
            </div>
          `,
        )}
      </div>
    `;
  };
}
