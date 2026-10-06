# 武器与序列层：先把**数据模型和内容层**立起来

- **日期**：2026-09-21
- **触发**：玩家 2026-09-21 给的武器设计（"武器可以使用挥砍、刺击等多种攻击方式
  （可以划归技能），武器可以铭刻技能……每种武器的技能范围和伤害因为属性不同而不同"），
  以及他明确的分轮要求：**这一轮只做数据模型和内容层**，输入接线下一轮、
  按键重绑再下一轮。
- **动了哪些文件**：
  - `schema/skill-schema.ts`（第十一节之二：`SkillSource` / `WeaponDef` 搬回来，
    加**序列层** `Technique.sequences` / `sequenceLinks` / `sequenceTimeout`，
    `ValueRef` 加 `weapon.reach` / `weapon.damage` / `weapon.windup`，
    `Skill.readonly`）
  - `schema/PLANNED.md`（武器/连段/技能来源那一节改成"回执"：搬回去了，
    以及 `ComboChain` 被**序列层**取代）
  - **新内容层**：`content/weapon-skills/{slash,thrust}.json`、
    `content/weapons/longsword.json`、
    `content/techniques/{ws-slash,ws-thrust,longsword-basic}.json`、`content/manifest.json`
  - `src/sim/types.ts`（`WEAPON_DEFAULTS` + `weaponParam`）、
    `src/sim/compile.ts`（序列术式能编译、`sequences` 进编译产物）
  - `src/pricing.ts`、`src/validator/index.ts`（`validateWeapon`、序列/武器引用检查）、
    `src/validator/checks.ts`（武器那一组检查）、`src/bridge.ts`、
    `src/cli/validate.ts`、`src/cli/run.ts`、`web/src/main.ts`
  - `tests/weapons.ts`（新，31 断言）、`tests/smoke.ts`、`package.json`
  - `docs/STRUCTURE.md`

## 改了什么

### 1. 三层模型变**四层**

```
技能 Skill      零件（可以歪：纯收益的火球、纯代价的收招）
序列 Sequence   **新的一层** —— "在实现方式上可以看作术式，但在激活方式上它在术式层级的下方"
术式 Technique  成品（必须配平）
来源 SkillSource 这些术式**属于谁**（角色 / 武器 / …）
```

⚠ 序列**不是**新类型，它复用的是 `Technique` 那一层（玩家原话：
"序列在实现方式上可以看作术式"）。好处很实际：**玩家自己做的术式
也能直接当武器的一段普攻用**。

一个术式要么走技能链（`skills` + `links`），要么走序列循环
（`sequences` + `sequenceLinks`）—— 两个都写是**错误**：
"按一次到底该走哪套"说不清。

### 2. 武器 = 一张属性表 + **两个**术式槽

| 槽 | 是什么 |
| --- | --- |
| `weaponTechnique` | **武器术式**：左键那套普攻，一个写了 `sequences` 的术式 |
| `magicTechnique` | **魔法术式**：一个普通术式，靠键触发或者做成被动 |

属性分两个命名空间，**别混**：
`weapon.*` 是**这把武器自己的参数**（只被武器技能的 `ref` 读），
`char.*` 是**给持有者的修饰**（走的是和状态同一套修饰符系统）。
混在一起会分不清"这把剑更长"和"这个人跑得更快"。

### 3. 武器技能模板是**只读**的

`content/weapon-skills/` 里的技能带 `readonly: true` —— 编辑器里不给改数值
（滑块都不显示），玩家能改的只有"怎么拼成术式"。
数值靠 `ref: 'weapon.damage'` 由武器代入，所以**同一份模板在不同武器上不一样**。

### 4. 引用查错：三处"静默失效"提前到加载期

这一轮真正值钱的东西其实是这三条检查 —— 它们的坏法**全都是没有报错**：

| 写错什么 | 原来会怎样 | 现在 |
| --- | --- | --- |
| `weaponTechnique` 指向不存在的术式 | 左键没反应（和空槽一模一样） | `UNKNOWN_WEAPON_TECHNIQUE` |
| `sequences` 里的名字敲错 | 按下去没反应 | `UNKNOWN_SEQUENCE` |
| 属性名拼错（`weapon.range`） | ref 读不到 → 退到缺省值，武器"看着能用"只是够不着人 | `UNKNOWN_WEAPON_ATTRIBUTE`（**警告**，不拦） |

## 为什么

### 为什么 `ComboChain` 没有搬回来

