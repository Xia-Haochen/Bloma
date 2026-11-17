export const visualReviewChecklist = {
  layout: '检查导航、顶部栏、搜索框、主要按钮：长路径/长名称是否挤压、截断、换行或溢出；结合当前窗口尺寸描述。',
  interaction: '检查当前弹窗、遮挡、主要操作和反馈；仅截图不能证明点击成功，引用同次操作事实，未覆盖状态须明确说明。',
  content: '检查当前对象、数值、单位、静态残留、空/错误/完成状态与确认需求是否一致。',
  scope: '列明本图实际页面与状态，以及未覆盖的页面、弹窗和窗口尺寸；不得把单图扩称全应用验收。',
} as const
export function visualCoverageComplete(rows: unknown[] | undefined): boolean {
  return Boolean(rows && Object.keys(visualReviewChecklist).every(area => rows.some(row =>
    row && typeof row === 'object' && (row as { area?: string }).area === area)))
}
