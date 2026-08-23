import { compressionImage } from 'duoyun-ui/lib/image';
import { t } from '../../shared/i18n.js';
import { icons } from '../../shared/icons.js';

const MAX_ATTACHMENTS = 10;
const MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024;
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

/** Compress an image file into a capped data URL for preview and wire. */
async function readImageAttachment(file) {
  const dataUrl = await compressionImage(file, { dimension: IMAGE_DIMENSION }, { type: 'url' });
  const [header, data] = dataUrl.split(',');
  return { mimeType: header.slice(5, header.indexOf(';')) || 'image/png', previewUrl: dataUrl, data };
}

/**
 * Message composer: textarea, staged attachments (+ button, paste, drag &
 * drop) and the session's config option pickers. Emits `send` with
 * `{ prompt, attachments }` and clears the draft, `cancel`, `configchange`
 * with `{ configId, value }`, and `attacherror` with a readable reason when
 * staged files are rejected.
 */
@customElement('agent-composer')
class AgentComposerElement extends GemElement {
  @boolattribute disabled; // prompt in flight
  @property configOptions; // selectable session config options (mode/model/effort/…)
  /** Current session id; the draft resets whenever it changes. */
  @property sessionId;

  @emitter send;
  @emitter cancel;
  @emitter configchange;
  @emitter attacherror;

  #s = createState({
    input: '',
    attachments: [], // staged prompt attachments: { id, kind: 'image'|'text', name, … }
  });

  #fileInputRef = createRef();
  #textareaRef = createRef();

  /** Clear the draft. The DOM value is reset imperatively as well: template
   * property bindings only rewrite when the bound value differs from their
   * last commit, which can desync once the user edited the field directly. */
  #clearDraft = () => {
    this.#s({ input: '', attachments: [] });
    if (this.#textareaRef.value) this.#textareaRef.value.value = '';
  };

  @effect((element) => [element.sessionId])
  #resetOnSessionChange = () => {
    this.#clearDraft();
  };

  get #canSend() {
    return !this.disabled && (Boolean(this.#s.input.trim()) || this.#s.attachments.length > 0);
  }

  /** Clear up front: the parent owns delivery and reports failures itself. */
  #emitSend = () => {
    if (!this.#canSend) return;
    const prompt = this.#s.input.trim();
    const attachments = this.#s.attachments;
    this.#clearDraft();
    this.send({ prompt, attachments });
  };

  #onKeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.#emitSend();
    }
  };

  #openFilePicker = () => {
    if (!this.disabled) this.#fileInputRef.value?.click();
  };

  #onFileInputChange = (e) => {
    this.#addFiles(e.target.files);
    e.target.value = '';
  };

  /** Turn one picked/pasted/dropped file into a staged attachment or a
   * rejection reason. */
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

  @template()
  #content = () => {
    const { input, attachments } = this.#s;
    const pending = this.disabled;
    const configOptions = this.configOptions || [];
    return html`
      <dy-drop-area
        class="block w-full"
        tip=${t('devtoolsPanelDropToAttach')}
        @change=${
          // The emitter is global: native `change` events (e.g. textarea blur)
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
            placeholder=${t('devtoolsPanelPlaceholder')}
            .value=${input}
            @input=${(e) => this.#s({ input: e.target.value })}
            @keydown=${this.#onKeydown}
            @paste=${this.#onPaste}
          ></textarea>
          <div class="flex min-h-10 items-center gap-1 px-2 pb-2">
            <button
              type="button"
              class="grid size-8 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-describe transition-[background-color,color] duration-150 hover:bg-bg-light hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-describe"
              ?disabled=${pending || attachments.length >= MAX_ATTACHMENTS}
              title=${t('devtoolsPanelAttach')}
              aria-label=${t('devtoolsPanelAttach')}
              @click=${this.#openFilePicker}
            >
              <dy-use class="size-4" .element=${icons.add}></dy-use>
            </button>
            <div class="ml-auto flex min-w-0 items-center">
              <div v-if=${configOptions.length} class="flex min-w-0 flex-wrap items-center gap-1">
                ${configOptions.map(
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
              </div>
              <button
                type="button"
                class="ml-1 grid size-8 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-primary text-white transition-[opacity,transform] duration-150 hover:opacity-[.85] active:scale-[.94] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:bg-disabled disabled:text-describe disabled:hover:opacity-100"
                ?disabled=${!pending && !this.#canSend}
                title=${pending ? t('devtoolsPanelCancel') : t('devtoolsPanelSend')}
                aria-label=${pending ? t('devtoolsPanelCancel') : t('devtoolsPanelSend')}
                @click=${() => (pending ? this.cancel() : this.#emitSend())}
              >
                <dy-use class="size-4" .element=${pending ? icons.stop : icons.send}></dy-use>
              </button>
            </div>
          </div>
        </div>
      </dy-drop-area>
      <input ${this.#fileInputRef} class="hidden" type="file" multiple @change=${this.#onFileInputChange} />
    `;
  };
}