它把一堆时间数字**写死在武器上**：谁能衔接谁、按多快算连着、什么时候能取消。
现在这些全部变成术式自己的字段（序列之间也能带条件，玩家明确要的），
而且**玩家能自己编**。所以它不需要单独一个类型了。

### 为什么武器的账是**空的**（不是"还没做"）

`validateWeapon` 返回的 `ledger` 是空的，而且这是对的：
武器不带效果，带的是**属性**。点数账是"这一下有多强"的账，
武器的强度体现在它**代入技能之后** —— 那笔账记在**术式**头上
（同一份横砍模板，长剑和短匕点数一样，因为它们**形状**一样，差的是数值）。

### 为什么武器技能进的是**同一张** `skills` 表

术式按 id 引用技能时不区分来源。分两张表的话，校验、定价、装配
都得查两遍，迟早漏一边 —— 而漏掉的那一边的表现是"武器术式算成 0 点"，
等于白送。区别只留在内容的 `readonly` 标记上。

## 验证

```
npm test         ✓ 14 个测试文件 · 909 个断言（含新的 tests/weapons.ts 36 条）
npm run validate ✓ 60 个文件 · 60 通过 · 0 失败 · 14 警告
npm run typecheck ✓ 两份 tsconfig 都干净
npm run calibrate ✓ 最大偏差 1.53（容差 2）
battle duel --duration 12 ✓ 逐字节一致：剑士 67.6/300 造成 129、法师 71/200 造成 232.4、施法 5/8 次
npm run build:web ✓ 页面 200
```

途中修掉的三个真 bug（都不是这一轮新写的代码，是**新形状**把它们照出来的）：

1. `looksLikeTechnique` 认的是"有 `skills`"→ 纯序列术式被当成技能，
   炸在 `phases.forEach of undefined` 上（校验器、运行器、网页各一处）。
2. `priceTechnique` 直接 `for (const id of tech.skills)` → 序列术式
   在 `loadLibrary` 里就崩，整个内容库加载不出来。
3. 网页 `recompileAll` 的"空术式不编译"只判 `skills` → 序列术式会被
   当成空草案丢掉（表现是"装上了武器但技能栏里没有那一格"）。

⚠ 这三个是同一类错：**"序列术式没有 `skills`"这个形状，代码里到处没认**。
所以顺手把 `Technique.skills` 改成了**可选**（`skills?: string[]`）——
这样编译器会替你把每一处都指出来，而不是等运行时炸。
它立刻在编辑器里照出 16 处，全部收口到一个 `chainOf(t)` 上。

## 玩家拍板（2026-09-21，这一轮问的四个问题）

| 问题 | 答复 |
| --- | --- |
| 横砍单独算出来 −2.06（越过容差，被判负值术式）怎么办 | **"我不是说了武器技能不算帐吗"** → ✅ **本轮就改了**：引入了 `isWeaponSide()`（引用了只读技能 = 武器侧），武器技能和由它拼成的序列**都不算账、不判配平、血契消耗恒为 0**。⚠ 校验器**必须说出来**为什么没有账（`ValidationReport.priceless`）—— 静默不显示会被读成"免费" |
| 按左键时当前段还没放完怎么办 | **放完才走下一段，按下进 150ms 缓冲**（下一轮做） |
| 攻速怎么进去 | **术式级攻速倍率：`weapon.windup` 只乘所有阶段时长**（下一轮做；比"把 `Phase.duration` 放宽成 `ValueSpec`"好懂，也比"先不做"完整） |
| 武器术式占哪个键 | **两个槽都进技能栏，玩家自己绑键**（左键只是默认绑法）。⚠ 这修正了我提的"武器术式固定占左键"—— 他要的是"默认左键"，不是"左键写死" |

## 欠账

- **输入层没做**：按左键走下一段序列、150ms 缓冲、1 秒超时回第一条、
  取消窗口按类别匹配 —— 数据齐了，消费者没写。下一轮。
- **属性代入没做**：`ref: 'weapon.damage'` 现在还读不到东西；
  载体几何（`DeliverySpec.radius` / `length`）还是裸 `number`，
  要放宽成 `number | ValueSpec`（见 `slash.json` 的 `_comment_geometry`）。
- **攻速倍率没做**：方向定了（术式级倍率），实现是下一轮。
- **武器还没装到人身上**：`SkillSource` 回来了但没人用；
  换武器、技能栏里出现武器术式、左键默认绑法，都是下一轮。
- **编辑器还不认 `readonly`**：武器技能现在只是"内容里带着标记"，
  滑块该隐藏这件事要等编辑器那一轮（`chainOf` 那 16 处只是让它别炸）。
