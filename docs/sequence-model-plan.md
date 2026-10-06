# 序列模型 B（内联）落地计划

- **日期**：2026-09-21
- **状态**：**未开工**（等编辑器 UI 的线框一起做 —— 理由在最后一节）
- **玩家已定**：模型 **B = 序列内联在术式里**（不是引用另一份术式）。

> ⚠ **2026-09-21 定稿后补的指针（只加指针；原来的正文行一个字没改，⚠ 都加在它们前面）**：
> 这份计划里"**每条序列自己的瞄准**"（`SequenceSegment.targeting`）**已被**
> [`sequence-and-modifier-model.md`](sequence-and-modifier-model.md) **取代** ——
> 那条规矩是"**术式没有瞄准，瞄准在技能层**（每个技能各自解释同一个意图）"（见那份第六节 / 第九节）。
> **其余部分（序列层本身：内联、合成内部术式的冷却键、删四份子术式）仍然有效** ✓
> 受影响的说法集中在下面这几处：第 31 行的"自己的瞄准"、第 56 行的"自己的瞄准"、
> 第 92 / 101 行的"每段瞄准"，以及两处 jsonc 例子里序列自己带的 `targeting`
> （第 32~33 行、第 45~46 行 —— 那两处只是例子，没动）。

  > 我设想的是术式中有若干条序列，每条序列放若干技能，按下按键就按顺序激活序列

  > 补充，如果释放某条序列时其中的某个技能在 cd，则释放下一条序列。
  （这条**引擎已经做完了**，见日志 38 —— 与 A/B 无关，两边都成立。
  ⚠ **日志 49 改了口径**：**不激活**这条序列、指针挪到下一条、**等下一次按键**才试
  —— 旧版是"跳到下一条并**当场把它打出去**"，见
  [日志 49](log/2026-09-27-49-cd-skip-and-hint.md)。）

---

## 一、现在是什么（模型 A）

```jsonc
// tech.longsword-basic —— 容器：不带技能，只挂两条"序列"
{ "sequences": ["tech.ws-slash", "tech.ws-thrust"] }

// ⚠ 下面这两行里的"瞄准"（targeting）**已被取代**：瞄准在技能层，序列不带瞄准（见文件开头 ⚠）；
//    "自己的 id / 冷却键"那一半仍然成立 ✓
// 每一条序列**自己是一份术式**（所以有自己的 id、瞄准、冷却键 cd.<id>）
// tech.ws-slash:  { "skills": ["skill.ws-slash"], "targeting": {…} }
// tech.ws-thrust: { "skills": ["skill.ws-thrust"], "targeting": {…} }
```

好处：每段自己的 CD / 能复用 / 引擎零改动；代价：内容里多出四份"子术式"
（`ws-slash` `ws-thrust` `mark-step` `blink-step`），**编辑器里完全编不出来**。

## 二、要变成什么（模型 B）

```jsonc
// tech.longsword-basic
{
  "sequences": [
    { "name": "横砍", "skills": ["skill.ws-slash"], "targeting": { "mode": "directional", … } },
    { "name": "刺击", "skills": ["skill.ws-thrust"], "targeting": { "mode": "directional", … } }
  ],
  "sequenceLinks": [ { "if": [ … ] } ],
  "sequenceTimeout": 1
}
```

- ⚠ **这一行里的"自己的瞄准"已被取代**：瞄准移到**技能层**（技能各自解释那一个意图），
  序列只带 `skills`（+ 可选 `name`）—— 见 [`sequence-and-modifier-model.md`](sequence-and-modifier-model.md) 第六 / 第九节。
  下面那条"冷却键由编译器合成"**不受影响，仍然成立** ✓
- 一条序列 = **若干技能 + 自己的瞄准**（`skills` + `targeting`），可选 `name`
- 序列的**冷却键**：`cd.<容器id>.seq<i>` —— 由编译器**合成**一份内部术式来承载（见下）
- `ws-slash` / `ws-thrust` / `mark-step` / `blink-step` **四份子术式删掉**

## 三、怎么做（引擎那半边，一处一处）

核心手法：**编译器把每条序列合成为一份"内部术式"**（id = `<容器id>.seq<i>`），
后面的东西（`activate` / `canActivate` / 冷却键 / HUD 的 `cd.*` / 链状态）**全都不用改** ——
它们本来就只认"一份编译好的术式"。

