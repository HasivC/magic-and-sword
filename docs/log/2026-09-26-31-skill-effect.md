# 固有效果（`Skill.effect`）+ 一次自己造成的内容损毁和恢复

- **日期**：2026-09-21
- **触发**：玩家 2026-09-21 的第 1 条要求落地 ——
  > 技能本身的效果**不计入规则栏中**，也不具有点数盈亏。
- **动了哪些文件**
  - 规格：`schema/skill-schema.ts`（`SkillEffect` + `Skill.effect`）
  - 引擎侧：**新文件** `src/effects.ts`（效果 ⇄ 规则的折叠）、`src/sim/compile.ts`、
    `src/pricing.ts`、`src/validator/checks.ts`、`src/validator/types.ts`、
    `src/cli/run.ts`、`tools/overview.ts`
  - 前端：`web/src/editor.ts`、`web/src/leaves.ts`
  - 内容：**26 个技能文件**（28 条 `phaseComplete` 规则搬进 `effect`）
  - 测试：`tests/{smoke,pricing,fx,weapons,barrier,blink,editor,web}.ts` 跟着改
  - 救火脚本（`.scratch/`）：`survey-effect.mjs`、`migrate-effect.mjs`、`ledger.mjs`、
    `recover-verify.mjs`、`recover-probe.mjs`、`restore-effects.mjs`、`find-cache.mjs`

---

## 一、改了什么

### 1. `Skill.effect`：这个技能**是什么**

```
Skill.effect: SkillEffect[]        // 固有效果：时间轴走到这一段就发生
Skill.rules:  Rule[]               // 额外做了什么：挂在某个时机上的行为与反应
```

判据是**机械的**：`when === 'phaseComplete'` 的那些就是固有效果
（时间轴的一部分），其余（`onHit` / `onCast` / `onTick` / `onLowHp` …）是反应。

```ts
export interface SkillEffect {
  id: string       // 技能内唯一，**不按下标**认身份
  at: string       // 在哪一段结束的时候发生（阶段 id）
  then: Action[]   // 这一下干了什么
  note?: string    // 设计意图（和 Rule.note 同规矩）
}
```

**引擎一行都没改。** `src/effects.ts` 把效果折成一条
`when: 'phaseComplete'` 的规则，编译、定价、说明、校验看到的还是同一条时间轴：

```
SkillEffect { id:'e1', at:'swing', then:[…] }
  ↓ effectAsRule()
Rule { id:'e1', when:'phaseComplete', phaseId:'swing', then:[…], order: -1000 }
```

所以这次搬家**行为零改动、账零改动** —— 换的只是数据形状和界面归属。
（验证：`duel` 逐位一致、`calibrate` 的 18.4 / 1.47 一模一样、
`validate` 的警告数 11 一条不差。）

### 2. 界面：效果是**单独一块**

- 技能编辑器里「固有效果」排在「规则」**前面**，卡片上**不给删**
  （效果是这个技能的定义；改的是它的**数值**，那是下面滑块的事）。
- 滑块的组也多了一个「固有效果」（`web/src/leaves.ts`）——
  效果里的数字照样能拖，照样计点数（偏离出厂值才算）。
- 标题规则不变：效果里的数按**它挂的那个阶段**叫（「命中 · 伤害」），
  和 `phaseComplete` 规则**字一模一样**。
- 命令行 `run` 的把效果和规则分成两栏打；`overview` 的机制覆盖也扫效果了。

### 3. ⚠ 一条真正要紧的教训：**"看不见效果"的地方会静默失明**

效果搬出 `rules` 之后，所有"遍历 `skill.rules`"的地方都变成了瞎子。
这次一共扫出 **8 处**，每一处的坏法都是静默的：

| 地方 | 漏了会怎样 |
| --- | --- |
| `compileTechnique` | 技能有阶段、有代价、账上有数，**但打出去什么都没有** |
| `priceSkill` | 效果里的数字变成**真的免费**（而它本该只是"出厂时恰好为 0"） |
| `collectActions` / `collectStatuses` | 跨文件引用检查漏掉效果的 `statusId` / `entityId` —— 那两样都是**运行期才炸** |
| `tests/fx.ts` 的伤害类型扫描 | 以为内容只用了一两种类型 |
| `tests/weapons.ts` 的 `ref: weapon.damage` | 武器技能的伤害检查**悄悄失明** |
| `web/src/leaves.ts` | 效果里的数字在面板上不出现（玩家看不到） |
| `src/cli/run.ts` | 效果显示成 id + 0 点 |
| `tools/overview.ts` | 机制覆盖统计偏低 |

规矩：**"这个技能会做什么"只有 `allRulesOf()` 一个入口**（`src/effects.ts`）。
再写"遍历 rules"的代码之前先问一句：效果算不算？

---

## 二、⚠ 事故：搬家的脚本把 6 个技能的固有效果**删掉了**

### 发生了什么

`migrate-effect.mjs` 我跑了两遍：

1. 第一遍搬家（把 `phaseComplete` 规则折进 `effect`）—— 对了。
2. 第二遍只重排 `rules` 的 `order`（第一遍留下的 order 不连续，校验器会报
   `NON_CONTIGUOUS_ORDER`）。

