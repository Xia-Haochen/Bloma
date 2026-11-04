import type { PrdBackplane } from '../model/prd-backplane'
import { snapshotProductTheme } from '../../shared/product-design-theme'

/** A project-owned default, subordinate to explicit user intent and confirmed UX. */
export function productDesignPolicy(brief: PrdBackplane) {
  if (!brief.lean_brief || brief.lean_brief.ui === 'none') return undefined
  const theme = brief.lean_brief.design_theme
  return {
    mode: theme ? 'platform_default' : 'legacy_preserve',
    theme: theme ? snapshotProductTheme(theme) : undefined,
    assets: brief.lean_brief.design_assets,
    priority: ['explicit_user_style_and_assets', 'confirmed_project_design', 'project_default_theme'],
    user_constraints: brief.constraints ?? [],
    guidance: theme
      ? '未指定外观时采用本项目冻结的Bloma语义调色；布局、信息密度和交互按产品用途设计，不套平台工作台。用户明确风格/素材要求优先，其次遵守已确认设计；局部要求仅覆盖相关部分，明确整体换风格可替换默认。不要为了保留绿色破坏指定美术资源。核对实际颜色用途、文字可读性、焦点和状态区分，不以CSS含色号冒充验收。'
      : '旧项目没有绑定平台默认调色，保留已确认设计和用户要求；不得因平台升级自动换色。',
    evidence: 'design_guidance_not_visual_acceptance',
  }
}
