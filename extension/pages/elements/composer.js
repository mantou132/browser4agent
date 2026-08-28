import { compressionImage } from 'duoyun-ui/lib/image';
import { t } from '../../shared/i18n.js';
import { icons } from '../../shared/icons.js';

const MAX_ATTACHMENTS = 10;
const MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024;
const CODEX_COMBINED_CONFIG_IDS = new Set(['model', 'reasoning_effort', 'fast-mode']);
// Cap images at what vision models can use anyway; compressionImage scales down.
const IMAGE_DIMENSION = { width: 1568, height: 1568 };
const TEXT_EXTENSION =
  /\.(txt|md|markdown|json|jsonl|ndjson|csv|tsv|log|xml|svg|yaml|yml|toml|ini|cfg|conf|env|html?|css|scss|less|[jt]sx?|mjs|cjs|graphql|proto|py|rb|rs|go|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|sql|r)$/i;

/** Text-like files are inlined into the prompt; binaries cannot be sent
 * because a browser `File` carries no host path for a resource link. */
function isTextFile(file) {
  if (/^text\/|\b(?:json|xml|yaml|javascript|ecmascript|x-sh|sql|toml)\b/.test(file.type)) return true;
  return !file.type && TEXT_EXTENSION.test(file.name);
}

async function readImageAttachment(file) {
  const dataUrl = await compressionImage(file, { dimension: IMAGE_DIMENSION }, { type: 'url' });
  const [header, data] = dataUrl.split(',');
  return { mimeType: header.slice(5, header.indexOf(';')) || 'image/png', previewUrl: dataUrl, data };
}

const queueButtonClass =
  'grid size-7 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-describe transition-[background-color,color] duration-150 hover:bg-bg-light hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

const sendButtonClass =
  'ml-1 grid size-8 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-primary text-white transition-[opacity,transform] duration-150 hover:opacity-[.85] active:scale-[.94] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:bg-disabled disabled:text-describe disabled:hover:opacity-100';

const stopButtonClass =
  'ml-1 grid size-8 shrink-0 cursor-pointer place-items-center rounded-full border border-border bg-transparent text-describe transition-[background-color,color] duration-150 hover:bg-bg-light hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

@customElement('agent-composer')
class AgentComposerElement extends GemElement {
  @boolattribute disabled; // prompt in flight
  @property agent;
  @property configOptions;
  @property sessionKey;
  @property queue; // staged prompts while one is in flight

  @emitter send;
  @emitter cancel;
  @emitter configchange;
  @emitter attacherror;
  @emitter queuesend; // detail: queued item id
  @emitter queueupdate; // detail: { id, prompt, attachments }
  @emitter queueremove; // detail: queued item id

