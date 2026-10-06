# 计划中的内容层（**引擎还没实现**）

> ⚠ **这份文档里的类型都不在代码里，因为它们一个都没有实现。**
>
> 它们原先写在 `skill-schema.ts` 里，2026-09-20 搬到了这里。
> 理由：schema 是**技能作者照着填的东西** —— 照着填就会期待它生效。
> 一个没有任何引擎实现的类型留在 schema 里，等于一张空头支票。
>
> **什么时候搬回去**：等对应的引擎真的做出来（至少有一处代码读它、
> 有一个技能用得上、有一条测试盯着）。搬回去的时候顺手把这一节删掉。

原来它们占的是 schema 的第十到十三节，约 120 行。

---

## 零、已经**删掉**的：组合技 `Combo`

这里原来有第一节"组合技 Combo"——有名字、可保存、可分享的**技能组**（≈ 函数），
`Technique` 上还留了 `combos?: string[]` 当入口。

**这个概念整个取消了**，不是"以后再做"。玩家的原话：

> 重申，没有组合技这个概念，分享码是术式的。术式由若干技能进行编程组合得到。

想清楚之后这很明显：术式**本身**就是"若干技能编程组合出来的东西"（见
`skill-schema.ts` 里的 `SkillLink` / `Technique.links`）。
在它上面再叠一层"组合技"，等于给同一个东西起两个名字，
而且第二层的存在会让人以为"术式只是把技能排成一列、组合技才是带逻辑的那种"——
正好反了：带逻辑的那个就是术式。

所以分享码将来发的是一份**术式**（外加它引用到的技能和状态），
`Combo` 没有存在的余地，`Technique.combos` 也一并删了。

---

## 一、武器与技能来源 —— **2026-09-21 搬回 schema 了**

这一节原来是"武器与连段"（原 §11 后半）和"技能来源"（原 §12）。
现在它们躺在 `schema/skill-schema.ts` 的**第十一节之二**
（`SkillSource` / `WeaponDef`），判据是这一节自己写的那句：

> **什么时候搬回去**：等对应的引擎真的做出来。

引擎这边确实做了：`content/weapon-skills/` 两份武器技能模板、
`content/weapons/longsword.json`、`content/internal-techniques/ws-slash.json` +
`ws-thrust.json` + `longsword-basic.json`，命令行和网页都会加载它们，
`weapon.*` 三个参数由 `src/sim/types.ts` 的 `WEAPON_DEFAULTS` 兜底，
`tests/weapons.ts` 盯着。

### `ComboChain` **没有**搬回去 —— 它被**序列层**取代了

原来的设计是：

```ts
/** 近战武器的连段（**已废弃**，留在这里只为了说明它被什么取代） */
export interface ComboChain {
  steps: {
    techniqueId: string
    /** 可输入窗口，单位秒（相对整条连段的起点） */
    inputWindow: [number, number]
    /** 取消窗口：在这段时间内输入下一段可衔接 */
    cancelWindow: [number, number]
    next: number | null
  }[]
}
```

它错在**把一堆时间数字写死在武器上**：谁能衔接谁、按多快算连着、
什么时候能取消 —— 全是武器作者说了算，玩家只能接受。

玩家 2026-09-21 给了替代方案：

> 本质上是在术式的层级之下多加了一层序列层……
> 序列在**实现方式**上可以看作术式，但在**激活方式**上它在术式层级的下方。

于是同一件事变成：

| 原来写死在 `ComboChain` 上 | 现在写在哪 |
| --- | --- |
| 「第一段是挥砍，第二段是刺击」 | `Technique.sequences: string[]`（序列**就是**术式） |
| 「按多快算连着」 | `Technique.sequenceTimeout`（默认 1 秒） |
| 「什么条件下才接下一段」 | `Technique.sequenceLinks`（和 `links` 同一套平行数组） |
| 「这段能不能取消、什么时候能取消」 | 阶段自己的 `cancellable` / `interrupt` |

