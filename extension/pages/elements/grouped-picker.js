import { addListener } from '@mantou/gem/lib/utils';
import { ContextMenu } from 'duoyun-ui/elements/contextmenu';
import { pickerStyle } from 'duoyun-ui/elements/picker';
import { commonHandle } from 'duoyun-ui/lib/hotkeys';
import { icons } from 'duoyun-ui/lib/icons';
import { focusStyle } from 'duoyun-ui/lib/styles';
import { theme } from 'duoyun-ui/lib/theme';

// Keep the same DOM class names and layout rules as dy-picker so this
// component can move into duoyun-ui without changing its visual contract.
const style = css`
  :host {
    width: 12em;
    white-space: nowrap;
  }

  .placeholder,
  .value {
    flex-grow: 1;
    text-overflow: ellipsis;
    overflow: hidden;
  }

  .placeholder {
    color: ${theme.describeColor};
  }
`;

/**
 * A dy-picker-shaped control for multiple independent single-select groups.
 *
 * `options` uses dy-picker's `{ label, description, value, children }` shape.
 * `value` is an object keyed by each group's value. `change` emits
 * `{ group, value }` for the selected child. `renderValue` can customize the
 * collapsed value.
 */
@customElement('agent-grouped-picker')
@adoptedStyle(style)
@adoptedStyle(pickerStyle)
@adoptedStyle(focusStyle)
@connectStore(icons)
@shadow()
@aria({ focusable: true, role: 'combobox' })
class AgentGroupedPickerElement extends GemElement {
  @attribute placeholder;
  @boolattribute disabled;
  @boolattribute borderless;
  @boolattribute fit;

  @state active;

  @property options;
  @property value;
  @property renderValue;

  @globalemitter change;

  #optionValue = (option) => option.value ?? option.label;

  #current = (group) => {
    const groupValue = this.#optionValue(group);
    const currentValue = this.value?.[groupValue];
    return group.children?.find((option) => this.#optionValue(option) === currentValue);
  };

  #genMenu = (group) => {
    const groupValue = this.#optionValue(group);
    const currentValue = this.value?.[groupValue];
    const current = this.#current(group);
    return {
      text: group.label,
      description: group.description,
      tag: current?.label,
      menu: group.children?.map((option) => {
        const value = this.#optionValue(option);
        return {
          text: option.label,
          description: option.description,
          selected: value === currentValue,
          handle: () => {
            if (value !== currentValue) this.change({ group: groupValue, value });
          },
        };
      }),
    };
  };

  #onOpen = async () => {
    const options = this.options?.filter((group) => group.children?.length);
    if (this.disabled || !options?.length) return;
    await ContextMenu.open(options.map(this.#genMenu), {
      activeElement: this,
      width: this.fit ? `${this.getBoundingClientRect().width}px` : undefined,
    });
  };

  @mounted()
  #init = () => {
    addListener(this, 'click', this.#onOpen);
    addListener(this, 'keydown', commonHandle);
    return () => this.active && ContextMenu.close();
  };

  @effect()
  #autoOpen = () => {
    if (this.active) this.#onOpen();
  };

  @template()
  #content = () => {
    const current = this.options?.length ? this.#current(this.options[0]) : undefined;
    const value = this.renderValue?.(this.value) ?? current?.label;
    return html`
      <div v-if=${value == null} class="placeholder">${this.placeholder}</div>
      <div v-else class="value">${value}</div>
      <dy-use .element=${icons.expand}></dy-use>
    `;
  };

  showPicker() {
    this.#onOpen();
  }
}