  #s = createState({
    input: '',
    attachments: [], // staged prompt attachments: { id, kind: 'image'|'text', name, … }
    editingId: null, // 正在编辑的队列条目：发送时会原地更新它而不是新发一条
  });

  #fileInputRef = createRef();
  #textareaRef = createRef();

  focus = () => {
    this.#textareaRef.value?.focus();
  };

  /** The DOM value is reset imperatively too: template property bindings only
   * rewrite when the bound value differs from their last commit, which can
   * desync once the user edited the field directly. */
  #setInput = (value) => {
    this.#s({ input: value });
    if (this.#textareaRef.value) this.#textareaRef.value.value = value;
  };

  #clearDraft = () => {
    this.#s({ attachments: [], editingId: null });
    this.#setInput('');
  };

  @effect((i) => [i.sessionKey])
  #resetOnSessionChange = () => {
    this.#clearDraft();
  };

  get #canSend() {
    return Boolean(this.#s.input.trim()) || this.#s.attachments.length > 0;
  }

  /** Clear up front: while a turn is in flight the parent stages the prompt
   * into its queue instead of delivering it; while editing a queue entry the
   * parent patches that entry in place. */
  #emitSend = () => {
    if (!this.#canSend) return;
    const prompt = this.#s.input.trim();
    const attachments = this.#s.attachments;
    const editingId = this.#s.editingId;
    this.#clearDraft();
    if (editingId) this.queueupdate({ id: editingId, prompt, attachments });
    else this.send({ prompt, attachments });
  };

  #onKeydown = (e) => {
    // 组字（输入法候选中）时的 Enter 是确认上屏，不能当作发送
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.#emitSend();
    }
  };

  #openFilePicker = () => {
    this.#fileInputRef.value?.click();
  };

  #onFileInputChange = (e) => {
    this.#addFiles(e.target.files);
    e.target.value = '';
  };

  #readFile = async (file) => {
    const base = { id: crypto.randomUUID(), name: file.name };
    try {
      if (file.type.startsWith('image/')) {
        return { attachment: { ...base, kind: 'image', ...(await readImageAttachment(file)) } };
      }
      if (isTextFile(file)) {
        if (file.size > MAX_TEXT_ATTACHMENT_BYTES) return { reason: t('devtoolsPanelAttachmentTooLarge') };
        return { attachment: { ...base, kind: 'text', text: await file.text() } };
      }
      return { reason: t('devtoolsPanelAttachmentUnsupported') };
    } catch {
      return { reason: t('devtoolsPanelAttachmentFailed') };
    }
  };

  #addFiles = async (fileList) => {
    // dy-drop-area wraps plain-text drags as { name: 'temp', type: '*' } —
    // ignore them; pasting covers that case.
    const room = MAX_ATTACHMENTS - this.#s.attachments.length;
    const files = [...fileList].filter((file) => file.type !== '*').slice(0, Math.max(room, 0));
    if (!files.length) return;
    const results = await Promise.all(files.map((file) => this.#readFile(file)));
    const added = results.flatMap(({ attachment }) => (attachment ? [attachment] : []));
    const reason = results.find(({ reason }) => reason)?.reason || '';
    if (added.length) this.#s({ attachments: [...this.#s.attachments, ...added] });
    if (reason) this.attacherror(reason);
  };

  #removeAttachment = (id) => {
    this.#s({ attachments: this.#s.attachments.filter((item) => item.id !== id) });
  };

  #onPaste = (e) => {
    const images = [...(e.clipboardData?.files || [])].filter((file) => file.type.startsWith('image/'));
    if (images.length) this.#addFiles(images);
  };

  /** Put a queued prompt back into the draft; sending then updates that
   * entry in place. Clicking its row button again cancels editing. */
  #editQueued = (id) => {
    if (this.#s.editingId === id) {
      this.#s({ editingId: null });
      return;
    }
    const item = (this.queue || []).find((entry) => entry.id === id);
    if (!item) return;
    this.#s({ editingId: id });
    this.#setInput(item.prompt);
    this.#s({ attachments: item.attachments || [] });
    this.focus();
  };

  #renderCodexConfigValue = (value) =>
    ['model', 'reasoning_effort']
      .map((id) => this.configOptions?.find((option) => option.id === id))
      .map((option) => option?.options.find((item) => item.value === value?.[option.id])?.name)
      .filter(Boolean)
      .join(' ');

  @template()
  #content = () => {
    const { input, attachments, editingId } = this.#s;
    const pending = this.disabled;
    const configOptions = this.configOptions || [];
    const codexConfigOptions =
      this.agent === 'codex' ? configOptions.filter((option) => CODEX_COMBINED_CONFIG_IDS.has(option.id)) : [];
    const standaloneConfigOptions = codexConfigOptions.length
      ? configOptions.filter((option) => !CODEX_COMBINED_CONFIG_IDS.has(option.id))
      : configOptions;
    const codexPickerOptions = codexConfigOptions.map((option) => ({
      label: option.name,
      description: option.description,
      value: option.id,
      children: option.options.map((item) => ({
        label: item.name,
        description: item.description,
        value: item.value,
      })),
    }));
    const codexPickerValue = Object.fromEntries(codexConfigOptions.map((option) => [option.id, option.currentValue]));
    const codexConfigSummary = codexConfigOptions
      .map(
        (option) =>
          `${option.name}: ${option.options.find((item) => item.value === option.currentValue)?.name || option.currentValue}`,
      )
      .join('; ');
    const canSend = this.#canSend;
    // 忙碌时主按钮二态：有草稿是「加入队列」，空草稿是「停止」
    const mainIcon = pending ? (canSend ? icons.queueAdd : icons.stop) : icons.send;
    const mainTitle = pending
      ? canSend
        ? t('devtoolsPanelEnqueue')
        : t('devtoolsPanelCancel')
      : t('devtoolsPanelSend');
    return html`
      <div v-if=${!!this.queue?.length} class="mb-2">
        <div class="px-1 pb-1 text-xs text-describe">${t('devtoolsPanelQueuedPrompts')}</div>
        <div class="flex flex-col gap-1.5">
          ${this.queue?.map(
            (item) => html`
              <div
                class=${`group flex items-center gap-2 rounded-lg border bg-bg px-3 py-1.5 ${
                  item.id === this.#s.editingId ? 'border-focus' : 'border-border'
                }`}
              >
                <div class="min-w-0 flex-1 self-stretch flex flex-col justify-center">
                  <div class="truncate text-sm text-text" title=${item.prompt}>${item.prompt}</div>
                  <div v-if=${item.attachments.length} class="truncate text-xs text-describe">
                    ${item.attachments.map((attachment) => attachment.name).join(' · ')}
                  </div>
                </div>
                <div
                  class="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <button
                    type="button"
                    class=${queueButtonClass}
                    title=${t('devtoolsPanelSendNow')}
                    aria-label=${t('devtoolsPanelSendNow')}
                    @click=${() => {
                      if (this.#s.editingId === item.id) this.#s({ editingId: null });
                      this.queuesend(item.id);
                    }}
                  >
                    <dy-use class="size-4" .element=${icons.send}></dy-use>
                  </button>
                  <button
                    type="button"
                    class=${queueButtonClass}
                    title=${t('devtoolsPanelEditPrompt')}
                    aria-label=${t('devtoolsPanelEditPrompt')}
                    @click=${() => this.#editQueued(item.id)}
                  >
                    <dy-use class="size-4" .element=${icons.edit}></dy-use>
                  </button>
                  <button
                    type="button"
                    class=${queueButtonClass}
                    title=${t('devtoolsPanelRemovePrompt')}
                    aria-label=${t('devtoolsPanelRemovePrompt')}
                    @click=${() => {
                      if (this.#s.editingId === item.id) this.#s({ editingId: null });
                      this.queueremove(item.id);
                    }}
                  >
                    <dy-use class="size-4" .element=${icons.delete}></dy-use>
                  </button>
                </div>
              </div>
            `,
          )}
        </div>
      </div>
      <dy-drop-area
        class="block w-full"
        tip=${t('devtoolsPanelDropToAttach')}
        @change=${
          // The emitter is global: native `change` events (e.g. input blur)
          // bubble here too and carry no detail — only react to file lists.
          (e) => {
            if (Array.isArray(e.detail)) this.#addFiles(e.detail);
          }
        }
      >
        <div
          class="w-full rounded-lg border border-border bg-bg transition-[border-color,box-shadow] duration-150 focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/15"
        >
          <div v-if=${attachments.length} class="flex flex-wrap gap-1.5 px-3 pt-2">
            ${attachments.map(
              (item) => html`
                <agent-attachment
                  .attachment=${item}
                  removable
                  @request-remove=${(e) => this.#removeAttachment(e.detail)}
                ></agent-attachment>
              `,
            )}
          </div>
          <textarea
            ${this.#textareaRef}
            class="field-sizing-content box-border block min-h-13 max-h-48 w-full resize-none overflow-y-auto border-0 bg-transparent px-3.5 pb-1 pt-3 text-sm leading-6 text-text outline-none placeholder:text-describe"
            rows="1"
            placeholder=${editingId ? t('devtoolsPanelEditHint') : t('devtoolsPanelPlaceholder')}
            .value=${input}
            @input=${(e) => this.#s({ input: e.target.value })}
            @keydown=${this.#onKeydown}
            @paste=${this.#onPaste}
          ></textarea>
          <div class="flex min-h-10 items-center gap-1 px-2 pb-2">
            <button
              type="button"
              class="grid size-8 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-describe transition-[background-color,color] duration-150 hover:bg-bg-light hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              ?disabled=${attachments.length >= MAX_ATTACHMENTS}
              title=${t('devtoolsPanelAttach')}
              aria-label=${t('devtoolsPanelAttach')}
              @click=${this.#openFilePicker}
            >
              <dy-use class="size-4" .element=${icons.add}></dy-use>
            </button>
            <div class="ml-auto flex min-w-0 items-center">
              <div
                v-if=${standaloneConfigOptions.length || codexConfigOptions.length}
                class="flex min-w-0 flex-wrap items-center gap-1"
              >
                ${standaloneConfigOptions.map(
                  (option) => html`
                    <dy-picker
                      borderless
                      class="max-w-40"
                      placeholder=${option.name}
                      .options=${option.options.map((item) => ({
                        label: item.name,
                        description: item.description,
                        value: item.value,
                      }))}
                      .value=${option.currentValue}
                      aria-label=${option.name}
                      title=${option.description || option.name}
                      @change=${(e) => this.configchange({ configId: option.id, value: e.detail })}
                    ></dy-picker>
                  `,
                )}
                <agent-grouped-picker
                  v-if=${codexConfigOptions.length}
                  borderless
                  class="max-w-40"
                  placeholder=${codexConfigOptions[0]?.name}
                  .options=${codexPickerOptions}
                  .value=${codexPickerValue}
                  .renderValue=${this.#renderCodexConfigValue}
                  aria-label=${codexConfigSummary}
                  title=${codexConfigSummary}
                  @change=${(event) => this.configchange({ configId: event.detail.group, value: event.detail.value })}
                ></agent-grouped-picker>
              </div>
              <button
                type="button"
                class=${pending && !canSend ? stopButtonClass : sendButtonClass}
                ?disabled=${!pending && !canSend}
                title=${mainTitle}
                aria-label=${mainTitle}
                @click=${() => (pending && !canSend ? this.cancel() : this.#emitSend())}
              >
                <dy-use class="size-4" .element=${mainIcon}></dy-use>
              </button>
            </div>
          </div>
        </div>
      </dy-drop-area>
      <input ${this.#fileInputRef} class="hidden" type="file" multiple @change=${this.#onFileInputChange} />
    `;
  };
}