第二遍进来时 `moved` 是空的，而我的写文件逻辑是
**"`effect` 用 `moved` 生成的结果覆盖"** —— 于是 6 个技能的 `effect`
被写成了空数组，直接蒸发：

> 破军突刺、裂地斩、寒冰锁、猎杀、熔岩护甲、裂魂

**没有 git、没有备份。** 这是这次最贵的一课。

### 怎么救回来的

四路证据交叉验证，最后 **5 个数一条不差地对上了**：

1. **账**。`npm run calibrate` 的输出里有一列「标定前」= 每个技能**搬之前**的
   绝对账。我复刻了它的定价选项（`DEFAULT_RATES` + 状态库、**不带**实体预设、
   容差 0），先拿**没被动过的技能**当对照组（魔法飞弹 −0.7、灵光盾 5.6、
   瞬影 3.05、贯日 −5、名刀 6.1 —— **全部一致**），再把 6 个技能的
   "搬之前 vs 搬之后"相减，得到每个效果**应该值多少点**：
   `−5.6 / −3.0 / −2.5 / −2.5 / 0 / −20`。
2. **备注原文**。`.scratch/v.txt`（早前一轮的 `validate` 完整输出）里留着效果的
   备注：「一枪捅穿一条线」「捅中的人被挑飞出去」「近身横扫」「一道冰锥打出去」
   「一支穿甲箭」「一发打穿」。
3. **测试里钉死的数字**：裂地斩 30 伤害（`tests/editor.ts`）、
   破军突刺推 2 米 + 击飞（`tests/scenario.ts` + 校验器的 `AIRBORNE` 警告）。
4. **点表**（`web/src/leaves.ts`）里的合法档位 + 载体标准值。

然后写了个探针（`.scratch/recover-probe.mjs`）把候选动作喂给同一个定价器，
**反解**出那几个数：扇形 2.5 米/120° 伤害 30 · 投射物 12/1.5/0.5 伤害 25 ·
光束 8/0.6 伤害 200 · 突刺 4/0.6 伤害 30 + 击退 2 米带击飞 · 熔岩护甲的护甲状态
是**无修饰的标记**（0 点，所以它对账没有影响）。

对账结果（`.scratch/recover-verify.mjs`）：

```
✓ skill.armor-pierce   现在 0.9    目标 0.9
✓ skill.cleave         现在 -4.35  目标 -4.35
✓ skill.frost-lock     现在 -17.85 目标 -17.85
✓ skill.hunt           现在 -3.6   目标 -3.6
✓ skill.lava-armor     现在 6.65   目标 6.65
✓ skill.soul-rend      合计 -4.73（明细 6.87 / -7.24 一发打穿 / -4 击杀就刷新 / -0.36）
```

裂魂那一条尤其硬：搬之前那次 `validate` 的输出是
`6.87 / -7.24 / -4 / -0.36 = -4.73`，**逐行一致**。

### 教训（写进规矩）

1. **"保留已有字段"绝不能写成空数组。** 一个只干别的事的脚本，
   不该顺手把不认识的字段清掉。
2. **一次性的内容脚本要能重跑**（幂等），或者干脆**只跑一遍就不留**。
   分两遍跑、每遍都重写整个文件，是这次事故的形状。
3. **这个项目没有版本控制。** 改 26 个内容文件之前，先复制一份到
   `.scratch/backup-<日期>/`。

这次已经补了一条：`migrate-effect.mjs` 现在会把"已有的 `effect`"原样留下，
注释里也写了这次事故。

---

## 三、验证

| 检查 | 结果 |
| --- | --- |
| `npm test` | 16 个文件 · **1055 个断言全绿**（纯净性 16 个文件） |
| `npm run validate` | 69 个文件 · 69 通过 · 0 失败 · **11 警告**（和搬家前一样） |
| `npm run typecheck` | 两套 tsconfig 都干净 |
| `npm run calibrate` | **18.4 → 1.47**（和搬家前一模一样） |
| `battle duel --duration 12` | **逐位一致**：剑士 67.6/300 造成 129、法师 71/200 造成 232.4、施法 5 / 8 |
| `npm run build:web` | 通过 |
| 页面 | `http://127.0.0.1:5173/` HTTP 200；`content/skills/cleave.json` 带 `effect` |

这三条"一模一样"就是这次搬家的验收标准：**数据形状换了，行为和账一分没动。**

## 四、欠账

1. **技能修正**（技能编辑器里负责数值和几何，改的是**它自己所在的这个技能**）
   —— 玩家 2026-09-21 确认过作用对象，还没实现。
2. **修饰技能**：术式里的**连接卡**（现在的 `links` / `sequenceLinks` 显示成卡片）
   + **触发器卡**（技能结束 / 碰撞 → 同时激活任意个技能）。
   触发器要"同时激活"，那需要引擎支持并行施法 —— 这一块要在 `cast.ts` 里动。
3. **锚点表**（`content/anchors.json`）：`calibrate` 的拟合目标仍然不成立，
   别用它的 `--write`。
4. 阶段时长的 **无 / 1× / 3× / 9×** 四档。
5. `docs/default-values.md` 第四节那 5 条待玩家定。
