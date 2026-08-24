import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';

/** ACP 的 diff 内容里 `oldText: null` 表示新建文件，`newText` 为空串表示清空。 */
function unifiedDiff({ path, oldText, newText }) {
  const name = path || 'file';
  return [
    `diff --git ${name} ${name}`,
    createTwoFilesPatch(
      oldText == null ? '/dev/null' : name,
      newText == null ? '/dev/null' : name,
      oldText ?? '',
      newText ?? '',
      undefined,
      undefined,
      { context: 3, headerOptions: FILE_HEADERS_ONLY },
    ),
  ].join('\n');
}

/** ACP tool call update 的所有 diff 内容项转成 `<gem-bind-diff2html>` 可渲染的 unified diff 文本。 */
export function toolCallDiffs(update) {
  return (update?.content || [])
    .filter((item) => item?.type === 'diff')
    .map((item) => ({ path: item.path, text: unifiedDiff(item) }));
}