多出来的好处是**玩家能自己编**：序列层复用的是术式那一层，
所以玩家做的术式可以直接当武器的一段普攻用。

### 铭刻槽 → 武器的**两个术式槽**

原来叫 `engravings: (string | null)[]`（"铭刻槽"）。
玩家定的是**只有两个**，而且各有名字：

| 槽 | 是什么 | 现在的内容 |
| --- | --- | --- |
| `weaponTechnique` | **武器术式**：左键那套普攻，一个写了 `sequences` 的术式 | `tech.longsword-basic` |
| `magicTechnique` | **魔法术式**：一个普通术式，靠键触发或者做成被动 | （还没配） |

⚠ 属性**代入**这一半还没做（`ref: 'weapon.damage'` 现在读不到东西，
载体几何也还写着数字）。那是**武器运行时**那一轮的事，理由见
`schema/skill-schema.ts` 里 `ValueRef` 的注释和
`content/weapon-skills/slash.json` 的 `_comment_geometry`。

---

## 二、构筑 Build（原 §13）

**想法**：整个 build = 技能来源 + 角色属性 + 血契余额。

```ts
export interface Build {
  schemaVersion: number
  sources: SkillSource[]
  /** 角色基础属性 */
  attributes: Record<string, number>
  /**
   * 血契。从战斗中的负面行为（自伤等）获得，不能为负。
   * 用于支付负值术式的消耗。
   */
  bloodPact: number
}
```

**为什么先不做**：构筑层是**最上面**那一层，它要聚合的东西（武器、铭刻、
来源）还没做。而且玩家明确说过："meta / 构筑层不紧急，从底层往上建"。

⚠ 2026-09-21 更新：`SkillSource` 已经搬回 schema 了（见第一节），
所以 `Build` 里那个字段现在指得到东西了。**但还是不做** ——
差的是"多个来源的聚合"这个结构本身：现在只有角色和武器两个来源，
而武器还没真正装上人身（属性代入没做）。
等武器运行时那一轮做完再回来看它 —— 那时 `sources` 才有第二项。

### 顺带：`Cost.bloodPact` 也删了（这个不是"计划"，是**冗余**）

原先 `Cost` 上有一个手写的 `bloodPact?: number`。它和**已经算出来的**
`PriceResult.bloodPactPerUse` 是同一个东西：

```ts
// src/validator/index.ts
bloodPactPerUse: priced.kind === 'negative' ? Math.abs(priced.total) : 0,
```

而那个手写字段**零引用、零内容**。整份代码的立场是
**"点数全部是算出来的，一个字都不存进 JSON"** —— 第一版手写的 `points`
就是这么被删掉的。手写的血契是同一个错误，一起删掉。

⚠ **2026-09-21 更新**："血契"这个机制本身**已经实现了**，而且被玩家扶正成了核心
（「花超了的术式叫做**负值术式**，消耗血契才能释放」）。
删掉的只是**手写的那个字段** —— 存量是 `char.bloodPact.current` 这条存储属性，
每次释放消耗多少仍然由 `|点数合计|` 算出来。见
`docs/log/2026-09-23-18-blood-pact-and-range-pricing.md`。

---

## 什么时候这些会回来

按依赖顺序，比较自然的下一步是：

1. **输入层 + 序列推进**：一次按键怎么走下一段序列、缓冲多少毫秒、
   超时回第一条 —— 序列层已经把数据准备好了（`sequences` /
   `sequenceTimeout` / `sequenceLinks`），差的是那个消费者
2. **武器运行时**：属性代入（`ref: 'weapon.*'` 真的读得到东西）、
   载体几何放宽成 `ValueSpec`、`Phase.duration` 能被攻速影响
3. **武器装到人身上**：`SkillSource` 上线，武器术式进技能栏、
   途中换武器
4. **分享码**：发的是**术式**（从来不需要一个额外的"组合技"类型）
5. **构筑**：上面四样齐了，`Build` 才有东西可聚合

每一步的判据都是同一条：**引擎里真的有代码读它了**。
