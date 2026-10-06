/**
 * 固有效果 ⇄ 规则：一个**纯数据**的折叠。
 *
 * ## 为什么需要这一层
 *
 * 玩家 2026-09-21 定的：
 *   > 技能本身的效果**不计入规则栏中**，也不具有点数盈亏。
 *
 * 于是数据分成了两块：`Skill.effect`（这个技能**是什么**）和
 * `Skill.rules`（这个技能**额外做了什么**）。
 *
 * 但引擎、定价、人类可读的说明**都不需要知道这个区分** ——
 * 它们要的是一串"什么时机、做什么事"。所以这里把效果按同一套形状折出来：
 *
 * ```
 * SkillEffect { id: 'e1', at: 'swing', then: [...] }
 *   ↓ effectsAsRules()
 * Rule { id: 'e1', when: 'phaseComplete', phaseId: 'swing', then: [...], order: -1000 }
 * ```
 *
 * ⚠ 这样一来**引擎一行都不用改**（`src/sim/compile.ts` 只是把它当成多几条规则），
 *   而且搬家前后**行为完全一致、账也完全一致** ——
 *   换的只是数据形状和界面归属。
 *
 * ## ⚠ 顺序：效果永远在反应**前面**
 *
 * 同一段上可能既有固有效果（"挥砍造成伤害"）又有挂在这一段上的反应规则。
 * 顺序定死为：**先把这一下打出去，再走额外的规则**。
 *
 * 理由：效果是"这个技能是什么"，反应是"它额外做了什么" ——
 * "额外"当然发生在"本身"之后。出厂内容里效果都是从规则里搬过去的，
 * 搬完就没有同段的 `phaseComplete` 规则了，所以这个顺序对出厂内容没有影响。
 */
import type { Rule, Skill, SkillEffect } from './schema.ts'

/** 效果折成的规则的 `order` 起点。负数 = 永远排在反应之前 */
const EFFECT_ORDER_BASE = -1000

/**
 * 一条效果折成规则。
 *
 * ⚠ `i` 是它在 `skill.effect` 里的位置 —— 只用来排 `order`，
 *   **不用来认身份**（身份是 `e.id`）。
 */
export function effectAsRule(e: SkillEffect, i: number): Rule {
  const r: Rule = {
    id: e.id,
    when: 'phaseComplete',
    phaseId: e.at,
    then: e.then,
    order: EFFECT_ORDER_BASE + i,
  }
  if (e.note !== undefined) r.note = e.note
  return r
}

/** 效果折成规则。没有效果时返回**空数组**（不是 undefined，调用方不用判） */
export function effectsAsRules(skill: Skill): Rule[] {
  const list = skill.effect
  if (list === undefined || list.length === 0) return []
  return list.map((e, i) => effectAsRule(e, i))
}

/**
 * 这个技能**全部**会跑的东西：固有效果 + 规则。
 *
 * ⚠ 顺序 = `[效果..., 规则...]`（见文件头）。
 *   编译、定价、说明、校验都用它 —— 这样"效果"和"规则"在任何地方
 *   看到的都是同一条时间轴。各写一份的话迟早会漂移，
 *   而漂移的表现是"界面上有这一下、引擎里没有"（或者反过来）。
 */
export function allRulesOf(skill: Skill): Rule[] {
  return [...effectsAsRules(skill), ...skill.rules]
}
