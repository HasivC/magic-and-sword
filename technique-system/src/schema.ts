/**
 * 类型统一从这里导入。
 *
 * 真正的定义在仓库根的 `schema/` 下 —— 那是唯一的真相来源，
 * 既是设计文档也是代码的类型。这里只做一次转出，避免出现两份会漂移的定义。
 *
 *   skill-schema.ts     技能 / 术式 / 状态 / 实体预设 / 载荷……
 *   scenario-schema.ts  场景（一场遭遇的初始条件）
 */
export * from '../../schema/skill-schema.ts'
export * from '../../schema/scenario-schema.ts'
