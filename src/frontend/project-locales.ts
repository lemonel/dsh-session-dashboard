import { interpolate, useDashboardLocale } from './i18n.js'

const zh = {
  saveProject: '保存项目', createProject: '创建项目', projectName: '项目名称', projectColor: '项目颜色',
  noPublicTags: '尚无公共标签，可先创建普通标签，再为项目选择。', tagName: '新标签名称', createTag: '创建标签并选中',
  pendingTag: '尚有未创建的标签名称。请明确创建或清空；保存项目不会隐式创建或丢弃它。',
  colorInvalid: '颜色须为空或 #RRGGBB，例如 #5266c9。输入仍保留。',
  serviceExpired: '服务已重新加载；此编辑仍属于打开时的旧服务，不能提交。输入已保留，请复制需要的内容后关闭并重新打开。',
  conflict: '项目或状态版本已变化。输入仍保留；请明确放弃此编辑并载入最新内容后重新核对。',
  discardProject: '放弃项目编辑并载入最新内容', requestFailed: '操作未成功，输入仍保留。请重新核对后重试。',
}
const en: Record<keyof typeof zh, string> = {
  saveProject: 'Save project', createProject: 'Create project', projectName: 'Project name', projectColor: 'Project color',
  noPublicTags: 'No tags yet. Create a tag, then select it for the project.', tagName: 'New tag name', createTag: 'Create and select tag',
  pendingTag: 'A tag name has not been created. Explicitly create it or clear it; saving the project will not create or discard it silently.',
  colorInvalid: 'Use an empty color or #RRGGBB, for example #5266c9. Your input is retained.',
  serviceExpired: 'The service reloaded. This edit belongs to the previous service and cannot be submitted. Your input is retained; copy what you need, then close and reopen.',
  conflict: 'The project or state revision changed. Your input is retained. Explicitly discard this edit and load the latest values before rechecking.',
  discardProject: 'Discard project edit and load latest', requestFailed: 'The operation did not succeed. Your input is retained; recheck and retry.',
}
/** Both dictionaries are exported so the locale-parity test covers them too. */
export const projectDictionaries = { zh, en }
export function useProjectTranslator() {
  const { active } = useDashboardLocale()
  const dictionary = active === 'zh' ? zh : en
  return (key: keyof typeof zh, params?: Record<string, string | number>): string => interpolate(dictionary[key], params)
}