| # | 文件 | 改什么 |
| --- | --- | --- |
| 1 | `schema/skill-schema.ts` | `Technique.sequences?: string[]` → `SequenceSegment[]`（`{ name?, skills, targeting? }`）+ 注释重写 |
| 2 | `src/sim/compile.ts` | `CompiledTechnique.sequences?: string[]` → `segments?: CompiledTechnique[]`；容器分支**递归编译**每条序列成内部术式；`skillIds` 取各段之和（这样"技能页 → 被这些术式用到"仍然准） |
| 3 | `src/sim/cast.ts` | `pressSequence` / `nextIndex` / `startSequence` / `peekSequence` / `runningSequence`：把 `world.techniques.get(seqId)` 换成 `technique.segments[i]`（少一次查表，顺带删掉"这一段没注册进世界"那条分支） |
| 4 | `src/pricing.ts` | 容器也要算账：把各段 `skills` 摊平进去（不然玩家内联的序列**不进点数账**，编辑器里会显示 0）。`bloodPactCostOf` 同理 |
| 5 | `src/validator/index.ts` | `UNKNOWN_SEQUENCE` / `BAD_SEQUENCE_ID` → 换成"每段的 `skills` 必须存在"；`TOO_MANY_SEQUENCE_LINKS` / `SKILLS_AND_SEQUENCES` 保留 |
| 6 | `src/cli/validate.ts` | 建"术式表"时不再需要收集序列 id（序列内联了）；`looksLikeTechnique` 不变（`Array.isArray(o.sequences)` 对新形状照样成立） |
| 7 | `web/src/main.ts` | 删掉"序列悬空引用"那段检查（内联了不会有悬空；改成查每段的技能引用 —— 那一条 `compileTechnique` 已经报）；注册时把 `segments` 也 `registerTechnique`（内联状态定义要跟着注册） |
| 8 | 内容 | 3 份容器改内联 + 删 4 份子术式 + `manifest.json` 去掉那四个名字 |
| 9 | 测试 | `tests/weapons.ts`（序列形状、序列推进、CD 跳段那几组）、`tests/blink.ts`（不再是三份文件）、`tests/fixtures/broken-tech.json`（如果里面有 `sequences` 的坏例子） |
| 10 | 文档 | `docs/STRUCTURE.md` 的序列两条、"想改什么改哪里"两行；`README.md`；新日志 |

⚠ **这是数据模型变更**：老存档里玩家的术式**不可能**有 `sequences`
（编辑器从来没给过这个入口，日志 35 起玩家的术式库就是他自己的），
所以**不需要存档迁移**；分享码同理（里面也不可能有）。
内容文件我们自己改 ✓。

## 四、为什么不现在做（这一轮只写了计划）

1. **它和编辑器 UI 是同一件事的两半**：引擎改完，编辑器里还是编不出来 ——
   B 对玩家的**唯一可见收益**是"少四份子术式"，而真正要的是那块 UI。
   两半一起落地，才叫"能自己编二段技能了"。
2. **它是数据模型变更**：10 个文件 + 内容 + 测试。半做的话，
   玩家的主流程（创造术式）会被弄坏 —— 那是他唯一在用的功能。
3. **UI 结构要先定**：编辑器现在整块 `innerHTML` 重建（`ui-plan.md` 第六节那条），
   要画"序列卡 + 每段瞄准 + 哪条是下一条"，得先把它改成"结构固定、只更新变化的部分"。
   （⚠ 其中的"每段瞄准"已被取代，见文件开头 ⚠；"序列卡 + 哪条是下一条"照旧 ✓）
   而结构怎么排，取决于玩家给的线框（见 `editor-ui-brief.md`）。

## 五、建议的落地顺序（下一步）

1. 玩家给**术式那一页的线框**（序列那块画个大概就行）
2. 我把编辑器改成"结构固定、只更新变化的部分" + 按线框重排（**先不碰数据模型**）
3. 引擎按上面第 1~7 条改成 B（内容 + 测试一起迁）
4. 编辑器加上序列 UI（增删改 + 每段瞄准 + "下一条是哪条"）
   （⚠ "每段瞄准"那一项已被取代 —— 瞄准在技能层；"增删改 + 下一条是哪条"照旧 ✓）
5. 配色 / 图标 / 动效（拿玩家的参考图对着调）
